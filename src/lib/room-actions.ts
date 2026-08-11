import {type Program} from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {PublicKey, SystemProgram, type TransactionInstruction} from "@solana/web3.js";

import type {CoreStatus, Cycle, LivePhase, RoomCore, RoomLive} from "./room-state";
import {ER_RPC, ER_VALIDATOR, allocationHash, bn, destinationAta, explorerTx, livePda, roomPda, vaultAta, vaultAuthorityPda} from "./tradetable";

type Bytes = Uint8Array | readonly number[];
type AccountSnapshot = {
  core?: RoomCore;
  live?: RoomLive;
  coreAddress?: Bytes;
  liveAddress?: Bytes;
};

export type PendingExpectation =
  | {kind: "proposal"; revision: bigint; selectedSlots: readonly number[]; cycle: Cycle; allocationHash: Bytes}
  | {kind: "lock"; actorIndex: number; revision: bigint; allocationHash: Bytes}
  | {kind: "revoke"; actorIndex: number; revision: bigint; allocationHash: Bytes}
  | {kind: "phase"; phase: LivePhase}
  | {kind: "status"; status: CoreStatus}
  | {kind: "mask"; field: "depositedMask" | "returnedMask" | "selectedMask" | "lockMask"; value: number}
  | {kind: "return"; slot: number}
  | {kind: "settlement"; selectedMask: number; revision: bigint; allocationHash: Bytes}
  | {kind: "room-initialized"; coreAddress: Bytes; liveAddress: Bytes};

export type PendingAction =
  | "initializeRoom" | "depositAsset" | "activateAndDelegate" | "cancelByParticipant" | "cancelExpired"
  | "settleCommitted" | "returnAsset" | "propose" | "lock" | "revokeLock" | "finalizeCommitOnly";
type Expectation<K extends PendingExpectation["kind"]> = Extract<PendingExpectation, {kind: K}>;
export type PendingExpectationByAction = {
  initializeRoom: Expectation<"room-initialized">;
  depositAsset: Expectation<"mask"> & {field: "depositedMask"};
  activateAndDelegate: Expectation<"status"> & {status: "Active"};
  propose: Expectation<"proposal">;
  lock: Expectation<"lock">;
  revokeLock: Expectation<"revoke">;
  finalizeCommitOnly: Expectation<"phase"> & {phase: "Finalized"};
  settleCommitted: Expectation<"settlement">;
  cancelByParticipant: Expectation<"status"> & {status: "Cancelled"};
  cancelExpired: Expectation<"status"> & {status: "Cancelled"};
  returnAsset: Expectation<"return">;
};
export type PendingRequest = {[Action in PendingAction]: {
  action: Action;
  expectation: PendingExpectationByAction[Action];
}}[PendingAction];
export type PendingNetwork = "magicblock-er" | "solana-base";
export type PendingPhase = "awaiting-wallet" | "broadcast" | "awaiting-authoritative" | "reconciled" | "timed-out" | "failed";
type PendingMetadata = {
  phase: PendingPhase;
  startedAt: number;
  updatedAt: number;
  timeoutAt: number;
  signature?: string;
  network?: PendingNetwork;
  evidenceUrl?: string;
  evidence?: {kind: "raw-er-signature"; endpoint: string};
  error?: string;
  refreshAuthority: boolean;
  canBlindRetry: false;
};
export type PendingWrite = PendingRequest & PendingMetadata;

type SettlementLeg = {slot: number; mint: PublicKey; vault: PublicKey; recipient: PublicKey; destination: PublicKey};

const publicKey = (value: Bytes) => new PublicKey(Uint8Array.from(value));
const equalBytes = (left: Bytes, right: Bytes) => left.length === right.length && Array.from(left).every((value, index) => value === right[index]);
const equalNumbers = (left: readonly number[], right: readonly number[]) => left.length === right.length && left.every((value, index) => value === right[index]);

export async function buildInitializeRoomInstruction(program: Program, creator: PublicKey, nonce: bigint, participants: [PublicKey, PublicKey, PublicKey], expiresAt: bigint) {
  const [core] = roomPda(creator, nonce);
  const [live] = livePda(core);
  const [vaultAuthority] = vaultAuthorityPda(core);
  const instruction = await program.methods.initializeRoom(bn(nonce), participants, bn(expiresAt)).accounts({
    creator, roomCore: core, roomLive: live, vaultAuthority, systemProgram: SystemProgram.programId,
  }).instruction();
  return {instruction, core, live};
}

export async function buildDepositAssetInstruction(program: Program, participant: PublicKey, core: PublicKey, mint: PublicKey, slot: number) {
  const [vaultAuthority] = vaultAuthorityPda(core);
  const source = getAssociatedTokenAddressSync(mint, participant);
  return program.methods.depositAsset(slot).accounts({
    participant, roomCore: core, vaultAuthority, mint, source, vault: vaultAta(core, mint),
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
}

export async function buildActivateAndDelegateLiveInstruction(program: Program, participant: PublicKey, core: PublicKey, live: PublicKey) {
  const accounts = {
    participant, roomCore: core,
    bufferRoomLive: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(live, program.programId),
    delegationRecordRoomLive: delegationRecordPdaFromDelegatedAccount(live),
    delegationMetadataRoomLive: delegationMetadataPdaFromDelegatedAccount(live), roomLive: live,
    ownerProgram: program.programId, delegationProgram: DELEGATION_PROGRAM_ID, systemProgram: SystemProgram.programId,
  };
  return program.methods.activateAndDelegateLive().accounts(accounts).remainingAccounts([
    {pubkey: ER_VALIDATOR, isSigner: false, isWritable: false},
  ]).instruction();
}

function mutateAccounts(actor: PublicKey, core: PublicKey, live: PublicKey) {
  return {actor, roomCore: core, roomLive: live};
}

export async function buildProposeInstruction(program: Program, actor: PublicKey, core: PublicKey, live: PublicKey, revision: bigint, slots: [number, number, number], cycle: Cycle) {
  const encodedCycle = cycle === "forward" ? {forward: {}} : {reverse: {}};
  return program.methods.propose(bn(revision), slots, encodedCycle).accounts(mutateAccounts(actor, core, live)).instruction();
}

export async function buildLockInstruction(program: Program, actor: PublicKey, core: PublicKey, live: PublicKey, revision: bigint, hash: number[]) {
  return program.methods.lock(bn(revision), hash).accounts(mutateAccounts(actor, core, live)).instruction();
}

export async function buildRevokeLockInstruction(program: Program, actor: PublicKey, core: PublicKey, live: PublicKey, revision: bigint, hash: number[]) {
  return program.methods.revokeLock(bn(revision), hash).accounts(mutateAccounts(actor, core, live)).instruction();
}

// The composed `finalize` and Magic Action `settle_action` are intentionally not wallet-callable exports.
export async function buildFinalizeCommitOnlyInstruction(program: Program, payer: PublicKey, core: PublicKey, live: PublicKey) {
  return program.methods.finalizeCommitOnly().accounts({payer, roomCore: core, roomLive: live}).instruction();
}

export async function buildCancelByParticipantInstruction(program: Program, participant: PublicKey, core: PublicKey) {
  return program.methods.cancelByParticipant().accounts({participant, roomCore: core}).instruction();
}

export async function buildCancelExpiredInstruction(program: Program, caller: PublicKey, core: PublicKey) {
  return program.methods.cancelExpired().accounts({caller, roomCore: core}).instruction();
}

function validateSettlementLinkage(coreAddress: PublicKey, liveAddress: PublicKey, core: RoomCore, live: RoomLive) {
  if (!roomPda(publicKey(core.creator), core.roomNonce)[0].equals(coreAddress)) throw new Error("invalid canonical core PDA");
  if (!livePda(coreAddress)[0].equals(liveAddress)) throw new Error("invalid canonical live PDA");
  if (!equalBytes(live.core, coreAddress.toBytes())) throw new Error("invalid live-to-core linkage");
  if (!equalBytes(core.liveRoom, liveAddress.toBytes())) throw new Error("invalid core-to-live linkage");
  if (!core.participants.every((owner, index) => equalBytes(owner, live.participants[index]))) throw new Error("invalid participant linkage");
  if (core.expiresAt !== live.expiresAt) throw new Error("invalid expiry linkage");
}

function validateSettlementState(coreAddress: PublicKey, core: RoomCore, live: RoomLive, now: bigint) {
  if (core.status !== "Active") throw new Error("settlement requires Core Active");
  if (now >= core.expiresAt) throw new Error("settlement room is expired");
  if (live.phase !== "Finalized") throw new Error("settlement requires Live Finalized");
  if (live.lockMask !== 7) throw new Error("settlement requires the exact lock mask");
  const locksMatch = live.lockedRevision.every(value => value === live.revision)
    && live.lockedHash.every(value => equalBytes(value, live.allocationHash));
  if (!locksMatch) throw new Error("settlement locked revision or hash mismatch");
  const expectedHash = allocationHash(coreAddress, live.revision, live.expiresAt, live.selectedSlots, live.cycle);
  if (!equalBytes(live.allocationHash, expectedHash)) throw new Error("invalid settlement allocation hash");
}

function validateSelection(core: RoomCore, live: RoomLive) {
  const valid = live.selectedSlots.every((slot, owner) => slot === owner * 2 || slot === owner * 2 + 1);
  if (!valid) throw new Error("settlement must select one slot per participant");
  if (!live.selectedSlots.every(slot => Boolean(core.depositedMask & (1 << slot)))) throw new Error("selected settlement slot is not funded");
  const expected = live.cycle === "forward" ? [1, 2, 0] : [2, 0, 1];
  if (!equalNumbers(live.destinations, expected)) throw new Error("invalid destination linkage");
}

function settlementLegs(coreAddress: PublicKey, core: RoomCore, live: RoomLive): [SettlementLeg, SettlementLeg, SettlementLeg] {
  const legs = live.selectedSlots.map((slot, leg) => {
    if (!(core.depositedMask & (1 << slot))) throw new Error(`selected slot ${slot} is not deposited`);
    const asset = core.assets[slot];
    const mint = publicKey(asset.mint);
    const vault = publicKey(asset.vault);
    if (!vault.equals(vaultAta(coreAddress, mint))) throw new Error(`slot ${slot} does not use its canonical vault`);
    if (!equalBytes(asset.originalOwner, core.participants[Math.floor(slot / 2)])) throw new Error(`slot ${slot} owner linkage is invalid`);
    const recipient = publicKey(core.participants[live.destinations[leg]]);
    return {slot, mint, vault, recipient, destination: destinationAta(recipient, mint)};
  });
  return legs as [SettlementLeg, SettlementLeg, SettlementLeg];
}

function settlementAccounts(caller: PublicKey, core: PublicKey, live: PublicKey, legs: SettlementLeg[]) {
  const accounts: Record<string, PublicKey> = {
    caller, roomCore: core, roomLive: live, vaultAuthority: vaultAuthorityPda(core)[0], tokenProgram: TOKEN_PROGRAM_ID,
  };
  legs.forEach((leg, index) => {
    accounts[`mint${index}`] = leg.mint;
    accounts[`vault${index}`] = leg.vault;
    accounts[`destination${index}`] = leg.destination;
  });
  return accounts;
}

export async function buildSettleCommittedInstructions(program: Program, caller: PublicKey, coreAddress: PublicKey, liveAddress: PublicKey, core: RoomCore, live: RoomLive, now: bigint) {
  validateSettlementLinkage(coreAddress, liveAddress, core, live);
  validateSettlementState(coreAddress, core, live, now);
  validateSelection(core, live);
  const legs = settlementLegs(coreAddress, core, live);
  const preparationInstructions = legs.map(leg => createAssociatedTokenAccountIdempotentInstruction(
    caller, leg.destination, leg.recipient, leg.mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  ));
  const settlementInstruction = await program.methods.settleCommitted().accounts(
    settlementAccounts(caller, coreAddress, liveAddress, legs),
  ).instruction();
  return {preparationInstructions, settlementInstruction, instructions: [...preparationInstructions, settlementInstruction], legs};
}

export async function buildReturnAssetInstruction(program: Program, caller: PublicKey, coreAddress: PublicKey, core: RoomCore, slot: number) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= core.assets.length) throw new Error("return slot is out of range");
  if (!roomPda(publicKey(core.creator), core.roomNonce)[0].equals(coreAddress)) throw new Error("invalid canonical core PDA");
  const asset = core.assets[slot];
  validateReturnState(coreAddress, core, slot, asset);
  return program.methods.returnAsset(slot).accounts({
    caller, roomCore: coreAddress, vaultAuthority: vaultAuthorityPda(coreAddress)[0],
    mint: publicKey(asset.mint), vault: publicKey(asset.vault), originalOwner: publicKey(asset.originalOwner),
    originalAta: publicKey(asset.originalAta), tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).instruction();
}

function validateReturnState(coreAddress: PublicKey, core: RoomCore, slot: number, asset: RoomCore["assets"][number]) {
  if (!(["Cancelled", "Settled", "Returning"] as CoreStatus[]).includes(core.status)) throw new Error("invalid return status");
  if (!(core.depositedMask & (1 << slot)) || !(asset.flags & 1)) throw new Error("asset is not deposited");
  if ((core.returnedMask & (1 << slot)) || (asset.flags & 8)) throw new Error("asset is already returned");
  if (core.status !== "Cancelled" && core.selectedMask & (1 << slot)) throw new Error("selected asset cannot return");
  if (asset.flags & 4) throw new Error("transferred asset cannot return");
  const mint = publicKey(asset.mint);
  if (!publicKey(asset.vault).equals(vaultAta(coreAddress, mint))) throw new Error("invalid canonical vault");
  const owner = publicKey(core.participants[Math.floor(slot / 2)]);
  if (!publicKey(asset.originalOwner).equals(owner)) throw new Error("invalid original owner");
  if (!publicKey(asset.originalAta).equals(getAssociatedTokenAddressSync(mint, owner))) throw new Error("invalid canonical original ATA");
}

export function startPending(request: PendingRequest, now: number, timeoutMs: number): PendingWrite {
  if (timeoutMs <= 0) throw new Error("pending timeout must be positive");
  return {...request, phase: "awaiting-wallet", startedAt: now, updatedAt: now, timeoutAt: now + timeoutMs, refreshAuthority: false, canBlindRetry: false};
}

const ACTION_NETWORK: Record<PendingAction, PendingNetwork> = {
  initializeRoom: "solana-base", depositAsset: "solana-base", activateAndDelegate: "solana-base",
  cancelByParticipant: "solana-base", cancelExpired: "solana-base", settleCommitted: "solana-base",
  returnAsset: "solana-base", propose: "magicblock-er", lock: "magicblock-er", revokeLock: "magicblock-er",
  finalizeCommitOnly: "magicblock-er",
};

export function broadcastPending(pending: PendingWrite, signature: string, now: number): PendingWrite {
  const network = ACTION_NETWORK[pending.action];
  const evidence = network === "magicblock-er" ? {kind: "raw-er-signature" as const, endpoint: ER_RPC} : undefined;
  return {...pending, phase: "broadcast", signature, network, updatedAt: now, evidence,
    evidenceUrl: network === "solana-base" ? explorerTx(signature) : undefined};
}

export function awaitAuthoritative(pending: PendingWrite, now: number): PendingWrite {
  return {...pending, phase: "awaiting-authoritative", updatedAt: now};
}

function lockExpectationMet(expectation: Extract<PendingExpectation, {kind: "lock" | "revoke"}>, live?: RoomLive) {
  if (!live || live.revision !== expectation.revision || !equalBytes(live.allocationHash, expectation.allocationHash)) return false;
  const locked = Boolean(live.lockMask & (1 << expectation.actorIndex));
  if (expectation.kind === "revoke") return !locked;
  return locked && live.lockedRevision[expectation.actorIndex] === expectation.revision
    && equalBytes(live.lockedHash[expectation.actorIndex], expectation.allocationHash);
}

function expectationMet(expectation: PendingExpectation, snapshot: AccountSnapshot): boolean {
  const {core, live} = snapshot;
  if (expectation.kind === "proposal") return Boolean(live && live.revision === expectation.revision && live.cycle === expectation.cycle
    && equalNumbers(live.selectedSlots, expectation.selectedSlots) && equalBytes(live.allocationHash, expectation.allocationHash));
  if (expectation.kind === "lock" || expectation.kind === "revoke") return lockExpectationMet(expectation, live);
  if (expectation.kind === "phase") return live?.phase === expectation.phase;
  if (expectation.kind === "status") return core?.status === expectation.status;
  if (expectation.kind === "settlement") return Boolean(core && ["Settled", "Returning", "Complete"].includes(core.status)
    && core.selectedMask === expectation.selectedMask && core.settledRevision === expectation.revision
    && equalBytes(core.allocationHash, expectation.allocationHash));
  if (expectation.kind === "return") return Boolean(core && core.returnedMask & (1 << expectation.slot));
  if (expectation.kind === "room-initialized") return Boolean(core && live && snapshot.coreAddress && snapshot.liveAddress
    && equalBytes(snapshot.coreAddress, expectation.coreAddress) && equalBytes(snapshot.liveAddress, expectation.liveAddress));
  return expectation.field === "lockMask" ? live?.lockMask === expectation.value : core?.[expectation.field] === expectation.value;
}

export function reconcilePending(pending: PendingWrite, snapshot: AccountSnapshot, now: number): PendingWrite {
  if (expectationMet(pending.expectation, snapshot)) return {...pending, phase: "reconciled", updatedAt: now, refreshAuthority: false};
  if (now < pending.timeoutAt) return pending;
  return {...pending, phase: "timed-out", updatedAt: now, refreshAuthority: true, canBlindRetry: false};
}

export function failPending(pending: PendingWrite, error: unknown, now: number): PendingWrite {
  const message = error instanceof Error ? error.message : String(error);
  return {...pending, phase: "failed", error: message, updatedAt: now, refreshAuthority: Boolean(pending.signature), canBlindRetry: false};
}
