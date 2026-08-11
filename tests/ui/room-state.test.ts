import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";

import {
  decodeRoomCore,
  decodeRoomLive,
  deriveConsent,
  deriveRoomUiState,
  deriveWalletRole,
  returnableSlots,
  type DraftProposal,
  type RoomCore,
  type RoomLive,
  type RoomUiInput,
  type WalletRole,
} from "../../src/lib/room-state";

const key = (value: number) => Uint8Array.from({length: 32}, () => value);
const writeKey = (data: Buffer, offset: number, value: number) => data.set(key(value), offset);
const CORE_DISCRIMINATOR = [159, 7, 60, 81, 143, 33, 177, 65];
const LIVE_DISCRIMINATOR = [245, 92, 71, 83, 30, 246, 85, 29];
const CORE_ADDRESS = key(90);
const LIVE_ADDRESS = key(14);
const PROGRAM_ID = key(88);
const DELEGATION_PROGRAM_ID = Uint8Array.from([181, 183, 0, 225, 242, 87, 58, 192, 204, 6, 34, 1, 52, 74, 207, 151, 184, 53, 6, 235, 140, 229, 25, 152, 204, 98, 126, 24, 147, 128, 167, 62]);

function expectedHash(revision: bigint, expiry: bigint, slots: [number, number, number], cycle: "forward" | "reverse") {
  const revisionBytes = Buffer.alloc(8);
  const expiryBytes = Buffer.alloc(8);
  revisionBytes.writeBigUInt64LE(revision);
  expiryBytes.writeBigInt64LE(expiry);
  const destinations = cycle === "forward" ? [1, 2, 0] : [2, 0, 1];
  return createHash("sha256").update(Buffer.concat([
    Buffer.from("tradetable-allocation-v1"), Buffer.from(CORE_ADDRESS), revisionBytes, expiryBytes,
    Buffer.from(slots), Buffer.from([cycle === "forward" ? 0 : 1]), Buffer.from(destinations),
  ])).digest();
}

function coreFixture(): Buffer {
  const data = Buffer.alloc(1_350);
  data.set(CORE_DISCRIMINATOR);
  data.set([1, 2, 3, 4], 8);
  writeKey(data, 12, 10);
  data.writeBigUInt64LE(99n, 44);
  [11, 12, 13].forEach((value, index) => writeKey(data, 52 + index * 32, value));
  writeKey(data, 148, 14);
  for (let slot = 0; slot < 6; slot += 1) {
    const offset = 180 + slot * 169;
    [21, 31, 41, 51, 61].forEach((base, index) => writeKey(data, offset + index * 32, base + slot));
    data.writeBigInt64LE(1_000n + BigInt(slot), offset + 160);
    data[offset + 168] = slot + 1;
  }
  data.set([0b11_1111, 0b10_1010, 0b01_0101, 2], 1_194);
  data.writeBigInt64LE(1_700_000_000n, 1_198);
  data.writeBigInt64LE(1_800_000_000n, 1_206);
  data.writeBigUInt64LE(7n, 1_214);
  data.set(Uint8Array.from({length: 32}, (_, index) => index), 1_222);
  writeKey(data, 1_254, 71);
  data.fill(72, 1_286, 1_350);
  return data;
}

function liveFixture(): Buffer {
  const data = Buffer.alloc(420);
  data.set(LIVE_DISCRIMINATOR);
  data.set([1, 9], 8);
  writeKey(data, 10, 90);
  [11, 12, 13].forEach((value, index) => writeKey(data, 42 + index * 32, value));
  data.writeBigInt64LE(1_800_000_000n, 138);
  data.writeBigUInt64LE(8n, 146);
  data.set([1, 2, 5, 1, 2, 0, 1], 154);
  data.set(expectedHash(8n, 1_800_000_000n, [1, 2, 5], "reverse"), 161);
  [8n, 8n, 0n].forEach((value, index) => data.writeBigUInt64LE(value, 193 + index * 8));
  [81, 82, 0].forEach((value, index) => writeKey(data, 217 + index * 32, value));
  data.set([0b011, 1], 313);
  writeKey(data, 315, 12);
  data[347] = 2;
  data.writeBigInt64LE(1_700_000_010n, 348);
  data.fill(91, 356, 420);
  return data;
}

test("decodes every RoomCore field at the Rust Borsh offsets", () => {
  const core = decodeRoomCore(coreFixture());
  assert.deepEqual([core.version, core.coreBump, core.liveBump, core.vaultAuthorityBump], [1, 2, 3, 4]);
  assert.deepEqual([...core.creator], [...key(10)]);
  assert.equal(core.roomNonce, 99n);
  assert.deepEqual(core.participants.map(value => value[0]), [11, 12, 13]);
  assert.equal(core.liveRoom[0], 14);
  assert.deepEqual(core.assets.map(asset => asset.mint[0]), [21, 22, 23, 24, 25, 26]);
  assert.deepEqual(core.assets.map(asset => asset.vault[0]), [31, 32, 33, 34, 35, 36]);
  assert.deepEqual(core.assets.map(asset => asset.originalOwner[0]), [41, 42, 43, 44, 45, 46]);
  assert.deepEqual(core.assets.map(asset => asset.originalAta[0]), [51, 52, 53, 54, 55, 56]);
  assert.deepEqual(core.assets.map(asset => asset.finalAta[0]), [61, 62, 63, 64, 65, 66]);
  assert.deepEqual(core.assets.map(asset => asset.depositedAt), [1000n, 1001n, 1002n, 1003n, 1004n, 1005n]);
  assert.deepEqual(core.assets.map(asset => asset.flags), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([core.depositedMask, core.returnedMask, core.selectedMask], [63, 42, 21]);
  assert.equal(core.status, "Settled");
  assert.deepEqual([core.createdAt, core.expiresAt, core.settledRevision], [1_700_000_000n, 1_800_000_000n, 7n]);
  assert.equal(core.allocationHash[31], 31);
  assert.equal(core.rentPayer[0], 71);
  assert.deepEqual([...core.reserved], Array(64).fill(72));
});

test("decodes every RoomLive field at the Rust Borsh offsets", () => {
  const live = decodeRoomLive(liveFixture());
  assert.deepEqual([live.version, live.bump, live.core[0]], [1, 9, 90]);
  assert.deepEqual(live.participants.map(value => value[0]), [11, 12, 13]);
  assert.deepEqual([live.expiresAt, live.revision], [1_800_000_000n, 8n]);
  assert.deepEqual(live.selectedSlots, [1, 2, 5]);
  assert.equal(live.cycle, "reverse");
  assert.deepEqual(live.destinations, [2, 0, 1]);
  assert.deepEqual(live.allocationHash, expectedHash(8n, 1_800_000_000n, [1, 2, 5], "reverse"));
  assert.deepEqual(live.lockedRevision, [8n, 8n, 0n]);
  assert.deepEqual(live.lockedHash.map(value => value[0]), [81, 82, 0]);
  assert.deepEqual([live.lockMask, live.phase, live.lastActor[0], live.lastAction], [3, "Finalizing", 12, "Locked"]);
  assert.equal(live.updatedAt, 1_700_000_010n);
  assert.deepEqual([...live.reserved], Array(64).fill(91));
});

test("rejects truncated accounts, wrong discriminators, and unknown enum variants", () => {
  assert.throws(() => decodeRoomCore(Buffer.alloc(1_349)), /RoomCore.*1350/);
  assert.throws(() => decodeRoomLive(Buffer.alloc(419)), /RoomLive.*420/);
  const wrongCore = coreFixture();
  wrongCore[0] ^= 0xff;
  assert.throws(() => decodeRoomCore(wrongCore), /RoomCore discriminator/);
  const wrongLive = liveFixture();
  wrongLive[7] ^= 0xff;
  assert.throws(() => decodeRoomLive(wrongLive), /RoomLive discriminator/);
  const core = coreFixture();
  core[1_197] = 7;
  assert.throws(() => decodeRoomCore(core), /CoreStatus/);
  const live = liveFixture();
  live[314] = 3;
  assert.throws(() => decodeRoomLive(live), /LivePhase/);
  live[314] = 0;
  live[157] = 2;
  assert.throws(() => decodeRoomLive(live), /Cycle/);
  live[157] = 0;
  live[347] = 5;
  assert.throws(() => decodeRoomLive(live), /LiveAction/);
});

test("rejects unsupported RoomCore and RoomLive versions", () => {
  const core = coreFixture();
  core[8] = 2;
  assert.throws(() => decodeRoomCore(core), /RoomCore version/);
  const live = liveFixture();
  live[8] = 0;
  assert.throws(() => decodeRoomLive(live), /RoomLive version/);
});

const baseCore = (overrides: Partial<RoomCore> = {}): RoomCore => ({
  ...decodeRoomCore(coreFixture()),
  status: "Active",
  depositedMask: 63,
  returnedMask: 0,
  selectedMask: 0,
  expiresAt: 2_000n,
  ...overrides,
});

function baseLive(overrides: Partial<RoomLive> = {}): RoomLive {
  const live = {
    ...decodeRoomLive(liveFixture()), expiresAt: 2_000n, phase: "Negotiating" as const,
    selectedSlots: [1, 2, 5] as [number, number, number], cycle: "reverse" as const, lockMask: 0,
    ...overrides,
  };
  if (!("allocationHash" in overrides)) {
    live.allocationHash = expectedHash(live.revision, live.expiresAt, live.selectedSlots, live.cycle);
  }
  return live;
}

const draft: DraftProposal = {selectedSlots: [1, 2, 5], cycle: "reverse"};

test("derives disconnected, participant A-B-C, and observer wallet roles", () => {
  const participants = baseCore().participants;
  assert.deepEqual(deriveWalletRole(null, participants), {kind: "disconnected"});
  assert.deepEqual(deriveWalletRole(key(11), participants), {kind: "participant", seat: "A", index: 0});
  assert.deepEqual(deriveWalletRole(key(12), participants), {kind: "participant", seat: "B", index: 1});
  assert.deepEqual(deriveWalletRole(key(13), participants), {kind: "participant", seat: "C", index: 2});
  assert.deepEqual(deriveWalletRole(key(99), participants), {kind: "observer"});
});

const exactParticipantRole: WalletRole = {kind: "participant", seat: "B", index: 1};
// @ts-expect-error participant seat and index must be an exact pair
const impossibleParticipantRole: WalletRole = {kind: "participant", seat: "A", index: 2};
assert.notDeepEqual(exactParticipantRole, impossibleParticipantRole);

test("derives returnable slots from status and the deposited, selected, and returned masks", () => {
  assert.deepEqual(returnableSlots(baseCore({status: "Settled", selectedMask: 0b01_0101})), [1, 3, 5]);
  assert.deepEqual(returnableSlots(baseCore({status: "Returning", selectedMask: 0b01_0101, returnedMask: 0b00_0010})), [3, 5]);
  assert.deepEqual(returnableSlots(baseCore({status: "Cancelled", depositedMask: 0b10_1011, returnedMask: 0b00_0010})), [0, 3, 5]);
  assert.deepEqual(returnableSlots(baseCore({status: "Active"})), []);
});

test("allows an unlocked participant to lock only the matching authoritative proposal", () => {
  const participant = {kind: "participant", seat: "A", index: 0} as const;
  assert.deepEqual(deriveConsent(draft, baseLive(), participant, baseCore(), CORE_ADDRESS), {conflict: false, lockAllowed: true, alreadyLocked: false, authorityValid: true, draftValid: true});
  assert.equal(deriveConsent({...draft, selectedSlots: [0, 2, 5]}, baseLive(), participant, baseCore(), CORE_ADDRESS).conflict, true);
  const locked = baseLive();
  locked.lockMask = 1;
  locked.lockedRevision = [locked.revision, 0n, 0n];
  locked.lockedHash = [locked.allocationHash, key(0), key(0)];
  assert.deepEqual(deriveConsent(draft, locked, participant, baseCore(), CORE_ADDRESS), {conflict: false, lockAllowed: false, alreadyLocked: true, authorityValid: true, draftValid: true});
  assert.equal(deriveConsent(draft, baseLive(), {kind: "observer"}, baseCore(), CORE_ADDRESS).lockAllowed, false);
});

test("rejects malformed, unfunded, uninitialized, and internally inconsistent consent targets", () => {
  const participant = {kind: "participant", seat: "A", index: 0} as const;
  assert.equal(deriveConsent({...draft, selectedSlots: [0, 1, 5]}, baseLive(), participant, baseCore(), CORE_ADDRESS).draftValid, false);
  assert.equal(deriveConsent(draft, baseLive({selectedSlots: [0, 1, 5]}), participant, baseCore(), CORE_ADDRESS).authorityValid, false);
  assert.equal(deriveConsent(draft, baseLive(), participant, baseCore({depositedMask: 0b01_1101}), CORE_ADDRESS).authorityValid, false);
  assert.equal(deriveConsent(draft, baseLive({revision: 0n}), participant, baseCore(), CORE_ADDRESS).authorityValid, false);
  assert.equal(deriveConsent(draft, baseLive({allocationHash: key(0)}), participant, baseCore(), CORE_ADDRESS).authorityValid, false);
  const brokenLock = baseLive({lockMask: 1, lockedRevision: [7n, 0n, 0n]});
  brokenLock.lockedHash = [brokenLock.allocationHash, key(0), key(0)];
  assert.equal(deriveConsent(draft, brokenLock, participant, baseCore(), CORE_ADDRESS).authorityValid, false);
});

test("rejects authoritative proposals whose destinations or allocation hash violate the protocol", () => {
  const badDestinations = baseLive({destinations: [1, 2, 0]});
  assert.equal(ui({live: badDestinations}).primary, "refreshAuthority");
  const badHash = baseLive({allocationHash: key(6)});
  assert.equal(ui({live: badHash}).primary, "refreshAuthority");
  const finalizingDestinations = fullLockedLive("Finalizing");
  finalizingDestinations.destinations = [1, 2, 0];
  assert.equal(ui({live: finalizingDestinations}).primary, "refreshAuthority");
  const finalizedHash = fullLockedLive("Finalized");
  finalizedHash.allocationHash = key(9);
  finalizedHash.lockedHash = [key(9), key(9), key(9)];
  assert.equal(ui({live: finalizedHash, authority: baseAuthority()}).primary, "inspectCommit");
});

const erAuthority = (delegated = true) => ({source: "magicblock-er", delegated, owner: PROGRAM_ID, delegationProgramId: DELEGATION_PROGRAM_ID} as const);
const baseAuthority = (delegated = false) => ({source: "solana-base", delegated, owner: delegated ? DELEGATION_PROGRAM_ID : PROGRAM_ID, delegationProgramId: DELEGATION_PROGRAM_ID} as const);
const unavailableAuthority = {source: "unavailable", delegated: false, owner: null, delegationProgramId: DELEGATION_PROGRAM_ID} as const;

function exactLockedLive(): RoomLive {
  const live = baseLive({lockMask: 1});
  live.lockedRevision = [live.revision, 0n, 0n];
  live.lockedHash = [live.allocationHash, key(0), key(0)];
  return live;
}

function fullLockedLive(phase: "Finalizing" | "Finalized"): RoomLive {
  const live = baseLive({phase, lockMask: 7});
  live.lockedRevision = [live.revision, live.revision, live.revision];
  live.lockedHash = [live.allocationHash, live.allocationHash, live.allocationHash];
  return live;
}

function ui(overrides: Partial<RoomUiInput> = {}) {
  return deriveRoomUiState({
    core: baseCore(),
    live: baseLive(),
    role: {kind: "participant", seat: "A", index: 0},
    draft,
    authority: erAuthority(),
    coreAddress: CORE_ADDRESS,
    liveAddress: LIVE_ADDRESS,
    programId: PROGRAM_ID,
    stale: false,
    now: 1_000n,
    ...overrides,
  });
}

test("derives the legal primary action and evidence authority for each lifecycle state", () => {
  const cases: Array<[string, Partial<RoomUiInput>, string, string]> = [
    ["unavailable", {core: undefined}, "refreshAuthority", "none"],
    ["Funding own deposits", {core: baseCore({status: "Funding", depositedMask: 0b11_1100})}, "depositAsset", "solana-base"],
    ["fully funded Funding", {core: baseCore({status: "Funding"})}, "activateAndDelegate", "solana-base"],
    ["expired Funding", {core: baseCore({status: "Funding", expiresAt: 999n})}, "cancelExpired", "solana-base"],
    ["Negotiating matching", {}, "lock", "magicblock-er"],
    ["Negotiating conflicting", {draft: {...draft, cycle: "forward"}}, "propose", "magicblock-er"],
    ["Negotiating locked", {live: exactLockedLive()}, "revokeLock", "magicblock-er"],
    ["Finalizing", {live: fullLockedLive("Finalizing")}, "finalizeCommitOnly", "magicblock-er"],
    ["ER-only Finalized", {live: fullLockedLive("Finalized")}, "inspectCommit", "magicblock-er"],
    ["base Finalized", {live: fullLockedLive("Finalized"), authority: baseAuthority()}, "settleCommitted", "solana-base"],
    ["Settled", {core: baseCore({status: "Settled", selectedMask: 21})}, "returnAsset", "solana-base"],
    ["Returning", {core: baseCore({status: "Returning", selectedMask: 21, returnedMask: 2})}, "returnAsset", "solana-base"],
    ["Cancelled", {core: baseCore({status: "Cancelled", returnedMask: 2})}, "returnAsset", "solana-base"],
    ["Complete", {core: baseCore({status: "Complete"})}, "viewReceipt", "both"],
    ["Closed", {core: baseCore({status: "Closed"})}, "viewReceipt", "solana-base"],
  ];
  for (const [name, input, action, evidence] of cases) {
    const state = ui(input);
    assert.equal(state.primary, action, `${name} primary`);
    assert.equal(state.evidenceAuthority, evidence, `${name} evidence`);
    assert.ok(state.reason.length > 0, `${name} reason`);
    assert.ok(state.recovery.length > 0, `${name} recovery`);
    assert.ok(Array.isArray(state.alternatives), `${name} alternatives`);
  }
});

test("enforces signer, expiry, freshness, and permissionless-action boundaries", () => {
  const observer = {kind: "observer"} as const;
  assert.equal(ui({core: baseCore({status: "Funding", depositedMask: 0}), role: observer}).primary, "waitForParticipants");
  assert.equal(ui({core: baseCore({status: "Funding", depositedMask: 0})}).alternatives.includes("cancelByParticipant"), true);
  assert.equal(ui({core: baseCore({status: "Active", expiresAt: 999n}), role: observer}).primary, "cancelExpired");
  assert.equal(ui({core: baseCore({status: "Funding", expiresAt: 999n}), role: observer}).primary, "cancelExpired");
  assert.equal(ui({core: baseCore({status: "Active", expiresAt: 999n}), live: fullLockedLive("Finalized"), authority: baseAuthority(), role: observer}).primary, "cancelExpired");
  assert.equal(ui({live: fullLockedLive("Finalized"), authority: baseAuthority(), role: observer}).primary, "settleCommitted");
  assert.equal(ui({core: baseCore({status: "Cancelled"}), role: observer}).primary, "returnAsset");
  assert.equal(ui({stale: true}).primary, "refreshAuthority");
  assert.deepEqual(ui({stale: true}).alternatives, []);
  assert.ok(ui({stale: true}).recovery);
  assert.equal(ui({core: baseCore({status: "Funding", expiresAt: 999n})}).alternatives.includes("cancelByParticipant"), true);
});

test("requires participant authority for negotiation and finalization writes", () => {
  const observer = {kind: "observer"} as const;
  assert.equal(ui({role: observer}).primary, "inspectProposal");
  assert.equal(ui({role: observer, live: fullLockedLive("Finalizing")}).primary, "inspectCommit");
  assert.equal(ui({role: {kind: "disconnected"}}).primary, "connectWallet");
});

test("allows the first proposal from the canonical revision-zero live state but never a revision-zero lock", () => {
  const initial = baseLive({revision: 0n, selectedSlots: [0, 2, 4], cycle: "forward", destinations: [1, 2, 0], allocationHash: key(0),
    lockedRevision: [0n, 0n, 0n], lockedHash: [key(0), key(0), key(0)], lockMask: 0, lastActor: key(0), lastAction: "Initialized"});
  const initialDraft: DraftProposal = {selectedSlots: [0, 2, 4], cycle: "forward"};
  assert.equal(ui({live: initial, draft: initialDraft}).primary, "propose");
  assert.equal(ui({live: initial, draft: initialDraft, role: {kind: "observer"}}).primary, "inspectProposal");
  assert.notEqual(ui({live: initial, draft: initialDraft}).primary, "lock");
  assert.equal(ui({live: {...initial, allocationHash: key(7)}, draft: initialDraft}).primary, "refreshAuthority");
});

test("validates Core and Live linkage before exposing any live write", () => {
  const broken = [
    {coreAddress: key(91)},
    {liveAddress: key(15)},
    {live: baseLive({participants: [key(11), key(12), key(99)]})},
    {live: baseLive({expiresAt: 2_001n})},
    {programId: key(87)},
  ];
  for (const override of broken) {
    const state = ui(override);
    assert.equal(state.primary, "refreshAuthority");
    assert.match(state.reason, /link|owner/i);
  }
});

test("gates every Authority and LivePhase combination", () => {
  const cases = [
    [erAuthority(), "Negotiating", "lock"],
    [erAuthority(), "Finalizing", "finalizeCommitOnly"],
    [erAuthority(), "Finalized", "inspectCommit"],
    [erAuthority(false), "Negotiating", "refreshAuthority"],
    [erAuthority(false), "Finalizing", "refreshAuthority"],
    [erAuthority(false), "Finalized", "refreshAuthority"],
    [baseAuthority(), "Negotiating", "inspectProposal"],
    [baseAuthority(), "Finalizing", "inspectCommit"],
    [baseAuthority(), "Finalized", "settleCommitted"],
    [baseAuthority(true), "Negotiating", "inspectProposal"],
    [baseAuthority(true), "Finalizing", "inspectCommit"],
    [baseAuthority(true), "Finalized", "inspectCommit"],
    [unavailableAuthority, "Negotiating", "refreshAuthority"],
    [unavailableAuthority, "Finalizing", "refreshAuthority"],
    [unavailableAuthority, "Finalized", "refreshAuthority"],
  ] as const;
  for (const [authority, phase, primary] of cases) {
    const live = phase === "Negotiating" ? baseLive({phase}) : fullLockedLive(phase);
    const state = ui({authority, live});
    assert.equal(state.primary, primary, `${authority.source}/${authority.delegated}/${phase}`);
    assert.ok(Array.isArray(state.alternatives));
    assert.ok(state.reason.length > 0);
    assert.ok(state.recovery.length > 0);
    assert.ok(state.evidenceAuthority.length > 0);
  }
  for (const phase of ["Negotiating", "Finalizing", "Finalized"] as const) {
    const wrongOwner = {...erAuthority(), owner: key(77)};
    assert.equal(ui({authority: wrongOwner, live: baseLive({phase})}).primary, "refreshAuthority", `wrong-owner/${phase}`);
  }
  assert.equal(ui({authority: baseAuthority(true), live: fullLockedLive("Finalized")}).evidenceAuthority, "solana-base");
});

test("accepts only the owner appropriate to each source and delegation state", () => {
  assert.equal(ui({authority: baseAuthority(true)}).primary, "inspectProposal");
  assert.equal(ui({authority: {...baseAuthority(true), owner: PROGRAM_ID}}).primary, "refreshAuthority");
  assert.equal(ui({authority: {...baseAuthority(), owner: DELEGATION_PROGRAM_ID}}).primary, "refreshAuthority");
  assert.equal(ui({authority: erAuthority()}).primary, "lock");
  assert.equal(ui({authority: {...erAuthority(), owner: DELEGATION_PROGRAM_ID}}).primary, "refreshAuthority");
});

test("requires a coherent unanimous lock set before finalization or settlement", () => {
  const partial = fullLockedLive("Finalizing");
  partial.lockMask = 3;
  assert.equal(ui({live: partial}).primary, "refreshAuthority");
  const badRevision = fullLockedLive("Finalizing");
  badRevision.lockedRevision[2] -= 1n;
  assert.equal(ui({live: badRevision}).primary, "refreshAuthority");
  const badHash = fullLockedLive("Finalized");
  badHash.lockedHash[2] = key(7);
  assert.equal(ui({live: badHash, authority: baseAuthority()}).primary, "inspectCommit");
  assert.equal(ui({live: fullLockedLive("Finalizing")}).primary, "finalizeCommitOnly");
  assert.equal(ui({live: fullLockedLive("Finalized"), authority: baseAuthority()}).primary, "settleCommitted");
});

test("treats the exact expiry timestamp as expired in Funding and Active", () => {
  assert.equal(ui({core: baseCore({status: "Funding", expiresAt: 1_000n})}).primary, "cancelExpired");
  assert.equal(ui({core: baseCore({status: "Active", expiresAt: 1_000n})}).primary, "cancelExpired");
});

test("Cancelled rooms with nothing left to return have a truthful terminal receipt", () => {
  assert.equal(ui({core: baseCore({status: "Cancelled", depositedMask: 0})}).primary, "viewReceipt");
  assert.equal(ui({core: baseCore({status: "Cancelled", returnedMask: 63})}).primary, "viewReceipt");
});

test("every UI state has a non-empty recovery and disconnected permissionless states request a signer", () => {
  const states = [
    ui(),
    ui({core: undefined}),
    ui({core: baseCore({status: "Complete"})}),
    ui({core: baseCore({status: "Active", expiresAt: 999n}), role: {kind: "disconnected"}}),
    ui({live: fullLockedLive("Finalized"), authority: baseAuthority(), role: {kind: "disconnected"}}),
    ui({core: baseCore({status: "Cancelled"}), role: {kind: "disconnected"}}),
  ];
  states.forEach(value => assert.ok(value.recovery.trim().length > 0));
  assert.deepEqual(states.slice(3).map(value => value.primary), ["connectWallet", "connectWallet", "connectWallet"]);
});
