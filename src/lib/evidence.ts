import {PublicKey} from "@solana/web3.js";

import type {LoadedRoom} from "./room-loader";
import {BASE_RPC, explorerAddress} from "./tradetable";

export const FEATURED_ROOM_CORE = "9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo";

type EvidenceAccount = {anchor: string; label: string; address: string; href: string};
type ErTransaction = {anchor: string; label: string; kind: "commit-only"; signature: string; href: string};
type SettlementTransaction = EvidenceTransaction & {selectedAssetCount: 3; selectedMask: 21};
type EvidenceTransaction = {anchor: string; label: string; signature: string; href: string};

export type FeaturedRoomEvidence = Readonly<{
  roomCore: string;
  er: Readonly<{transactions: readonly ErTransaction[]; note: string}>;
  base: Readonly<{
    accounts: readonly EvidenceAccount[];
    maintenance: readonly EvidenceTransaction[];
    settlement: readonly SettlementTransaction[];
    returns: readonly EvidenceTransaction[];
  }>;
}>;

export type CurrentVaultEvidence = {
  anchor: string;
  slot: number;
  mint: string | null;
  vault: string | null;
  href: string | null;
  deposited: boolean;
  selected: boolean;
  returned: boolean;
};

export type RoomEvidenceSnapshot = {
  identity: {roomCore: string; roomLive: string; coreAnchor: string; liveAnchor: string; coreHref: string | null; liveHref: string | null};
  current: {
    coreStatus: string; livePhase: string; revision: bigint; lockMask: number;
    authority: LoadedRoom["authority"]; authorityEndpoint: string; delegated: boolean;
    vaults: CurrentVaultEvidence[]; settlementEligible: boolean; settlementReason: string;
  };
  history: {kind: "earned" | "unindexed"; message: string};
  featured: FeaturedRoomEvidence | null;
  boundary: {selected: string; returns: string; failure: string};
};

const explorer = "https://explorer.solana.com";
const devnet = "?cluster=devnet";
const tx = (signature: string) => `${explorer}/tx/${signature}${devnet}`;
const account = (address: string) => `${explorer}/address/${address}${devnet}`;

const accounts = Object.freeze([
  {anchor: "earned-program-account", label: "TradeTable program", address: "FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3", href: account("FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3")},
  {anchor: "earned-program-data-account", label: "TradeTable ProgramData", address: "3kXZXTVz94dTppTeaPCYbXSyqvf14Tf12LT9pN7WAfew", href: account("3kXZXTVz94dTppTeaPCYbXSyqvf14Tf12LT9pN7WAfew")},
  {anchor: "earned-room-core-account", label: "RoomCore", address: FEATURED_ROOM_CORE, href: account(FEATURED_ROOM_CORE)},
  {anchor: "earned-room-live-account", label: "RoomLive", address: "46r8db8EKsrtzz2btXfxLz8A3vSX1FHmbw3ynpzSAbD1", href: account("46r8db8EKsrtzz2btXfxLz8A3vSX1FHmbw3ynpzSAbD1")},
] as const);

const erTransactions = Object.freeze([
  {anchor: "earned-er-commit-only", label: "Commit-only finalization", kind: "commit-only", signature: "2fpZgMn89JbMQBWfcxDkoFmqcZeGNmbiskc9v5ym97uqYxUdaND2KP8coc3GJbTtNCbuUV6TBtjJCXYuaRby7yJc", href: "https://devnet-as.magicblock.app/"},
] as const);

const maintenance = Object.freeze([
  {anchor: "earned-base-program-deployment", label: "Program deployment", signature: "33hFq3TbMZ6udbYQnNK5EdWaxsTSKdVsv8bqXuPYo1r9JqNvc89usdu7c3BKBxLihm7CZqUjLrgogNMuJafZxzby", href: tx("33hFq3TbMZ6udbYQnNK5EdWaxsTSKdVsv8bqXuPYo1r9JqNvc89usdu7c3BKBxLihm7CZqUjLrgogNMuJafZxzby")},
  {anchor: "earned-base-security-upgrade", label: "Funding-only participant cancellation upgrade", signature: "3yhzSXkxDny8DY345Pirf7qfxJWtDSwnUkuYucdcRM6xxHdRL6vMW9LE75NVxkdqiM7cyuPPczCsXpfaFFftmkja", href: tx("3yhzSXkxDny8DY345Pirf7qfxJWtDSwnUkuYucdcRM6xxHdRL6vMW9LE75NVxkdqiM7cyuPPczCsXpfaFFftmkja")},
] as const);

const settlement = Object.freeze([
  {anchor: "earned-base-selected-three", label: "Selected-three settlement", signature: "2vsmk7HDrWzRTAG1sbY9U7oFS14mgZ4CgZQZ5nDCSmxSPoe71wWUAXKZFmSF2UKwdsCMBdtSbKzXyqScMpTH6BX5", href: tx("2vsmk7HDrWzRTAG1sbY9U7oFS14mgZ4CgZQZ5nDCSmxSPoe71wWUAXKZFmSF2UKwdsCMBdtSbKzXyqScMpTH6BX5"), selectedAssetCount: 3, selectedMask: 21},
] as const);

const returns = Object.freeze([
  ["earned-base-return-01", "Separate return 01", "5fArNw2GtfLHK5vq344wPnqqGrb9t2bYzabfLYQNrwAbJs5egj4ydhcposp5NWBZR3mtQToepCb6NXCdSN7391ms"],
  ["earned-base-return-02", "Separate return 02", "3u98udn2X1XBzYzepb8Mm8wvHsKcuM7Vc3Gq6A4pX5CG83VoiSJBM3qucxbiyJtYa9xvV1xwrr7bqXLnTMUGR26y"],
  ["earned-base-return-03", "Separate return 03", "4zWBZnCW2y4dEygfLoL8cFVNCXAKAxQo1tBiYp7YYsdDJRz7EjVPhKoCQHf5GnD2Zazoxsipz5fH8fMcQx9nFHVj"],
].map(([anchor, label, signature]) => Object.freeze({anchor, label, signature, href: tx(signature)})));

const FEATURED = Object.freeze({
  roomCore: FEATURED_ROOM_CORE,
  er: Object.freeze({transactions: erTransactions, note: "Only the earned raw commit-only ER signature is recorded here. Proposal and lock history was not indexed."}),
  base: Object.freeze({accounts, maintenance, settlement, returns: Object.freeze(returns)}),
}) satisfies FeaturedRoomEvidence;

export function featuredEvidenceForRoom(roomCore: string): FeaturedRoomEvidence | null {
  return roomCore === FEATURED_ROOM_CORE ? FEATURED : null;
}

function publicBaseExplorerAvailable(): boolean {
  try { return !["localhost", "127.0.0.1", "::1"].includes(new URL(BASE_RPC).hostname); }
  catch { return false; }
}

function publicKeyOrNull(value: Uint8Array): string | null {
  const address = new PublicKey(value);
  return address.equals(PublicKey.default) ? null : address.toBase58();
}

function settlementState(room: LoadedRoom): {eligible: boolean; reason: string} {
  if (room.live.phase === "Finalized" && (room.authority === "magicblock-er" || room.delegated)) {
    return {eligible: false, reason: "ER-only Finalized is not settlement eligible. Wait and inspect; use expiry recovery only when eligible."};
  }
  const eligible = room.core.status === "Active" && room.live.phase === "Finalized" && !room.delegated;
  return eligible
    ? {eligible, reason: "Program-owned, undelegated base RoomLive is Finalized while RoomCore is Active."}
    : {eligible, reason: "Current verified base and authority state does not permit settlement."};
}

function currentVaults(room: LoadedRoom): CurrentVaultEvidence[] {
  const canLink = publicBaseExplorerAvailable();
  return room.core.assets.map((asset, slot) => {
    const vault = publicKeyOrNull(asset.vault);
    return {anchor: `current-vault-slot-${slot}`, slot, mint: publicKeyOrNull(asset.mint), vault,
      href: vault && canLink ? explorerAddress(new PublicKey(vault)) : null,
      deposited: Boolean(room.core.depositedMask & (1 << slot)), selected: Boolean(room.core.selectedMask & (1 << slot)),
      returned: Boolean(room.core.returnedMask & (1 << slot))};
  });
}

export function buildRoomEvidence(room: LoadedRoom): RoomEvidenceSnapshot {
  const roomCore = room.address.toBase58();
  const roomLive = room.liveAddress.toBase58();
  const featured = featuredEvidenceForRoom(roomCore);
  const settlement = settlementState(room);
  const canLink = publicBaseExplorerAvailable();
  return {
    identity: {roomCore, roomLive, coreAnchor: "current-room-core", liveAnchor: "current-room-live",
      coreHref: canLink ? explorerAddress(room.address) : null, liveHref: canLink ? explorerAddress(room.liveAddress) : null},
    current: {coreStatus: room.core.status, livePhase: room.live.phase, revision: room.live.revision,
      lockMask: room.live.lockMask, authority: room.authority, authorityEndpoint: room.authorityEndpoint,
      delegated: room.delegated, vaults: currentVaults(room), settlementEligible: settlement.eligible,
      settlementReason: settlement.reason},
    history: featured ? {kind: "earned", message: "Immutable earned evidence is indexed for this RoomCore."}
      : {kind: "unindexed", message: "ER history not indexed"},
    featured,
    boundary: {
      selected: "Exactly three selected assets settle atomically in one Solana base transaction.",
      returns: "Exactly three unselected assets return through three separate Solana base transactions.",
      failure: "A failed asynchronous Magic Action is not described as an ER rollback.",
    },
  };
}
