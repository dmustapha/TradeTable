"use client";

import {Idl, type Wallet} from "@coral-xyz/anchor";
import {DELEGATION_PROGRAM_ID} from "@magicblock-labs/ephemeral-rollups-sdk";
import {getAccount, getAssociatedTokenAddressSync, getMint, TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {PublicKey, Transaction, VersionedTransaction, type TransactionInstruction} from "@solana/web3.js";
import React, {useEffect, useMemo, useRef, useState} from "react";

import idl from "../idl/tradetable.json";
import {ConsentPanel} from "./consent-panel";
import {SharedTable} from "./shared-table";
import {WalletControl} from "./wallet-control";
import {assertWalletSnapshot} from "@/lib/create-room-state";
import {
  awaitAuthoritative, broadcastPending, buildActivateAndDelegateLiveInstruction, buildCancelByParticipantInstruction,
  buildCancelExpiredInstruction, buildDepositAssetInstruction, buildFinalizeCommitOnlyInstruction, buildLockInstruction,
  buildProposeInstruction, buildReturnAssetInstruction, buildRevokeLockInstruction, buildSettleCommittedInstructions,
  failPending, startPending, type PendingAction, type PendingRequest, type PendingWrite,
} from "@/lib/room-actions";
import {
  decodeRoomCore, decodeRoomLive, deriveRoomUiState, deriveWalletRole, returnableSlots,
  type Cycle, type RoomAction, type RoomCore, type RoomLive,
} from "@/lib/room-state";
import {
  acquireWriteMutex, actionTransport, assertDepositMintUnique, assetLifecycleLabel, authorityDraft, bindWalletEvents,
  changeDraft, failureAfterSigning, humanizeWorkspaceError, reconcileDraft, reconcileFreshPending, reduceWallet,
  releaseWriteMutex, resolveSignedOutcome, snapshotActionAllowed, workspacePolicy, type WalletEvent, type WalletState, type WorkspaceDraft, type WriteMutex,
} from "@/lib/workspace-state";
import {
  AmbiguousBroadcastError, SignedTransactionRejectedError, allocationHash, ambiguousBroadcastSignature, baseConnection,
  isProjectionStale, livePda, programFor, programId, readSignedOutcome, sendBaseInstructions, sendErWithFallback,
  subscribeAuthoritative, vaultAta, vaultAuthorityPda, type SignedIntent,
} from "@/lib/tradetable";

type InjectedWallet = {
  publicKey: PublicKey | null;
  connect(): Promise<{publicKey: PublicKey}>;
  signTransaction<T extends Transaction | VersionedTransaction>(value: T): Promise<T>;
  signAllTransactions?<T extends Transaction | VersionedTransaction>(values: T[]): Promise<T[]>;
  on?(event: "accountChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
  removeListener?(event: "accountChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
};
declare global {interface Window {solana?: InjectedWallet}}

type Props = {room: string; initialCore: RoomCore; initialLive: RoomLive; initialAuthority: "magicblock-er" | "solana-base"; initialDelegated?: boolean; initialObservedAt: number};
type Projection = {core: RoomCore; live: RoomLive; coreSource: string; liveSource: string; delegated: boolean; coreObservedAt: number; liveObservedAt: number};
type ActionInput = {slot?: number; mint?: string};

function injectedWallet(): InjectedWallet | undefined { return window.solana; }
const sourceAuthority = (source: string): "magicblock-er" | "solana-base" => source.startsWith("router") || source.startsWith("er") || source === "magicblock-er" ? "magicblock-er" : "solana-base";
const isBlockingPending = (pending: PendingWrite | null) => Boolean(pending && (pending.refreshAuthority || ["awaiting-wallet", "broadcast", "awaiting-authoritative"].includes(pending.phase)));
const short = (value: Uint8Array) => new PublicKey(value).toBase58().replace(/^(.{6}).*(.{5})$/, "$1…$2");

function walletAdapter(wallet: InjectedWallet, snapshot: PublicKey, onSigned: () => void): Wallet {
  const assertCurrent = () => assertWalletSnapshot(snapshot.toBase58(), wallet.publicKey?.toBase58() ?? null);
  return {publicKey: snapshot, signTransaction: async <T extends Transaction | VersionedTransaction>(value: T) => {
    assertCurrent(); const signed = await wallet.signTransaction(value); assertCurrent(); onSigned(); return signed;
  }, signAllTransactions: async <T extends Transaction | VersionedTransaction>(values: T[]) => {
    const signed: T[] = []; for (const value of values) signed.push(await wallet.signTransaction(value)); return signed;
  }} as Wallet;
}

export function buildPendingRequest(action: PendingAction, coreAddress: PublicKey, core: RoomCore, live: RoomLive, roleIndex: number, draft: WorkspaceDraft, slot?: number): PendingRequest {
  if (action === "depositAsset") return {action, expectation: {kind: "mask", field: "depositedMask", value: core.depositedMask | (1 << requiredSlot(slot))}};
  if (action === "activateAndDelegate") return {action, expectation: {kind: "status", status: "Active"}};
  if (action === "cancelByParticipant" || action === "cancelExpired") return {action, expectation: {kind: "status", status: "Cancelled"}};
  if (action === "returnAsset") return {action, expectation: {kind: "return", slot: requiredSlot(slot)}};
  if (action === "finalizeCommitOnly") return {action, expectation: {kind: "phase", phase: "Finalized"}};
  if (action === "settleCommitted") return settlementRequest(coreAddress, action, live);
  if (action === "propose" || action === "lock" || action === "revokeLock") return consentRequest(action, coreAddress, live, roleIndex, draft);
  throw new Error(`${action} is not available inside an existing room.`);
}

function settlementRequest(core: PublicKey, action: "settleCommitted", live: RoomLive): PendingRequest {
  const selectedMask = live.selectedSlots.reduce((mask, slot) => mask | (1 << slot), 0);
  return {action, expectation: {kind: "settlement", selectedMask, revision: live.revision, allocationHash: live.allocationHash}};
}

function consentRequest(action: "propose" | "lock" | "revokeLock", core: PublicKey, live: RoomLive, actorIndex: number, draft: WorkspaceDraft): PendingRequest {
  if (action === "propose") {
    const revision = live.revision + 1n;
    return {action, expectation: {kind: "proposal", revision, selectedSlots: draft.proposal.selectedSlots,
      cycle: draft.proposal.cycle, allocationHash: allocationHash(core, revision, live.expiresAt, draft.proposal.selectedSlots, draft.proposal.cycle)}};
  }
  const kind = action === "lock" ? "lock" : "revoke";
  return {action, expectation: {kind, actorIndex, revision: live.revision, allocationHash: live.allocationHash}} as PendingRequest;
}

function requiredSlot(slot?: number): number {
  if (slot === undefined) throw new Error("Choose an exact asset slot first.");
  return slot;
}

async function validateDeposit(connection: ReturnType<typeof baseConnection>, owner: PublicKey, coreAddress: PublicKey, core: RoomCore, mint: PublicKey, slot: number) {
  assertDepositMintUnique(core, mint.toBytes(), slot);
  const accountInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!accountInfo?.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("Mint must be a classic SPL Token mint.");
  const mintState = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  if (mintState.decimals !== 0 || mintState.supply !== 1n || mintState.mintAuthority || mintState.freezeAuthority) throw new Error("Mint must be immutable, decimals 0, and supply exactly 1.");
  const source = await getAccount(connection, getAssociatedTokenAddressSync(mint, owner), "confirmed", TOKEN_PROGRAM_ID);
  if (!source.owner.equals(owner) || !source.mint.equals(mint) || source.amount !== 1n) throw new Error("Connected wallet must own exactly one token in its canonical ATA.");
  const vault = vaultAta(coreAddress, mint); const vaultInfo = await connection.getAccountInfo(vault, "confirmed");
  if (!vaultInfo) return;
  const vaultState = await getAccount(connection, vault, "confirmed", TOKEN_PROGRAM_ID);
  if (!vaultState.owner.equals(vaultAuthorityPda(coreAddress)[0]) || !vaultState.mint.equals(mint) || vaultState.amount !== 0n) throw new Error("Target vault already exists with non-zero or invalid custody state.");
}

async function buildBaseWrite(action: PendingAction, program: ReturnType<typeof programFor>, signer: PublicKey, coreAddress: PublicKey, liveAddress: PublicKey, core: RoomCore, live: RoomLive, input: ActionInput) {
  if (action === "depositAsset") {
    const slot = requiredSlot(input.slot); const mint = new PublicKey(input.mint?.trim() ?? "");
    await validateDeposit(baseConnection(), signer, coreAddress, core, mint, slot);
    return [await buildDepositAssetInstruction(program, signer, coreAddress, mint, slot)];
  }
  if (action === "activateAndDelegate") return [await buildActivateAndDelegateLiveInstruction(program, signer, coreAddress, liveAddress)];
  if (action === "cancelByParticipant") return [await buildCancelByParticipantInstruction(program, signer, coreAddress)];
  if (action === "cancelExpired") return [await buildCancelExpiredInstruction(program, signer, coreAddress)];
  if (action === "returnAsset") return [await buildReturnAssetInstruction(program, signer, coreAddress, core, requiredSlot(input.slot))];
  if (action === "settleCommitted") return (await buildSettleCommittedInstructions(program, signer, coreAddress, liveAddress, core, live, BigInt(Math.floor(Date.now() / 1_000)))).instructions;
  throw new Error(`${action} is not a Solana base action.`);
}

async function buildErWrite(action: PendingAction, program: ReturnType<typeof programFor>, signer: PublicKey, core: PublicKey, liveAddress: PublicKey, live: RoomLive, draft: WorkspaceDraft) {
  if (action === "propose") return [await buildProposeInstruction(program, signer, core, liveAddress, live.revision, draft.proposal.selectedSlots, draft.proposal.cycle)];
  if (action === "lock") return [await buildLockInstruction(program, signer, core, liveAddress, live.revision, [...live.allocationHash])];
  if (action === "revokeLock") return [await buildRevokeLockInstruction(program, signer, core, liveAddress, live.revision, [...live.allocationHash])];
  if (action === "finalizeCommitOnly") return [await buildFinalizeCommitOnlyInstruction(program, signer, core, liveAddress)];
  throw new Error(`${action} is not a MagicBlock ER action.`);
}

export function FrozenReceipt({core, live, frozen = true}: {core: RoomCore; live: RoomLive; frozen?: boolean}) {
  return <section className="receiptTable" aria-label={frozen ? "Frozen room receipt" : "Authoritative custody projection"}><p className="kicker">{frozen ? "FROZEN AUTHORITATIVE RECEIPT" : "AUTHORITATIVE CUSTODY"}</p><h2>{core.status} · revision {live.revision.toString()}</h2>
    <dl><div><dt>Selected slots</dt><dd>{live.selectedSlots.join(" · ")}</dd></div><div><dt>Cycle / destinations</dt><dd>{live.cycle} · {live.destinations.join(" · ")}</dd></div><div><dt>Allocation hash</dt><dd><code>{short(live.allocationHash)}</code></dd></div><div><dt>Last action</dt><dd>{live.lastAction} by {short(live.lastActor)}</dd></div></dl>
    <div>{core.assets.map((asset, slot) => <article data-custody-slot={slot} key={slot}><strong>Slot {slot}</strong><code>{core.depositedMask & (1 << slot) ? short(asset.mint) : "Not deposited"}</code><small>{assetState(core, slot)}</small></article>)}</div>
    <div className="lockLedger">{(["A", "B", "C"] as const).map((seat, index) => {
      const locked = Boolean(live.lockMask & (1 << index));
      return <div data-lock-row={seat} data-locked={locked} key={seat}><span>Seat {seat}</span><strong>{locked ? `Locked r${live.lockedRevision[index]}` : "Open"}</strong></div>;
    })}</div>
  </section>;
}

function assetState(core: RoomCore, slot: number): string {
  return assetLifecycleLabel(core, slot);
}

function AuthorityBar({projection, stale}: {projection: Projection; stale: boolean}) {
  return <section className="authorityBar" data-stale={stale} aria-label="Room authority">
    <span>Custody · Solana base · {projection.coreSource}</span><span>Negotiation · {sourceAuthority(projection.liveSource)} · {projection.liveSource}</span>
    <span>Delegation · {projection.delegated ? "current ER" : "base"}</span><strong>{stale ? "STALE · WRITES DISABLED" : "FRESH · AUTHORITATIVE"}</strong>
  </section>;
}

export function PendingPanel({pending, recovery, verification, onRefresh, onVerify}: {pending: PendingWrite | null; recovery: SignedIntent | null; verification: string | null; onRefresh(): void; onVerify(): void}) {
  if (!pending) return null;
  const human = pending.error ? humanizeWorkspaceError(pending.error) : null;
  return <section className="pendingPanel"><p role="status" aria-live="polite"><strong>{PENDING_ACTION_LABELS[pending.action]}</strong> · {PENDING_PHASE_LABELS[pending.phase]}</p>
    {pending.signature ? <code>{pending.signature}</code> : null}{pending.evidenceUrl ? <a href={pending.evidenceUrl}>Open Solana base evidence ↗</a> : null}
    {pending.evidence ? <p>Copy the ER signature above, then query <code>getSignatureStatuses</code> at the <a href={pending.evidence.endpoint}>MagicBlock ER RPC endpoint ↗</a>. Solana Explorer is not authoritative for this ER write.</p> : null}
    {human ? <><p role="alert"><strong>{human.summary}</strong> {human.remedy}</p><details><summary>Diagnostic detail</summary><code>{human.raw}</code></details></> : null}
    {verification ? <p role="status" aria-live="polite">{verification}</p> : null}
    {recovery && pending.refreshAuthority ? <button type="button" onClick={onVerify}>Verify signed outcome</button> : null}
    {pending.refreshAuthority ? <button type="button" onClick={onRefresh}>Refresh authority only</button> : null}
  </section>;
}

const PENDING_ACTION_LABELS: Record<PendingAction, string> = {
  initializeRoom: "Create room", depositAsset: "Deposit asset", activateAndDelegate: "Activate collaboration",
  cancelByParticipant: "Cancel room", cancelExpired: "Cancel expired room", settleCommitted: "Settle selected assets",
  returnAsset: "Return asset", propose: "Propose draft", lock: "Lock exact revision",
  revokeLock: "Revoke exact-revision lock", finalizeCommitOnly: "Commit final agreement",
};

const PENDING_PHASE_LABELS: Record<PendingWrite["phase"], string> = {
  "awaiting-wallet": "Awaiting wallet approval", broadcast: "Broadcasting signed transaction",
  "awaiting-authoritative": "Awaiting authoritative state", reconciled: "Authoritative state confirmed",
  "timed-out": "Verification timed out", failed: "Action needs attention",
};

function ErrorNotice({error}: {error: string}) {
  const human = humanizeWorkspaceError(error);
  return <section className="errorNotice"><p role="alert"><strong>{human.summary}</strong> {human.remedy}</p><details><summary>Diagnostic detail</summary><code>{human.raw}</code></details></section>;
}

export default function RoomClient(props: Props) {
  const coreAddress = useMemo(() => new PublicKey(props.room), [props.room]);
  const liveAddress = useMemo(() => livePda(coreAddress)[0], [coreAddress]);
  const [projection, setProjection] = useState<Projection>(() => ({core: props.initialCore, live: props.initialLive,
    coreSource: "server-verified-base", liveSource: props.initialAuthority, delegated: props.initialDelegated ?? props.initialAuthority === "magicblock-er",
    coreObservedAt: props.initialObservedAt, liveObservedAt: props.initialObservedAt}));
  const [draft, setDraft] = useState(() => authorityDraft(props.initialLive));
  const [wallet, setWallet] = useState<WalletState>(() => reduceWallet({status: "disconnected", address: null}, {type: "available"}, props.initialCore.participants, true));
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [mintInputs, setMintInputs] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [rpcReady, setRpcReady] = useState(true);
  const [signedRecovery, setSignedRecovery] = useState<SignedIntent | null>(null);
  const [verification, setVerification] = useState<string | null>(null);
  const walletGeneration = useRef(0);
  const writeMutex = useRef<WriteMutex>({locked: false});
  const refreshAuthority = useRef<() => Promise<void>>(() => Promise.resolve());
  const lastAuthorityAt = useRef({core: props.initialObservedAt, live: props.initialObservedAt});
  const latestAuthority = useRef({core: props.initialCore, live: props.initialLive});
  const liveRef = useRef(projection.live);
  liveRef.current = projection.live;
  const rosterKey = projection.core.participants.map(value => new PublicKey(value).toBase58()).join(":");

  useAuthoritySubscription(coreAddress, liveAddress, setProjection, setRpcReady, refreshAuthority, lastAuthorityAt, latestAuthority);
  useWalletLifecycle(projection.core.participants, rosterKey, walletGeneration, setWallet, setDraft, liveRef, setPending);

  const observedAt = Math.min(projection.coreObservedAt, projection.liveObservedAt);
  const stale = isProjectionStale(observedAt, now);
  const role = deriveWalletRole(wallet.address, projection.core.participants);
  const authorityKind = sourceAuthority(projection.liveSource);
  const authority = {source: authorityKind, delegated: projection.delegated, owner: programId().toBytes(), delegationProgramId: delegationProgramBytes()};
  const ui = deriveRoomUiState({core: projection.core, live: projection.live, role, draft: draft.proposal, authority,
    coreAddress: coreAddress.toBytes(), liveAddress: liveAddress.toBytes(), programId: programId().toBytes(), stale, now: BigInt(Math.floor(now / 1_000))});
  const policy = workspacePolicy(ui, role, stale, isBlockingPending(pending) ? pending!.phase : null, draft);

  useEffect(() => {const clock = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(clock);}, []);
  useEffect(() => {
    setPending(current => current ? reconcileFreshPending(current, projection.core, projection.live, observedAt, now) : null);
  }, [projection, observedAt, now]);
  useEffect(() => {
    const exact = pending?.action === "propose" && pending.phase === "reconciled";
    setDraft(current => reconcileDraft(current, projection.live, exact));
    if (pending?.phase === "reconciled") {releaseWriteMutex(writeMutex.current, "reconciled"); setSignedRecovery(null); setVerification("Exact authoritative postcondition reconciled.");}
  }, [projection.live, pending?.action, pending?.phase]);

  async function connect() {
    const injected = injectedWallet();
    if (!injected) {setWallet(reduceWallet(wallet, {type: "error", error: "Install or open an injected Solana wallet."}, projection.core.participants, true)); return;}
    setWallet(reduceWallet(wallet, {type: "connecting"}, projection.core.participants, false));
    try {const connected = await injected.connect(); setWallet(reduceWallet(wallet, {type: "connected", address: connected.publicKey.toBytes()}, projection.core.participants, false)); setError(null);}
    catch (caught) {const message = caught instanceof Error ? caught.message : String(caught); const declined = /reject|declin|4001/i.test(message); setWallet(reduceWallet(wallet, declined ? {type: "declined", error: message} : {type: "error", error: message}, projection.core.participants, false));}
  }

  async function submit(action: PendingAction, input: ActionInput = {}) {
    if (isBlockingPending(pending) || !acquireWriteMutex(writeMutex.current)) return;
    setPending(null); setError(null); setSignedRecovery(null); setVerification(null);
    let signed = false;
    let knownRejected = false;
    try {
      const injected = injectedWallet(); const snapshot = injected?.publicKey;
      if (!injected || !snapshot) throw new Error("Connect a wallet before submitting this action.");
      assertWalletSnapshot(snapshot.toBase58(), injected.publicKey?.toBase58() ?? null);
      const exactRole = deriveWalletRole(snapshot.toBytes(), projection.core.participants);
      const snapshotNow = Date.now();
      const exactUi = deriveRoomUiState({core: projection.core, live: projection.live, role: exactRole, draft: draft.proposal, authority,
        coreAddress: coreAddress.toBytes(), liveAddress: liveAddress.toBytes(), programId: programId().toBytes(), stale: isProjectionStale(observedAt, snapshotNow), now: BigInt(Math.floor(snapshotNow / 1_000))});
      assertLegalAction(action, exactUi, exactRole, input.slot);
      const adapter = walletAdapter(injected, snapshot, () => {signed = true; setPending(current => current ? {...current, phase: "broadcast", updatedAt: Date.now()} : current);});
      const program = programFor(idl as Idl, adapter);
      const roleIndex = exactRole.kind === "participant" ? exactRole.index : -1;
      const request = buildPendingRequest(action, coreAddress, projection.core, projection.live, roleIndex, draft, input.slot);
      const instructions = actionTransport(action) === "magicblock-er"
        ? await buildErWrite(action, program, snapshot, coreAddress, liveAddress, projection.live, draft)
        : await buildBaseWrite(action, program, snapshot, coreAddress, liveAddress, projection.core, projection.live, input);
      await sendPrepared(action, instructions, adapter, request, setPending, setSignedRecovery);
      setError(null);
    } catch (caught) {knownRejected = handleWriteFailure(caught, signed, null, setPending, setError, setSignedRecovery);}
    finally {releaseWriteMutex(writeMutex.current, signed && !knownRejected ? "signed-pending" : "unsigned-failure");}
  }

  async function verifyOutcome() {
    if (!signedRecovery || !pending) return;
    setVerification("Refreshing authority and checking the exact signed outcome…");
    await refreshAuthority.current();
    const result = await readSignedOutcome(signedRecovery);
    const checkedAt = Date.now();
    const observedAt = Math.min(lastAuthorityAt.current.core, lastAuthorityAt.current.live);
    const freshAuthority = checkedAt - observedAt <= 5_000;
    const exactPostcondition = reconcileFreshPending(pending, latestAuthority.current.core, latestAuthority.current.live, observedAt, checkedAt).phase === "reconciled";
    const decision = resolveSignedOutcome({...result, freshAuthority, exactPostcondition});
    applyVerifiedOutcome(decision, result.status?.err, pending, setPending, writeMutex.current, setVerification);
  }

  const negotiation = projection.core.status === "Active" && projection.live.phase === "Negotiating";
  const editable = negotiation && role.kind === "participant" && !stale && !isBlockingPending(pending);
  const select = (slot: number) => setDraft(current => changeDraft(current, {...current.proposal, selectedSlots: current.proposal.selectedSlots.map((value, index) => Math.floor(slot / 2) === index ? slot : value) as [number, number, number]}, projection.live));
  return <section className="roomWorkspace">
    <div className="workspaceHeader"><div><p className="kicker">LIVE COLLABORATION / {projection.core.status}</p><h1>{projection.live.phase} · revision {projection.live.revision.toString()}</h1></div><WalletControl state={{...wallet, role}} networkReady={rpcReady} onConnect={() => void connect()} /></div>
    <AuthorityBar projection={projection} stale={stale} />
    {negotiation ? <><SharedTable core={projection.core} live={projection.live} draft={draft} editable={editable} onSelect={select} /><ConsentPanel live={projection.live} draft={draft} editable={editable} onCycle={(cycle: Cycle) => setDraft(current => changeDraft(current, {...current.proposal, cycle}, projection.live))} /></> : <FrozenReceipt core={projection.core} live={projection.live} frozen={projection.core.status === "Active" || policy.frozen} />}
    <ActionPanel ui={ui} policy={policy} core={projection.core} live={projection.live} draft={draft} mintInputs={mintInputs} setMintInputs={setMintInputs} submit={submit} rebase={() => setDraft(authorityDraft(projection.live))} refresh={() => refreshAuthority.current()} />
    <PendingPanel pending={pending} recovery={signedRecovery} verification={verification} onRefresh={() => {void refreshAuthority.current();}} onVerify={() => void verifyOutcome()} />
    {wallet.error ? <ErrorNotice error={wallet.error} /> : null}{error && !pending ? <ErrorNotice error={error} /> : null}
  </section>;
}

function useAuthoritySubscription(core: PublicKey, live: PublicKey, setProjection: React.Dispatch<React.SetStateAction<Projection>>, setReady: React.Dispatch<React.SetStateAction<boolean>>, refreshRef: React.MutableRefObject<() => Promise<void>>, lastAuthorityAt: React.MutableRefObject<{core: number; live: number}>, latestAuthority: React.MutableRefObject<{core: RoomCore; live: RoomLive}>) {
  useEffect(() => {
    const stop = subscribeAuthoritative(core, live, (data, source) => {const decoded = decodeRoomCore(data); latestAuthority.current.core = decoded; lastAuthorityAt.current.core = Date.now(); setReady(true); setProjection(current => ({...current, core: decoded, coreSource: source, coreObservedAt: Date.now()}));},
      (data, source) => {const decoded = decodeRoomLive(data); latestAuthority.current.live = decoded; lastAuthorityAt.current.live = Date.now(); setReady(true); setProjection(current => ({...current, live: decoded, liveSource: source, delegated: sourceAuthority(source) === "magicblock-er", liveObservedAt: Date.now()}));}, ready => setReady(ready));
    refreshRef.current = () => stop.refresh();
    return () => {refreshRef.current = () => Promise.resolve(); void stop();};
  }, [core, lastAuthorityAt, latestAuthority, live, refreshRef, setProjection, setReady]);
}

function useWalletLifecycle(participants: RoomCore["participants"], rosterKey: string, generation: React.MutableRefObject<number>, setWallet: React.Dispatch<React.SetStateAction<WalletState>>, setDraft: React.Dispatch<React.SetStateAction<WorkspaceDraft>>, live: React.MutableRefObject<RoomLive>, setPending: React.Dispatch<React.SetStateAction<PendingWrite | null>>) {
  useEffect(() => {
    const injected = injectedWallet(); const id = ++generation.current;
    if (!injected) {setWallet(current => reduceWallet(current, {type: "available"}, participants, true)); return;}
    const apply = (event: WalletEvent) => {setWallet(current => reduceWallet(current, event, participants, false)); if (event.type === "accountChanged" || event.type === "disconnect") {setDraft(authorityDraft(live.current)); setPending(current => current && current.phase !== "awaiting-wallet" ? current : null);}};
    setWallet(current => injected.publicKey ? reduceWallet(current, {type: "connected", address: injected.publicKey!.toBytes()}, participants, false) : reduceWallet(current, {type: "available"}, participants, false));
    if (!injected.on || !injected.removeListener) return;
    return bindWalletEvents(injected as Required<Pick<InjectedWallet, "on" | "removeListener">>, id, () => generation.current, apply);
  }, [generation, live, rosterKey, setDraft, setPending, setWallet]);
}

function delegationProgramBytes(): Uint8Array {
  return DELEGATION_PROGRAM_ID.toBytes();
}

function assertLegalAction(action: PendingAction, ui: ReturnType<typeof deriveRoomUiState>, role: ReturnType<typeof deriveWalletRole>, slot?: number) {
  if (!snapshotActionAllowed(action as RoomAction, ui, role)) throw new Error("That signer cannot execute this action in the current authoritative lifecycle state.");
  if ((action === "depositAsset" || action === "returnAsset") && !ui.slots?.includes(requiredSlot(slot))) throw new Error("That asset slot is not currently eligible.");
}

async function sendPrepared(action: PendingAction, instructions: TransactionInstruction[], wallet: Wallet, request: PendingRequest, setPending: React.Dispatch<React.SetStateAction<PendingWrite | null>>, setRecovery: React.Dispatch<React.SetStateAction<SignedIntent | null>>) {
  let marker = startPending(request, Date.now(), 45_000); setPending(marker);
  const capture = (intent: SignedIntent) => setRecovery(intent);
  const signature = actionTransport(action) === "magicblock-er" ? await sendErWithFallback(wallet, instructions[0], capture) : await sendBaseInstructions(baseConnection(), wallet, instructions, undefined, capture);
  marker = broadcastPending(marker, signature, Date.now());
  setPending(current => current?.phase === "reconciled" ? {...marker, phase: "reconciled"} : awaitAuthoritative(marker, Date.now()));
}

function handleWriteFailure(error: unknown, signed: boolean, previous: PendingWrite | null, setPending: React.Dispatch<React.SetStateAction<PendingWrite | null>>, setError: React.Dispatch<React.SetStateAction<string | null>>, setRecovery: React.Dispatch<React.SetStateAction<SignedIntent | null>>): boolean {
  const signature = ambiguousBroadcastSignature(error);
  const knownRejected = error instanceof SignedTransactionRejectedError;
  if (error instanceof AmbiguousBroadcastError || knownRejected) setRecovery({signature: error.signature, endpoint: error.endpoint, recentBlockhash: error.recentBlockhash, rpcUrl: error.rpcUrl});
  setPending(current => {
    const basis = current ?? previous;
    if (!basis) return null;
    if (knownRejected) return {...failPending(broadcastPending(basis, error.signature, Date.now()), error, Date.now()), refreshAuthority: false};
    return signed ? failureAfterSigning(basis, error, signature, Date.now()) : failPending(basis, error, Date.now());
  });
  setError(error instanceof Error ? error.message : String(error));
  return knownRejected;
}

function applyVerifiedOutcome(decision: ReturnType<typeof resolveSignedOutcome>, statusError: unknown, pending: PendingWrite, setPending: React.Dispatch<React.SetStateAction<PendingWrite | null>>, mutex: WriteMutex, setVerification: React.Dispatch<React.SetStateAction<string | null>>) {
  if (decision.kind === "reconciled") {setPending({...pending, phase: "reconciled", refreshAuthority: false, updatedAt: Date.now()}); releaseWriteMutex(mutex, "reconciled"); setVerification("Exact authoritative postcondition reconciled."); return;}
  if (decision.kind === "landed") {setPending({...pending, phase: "awaiting-authoritative", error: undefined, refreshAuthority: true, timeoutAt: Date.now() + 45_000}); setVerification("The signature landed successfully. Waiting for the exact authoritative postcondition; no retry is allowed."); return;}
  if (decision.kind === "still-pending") {setVerification("Signature is absent, but its blockhash is still valid. Outcome remains pending and locked."); return;}
  if (decision.kind === "inconclusive") {setVerification("Signature status or blockhash validity is unavailable. Outcome remains locked."); return;}
  if (decision.kind === "needs-fresh-authority") {setVerification("The blockhash expired, but authority is not fresh enough to prove non-effect. Outcome remains locked."); return;}
  const message = decision.kind === "known-failed" ? `Signature status proves failure: ${JSON.stringify(statusError)}` : "Signature is absent, its blockhash expired, and fresh authority proves no exact postcondition. This intent had no effect.";
  setPending({...failPending(pending, new Error(message), Date.now()), refreshAuthority: false});
  releaseWriteMutex(mutex, decision.kind === "known-failed" ? "known-failure" : "verified-non-effect"); setVerification(message);
}

type ActionPanelProps = {ui: ReturnType<typeof deriveRoomUiState>; policy: ReturnType<typeof workspacePolicy>; core: RoomCore; live: RoomLive; draft: WorkspaceDraft; mintInputs: Record<number, string>; setMintInputs: React.Dispatch<React.SetStateAction<Record<number, string>>>; submit(action: PendingAction, input?: ActionInput): Promise<void>; rebase(): void; refresh(): void};
function ActionPanel({ui, policy, core, live, draft, mintInputs, setMintInputs, submit, rebase, refresh}: ActionPanelProps) {
  const returns = returnableSlots(core);
  const run = (action: PendingAction, input?: ActionInput) => {
    if (destructive(action) && !window.confirm("Cancel this room? Deposited assets will require separate return transactions.")) return;
    void submit(action, input);
  };
  return <section className="lifecycleActions"><p>{ui.reason}</p><small>{ui.recovery}</small>
    {ui.primary === "depositAsset" ? ui.slots?.map(slot => <div className="depositRow" key={slot}><label htmlFor={`mint-${slot}`}>Slot {slot} immutable classic SPL mint</label><input id={`mint-${slot}`} value={mintInputs[slot] ?? ""} onChange={event => setMintInputs(current => ({...current, [slot]: event.target.value}))} /><button type="button" disabled={!policy.primary.enabled} onClick={() => run("depositAsset", {slot, mint: mintInputs[slot]})}>Deposit slot {slot}</button></div>) : null}
    {ui.primary === "returnAsset" ? returns.map(slot => <button type="button" key={slot} disabled={!policy.primary.enabled} onClick={() => run("returnAsset", {slot})}>Return slot {slot} · {short(core.assets[slot].mint)}</button>) : null}
    {ui.primary === "settleCommitted" ? <p>Three recipient ATAs are prepared idempotently, then the selected three settle together in one Solana base transaction.</p> : null}
    {ui.primary === "refreshAuthority" ? <button type="button" onClick={refresh}>Refresh authority</button> : null}
    {policy.primary.visible && actionable(ui.primary) && !["depositAsset", "returnAsset"].includes(ui.primary) ? <button className="accent" type="button" disabled={!policy.primary.enabled} onClick={() => run(ui.primary as PendingAction)}>{ui.primary === "lock" ? `Lock revision ${live.revision}` : policy.primary.label}</button> : null}
    {policy.alternatives.filter(item => actionable(item.action)).map(item => <button type="button" key={item.action} disabled={!item.enabled} onClick={() => run(item.action as PendingAction)}>{item.action === "revokeLock" ? `Revoke my lock on revision ${live.revision}` : item.label}</button>)}
    {draft.outdated ? <button type="button" onClick={rebase}>Rebase draft to revision {live.revision.toString()}</button> : null}
  </section>;
}

function actionable(action: RoomAction): boolean {
  return ["activateAndDelegate", "cancelByParticipant", "cancelExpired", "propose", "lock", "revokeLock", "finalizeCommitOnly", "settleCommitted"].includes(action);
}

function destructive(action: PendingAction): boolean {
  return action === "cancelByParticipant" || action === "cancelExpired";
}
