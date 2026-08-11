import {PublicKey} from "@solana/web3.js";

import type {PendingWrite} from "./room-actions";
import type {CoreStatus, LivePhase, RoomCore, RoomLive} from "./room-state";
import {allocationHash, livePda} from "./tradetable";
import type {SignedIntent} from "./tradetable";

export const UI_FIXTURE_SCENARIOS = [
  "funding", "funded", "negotiating", "finalizing", "er-stuck", "settle-ready",
  "returning", "cancelled", "complete", "expired", "pending-timeout",
] as const;
export type UiFixtureScenario = typeof UI_FIXTURE_SCENARIOS[number];

const key = (value: number) => new PublicKey(Uint8Array.from({length: 32}, () => value));
export const UI_FIXTURE_CORE = key(90);
export const UI_FIXTURE_PARTICIPANTS = [key(11), key(12), key(13)] as const;
export const UI_FIXTURE_OBSERVER = key(99);

type FixtureOptions = {
  status: CoreStatus;
  phase?: LivePhase;
  depositedMask?: number;
  returnedMask?: number;
  selectedMask?: number;
  lockMask?: number;
  delegated?: boolean;
  expired?: boolean;
  pending?: PendingWrite;
};

function assets(): RoomCore["assets"] {
  return Array.from({length: 6}, (_, slot) => ({
    mint: key(21 + slot).toBytes(), vault: key(31 + slot).toBytes(),
    originalOwner: UI_FIXTURE_PARTICIPANTS[Math.floor(slot / 2)].toBytes(),
    originalAta: key(41 + slot).toBytes(), finalAta: key(51 + slot).toBytes(),
    depositedAt: 1_700_000_000n + BigInt(slot), flags: 1,
  })) as RoomCore["assets"];
}

function liveState(expiresAt: bigint, phase: LivePhase, lockMask: number): RoomLive {
  const revision = 4n;
  const hash = allocationHash(UI_FIXTURE_CORE, revision, expiresAt, [0, 2, 4], "forward");
  const locked = (index: number) => lockMask & (1 << index) ? revision : 0n;
  const lockedHash = (index: number) => lockMask & (1 << index) ? new Uint8Array(hash) : new Uint8Array(32);
  return {version: 1, bump: 1, core: UI_FIXTURE_CORE.toBytes(), participants: UI_FIXTURE_PARTICIPANTS.map(item => item.toBytes()) as RoomLive["participants"],
    expiresAt, revision, selectedSlots: [0, 2, 4], cycle: "forward", destinations: [1, 2, 0], allocationHash: hash,
    lockedRevision: [locked(0), locked(1), locked(2)], lockedHash: [lockedHash(0), lockedHash(1), lockedHash(2)],
    lockMask, phase, lastActor: UI_FIXTURE_PARTICIPANTS[0].toBytes(), lastAction: phase === "Finalized" ? "Finalized" : lockMask ? "Locked" : "Proposed",
    updatedAt: 1_700_000_100n, reserved: new Uint8Array(64)};
}

function coreState(expiresAt: bigint, options: FixtureOptions, live: RoomLive): RoomCore {
  return {version: 1, coreBump: 1, liveBump: 1, vaultAuthorityBump: 1,
    creator: UI_FIXTURE_PARTICIPANTS[0].toBytes(), roomNonce: 1n,
    participants: UI_FIXTURE_PARTICIPANTS.map(item => item.toBytes()) as RoomCore["participants"],
    liveRoom: livePda(UI_FIXTURE_CORE)[0].toBytes(), assets: assets(), depositedMask: options.depositedMask ?? 63,
    returnedMask: options.returnedMask ?? 0, selectedMask: options.selectedMask ?? 0, status: options.status,
    createdAt: 1_700_000_000n, expiresAt, settledRevision: options.selectedMask ? live.revision : 0n,
    allocationHash: options.selectedMask ? new Uint8Array(live.allocationHash) : new Uint8Array(32),
    rentPayer: UI_FIXTURE_PARTICIPANTS[0].toBytes(), reserved: new Uint8Array(64)};
}

function timedOutPending(live: RoomLive): PendingWrite {
  const now = Date.now();
  return {action: "lock", expectation: {kind: "lock", actorIndex: 0, revision: live.revision, allocationHash: live.allocationHash},
    phase: "timed-out", startedAt: now - 60_000, updatedAt: now - 1_000, timeoutAt: now - 15_000,
    signature: "fixture-er-signature", network: "magicblock-er", evidence: {kind: "raw-er-signature", endpoint: "https://devnet-as.magicblock.app/"},
    error: "Authoritative postcondition was not observed before the bounded timeout.", refreshAuthority: true, canBlindRetry: false};
}

function optionsFor(scenario: UiFixtureScenario): FixtureOptions {
  if (scenario === "funding") return {status: "Funding", depositedMask: 0, delegated: false};
  if (scenario === "funded") return {status: "Funding", depositedMask: 63, delegated: false};
  if (scenario === "finalizing") return {status: "Active", phase: "Finalizing", lockMask: 7, delegated: true};
  if (scenario === "er-stuck") return {status: "Active", phase: "Finalized", lockMask: 7, delegated: true};
  if (scenario === "settle-ready") return {status: "Active", phase: "Finalized", lockMask: 7, delegated: false};
  if (scenario === "returning") return {status: "Returning", phase: "Finalized", lockMask: 7, selectedMask: 21, returnedMask: 2, delegated: false};
  if (scenario === "cancelled") return {status: "Cancelled", phase: "Negotiating", lockMask: 0, delegated: false};
  if (scenario === "complete") return {status: "Complete", phase: "Finalized", lockMask: 7, selectedMask: 21, returnedMask: 42, delegated: false};
  if (scenario === "expired") return {status: "Active", phase: "Negotiating", delegated: true, expired: true};
  return {status: "Active", phase: "Negotiating", delegated: true};
}

export function fixtureRoom(scenario: UiFixtureScenario) {
  const options = optionsFor(scenario);
  const expiresAt = BigInt(Math.floor(Date.now() / 1_000) + (options.expired ? -60 : 3_600));
  const live = liveState(expiresAt, options.phase ?? "Negotiating", options.lockMask ?? 0);
  const core = coreState(expiresAt, options, live);
  const pending = scenario === "pending-timeout" ? timedOutPending(live) : undefined;
  const recovery: SignedIntent | undefined = pending ? {signature: pending.signature!, endpoint: "direct", recentBlockhash: "fixture-blockhash", rpcUrl: pending.evidence!.endpoint} : undefined;
  return {room: UI_FIXTURE_CORE.toBase58(), core, live, delegated: options.delegated ?? false,
    authority: options.delegated ? "magicblock-er" as const : "solana-base" as const, pending, recovery};
}

export function isUiFixtureScenario(value: string): value is UiFixtureScenario {
  return UI_FIXTURE_SCENARIOS.includes(value as UiFixtureScenario);
}
