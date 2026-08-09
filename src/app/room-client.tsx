"use client";

import {AnchorProvider, BN, Idl, Program, Wallet} from "@coral-xyz/anchor";
import {PublicKey, Transaction, VersionedTransaction} from "@solana/web3.js";
import {useEffect, useMemo, useState} from "react";
import idl from "../idl/tradetable.json";
import {baseConnection, isProjectionStale, livePda, programId, sendErWithFallback, subscribeAuthoritative} from "@/lib/tradetable";

type InjectedWallet = {publicKey: PublicKey | null; connect(): Promise<{publicKey: PublicKey}>; signTransaction<T extends Transaction | VersionedTransaction>(value: T): Promise<T>; signAllTransactions<T extends Transaction | VersionedTransaction>(values: T[]): Promise<T[]>};
declare global {interface Window {solana?: InjectedWallet}}
type LiveView = {revision: bigint; allocationHash: number[]; locks: number; phase: number; source: string; observedAt: number};
type Pending = {kind: "propose" | "lock"; signature: string; revision: bigint; locks: number};

function decodeLive(data: Buffer, source: string): LiveView {
  if (data.length < 356) throw new Error("RoomLive data is truncated");
  const mask = data[313];
  return {revision: data.readBigUInt64LE(146), allocationHash: [...data.subarray(161, 193)], locks: [0, 1, 2].filter(index => mask & (1 << index)).length, phase: data[314], source, observedAt: Date.now()};
}

function walletAdapter(injected: InjectedWallet): Wallet {
  if (!injected.publicKey) throw new Error("Connect a rostered wallet first");
  return {
    publicKey: injected.publicKey,
    signTransaction: <T extends Transaction | VersionedTransaction>(value: T) => injected.signTransaction(value),
    signAllTransactions: <T extends Transaction | VersionedTransaction>(values: T[]) => injected.signAllTransactions(values),
  } as unknown as Wallet;
}

export default function RoomClient({room}: {room: string}) {
  const core = useMemo(() => new PublicKey(room), [room]);
  const live = useMemo(() => livePda(core)[0], [core]);
  const [wallet, setWallet] = useState<InjectedWallet | null>(null);
  const [view, setView] = useState<LiveView | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    const stop = subscribeAuthoritative(core, live, () => undefined, (data, source) => setView(decodeLive(data, source)));
    return () => {clearInterval(clock); void stop();};
  }, [core, live]);

  useEffect(() => {
    if (!pending || !view) return;
    if (view.revision > pending.revision || view.locks > pending.locks || view.phase !== 0) setPending(null);
  }, [pending, view]);

  async function connect() {
    try {if (!window.solana) throw new Error("An injected Solana wallet is required"); await window.solana.connect(); setWallet(window.solana); setError(null);} catch (caught) {setError(String(caught));}
  }

  async function build(kind: "propose" | "lock") {
    if (!wallet?.publicKey || !view) throw new Error("Wallet and authoritative RoomLive are required");
    const program = new Program(idl as Idl, new AnchorProvider(baseConnection(), walletAdapter(wallet), {commitment: "confirmed"})) as any;
    if (!program.programId.equals(programId())) throw new Error("Generated IDL program ID mismatch");
    if (kind === "propose") return program.methods.propose(new BN(view.revision.toString()), [0, 2, 4], {forward: {}}).accounts({actor: wallet.publicKey, roomCore: core, roomLive: live}).instruction();
    return program.methods.lock(new BN(view.revision.toString()), view.allocationHash).accounts({actor: wallet.publicKey, roomCore: core, roomLive: live}).instruction();
  }

  async function submit(kind: "propose" | "lock") {
    if (!view || !wallet) return;
    const marker = {kind, signature: "AWAITING WALLET", revision: view.revision, locks: view.locks};
    setPending(marker); setError(null);
    try {const signature = await sendErWithFallback(walletAdapter(wallet), await build(kind)); setPending({...marker, signature});}
    catch (caught) {setPending(null); setError(caught instanceof Error ? caught.message : String(caught));}
  }

  const stale = !view || isProjectionStale(view.observedAt, now);
  const disabled = !wallet?.publicKey || !view || stale || Boolean(pending) || view.phase !== 0;
  return <section className="liveControls">
    <div><p className="kicker">LIVE COLLABORATION</p><h2>Revision {view?.revision.toString() ?? "—"}</h2><p className={stale ? "stale" : "fresh"}>{stale ? "STALE / WRITES DISABLED" : `${view?.source} · AUTHORITATIVE`}</p></div>
    <div className="controlRail">
      <button type="button" onClick={() => void connect()}>{wallet?.publicKey ? `${wallet.publicKey.toBase58().slice(0, 7)}… CONNECTED` : "CONNECT PRIMARY WALLET"}</button>
      <button type="button" disabled={disabled} onClick={() => void submit("propose")}>PROPOSE 0 · 2 · 4</button>
      <button className="accent" type="button" disabled={disabled} onClick={() => void submit("lock")}>LOCK EXACT REVISION</button>
      {pending ? <code>{pending.signature}</code> : null}{error ? <p role="alert">{error}</p> : null}
    </div>
  </section>;
}
