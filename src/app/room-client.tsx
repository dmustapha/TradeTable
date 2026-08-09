"use client";

import {AnchorProvider, BN, Idl, Program, Wallet} from "@coral-xyz/anchor";
import {PublicKey, Transaction, VersionedTransaction} from "@solana/web3.js";
import {useEffect, useMemo, useState} from "react";
import idl from "../idl/tradetable.json";
import {
  Cycle, PendingPostcondition, allocationHash, baseConnection, isProjectionStale, livePda,
  pendingPostconditionMet, programId, selectedSlotsFromChoices, sendErWithFallback,
  subscribeAuthoritative,
} from "@/lib/tradetable";

type InjectedWallet = {publicKey: PublicKey | null; connect(): Promise<{publicKey: PublicKey}>; signTransaction<T extends Transaction | VersionedTransaction>(value: T): Promise<T>; signAllTransactions<T extends Transaction | VersionedTransaction>(values: T[]): Promise<T[]>};
declare global {interface Window {solana?: InjectedWallet}}
type LiveView = {revision: bigint; expiresAt: bigint; selectedSlots: [number, number, number]; cycle: Cycle; allocationHash: number[]; lockMask: number; lockedRevision: bigint[]; lockedHash: number[][]; phase: number; source: string; observedAt: number};
type Pending = PendingPostcondition & {signature: string};
type Props = {room: string; participants: string[]; mints: string[]};

function decodeLive(data: Buffer, source: string): LiveView {
  if (data.length < 356) throw new Error("RoomLive data is truncated");
  return {
    expiresAt: data.readBigInt64LE(138), revision: data.readBigUInt64LE(146),
    selectedSlots: [...data.subarray(154, 157)] as [number, number, number],
    cycle: data[157] === 0 ? "forward" : "reverse", allocationHash: [...data.subarray(161, 193)],
    lockedRevision: [0, 1, 2].map(index => data.readBigUInt64LE(193 + index * 8)),
    lockedHash: [0, 1, 2].map(index => [...data.subarray(217 + index * 32, 249 + index * 32)]),
    lockMask: data[313], phase: data[314], source, observedAt: Date.now(),
  };
}

function walletAdapter(injected: InjectedWallet): Wallet {
  if (!injected.publicKey) throw new Error("Connect a rostered wallet first");
  return {publicKey: injected.publicKey, signTransaction: <T extends Transaction | VersionedTransaction>(value: T) => injected.signTransaction(value), signAllTransactions: <T extends Transaction | VersionedTransaction>(values: T[]) => injected.signAllTransactions(values)} as unknown as Wallet;
}

export default function RoomClient({room, participants, mints}: Props) {
  const core = useMemo(() => new PublicKey(room), [room]);
  const live = useMemo(() => livePda(core)[0], [core]);
  const [wallet, setWallet] = useState<InjectedWallet | null>(null);
  const [view, setView] = useState<LiveView | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [choices, setChoices] = useState<[number, number, number]>([0, 0, 0]);
  const [cycle, setCycle] = useState<Cycle>("forward");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    const stop = subscribeAuthoritative(core, live, () => undefined, (data, source) => setView(decodeLive(data, source)));
    return () => {clearInterval(clock); void stop();};
  }, [core, live]);

  useEffect(() => {
    if (pending && view && pendingPostconditionMet(pending, view)) setPending(null);
  }, [pending, view]);

  async function connect() {
    try {if (!window.solana) throw new Error("An injected Solana wallet is required"); await window.solana.connect(); setWallet(window.solana); setError(null);} catch (caught) {setError(String(caught));}
  }

  function actorIndex(): number {
    const index = participants.indexOf(wallet?.publicKey?.toBase58() ?? "");
    if (index < 0) throw new Error("Connected wallet is not in this room roster");
    return index;
  }

  function buildProgram() {
    if (!wallet) throw new Error("Connect a rostered wallet first");
    const value = new Program(idl as Idl, new AnchorProvider(baseConnection(), walletAdapter(wallet), {commitment: "confirmed"})) as any;
    if (!value.programId.equals(programId())) throw new Error("Generated IDL program ID mismatch");
    return value;
  }

  async function build(kind: "propose" | "lock") {
    if (!wallet?.publicKey || !view) throw new Error("Wallet and authoritative RoomLive are required");
    const program = buildProgram();
    if (kind === "propose") return program.methods.propose(new BN(view.revision.toString()), selectedSlotsFromChoices(choices), cycle === "forward" ? {forward: {}} : {reverse: {}}).accounts({actor: wallet.publicKey, roomCore: core, roomLive: live}).instruction();
    return program.methods.lock(new BN(view.revision.toString()), view.allocationHash).accounts({actor: wallet.publicKey, roomCore: core, roomLive: live}).instruction();
  }

  function expected(kind: "propose" | "lock"): PendingPostcondition {
    if (!view) throw new Error("Authoritative RoomLive is required");
    const index = actorIndex();
    if (kind === "lock") return {kind, actorIndex: index, revision: view.revision, allocationHash: view.allocationHash};
    const slots = selectedSlotsFromChoices(choices);
    const revision = view.revision + 1n;
    return {kind, actorIndex: index, revision, slots, cycle, allocationHash: [...allocationHash(core, revision, view.expiresAt, slots, cycle)]};
  }

  async function submit(kind: "propose" | "lock") {
    if (!view || !wallet) return;
    const marker = {...expected(kind), signature: "AWAITING WALLET"} as Pending;
    setPending(marker); setError(null);
    try {const signature = await sendErWithFallback(walletAdapter(wallet), await build(kind)); setPending({...marker, signature});}
    catch (caught) {setPending(null); setError(caught instanceof Error ? caught.message : String(caught));}
  }

  const stale = !view || isProjectionStale(view.observedAt, now);
  const disabled = !wallet?.publicKey || !view || stale || Boolean(pending) || view.phase !== 0;
  const slots = selectedSlotsFromChoices(choices);
  return <section className="liveControls">
    <div><p className="kicker">LIVE COLLABORATION</p><h2>Revision {view?.revision.toString() ?? "—"}</h2><p className={stale ? "stale" : "fresh"}>{stale ? "STALE / WRITES DISABLED" : `${view?.source} · AUTHORITATIVE`}</p></div>
    <div className="controlRail">
      <button type="button" onClick={() => void connect()}>{wallet?.publicKey ? `${wallet.publicKey.toBase58().slice(0, 7)}… CONNECTED` : "CONNECT PRIMARY WALLET"}</button>
      {choices.map((choice, owner) => <button type="button" disabled={Boolean(pending)} key={owner} onClick={() => setChoices(current => current.map((value, index) => index === owner ? 1 - value : value) as [number, number, number])}>OWNER {owner + 1}: SLOT {owner * 2 + choice} ({mints[owner * 2 + choice]?.slice(0, 7) ?? "UNAVAILABLE"}…)</button>)}
      <button type="button" title="SET CYCLE: FORWARD / SET CYCLE: REVERSE" disabled={Boolean(pending)} onClick={() => setCycle(current => current === "forward" ? "reverse" : "forward")}>SET CYCLE: {cycle === "forward" ? "FORWARD" : "REVERSE"}</button>
      <button type="button" disabled={disabled} onClick={() => void submit("propose")}>PROPOSE {slots.join(" · ")} / {cycle.toUpperCase()}</button>
      <button className="accent" type="button" disabled={disabled} onClick={() => void submit("lock")}>LOCK EXACT REVISION</button>
      {pending ? <code>{pending.signature} · WAITING FOR EXACT {pending.kind.toUpperCase()} POSTCONDITION</code> : null}{error ? <p role="alert">{error}</p> : null}
    </div>
  </section>;
}
