import type {PendingAction, PendingNetwork, PendingPhase, PendingWrite} from "./room-actions";
import {broadcastPending, failPending, reconcilePending} from "./room-actions";
import {deriveWalletRole, type DraftProposal, type RoomAction, type RoomCore, type RoomLive, type RoomUiState, type WalletRole} from "./room-state";

export type WalletStatus = "unavailable" | "disconnected" | "connecting" | "connected" | "declined" | "error" | "account-changed";
export type WalletState = {
  status: WalletStatus;
  address: Uint8Array | null;
  role: WalletRole;
  clearLocalIntent: boolean;
  preserveSignedPending: boolean;
  error?: string;
};
export type WalletEvent =
  | {type: "available"} | {type: "connecting"} | {type: "declined"; error?: string}
  | {type: "error"; error: string} | {type: "connected" | "accountChanged"; address: Uint8Array}
  | {type: "disconnect"};

export type WorkspaceDraft = {
  proposal: DraftProposal;
  baseRevision: bigint;
  baseHash: Uint8Array;
  dirty: boolean;
  outdated: boolean;
  conflict: boolean;
};

type WalletEmitter = {
  on(event: "accountChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
  removeListener(event: "accountChanged" | "disconnect", listener: (...args: unknown[]) => void): void;
};

const sameBytes = (left: Uint8Array, right: Uint8Array) => left.length === right.length
  && left.every((value, index) => value === right[index]);

function walletResult(status: WalletStatus, address: Uint8Array | null, participants: RoomCore["participants"], clear = false, error?: string): WalletState {
  return {status, address, role: deriveWalletRole(address, participants), clearLocalIntent: clear, preserveSignedPending: clear, error};
}

export function reduceWallet(current: Pick<WalletState, "status" | "address">, event: WalletEvent, participants: RoomCore["participants"], unavailable: boolean): WalletState {
  if (unavailable) return walletResult("unavailable", null, participants);
  if (event.type === "available") return walletResult("disconnected", null, participants);
  if (event.type === "connecting") return walletResult("connecting", current.address, participants);
  if (event.type === "declined") return walletResult("declined", null, participants, false, event.error);
  if (event.type === "error") return walletResult("error", current.address, participants, false, event.error);
  if (event.type === "disconnect") return walletResult("disconnected", null, participants, true);
  return walletResult(event.type === "accountChanged" ? "account-changed" : "connected", event.address, participants, event.type === "accountChanged");
}

export function bindWalletEvents(wallet: WalletEmitter, generation: number, currentGeneration: () => number, onEvent: (event: WalletEvent) => void): () => void {
  const active = () => generation === currentGeneration();
  const account = (...args: unknown[]) => { if (active()) onEvent(args[0] ? {type: "accountChanged", address: publicKeyBytes(args[0])} : {type: "disconnect"}); };
  const disconnect = () => { if (active()) onEvent({type: "disconnect"}); };
  wallet.on("accountChanged", account); wallet.on("disconnect", disconnect);
  return () => { wallet.removeListener("accountChanged", account); wallet.removeListener("disconnect", disconnect); };
}

function publicKeyBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === "object" && "toBytes" in value) return (value as {toBytes(): Uint8Array}).toBytes();
  throw new Error("Wallet emitted an invalid account.");
}

export function walletLabel(state: WalletState): string {
  if (state.status === "unavailable") return "Install wallet";
  if (state.status === "connecting") return "Connecting…";
  if (state.status === "declined") return "Approval declined";
  if (state.status === "error") return "Wallet error";
  if (state.status === "account-changed") return `Account changed · ${state.role.kind === "participant" ? `Participant ${state.role.seat}` : "Observer"}`;
  if (state.status === "disconnected" && state.clearLocalIntent) return "Disconnected";
  if (state.role.kind === "participant") return `Participant ${state.role.seat}`;
  if (state.role.kind === "observer") return "Observer";
  return "Connect wallet";
}

export type WriteMutex = {locked: boolean};
export function acquireWriteMutex(mutex: WriteMutex): boolean {
  if (mutex.locked) return false;
  mutex.locked = true; return true;
}

export type WriteResolution = "unsigned-failure" | "known-failure" | "verified-non-effect" | "reconciled" | "signed-pending";
export function releaseWriteMutex(mutex: WriteMutex, outcome: WriteResolution): void {
  if (outcome !== "signed-pending") mutex.locked = false;
}

export function authorityDraft(live: RoomLive): WorkspaceDraft {
  return {proposal: {selectedSlots: [...live.selectedSlots], cycle: live.cycle}, baseRevision: live.revision,
    baseHash: new Uint8Array(live.allocationHash), dirty: false, outdated: false, conflict: false};
}

function sameProposal(left: DraftProposal, right: DraftProposal): boolean {
  return left.cycle === right.cycle && left.selectedSlots.every((slot, index) => slot === right.selectedSlots[index]);
}

export function changeDraft(current: WorkspaceDraft, proposal: DraftProposal, live: RoomLive): WorkspaceDraft {
  const authority = {selectedSlots: live.selectedSlots, cycle: live.cycle};
  return {...current, proposal, dirty: !sameProposal(proposal, authority), conflict: !sameProposal(proposal, authority)};
}

export function reconcileDraft(current: WorkspaceDraft, live: RoomLive, exactProposalReconciled: boolean): WorkspaceDraft {
  if (!current.dirty || exactProposalReconciled) return authorityDraft(live);
  const authorityChanged = current.baseRevision !== live.revision || !sameBytes(current.baseHash, live.allocationHash);
  return {...current, outdated: current.outdated || authorityChanged, conflict: true};
}

export type SeatRadioGroup = {seat: "A" | "B" | "C"; name: string; options: {slot: number; checked: boolean}[]};
export function seatRadioModel(selectedSlots: [number, number, number]): SeatRadioGroup[] {
  return (["A", "B", "C"] as const).map((seat, index) => ({seat, name: `seat-${seat}-selection`, options: [index * 2, index * 2 + 1].map(slot => ({slot, checked: selectedSlots[index] === slot}))}));
}

const LABELS: Record<RoomUiState["primary"], string> = {
  refreshAuthority: "Refresh authority", connectWallet: "Connect wallet", depositAsset: "Deposit asset",
  cancelByParticipant: "Cancel room", activateAndDelegate: "Activate negotiation", waitForParticipants: "Waiting for participants",
  cancelExpired: "Cancel expired room", propose: "Propose this draft", lock: "Lock revision", revokeLock: "Revoke my lock",
  inspectProposal: "Inspect authoritative proposal", finalizeCommitOnly: "Commit final agreement", inspectCommit: "Inspect commit evidence",
  settleCommitted: "Settle selected three", returnAsset: "Return eligible asset", viewReceipt: "View final receipt",
};

export function workspacePolicy(ui: RoomUiState, role: WalletRole, stale: boolean, pending: PendingPhase | null, draft?: WorkspaceDraft) {
  const conflictLock = ui.primary === "lock" && Boolean(draft?.conflict || draft?.outdated);
  const passive = ["waitForParticipants", "inspectProposal", "inspectCommit", "viewReceipt", "refreshAuthority"].includes(ui.primary);
  const canWrite = !stale && !pending && role.kind !== "disconnected";
  const enabled = canWrite && !passive;
  return {primary: {action: ui.primary, label: LABELS[ui.primary], visible: !conflictLock, enabled},
    alternatives: ui.alternatives.map(action => ({action, label: LABELS[action], enabled: canWrite})), frozen: ui.primary === "viewReceipt"};
}

const ER_ACTIONS: PendingAction[] = ["propose", "lock", "revokeLock", "finalizeCommitOnly"];
export function actionTransport(action: PendingAction): PendingNetwork {
  return ER_ACTIONS.includes(action) ? "magicblock-er" : "solana-base";
}

const PARTICIPANT_ACTIONS: RoomAction[] = ["depositAsset", "cancelByParticipant", "activateAndDelegate", "propose", "lock", "revokeLock", "finalizeCommitOnly"];
export function snapshotActionAllowed(action: RoomAction, ui: RoomUiState, role: WalletRole): boolean {
  if (![ui.primary, ...ui.alternatives].includes(action)) return false;
  if (role.kind === "disconnected") return false;
  return !PARTICIPANT_ACTIONS.includes(action) || role.kind === "participant";
}

export function reconcileFreshPending(pending: PendingWrite, core: RoomCore, live: RoomLive, observedAt: number, now: number): PendingWrite {
  if (now - observedAt > 5_000) return reconcilePending(pending, {}, now);
  return reconcilePending(pending, {core, live}, now);
}

export function failureAfterSigning(pending: PendingWrite, error: unknown, signature: string | null, now: number): PendingWrite {
  const broadcast = signature ? broadcastPending(pending, signature, now) : pending;
  return {...failPending(broadcast, error, now), refreshAuthority: true, canBlindRetry: false};
}

export function assertDepositMintUnique(core: RoomCore, mint: Uint8Array, targetSlot: number): void {
  const duplicate = core.assets.findIndex((asset, slot) => slot !== targetSlot && Boolean(core.depositedMask & (1 << slot)) && sameBytes(asset.mint, mint));
  if (duplicate >= 0) throw new Error(`This mint is already deposited in slot ${duplicate}.`);
}

export function assetLifecycleLabel(core: RoomCore, slot: number): string {
  if (!(core.depositedMask & (1 << slot))) return core.status === "Funding" ? "Not deposited · Awaiting funding" : "Not deposited";
  if (core.returnedMask & (1 << slot)) return "Deposited · Returned";
  const selected = Boolean(core.selectedMask & (1 << slot));
  if (core.status === "Funding") return "Deposited · In custody · Awaiting activation";
  if (core.status === "Active") return selected ? "Deposited · Selected proposal slot · Not settled" : "Deposited · In custody · Not settled";
  if (core.status === "Cancelled") return "Deposited · Cancelled · Eligible to return";
  if (selected && ["Settled", "Returning", "Complete", "Closed"].includes(core.status)) return "Deposited · Selected · Settled";
  if (["Settled", "Returning"].includes(core.status)) return "Deposited · Unselected · Eligible to return";
  return "Deposited · In custody";
}

export function humanizeWorkspaceError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  if (/reject|declin|4001/i.test(raw)) return {summary: "Wallet approval declined.", remedy: "Approve the request in your wallet when you are ready.", raw};
  if (/stale|authority|reconcil/i.test(raw)) return {summary: "Authoritative state is not current.", remedy: "Refresh authority and verify the exact room state before acting.", raw};
  if (/account changed|signer|participant|roster/i.test(raw)) return {summary: "The connected signer cannot perform this action.", remedy: "Use the intended participant account or choose a legal permissionless action.", raw};
  if (/mint|token|vault|ata/i.test(raw)) return {summary: "The asset failed custody preflight.", remedy: "Check the immutable classic SPL mint and its canonical token account.", raw};
  return {summary: "The transaction could not be completed.", remedy: "Review the diagnostic detail, then refresh authoritative state before deciding what to do.", raw};
}

export type SignedStatus = {err: unknown} | null;
export function resolveSignedOutcome(input: {status: SignedStatus; blockhashValid: boolean | null; freshAuthority: boolean; exactPostcondition: boolean}) {
  if (input.exactPostcondition) return {kind: "reconciled" as const, release: true};
  if (input.status?.err) return {kind: "known-failed" as const, release: true};
  if (input.status && !input.status.err) return {kind: "landed" as const, release: false};
  if (input.blockhashValid === true) return {kind: "still-pending" as const, release: false};
  if (input.blockhashValid === null) return {kind: "inconclusive" as const, release: false};
  if (!input.freshAuthority) return {kind: "needs-fresh-authority" as const, release: false};
  return {kind: "verified-non-effect" as const, release: true};
}
