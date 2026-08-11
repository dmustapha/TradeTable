import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

import {BN, BorshInstructionCoder, type Idl, type Program, type Wallet} from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationMetadataPdaFromDelegatedAccount,
  delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync} from "@solana/spl-token";
import {Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, type VersionedTransaction} from "@solana/web3.js";

import idl from "../../src/idl/tradetable.json";
import {
  awaitAuthoritative,
  buildActivateAndDelegateLiveInstruction,
  buildCancelByParticipantInstruction,
  buildCancelExpiredInstruction,
  buildDepositAssetInstruction,
  buildFinalizeCommitOnlyInstruction,
  buildInitializeRoomInstruction,
  buildLockInstruction,
  buildProposeInstruction,
  buildReturnAssetInstruction,
  buildRevokeLockInstruction,
  buildSettleCommittedInstructions,
  broadcastPending,
  failPending,
  reconcilePending,
  startPending,
  type PendingRequest,
} from "../../src/lib/room-actions";
import type {RoomCore, RoomLive} from "../../src/lib/room-state";
import {AmbiguousBroadcastError, SignedTransactionRejectedError, allocationHash, ambiguousBroadcastSignature, destinationAta, ER_RPC, ER_VALIDATOR, explorerTx, livePda, programFor, roomPda, sendBase, sendBaseInstructions, sendErWithTransport, vaultAta, vaultAuthorityPda} from "../../src/lib/tradetable";

process.env.NEXT_PUBLIC_PROGRAM_ID = idl.address;

const signer = Keypair.generate();
const wallet: Wallet = {
  payer: signer,
  publicKey: signer.publicKey,
  signTransaction: async <T extends Transaction | VersionedTransaction>(transaction: T) => transaction,
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(transactions: T[]) => transactions,
};
const program = programFor(idl as Idl, wallet) as Program;
const instructionCoder = new BorshInstructionCoder(idl as Idl);
const key = () => Keypair.generate().publicKey;
const bytes = (value: PublicKey) => value.toBytes();

function discriminator(name: string): number[] {
  const instruction = idl.instructions.find(candidate => candidate.name === name);
  assert(instruction, `missing ${name} in generated IDL`);
  return instruction.discriminator;
}

function assertInstruction(ix: TransactionInstruction, name: string, keys: PublicKey[]) {
  assert.deepEqual([...ix.data.subarray(0, 8)], discriminator(name));
  assert.deepEqual(ix.keys.map(meta => meta.pubkey.toBase58()), keys.map(value => value.toBase58()));
}

function decodedArgs(ix: TransactionInstruction, name: string): Record<string, unknown> {
  const decoded = instructionCoder.decode(ix.data);
  assert(decoded);
  assert.equal(decoded.name, name);
  return decoded.data as unknown as Record<string, unknown>;
}

const participants = [key(), key(), key()] as [PublicKey, PublicKey, PublicKey];
const coreCreator = key();
const coreNonce = 9n;
const [coreAddress] = roomPda(coreCreator, coreNonce);
const [liveAddress] = livePda(coreAddress);

function coreFixture(overrides: Partial<RoomCore> = {}): RoomCore {
  const assets = Array.from({length: 6}, (_, slot) => {
    const mint = key();
    const owner = participants[Math.floor(slot / 2)];
    return {
      mint: bytes(mint), vault: bytes(vaultAta(coreAddress, mint)), originalOwner: bytes(owner),
      originalAta: bytes(getAssociatedTokenAddressSync(mint, owner)), finalAta: new Uint8Array(32),
      depositedAt: 1n, flags: 1,
    };
  }) as RoomCore["assets"];
  return {
    version: 1, coreBump: 1, liveBump: 2, vaultAuthorityBump: 3, creator: bytes(coreCreator), roomNonce: coreNonce,
    participants: participants.map(bytes) as RoomCore["participants"], liveRoom: bytes(liveAddress), assets,
    depositedMask: 63, returnedMask: 0, selectedMask: 0, status: "Active", createdAt: 1n, expiresAt: 9_999n,
    settledRevision: 0n, allocationHash: new Uint8Array(32), rentPayer: bytes(signer.publicKey), reserved: new Uint8Array(64),
    ...overrides,
  };
}

function liveFixture(overrides: Partial<RoomLive> = {}): RoomLive {
  const revision = overrides.revision ?? 4n;
  const selectedSlots = overrides.selectedSlots ?? [1, 2, 5];
  const cycle = overrides.cycle ?? "reverse";
  const expiresAt = overrides.expiresAt ?? 9_999n;
  const hash = overrides.allocationHash ?? allocationHash(coreAddress, revision, expiresAt, selectedSlots, cycle);
  return {
    version: 1, bump: 2, core: bytes(coreAddress), participants: participants.map(bytes) as RoomLive["participants"],
    expiresAt, revision, selectedSlots, cycle, destinations: cycle === "forward" ? [1, 2, 0] : [2, 0, 1],
    allocationHash: hash, lockedRevision: [revision, revision, revision],
    lockedHash: [hash, hash, hash], lockMask: 7,
    phase: "Finalized", lastActor: bytes(participants[2]), lastAction: "Finalized", updatedAt: 2n, reserved: new Uint8Array(64),
    ...overrides,
  };
}

test("builds initialize and deposit instructions with canonical PDAs and ATAs", async () => {
  const nonce = 44n;
  const initialized = await buildInitializeRoomInstruction(program, signer.publicKey, nonce, participants, 8_000n);
  const [core] = roomPda(signer.publicKey, nonce);
  const [live] = livePda(core);
  const [vaultAuthority] = vaultAuthorityPda(core);
  assert.equal(initialized.core.toBase58(), core.toBase58());
  assert.equal(initialized.live.toBase58(), live.toBase58());
  assertInstruction(initialized.instruction, "initialize_room", [signer.publicKey, core, live, vaultAuthority, SystemProgram.programId]);
  const initializeArgs = decodedArgs(initialized.instruction, "initialize_room");
  assert.equal((initializeArgs.room_nonce as BN).toString(), nonce.toString());
  assert.deepEqual((initializeArgs.participants as PublicKey[]).map(value => value.toBase58()), participants.map(value => value.toBase58()));
  assert.equal((initializeArgs.expires_at as BN).toString(), "8000");

  const mint = key();
  const deposit = await buildDepositAssetInstruction(program, participants[0], core, mint, 1);
  const source = getAssociatedTokenAddressSync(mint, participants[0]);
  assertInstruction(deposit, "deposit_asset", [participants[0], core, vaultAuthority, mint, source, vaultAta(core, mint), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId]);
  assert.equal(decodedArgs(deposit, "deposit_asset").slot, 1);
});

test("builds activation with generated delegation PDAs and the exact ER validator meta", async () => {
  const ix = await buildActivateAndDelegateLiveInstruction(program, participants[0], coreAddress, liveAddress);
  assertInstruction(ix, "activate_and_delegate_live", [
    participants[0], coreAddress,
    delegateBufferPdaFromDelegatedAccountAndOwnerProgram(liveAddress, program.programId),
    delegationRecordPdaFromDelegatedAccount(liveAddress), delegationMetadataPdaFromDelegatedAccount(liveAddress),
    liveAddress, program.programId, DELEGATION_PROGRAM_ID, SystemProgram.programId, ER_VALIDATOR,
  ]);
  assert.deepEqual(ix.keys.at(-1), {pubkey: ER_VALIDATOR, isSigner: false, isWritable: false});
  assert.deepEqual(decodedArgs(ix, "activate_and_delegate_live"), {});
});

test("builds only exact-revision ER consent and commit-only instructions", async () => {
  const hash = Array.from({length: 32}, (_, index) => index);
  const common = [participants[1], coreAddress, liveAddress];
  const propose = await buildProposeInstruction(program, participants[1], coreAddress, liveAddress, 4n, [1, 2, 5], "reverse");
  const lock = await buildLockInstruction(program, participants[1], coreAddress, liveAddress, 4n, hash);
  const revoke = await buildRevokeLockInstruction(program, participants[1], coreAddress, liveAddress, 4n, hash);
  assertInstruction(propose, "propose", common);
  assertInstruction(lock, "lock", common);
  assertInstruction(revoke, "revoke_lock", common);
  const proposalArgs = decodedArgs(propose, "propose");
  assert.equal((proposalArgs.expected_revision as BN).toString(), "4");
  assert.deepEqual(proposalArgs.selected_slots, [1, 2, 5]);
  assert.deepEqual(proposalArgs.cycle, {Reverse: {}});
  for (const [ix, name] of [[lock, "lock"], [revoke, "revoke_lock"]] as const) {
    const args = decodedArgs(ix, name);
    assert.equal((args.expected_revision as BN).toString(), "4");
    assert.deepEqual(args.expected_hash, hash);
  }
  const finalize = await buildFinalizeCommitOnlyInstruction(program, participants[1], coreAddress, liveAddress);
  assertInstruction(finalize, "finalize_commit_only", [participants[1], coreAddress, liveAddress, new PublicKey("Magic11111111111111111111111111111111111111"), new PublicKey("MagicContext1111111111111111111111111111111")]);
  assert.deepEqual(decodedArgs(finalize, "finalize_commit_only"), {});
});

test("builds participant cancellation and permissionless expiry cancellation", async () => {
  const participantCancel = await buildCancelByParticipantInstruction(program, participants[0], coreAddress);
  assertInstruction(participantCancel, "cancel_by_participant", [participants[0], coreAddress]);
  assert.deepEqual(decodedArgs(participantCancel, "cancel_by_participant"), {});
  const outsider = key();
  const expiryCancel = await buildCancelExpiredInstruction(program, outsider, coreAddress);
  assertInstruction(expiryCancel, "cancel_expired", [outsider, coreAddress]);
  assert.deepEqual(decodedArgs(expiryCancel, "cancel_expired"), {});
});

test("derives all settlement legs from authoritative state and prepares destination ATAs idempotently", async () => {
  const caller = key();
  const core = coreFixture();
  const live = liveFixture();
  const result = await buildSettleCommittedInstructions(program, caller, coreAddress, liveAddress, core, live, 5_000n);
  assert.equal(result.preparationInstructions.length, 3);
  assert.equal(result.instructions.length, 4);
  const selected = [1, 2, 5];
  selected.forEach((slot, leg) => {
    const mint = new PublicKey(core.assets[slot].mint);
    const recipient = participants[live.destinations[leg]];
    assert.equal(result.legs[leg].destination.toBase58(), destinationAta(recipient, mint).toBase58());
    assert.deepEqual([...result.preparationInstructions[leg].data], [1]);
    assert.deepEqual(result.preparationInstructions[leg].keys.map(meta => meta.pubkey.toBase58()), [caller, result.legs[leg].destination, recipient, mint, SystemProgram.programId, TOKEN_PROGRAM_ID].map(value => value.toBase58()));
  });
  const settlementKeys = [caller, coreAddress, liveAddress, vaultAuthorityPda(coreAddress)[0], TOKEN_PROGRAM_ID];
  result.legs.forEach(leg => settlementKeys.push(leg.mint, leg.vault, leg.destination));
  assertInstruction(result.settlementInstruction, "settle_committed", settlementKeys);
  assert.deepEqual(decodedArgs(result.settlementInstruction, "settle_committed"), {});
});

test("rejects malformed settlement state before constructing a consequence transaction", async () => {
  const build = (core: RoomCore, live: RoomLive, now = 5_000n) => buildSettleCommittedInstructions(program, key(), coreAddress, liveAddress, core, live, now);
  await assert.rejects(() => build(coreFixture(), liveFixture({core: bytes(key())})), /live.*core linkage/i);
  await assert.rejects(() => build(coreFixture(), liveFixture({selectedSlots: [0, 1, 5]})), /one slot per participant/i);
  const core = coreFixture();
  core.assets[1].vault = bytes(key());
  await assert.rejects(() => build(core, liveFixture()), /canonical vault/i);
  await assert.rejects(() => build(coreFixture(), liveFixture({destinations: [0, 1, 2]})), /destination linkage/i);
});

test("rejects every invalid settlement preflight invariant before instruction construction", async () => {
  const hash = liveFixture().allocationHash;
  const invalid: Array<[string, RoomCore, RoomLive, bigint]> = [
    ["canonical core PDA", coreFixture({creator: bytes(key())}), liveFixture(), 5_000n],
    ["canonical live PDA", coreFixture({liveRoom: bytes(key())}), liveFixture(), 5_000n],
    ["Core Active", coreFixture({status: "Settled"}), liveFixture(), 5_000n],
    ["not expired", coreFixture(), liveFixture(), 9_999n],
    ["Live Finalized", coreFixture(), liveFixture({phase: "Finalizing"}), 5_000n],
    ["exact lock mask", coreFixture(), liveFixture({lockMask: 3}), 5_000n],
    ["locked revision", coreFixture(), liveFixture({lockedRevision: [4n, 3n, 4n]}), 5_000n],
    ["locked hash", coreFixture(), liveFixture({lockedHash: [hash, new Uint8Array(32), hash]}), 5_000n],
    ["allocation hash", coreFixture(), liveFixture({allocationHash: new Uint8Array(32), lockedHash: [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)]}), 5_000n],
  ];
  for (const [label, core, live, now] of invalid) {
    await assert.rejects(() => buildSettleCommittedInstructions(program, key(), coreAddress, liveAddress, core, live, now), /./, label);
  }
});

test("uses immutable stored return accounts for one permissionless asset return", async () => {
  const caller = key();
  const core = coreFixture({status: "Returning", selectedMask: 0b01_0101});
  const asset = core.assets[3];
  const ix = await buildReturnAssetInstruction(program, caller, coreAddress, core, 3);
  assertInstruction(ix, "return_asset", [caller, coreAddress, vaultAuthorityPda(coreAddress)[0], new PublicKey(asset.mint), new PublicKey(asset.vault), new PublicKey(asset.originalOwner), new PublicKey(asset.originalAta), TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId]);
  assert.equal(decodedArgs(ix, "return_asset").slot, 3);
  await assert.rejects(() => buildReturnAssetInstruction(program, caller, coreAddress, core, 6), /slot/i);
});

test("rejects invalid return masks, lifecycle, linkage, flags, and canonical accounts", async () => {
  const build = (core: RoomCore, address = coreAddress, slot = 3) => buildReturnAssetInstruction(program, key(), address, core, slot);
  await assert.rejects(() => build(coreFixture({status: "Active"})), /status/i);
  await assert.rejects(() => build(coreFixture({status: "Returning", depositedMask: 0})), /deposited/i);
  await assert.rejects(() => build(coreFixture({status: "Returning", returnedMask: 1 << 3})), /returned/i);
  await assert.rejects(() => build(coreFixture({status: "Returning", selectedMask: 1 << 3})), /selected/i);
  await assert.rejects(() => build(coreFixture({status: "Returning"}), key()), /canonical core PDA/i);
  const owner = coreFixture({status: "Cancelled"});
  owner.assets[3].originalOwner = bytes(participants[0]);
  await assert.rejects(() => build(owner), /original owner/i);
  const ata = coreFixture({status: "Cancelled"});
  ata.assets[3].originalAta = bytes(key());
  await assert.rejects(() => build(ata), /original ATA/i);
  const flags = coreFixture({status: "Returning"});
  flags.assets[3].flags = 1 | 4;
  await assert.rejects(() => build(flags), /transferred/i);
});

test("tracks bounded pending writes and lets late authoritative state reconcile a timeout", () => {
  const hash = Array(32).fill(7);
  const pending = startPending({action: "lock", expectation: {kind: "lock", actorIndex: 1, revision: 4n, allocationHash: hash}}, 1_000, 500);
  assert.equal(pending.phase, "awaiting-wallet");
  const broadcast = broadcastPending(pending, "er-signature", 1_100);
  assert.deepEqual([broadcast.phase, broadcast.signature, broadcast.evidenceUrl, broadcast.evidence], ["broadcast", "er-signature", undefined, {kind: "raw-er-signature", endpoint: ER_RPC}]);
  const waiting = awaitAuthoritative(broadcast, 1_101);
  const timedOut = reconcilePending(waiting, {live: liveFixture({lockMask: 0})}, 1_501);
  assert.deepEqual([timedOut.phase, timedOut.signature, timedOut.refreshAuthority, timedOut.canBlindRetry], ["timed-out", "er-signature", true, false]);
  const live = liveFixture({allocationHash: Uint8Array.from(hash), lockMask: 2, lockedRevision: [0n, 4n, 0n], lockedHash: [new Uint8Array(32), Uint8Array.from(hash), new Uint8Array(32)]});
  assert.equal(reconcilePending(timedOut, {live}, 1_900).phase, "reconciled");
});

test("supports exact proposal, revoke, phase, status, mask, return, and initialization expectations", () => {
  const activeCore = coreFixture({status: "Active", depositedMask: 63, returnedMask: 2});
  const live = liveFixture({phase: "Finalized", lockMask: 5});
  const cases: Array<[PendingRequest, Parameters<typeof reconcilePending>[1]]> = [
    [{action: "propose", expectation: {kind: "proposal", revision: 4n, selectedSlots: [1, 2, 5], cycle: "reverse", allocationHash: live.allocationHash}}, {core: activeCore, live}],
    [{action: "revokeLock", expectation: {kind: "revoke", actorIndex: 1, revision: 4n, allocationHash: live.allocationHash}}, {core: activeCore, live}],
    [{action: "finalizeCommitOnly", expectation: {kind: "phase", phase: "Finalized"}}, {core: activeCore, live}],
    [{action: "activateAndDelegate", expectation: {kind: "status", status: "Active"}}, {core: activeCore, live}],
    [{action: "depositAsset", expectation: {kind: "mask", field: "depositedMask", value: 63}}, {core: activeCore, live}],
    [{action: "returnAsset", expectation: {kind: "return", slot: 1}}, {core: activeCore, live}],
    [{action: "initializeRoom", expectation: {kind: "room-initialized", coreAddress: coreAddress.toBytes(), liveAddress: liveAddress.toBytes()}}, {core: activeCore, live, coreAddress: coreAddress.toBytes(), liveAddress: liveAddress.toBytes()}],
  ];
  cases.forEach(([request, snapshot]) => {
    const pending = awaitAuthoritative(broadcastPending(startPending(request, 0, 10), "signature", 1), 2);
    assert.equal(reconcilePending(pending, snapshot, 3).phase, "reconciled", request.action);
  });
  assert.equal(failPending(startPending(cases[0][0], 0, 10), new Error("declined"), 1).phase, "failed");
});

test("maps every pending action to its evidence network without caller choice", () => {
  const baseRequests: PendingRequest[] = [
    {action: "initializeRoom", expectation: {kind: "room-initialized", coreAddress: [], liveAddress: []}},
    {action: "depositAsset", expectation: {kind: "mask", field: "depositedMask", value: 1}},
    {action: "activateAndDelegate", expectation: {kind: "status", status: "Active"}},
    {action: "cancelByParticipant", expectation: {kind: "status", status: "Cancelled"}},
    {action: "cancelExpired", expectation: {kind: "status", status: "Cancelled"}},
    {action: "settleCommitted", expectation: {kind: "settlement", selectedMask: 1, revision: 1n, allocationHash: []}},
    {action: "returnAsset", expectation: {kind: "return", slot: 1}},
  ];
  const erRequests: PendingRequest[] = [
    {action: "propose", expectation: {kind: "proposal", revision: 1n, selectedSlots: [0, 2, 4], cycle: "forward", allocationHash: []}},
    {action: "lock", expectation: {kind: "lock", actorIndex: 0, revision: 1n, allocationHash: []}},
    {action: "revokeLock", expectation: {kind: "revoke", actorIndex: 0, revision: 1n, allocationHash: []}},
    {action: "finalizeCommitOnly", expectation: {kind: "phase", phase: "Finalized"}},
  ];
  baseRequests.forEach(request => assert.equal(broadcastPending(startPending(request, 0, 10), "sig", 1).evidenceUrl, explorerTx("sig")));
  erRequests.forEach(request => assert.deepEqual(broadcastPending(startPending(request, 0, 10), "sig", 1).evidence, {kind: "raw-er-signature", endpoint: ER_RPC}));
});

test("settlement pending requires status and the exact mask, revision, and allocation hash", () => {
  const core = coreFixture({status: "Settled", selectedMask: 0b10_0110, settledRevision: 4n});
  const hash = liveFixture().allocationHash;
  core.allocationHash = hash;
  const expectation = {kind: "settlement", selectedMask: 0b10_0110, revision: 4n, allocationHash: hash} as const;
  const pending = awaitAuthoritative(broadcastPending(startPending({action: "settleCommitted", expectation}, 0, 10), "sig", 1), 2);
  assert.equal(reconcilePending(pending, {core}, 3).phase, "reconciled");
  for (const wrong of [
    coreFixture({status: "Active", selectedMask: 0b10_0110, settledRevision: 4n, allocationHash: hash}),
    {...core, selectedMask: 0}, {...core, settledRevision: 3n}, {...core, allocationHash: new Uint8Array(32)},
  ]) assert.notEqual(reconcilePending(pending, {core: wrong}, 3).phase, "reconciled");
});

// @ts-expect-error lock writes can only wait for a lock expectation
startPending({action: "lock", expectation: {kind: "proposal", revision: 1n, selectedSlots: [0, 2, 4], cycle: "forward", allocationHash: []}}, 0, 10);

test("does not expose wallet-callable settleAction or composed finalize builders", () => {
  const source = readFileSync(new URL("../../src/lib/room-actions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /buildSettleAction|methods\.settleAction\s*\(/);
  assert.doesNotMatch(source, /buildFinalizeInstruction|methods\.finalize\s*\(/);
});

test("sendBase delegates to the multi-instruction sender", async () => {
  assert.equal(typeof sendBaseInstructions, "function");
  assert.match(sendBase.toString(), /sendBaseInstructions/);
});

test("base transport falls back only for blockhash selection and never retries an ambiguous broadcast", async () => {
  const blockhash = key().toBase58();
  const instruction = new TransactionInstruction({programId: SystemProgram.programId, keys: [], data: Buffer.from([1])});
  let signCalls = 0;
  const signingWallet: Wallet = {
    payer: signer, publicKey: signer.publicKey, signAllTransactions: wallet.signAllTransactions,
    signTransaction: async <T extends Transaction | VersionedTransaction>(transaction: T) => {
      signCalls += 1;
      if (transaction instanceof Transaction) transaction.partialSign(signer);
      return transaction;
    },
  };
  const calls = {primaryBlockhash: 0, primarySend: 0, fallbackBlockhash: 0, fallbackSend: 0, instructionCount: 0};
  const primaryBlockhashFailure = {
    getLatestBlockhash: async () => { calls.primaryBlockhash += 1; throw new Error("primary blockhash unavailable"); },
    sendRawTransaction: async () => { calls.primarySend += 1; return "wrong"; },
  } as unknown as Connection;
  const fallback = {
    getLatestBlockhash: async () => { calls.fallbackBlockhash += 1; return {blockhash, lastValidBlockHeight: 1}; },
    sendRawTransaction: async (raw: Buffer | Uint8Array) => { calls.fallbackSend += 1; calls.instructionCount = Transaction.from(raw).instructions.length; return "fallback-signature"; },
  } as unknown as Connection;
  assert.equal(await sendBaseInstructions(primaryBlockhashFailure, signingWallet, [instruction, instruction], fallback), "fallback-signature");
  assert.deepEqual(calls, {primaryBlockhash: 1, primarySend: 0, fallbackBlockhash: 1, fallbackSend: 1, instructionCount: 2});
  assert.equal(signCalls, 1);

  calls.primarySend = 0;
  calls.fallbackSend = 0;
  calls.fallbackBlockhash = 0;
  signCalls = 0;
  const primaryBroadcastTimeout = {
    getLatestBlockhash: async () => ({blockhash, lastValidBlockHeight: 1}),
    sendRawTransaction: async () => { calls.primarySend += 1; throw new Error("broadcast timed out ambiguously"); },
  } as unknown as Connection;
  await assert.rejects(() => sendBaseInstructions(primaryBroadcastTimeout, signingWallet, [instruction], fallback), /base broadcast outcome is ambiguous/);
  assert.deepEqual([signCalls, calls.primarySend, calls.fallbackSend, calls.fallbackBlockhash], [1, 1, 0, 0]);
  try { await sendBaseInstructions(primaryBroadcastTimeout, signingWallet, [instruction], fallback); }
  catch (error) {
    assert.ok(error instanceof AmbiguousBroadcastError);
    assert.equal(error.endpoint, "base");
    assert.equal(error.recentBlockhash, blockhash);
    assert.match(ambiguousBroadcastSignature(error) ?? "", /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  }

  const rejected = {...primaryBroadcastTimeout, sendRawTransaction: async () => { throw new Error("Transaction simulation failed: custom program error: 0x1"); }} as unknown as Connection;
  await assert.rejects(() => sendBaseInstructions(rejected, signingWallet, [instruction]), (error: unknown) => error instanceof SignedTransactionRejectedError
    && error.recentBlockhash === blockhash && error.endpoint === "base"
    && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(error.signature));
});

test("ER transport signs once and never retries an ambiguous Router broadcast", async () => {
  const instruction = new TransactionInstruction({programId: SystemProgram.programId, keys: [], data: Buffer.from([1])});
  const blockhash = key().toBase58();
  const calls = {sign: 0, routerSend: 0, directSend: 0, directBlockhash: 0};
  const signingWallet: Wallet = {payer: signer, publicKey: signer.publicKey, signAllTransactions: wallet.signAllTransactions,
    signTransaction: async <T extends Transaction | VersionedTransaction>(transaction: T) => { calls.sign += 1; if (transaction instanceof Transaction) transaction.partialSign(signer); return transaction; }};
  let failure: unknown;
  try { await sendErWithTransport(signingWallet, instruction, {
    routerBlockhash: async () => blockhash,
    directBlockhash: async () => { calls.directBlockhash += 1; return blockhash; },
    sendRouter: async () => { calls.routerSend += 1; throw new Error("router send timed out"); },
    sendDirect: async () => { calls.directSend += 1; return "wrong"; },
  }); } catch (error) { failure = error; }
  assert.ok(failure instanceof AmbiguousBroadcastError);
  assert.equal(failure.recentBlockhash, blockhash);
  assert.match(ambiguousBroadcastSignature(failure) ?? "", /^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  assert.deepEqual(calls, {sign: 1, routerSend: 1, directSend: 0, directBlockhash: 0});
});

test("ER transport selects direct ER before signing when Router blockhash acquisition fails", async () => {
  const instruction = new TransactionInstruction({programId: SystemProgram.programId, keys: [], data: Buffer.from([1])});
  const blockhash = key().toBase58();
  const calls = {sign: 0, routerSend: 0, directSend: 0};
  const signingWallet: Wallet = {payer: signer, publicKey: signer.publicKey, signAllTransactions: wallet.signAllTransactions,
    signTransaction: async <T extends Transaction | VersionedTransaction>(transaction: T) => { calls.sign += 1; return transaction; }};
  const signature = await sendErWithTransport(signingWallet, instruction, {
    routerBlockhash: async () => { throw new Error("router unavailable"); },
    directBlockhash: async () => blockhash,
    sendRouter: async () => { calls.routerSend += 1; return "wrong"; },
    sendDirect: async () => { calls.directSend += 1; return "direct-signature"; },
  });
  assert.equal(signature, "direct-signature");
  assert.deepEqual(calls, {sign: 1, routerSend: 0, directSend: 1});
});
