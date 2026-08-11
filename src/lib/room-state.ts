import {sha256} from "@noble/hashes/sha256";
import {concatBytes} from "@noble/hashes/utils";

export type AddressBytes = Uint8Array;
export type CoreStatus = "Funding" | "Active" | "Settled" | "Returning" | "Complete" | "Cancelled" | "Closed";
export type LivePhase = "Negotiating" | "Finalizing" | "Finalized";
export type Cycle = "forward" | "reverse";
export type LiveAction = "Initialized" | "Proposed" | "Locked" | "Revoked" | "Finalized";
export type Seat = "A" | "B" | "C";

export type AssetRecord = {
  mint: AddressBytes;
  vault: AddressBytes;
  originalOwner: AddressBytes;
  originalAta: AddressBytes;
  finalAta: AddressBytes;
  depositedAt: bigint;
  flags: number;
};

export type RoomCore = {
  version: number;
  coreBump: number;
  liveBump: number;
  vaultAuthorityBump: number;
  creator: AddressBytes;
  roomNonce: bigint;
  participants: [AddressBytes, AddressBytes, AddressBytes];
  liveRoom: AddressBytes;
  assets: [AssetRecord, AssetRecord, AssetRecord, AssetRecord, AssetRecord, AssetRecord];
  depositedMask: number;
  returnedMask: number;
  selectedMask: number;
  status: CoreStatus;
  createdAt: bigint;
  expiresAt: bigint;
  settledRevision: bigint;
  allocationHash: Uint8Array;
  rentPayer: AddressBytes;
  reserved: Uint8Array;
};

export type RoomLive = {
  version: number;
  bump: number;
  core: AddressBytes;
  participants: [AddressBytes, AddressBytes, AddressBytes];
  expiresAt: bigint;
  revision: bigint;
  selectedSlots: [number, number, number];
  cycle: Cycle;
  destinations: [number, number, number];
  allocationHash: Uint8Array;
  lockedRevision: [bigint, bigint, bigint];
  lockedHash: [Uint8Array, Uint8Array, Uint8Array];
  lockMask: number;
  phase: LivePhase;
  lastActor: AddressBytes;
  lastAction: LiveAction;
  updatedAt: bigint;
  reserved: Uint8Array;
};

export type WalletRole =
  | {kind: "disconnected"}
  | {kind: "participant"; seat: "A"; index: 0}
  | {kind: "participant"; seat: "B"; index: 1}
  | {kind: "participant"; seat: "C"; index: 2}
  | {kind: "observer"};

export type DraftProposal = {selectedSlots: [number, number, number]; cycle: Cycle};
export type Authority = {
  source: "unavailable" | "magicblock-er" | "solana-base";
  delegated: boolean;
  owner: AddressBytes | null;
  delegationProgramId: AddressBytes;
};
export type EvidenceAuthority = "none" | "magicblock-er" | "solana-base" | "both";
export type RoomAction =
  | "refreshAuthority" | "connectWallet" | "depositAsset" | "cancelByParticipant"
  | "activateAndDelegate" | "waitForParticipants" | "cancelExpired" | "propose"
  | "lock" | "revokeLock" | "inspectProposal" | "finalizeCommitOnly"
  | "inspectCommit" | "settleCommitted" | "returnAsset" | "viewReceipt";

export type RoomUiInput = {
  core?: RoomCore;
  live?: RoomLive;
  role: WalletRole;
  draft: DraftProposal;
  authority: Authority;
  coreAddress: AddressBytes;
  liveAddress: AddressBytes;
  programId: AddressBytes;
  stale: boolean;
  now: bigint;
};

export type RoomUiState = {
  primary: RoomAction;
  alternatives: RoomAction[];
  reason: string;
  recovery: string;
  evidenceAuthority: EvidenceAuthority;
  slots?: number[];
};

const CORE_SIZE = 1_350;
const LIVE_SIZE = 420;
const CORE_DISCRIMINATOR = Uint8Array.from([159, 7, 60, 81, 143, 33, 177, 65]);
const LIVE_DISCRIMINATOR = Uint8Array.from([245, 92, 71, 83, 30, 246, 85, 29]);
const CORE_STATUSES: CoreStatus[] = ["Funding", "Active", "Settled", "Returning", "Complete", "Cancelled", "Closed"];
const LIVE_PHASES: LivePhase[] = ["Negotiating", "Finalizing", "Finalized"];
const LIVE_ACTIONS: LiveAction[] = ["Initialized", "Proposed", "Locked", "Revoked", "Finalized"];

function requireSize(data: Uint8Array, size: number, name: string): void {
  if (data.byteLength < size) throw new Error(`${name} requires at least ${size} bytes`);
}

function requireDiscriminator(data: Uint8Array, expected: Uint8Array, name: string): void {
  if (!expected.every((value, index) => data[index] === value)) throw new Error(`invalid ${name} discriminator`);
}

function requireVersion(data: Uint8Array, name: string): void {
  if (data[8] !== 1) throw new Error(`unsupported ${name} version ${data[8]}`);
}

function bytes(data: Uint8Array, offset: number, length = 32): Uint8Array {
  return data.slice(offset, offset + length);
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function readU64(data: Uint8Array, offset: number): bigint {
  return view(data).getBigUint64(offset, true);
}

function readI64(data: Uint8Array, offset: number): bigint {
  return view(data).getBigInt64(offset, true);
}

function enumAt<T>(values: T[], index: number, name: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`unknown ${name} variant ${index}`);
  return value;
}

function decodeAsset(data: Uint8Array, offset: number): AssetRecord {
  return {
    mint: bytes(data, offset),
    vault: bytes(data, offset + 32),
    originalOwner: bytes(data, offset + 64),
    originalAta: bytes(data, offset + 96),
    finalAta: bytes(data, offset + 128),
    depositedAt: readI64(data, offset + 160),
    flags: data[offset + 168],
  };
}

function decodeAssets(data: Uint8Array): RoomCore["assets"] {
  return [0, 1, 2, 3, 4, 5].map(slot => decodeAsset(data, 180 + slot * 169)) as RoomCore["assets"];
}

export function decodeRoomCore(data: Uint8Array): RoomCore {
  requireSize(data, CORE_SIZE, "RoomCore");
  requireDiscriminator(data, CORE_DISCRIMINATOR, "RoomCore");
  requireVersion(data, "RoomCore");
  return {
    version: data[8], coreBump: data[9], liveBump: data[10], vaultAuthorityBump: data[11],
    creator: bytes(data, 12), roomNonce: readU64(data, 44),
    participants: [bytes(data, 52), bytes(data, 84), bytes(data, 116)],
    liveRoom: bytes(data, 148), assets: decodeAssets(data),
    depositedMask: data[1_194], returnedMask: data[1_195], selectedMask: data[1_196],
    status: enumAt(CORE_STATUSES, data[1_197], "CoreStatus"),
    createdAt: readI64(data, 1_198), expiresAt: readI64(data, 1_206),
    settledRevision: readU64(data, 1_214), allocationHash: bytes(data, 1_222),
    rentPayer: bytes(data, 1_254), reserved: bytes(data, 1_286, 64),
  };
}

export function decodeRoomLive(data: Uint8Array): RoomLive {
  requireSize(data, LIVE_SIZE, "RoomLive");
  requireDiscriminator(data, LIVE_DISCRIMINATOR, "RoomLive");
  requireVersion(data, "RoomLive");
  return {
    version: data[8], bump: data[9], core: bytes(data, 10),
    participants: [bytes(data, 42), bytes(data, 74), bytes(data, 106)],
    expiresAt: readI64(data, 138), revision: readU64(data, 146),
    selectedSlots: [data[154], data[155], data[156]],
    cycle: enumAt<Cycle>(["forward", "reverse"], data[157], "Cycle"),
    destinations: [data[158], data[159], data[160]], allocationHash: bytes(data, 161),
    lockedRevision: [readU64(data, 193), readU64(data, 201), readU64(data, 209)],
    lockedHash: [bytes(data, 217), bytes(data, 249), bytes(data, 281)],
    lockMask: data[313], phase: enumAt(LIVE_PHASES, data[314], "LivePhase"),
    lastActor: bytes(data, 315), lastAction: enumAt(LIVE_ACTIONS, data[347], "LiveAction"),
    updatedAt: readI64(data, 348), reserved: bytes(data, 356, 64),
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function deriveWalletRole(wallet: Uint8Array | null, participants: RoomCore["participants"]): WalletRole {
  if (!wallet) return {kind: "disconnected"};
  const index = participants.findIndex(participant => equalBytes(wallet, participant));
  if (index === 0) return {kind: "participant", seat: "A", index};
  if (index === 1) return {kind: "participant", seat: "B", index};
  if (index === 2) return {kind: "participant", seat: "C", index};
  return {kind: "observer"};
}

export function returnableSlots(core: RoomCore): number[] {
  const eligible = core.status === "Cancelled"
    ? core.depositedMask
    : (["Settled", "Returning"] as CoreStatus[]).includes(core.status)
      ? core.depositedMask & ~core.selectedMask
      : 0;
  return [0, 1, 2, 3, 4, 5].filter(slot => (eligible & ~core.returnedMask & (1 << slot)) !== 0);
}

function validSelection(slots: [number, number, number]): boolean {
  return (slots[0] === 0 || slots[0] === 1)
    && (slots[1] === 2 || slots[1] === 3)
    && (slots[2] === 4 || slots[2] === 5);
}

function selectionFunded(slots: [number, number, number], core: RoomCore): boolean {
  return slots.every(slot => Boolean(core.depositedMask & (1 << slot)));
}

function allocationInitialized(live: RoomLive): boolean {
  return live.revision > 0n && live.allocationHash.some(value => value !== 0);
}

function integerBytes(value: bigint, signed: boolean): Uint8Array {
  const data = new Uint8Array(8);
  const target = new DataView(data.buffer);
  if (signed) target.setBigInt64(0, value, true);
  else target.setBigUint64(0, value, true);
  return data;
}

function expectedDestinations(cycle: Cycle): [number, number, number] {
  return cycle === "forward" ? [1, 2, 0] : [2, 0, 1];
}

function protocolAllocationHash(coreAddress: AddressBytes, live: RoomLive): Uint8Array {
  return sha256(concatBytes(
    new TextEncoder().encode("tradetable-allocation-v1"), coreAddress,
    integerBytes(live.revision, false), integerBytes(live.expiresAt, true),
    Uint8Array.from(live.selectedSlots), Uint8Array.from([live.cycle === "forward" ? 0 : 1]),
    Uint8Array.from(expectedDestinations(live.cycle)),
  ));
}

function proposalIntegrity(coreAddress: AddressBytes, live: RoomLive): boolean {
  const destinationsMatch = live.destinations.every((value, index) => value === expectedDestinations(live.cycle)[index]);
  return destinationsMatch && equalBytes(live.allocationHash, protocolAllocationHash(coreAddress, live));
}

function locksMatchAuthority(live: RoomLive): boolean {
  return [0, 1, 2].every(index => !(live.lockMask & (1 << index)) || (
    live.lockedRevision[index] === live.revision && equalBytes(live.lockedHash[index], live.allocationHash)
  ));
}

function canonicalInitialProposal(live: RoomLive): boolean {
  const empty = (value: Uint8Array) => value.every(byte => byte === 0);
  return live.revision === 0n && live.phase === "Negotiating" && live.lastAction === "Initialized"
    && live.selectedSlots.every((slot, index) => slot === index * 2) && live.cycle === "forward"
    && live.destinations.every((value, index) => value === [1, 2, 0][index])
    && empty(live.allocationHash) && live.lockMask === 0
    && live.lockedRevision.every(value => value === 0n) && live.lockedHash.every(empty);
}

export function deriveConsent(draft: DraftProposal, live: RoomLive, role: WalletRole, core: RoomCore, coreAddress: AddressBytes) {
  const sameSlots = draft.selectedSlots.every((slot, index) => slot === live.selectedSlots[index]);
  const conflict = !sameSlots || draft.cycle !== live.cycle;
  const draftValid = validSelection(draft.selectedSlots) && selectionFunded(draft.selectedSlots, core);
  const authorityValid = validSelection(live.selectedSlots) && selectionFunded(live.selectedSlots, core)
    && allocationInitialized(live) && proposalIntegrity(coreAddress, live) && locksMatchAuthority(live);
  const bitLocked = role.kind === "participant" && Boolean(live.lockMask & (1 << role.index));
  const alreadyLocked = bitLocked && authorityValid;
  const lockAllowed = role.kind === "participant" && live.phase === "Negotiating"
    && draftValid && authorityValid && !conflict && !alreadyLocked;
  return {conflict, lockAllowed, alreadyLocked, authorityValid, draftValid};
}

function state(primary: RoomAction, reason: string, evidenceAuthority: EvidenceAuthority, alternatives: RoomAction[] = [], recovery = "Refresh authoritative state before retrying if this state changes.", slots?: number[]): RoomUiState {
  return {primary, alternatives, reason, recovery, evidenceAuthority, slots};
}

function disconnected(reason: string, evidence: EvidenceAuthority = "none"): RoomUiState {
  return state("connectWallet", reason, evidence, [], "Connect a wallet, then re-check authority before submitting.");
}

function fundingState(input: RoomUiInput, core: RoomCore): RoomUiState {
  if (input.now >= core.expiresAt) {
    if (input.role.kind === "disconnected") return disconnected("Expired-room cancellation is permissionless but requires a signer.", "solana-base");
    const alternatives = input.role.kind === "participant" ? ["cancelByParticipant" as RoomAction] : [];
    return state("cancelExpired", "The funding window expired; any connected signer may cancel.", "solana-base", alternatives);
  }
  if (input.role.kind === "disconnected") return disconnected("A signer is required for funding actions.", "solana-base");
  if (input.role.kind !== "participant") return state("waitForParticipants", "Only roster participants can deposit or cancel during Funding.", "solana-base");
  const owned = [input.role.index * 2, input.role.index * 2 + 1];
  const missing = owned.filter(slot => !(core.depositedMask & (1 << slot)));
  if (missing.length) return state("depositAsset", "Deposit the remaining assets assigned to your seat.", "solana-base", ["cancelByParticipant"], undefined, missing);
  if (core.depositedMask === 63) return state("activateAndDelegate", "All six assets are funded; a participant can activate negotiation.", "solana-base", ["cancelByParticipant"]);
  return state("waitForParticipants", "Your deposits are complete; other seats are still funding.", "solana-base", ["cancelByParticipant"]);
}

function negotiatingState(input: RoomUiInput, core: RoomCore, live: RoomLive): RoomUiState {
  if (live.revision === 0n && !canonicalInitialProposal(live)) return state("refreshAuthority", "The revision-zero live state is not the canonical initialized proposal.", "magicblock-er");
  if (input.role.kind === "disconnected") return disconnected("Connect a participant wallet to negotiate.");
  if (input.role.kind !== "participant") return state("inspectProposal", "Observers can inspect but cannot change or lock a proposal.", "magicblock-er");
  if (live.revision === 0n) {
    if (!validSelection(input.draft.selectedSlots) || !selectionFunded(input.draft.selectedSlots, core)) return state("inspectProposal", "Your first draft must select one funded slot from each seat.", "magicblock-er");
    return state("propose", "No authoritative proposal exists yet; submit revision one before any seat can lock.", "magicblock-er");
  }
  const consent = deriveConsent(input.draft, live, input.role, core, input.coreAddress);
  if (!consent.authorityValid) return state("refreshAuthority", "The authoritative proposal or lock set is invalid.", "magicblock-er");
  if (!consent.draftValid) return state("inspectProposal", "Your draft must select one funded slot from each seat.", "magicblock-er");
  if (consent.conflict) return state("propose", "Your local draft differs from the authoritative revision and cannot be locked.", "magicblock-er", consent.alreadyLocked ? ["revokeLock"] : []);
  if (consent.alreadyLocked) return state("revokeLock", "Your seat is locked to the current authoritative revision.", "magicblock-er");
  return state("lock", "Your draft matches the authoritative revision exactly.", "magicblock-er", ["propose"]);
}

function liveLinkValid(input: RoomUiInput, core: RoomCore, live: RoomLive): boolean {
  const addressesMatch = equalBytes(core.liveRoom, input.liveAddress) && equalBytes(live.core, input.coreAddress);
  const rosterMatches = core.participants.every((participant, index) => equalBytes(participant, live.participants[index]));
  const ownerMatches = authorityOwnerValid(input);
  return addressesMatch && rosterMatches && core.expiresAt === live.expiresAt && ownerMatches;
}

function authorityOwnerValid(input: RoomUiInput): boolean {
  const authority = input.authority;
  if (!authority.owner || authority.source === "unavailable") return false;
  if (authority.source === "magicblock-er") {
    return authority.delegated && equalBytes(authority.owner, input.programId);
  }
  const expected = authority.delegated ? authority.delegationProgramId : input.programId;
  return equalBytes(authority.owner, expected);
}

function fullLockSetValid(input: RoomUiInput, core: RoomCore, live: RoomLive): boolean {
  const proposal = {selectedSlots: live.selectedSlots, cycle: live.cycle};
  return live.lockMask === 7 && deriveConsent(proposal, live, {kind: "observer"}, core, input.coreAddress).authorityValid;
}

function finalizedState(input: RoomUiInput, core: RoomCore): RoomUiState {
  if (input.authority.source === "magicblock-er") {
    return state("inspectCommit", "Wait for an undelegated, program-owned finalized account on Solana base.", "magicblock-er", [], "Inspect commit evidence and refresh the base account; cancel only after expiry.");
  }
  if (input.authority.delegated) {
    return state("inspectCommit", "The base snapshot is still delegated and cannot settle yet.", "solana-base", [], "Refresh base delegation status before attempting settlement.");
  }
  if (!input.live || !fullLockSetValid(input, core, input.live)) {
    return state("inspectCommit", "The committed proposal does not contain three exact matching locks.", "solana-base", [], "Refresh the committed account and inspect its lock revisions and hashes.");
  }
  if (input.role.kind === "disconnected") return disconnected("Committed settlement is permissionless but requires a signer.", "solana-base");
  return state("settleCommitted", "The finalized live account is program-owned on base; settlement is permissionless.", "solana-base");
}

function activeState(input: RoomUiInput, core: RoomCore): RoomUiState {
  if (input.now >= core.expiresAt) return input.role.kind === "disconnected"
    ? disconnected("Expired-room cancellation is permissionless but requires a signer.", "solana-base")
    : state("cancelExpired", "The active room expired; settlement is no longer legal and any signer may cancel.", "solana-base");
  if (!input.live || input.authority.source === "unavailable") return state("refreshAuthority", "The authoritative live account is unavailable.", "none", [], "Refresh the authority projection before acting.");
  if (!liveLinkValid(input, core, input.live)) return state("refreshAuthority", "Core, Live, or program-owner linkage is invalid.", "none", [], "Reload both accounts from their authoritative sources.");
  if (input.authority.source === "solana-base" && input.live.phase === "Negotiating") return state("inspectProposal", "The base snapshot is read-only during negotiation.", "solana-base");
  if (input.authority.source === "solana-base" && input.live.phase === "Finalizing") return state("inspectCommit", "The base snapshot cannot execute ER finalization.", "solana-base");
  if (input.live.phase === "Finalized") return finalizedState(input, core);
  if (input.live.phase === "Negotiating") return negotiatingState(input, core, input.live);
  if (!fullLockSetValid(input, core, input.live)) return state("refreshAuthority", "Finalization requires three exact locks on one initialized funded proposal.", "magicblock-er");
  return input.role.kind === "participant"
    ? state("finalizeCommitOnly", "All seats locked; a participant may commit the finalized live state.", "magicblock-er", ["inspectCommit"])
    : input.role.kind === "disconnected"
      ? disconnected("Connect a participant wallet to submit commit-only finalization.", "magicblock-er")
      : state("inspectCommit", "Only a participant may submit the commit-only finalization.", "magicblock-er");
}

function returnState(input: RoomUiInput, core: RoomCore): RoomUiState {
  const slots = returnableSlots(core);
  if (!slots.length && core.status === "Cancelled") return state("viewReceipt", "No deposited assets remain to return from this cancelled room.", "solana-base", [], "No recovery action is required; open the base receipt for evidence.");
  if (!slots.length) return state("refreshAuthority", "No unreturned eligible asset is visible yet.", "solana-base", [], "Refresh the base account projection.");
  if (input.role.kind === "disconnected") return disconnected("Returning an asset is permissionless but still requires a signer.", "solana-base");
  const reason = core.status === "Cancelled"
    ? "Any signer may return each deposited, unreturned asset from the cancelled room."
    : "Any signer may return each unselected asset in a separate base transaction.";
  return state("returnAsset", reason, "solana-base", [], undefined, slots);
}

export function deriveRoomUiState(input: RoomUiInput): RoomUiState {
  const core = input.core;
  if (!core) return state("refreshAuthority", "RoomCore is unavailable.", "none", [], "Check the room address and refresh Solana base state.");
  if (["Complete", "Closed"].includes(core.status)) {
    const evidence = core.status === "Complete" ? "both" : "solana-base";
    return state("viewReceipt", "The room lifecycle is complete; writes are closed.", evidence);
  }
  if (input.stale) return state("refreshAuthority", "The authority projection is stale, so writes are disabled.", "none", [], "Refresh the authoritative account state before acting.");
  if (core.status === "Funding") return fundingState(input, core);
  if (core.status === "Active") return activeState(input, core);
  if (["Settled", "Returning", "Cancelled"].includes(core.status)) return returnState(input, core);
  return state("refreshAuthority", "The room state has no legal write action.", "none");
}
