import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {PublicKey} from "@solana/web3.js";

import {
  FEATURED_ROOM_CORE,
  buildRoomEvidence,
  featuredEvidenceForRoom,
  type RoomEvidenceSnapshot,
} from "../../src/lib/evidence";
import type {LoadedRoom} from "../../src/lib/room-loader";
import type {RoomCore, RoomLive} from "../../src/lib/room-state";

const key = (value: number) => Uint8Array.from({length: 32}, () => value);

function loadedRoom(overrides: Partial<LoadedRoom> = {}): LoadedRoom {
  const address = new PublicKey(key(9));
  const liveAddress = new PublicKey(key(8));
  const participants = [key(1), key(2), key(3)] as RoomCore["participants"];
  const core = {
    status: "Active", depositedMask: 63, returnedMask: 0, selectedMask: 0,
    participants, assets: Array.from({length: 6}, (_, slot) => ({
      mint: key(20 + slot), vault: key(30 + slot), originalOwner: participants[Math.floor(slot / 2)],
      originalAta: key(40 + slot), finalAta: key(0), depositedAt: 1n, flags: 1,
    })),
  } as unknown as RoomCore;
  const live = {phase: "Finalized", revision: 7n, lockMask: 7} as RoomLive;
  return {address, liveAddress, core, live, authority: "solana-base", authorityEndpoint: "https://api.devnet.solana.com", delegated: false, observedAt: 1, ...overrides};
}

test("featured evidence is immutable and keyed only by its earned RoomCore", () => {
  const featured = featuredEvidenceForRoom(FEATURED_ROOM_CORE);
  assert.ok(featured);
  assert.equal(featured.roomCore, FEATURED_ROOM_CORE);
  assert.equal(featured.base.settlement.length, 1);
  assert.equal(featured.base.returns.length, 3);
  assert.equal(new Set(featured.base.returns.map(item => item.signature)).size, 3);
  assert.equal(featured.base.settlement[0].selectedAssetCount, 3);
  assert.equal(featured.base.settlement[0].selectedMask, 21);
  assert.equal(featuredEvidenceForRoom(new PublicKey(key(7)).toBase58()), null);
  assert.equal(Object.isFrozen(featured), true);
  assert.equal(Object.isFrozen(featured.base.returns), true);
});

test("ER evidence never receives a Solana Explorer transaction target", () => {
  const featured = featuredEvidenceForRoom(FEATURED_ROOM_CORE)!;
  assert.equal(featured.er.transactions.length, 1);
  for (const evidence of featured.er.transactions) {
    assert.equal(evidence.kind, "commit-only");
    assert.doesNotMatch(evidence.href, /explorer\.solana\.com/i);
    assert.match(evidence.href, /magicblock/i);
  }
  for (const evidence of [...featured.base.settlement, ...featured.base.returns]) {
    assert.match(evidence.href, /explorer\.solana\.com\/tx\//i);
  }
});

test("the featured ledger retains every previously earned public identity and signature", () => {
  const featured = featuredEvidenceForRoom(FEATURED_ROOM_CORE)!;
  const addresses = featured.base.accounts.map(item => item.address);
  assert.ok(addresses.includes("FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3"));
  assert.ok(addresses.includes("3kXZXTVz94dTppTeaPCYbXSyqvf14Tf12LT9pN7WAfew"));
  assert.ok(addresses.includes("46r8db8EKsrtzz2btXfxLz8A3vSX1FHmbw3ynpzSAbD1"));
  const signatures = [...featured.base.maintenance, ...featured.base.settlement, ...featured.base.returns].map(item => item.signature);
  assert.ok(signatures.includes("33hFq3TbMZ6udbYQnNK5EdWaxsTSKdVsv8bqXuPYo1r9JqNvc89usdu7c3BKBxLihm7CZqUjLrgogNMuJafZxzby"));
  assert.ok(signatures.includes("3yhzSXkxDny8DY345Pirf7qfxJWtDSwnUkuYucdcRM6xxHdRL6vMW9LE75NVxkdqiM7cyuPPczCsXpfaFFftmkja"));
});

test("current room evidence separates verified account state from unindexed history", () => {
  const room = loadedRoom();
  const evidence = buildRoomEvidence(room);
  assert.equal(evidence.identity.roomCore, room.address.toBase58());
  assert.equal(evidence.identity.roomLive, room.liveAddress.toBase58());
  assert.equal(evidence.current.coreStatus, "Active");
  assert.equal(evidence.current.livePhase, "Finalized");
  assert.equal(evidence.current.authority, "solana-base");
  assert.equal(evidence.current.vaults.length, 6);
  assert.equal(evidence.history.kind, "unindexed");
  assert.equal(evidence.history.message, "ER history not indexed");
  assert.equal(evidence.featured, null);
});

test("ER-only Finalized state is explicitly ineligible for base settlement", () => {
  const evidence = buildRoomEvidence(loadedRoom({authority: "magicblock-er", delegated: true}));
  assert.equal(evidence.current.settlementEligible, false);
  assert.match(evidence.current.settlementReason, /ER-only Finalized/i);
  assert.match(evidence.current.settlementReason, /not settlement eligible/i);
});

test("base Finalized Active state is settlement eligible only when undelegated", () => {
  const ready = buildRoomEvidence(loadedRoom());
  assert.equal(ready.current.settlementEligible, true);
  const settled = buildRoomEvidence(loadedRoom({core: {...loadedRoom().core, status: "Complete"}}));
  assert.equal(settled.current.settlementEligible, false);
});

test("all evidence anchors are unique and claims preserve the exact atomic boundary", () => {
  const evidence = buildRoomEvidence(loadedRoom({address: new PublicKey(FEATURED_ROOM_CORE)}));
  const anchors = collectAnchors(evidence);
  assert.equal(new Set(anchors).size, anchors.length);
  assert.match(evidence.boundary.selected, /exactly three selected assets.*one Solana base transaction/i);
  assert.match(evidence.boundary.returns, /exactly three unselected assets.*three separate Solana base transactions/i);
  const serialized = JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  assert.doesNotMatch(serialized, /all six.*atomic|is an ER rollback|rolled back on ER/i);
  assert.match(evidence.boundary.failure, /not described as an ER rollback/i);
});

test("room proof validates through loadRoom and compatibility proof never fabricates a room", async () => {
  const [roomProof, compatibility] = await Promise.all([
    readFile(new URL("../../src/app/rooms/[core]/proof/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/proof/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(roomProof, /canonicalRoomAddress/);
  assert.match(roomProof, /loadRoom/);
  assert.match(roomProof, /buildRoomEvidence/);
  assert.match(roomProof, /ER history not indexed/);
  assert.match(compatibility, /NEXT_PUBLIC_DEMO_ROOM/);
  assert.match(compatibility, /OpenRoomForm/);
  assert.match(compatibility, /rooms\/\$\{featuredRoom\}\/proof/);
  assert.doesNotMatch(compatibility, /9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo/);
});

function collectAnchors(evidence: RoomEvidenceSnapshot): string[] {
  const current = [evidence.identity.coreAnchor, evidence.identity.liveAnchor, ...evidence.current.vaults.map(item => item.anchor)];
  if (!evidence.featured) return current;
  return [...current, ...evidence.featured.er.transactions.map(item => item.anchor),
    ...evidence.featured.base.accounts.map(item => item.anchor),
    ...evidence.featured.base.settlement.map(item => item.anchor),
    ...evidence.featured.base.returns.map(item => item.anchor)];
}
