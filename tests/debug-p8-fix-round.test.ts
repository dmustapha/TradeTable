import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {
  destinations,
  pendingPostconditionMet,
  primaryThenFallback,
  selectedSlotsFromChoices,
  withTimeout,
} from "../src/lib/tradetable";

const source = (path: string) => readFileSync(path, "utf8");
const hash = (value: number) => Array(32).fill(value);

test("one chain-derived slot per owner and either cycle form the proposal", () => {
  assert.deepEqual(selectedSlotsFromChoices([1, 0, 1]), [1, 2, 5]);
  assert.deepEqual(selectedSlotsFromChoices([0, 1, 0]), [0, 3, 4]);
  assert.throws(() => selectedSlotsFromChoices([0, 2, 0]), /choice/);
  assert.deepEqual(destinations("forward"), [1, 2, 0]);
  assert.deepEqual(destinations("reverse"), [2, 0, 1]);
});

test("pending proposal completion requires its exact authoritative result", () => {
  const pending = {kind: "propose" as const, actorIndex: 0, revision: 8n, slots: [1, 2, 5] as [number, number, number], cycle: "reverse" as const, allocationHash: hash(7)};
  const exact = {revision: 8n, selectedSlots: [1, 2, 5] as [number, number, number], cycle: "reverse" as const, allocationHash: hash(7), lockMask: 0, lockedRevision: [0n, 0n, 0n], lockedHash: [hash(0), hash(0), hash(0)]};
  assert.equal(pendingPostconditionMet(pending, exact), true);
  assert.equal(pendingPostconditionMet(pending, {...exact, selectedSlots: [0, 2, 4]}), false);
  assert.equal(pendingPostconditionMet(pending, {...exact, revision: 9n}), false);
});

test("pending lock completion requires the exact actor bit, revision, and hash", () => {
  const pending = {kind: "lock" as const, actorIndex: 1, revision: 4n, allocationHash: hash(9)};
  const view = {revision: 4n, selectedSlots: [0, 2, 4] as [number, number, number], cycle: "forward" as const, allocationHash: hash(9), lockMask: 2, lockedRevision: [0n, 4n, 0n], lockedHash: [hash(0), hash(9), hash(0)]};
  assert.equal(pendingPostconditionMet(pending, view), true);
  assert.equal(pendingPostconditionMet(pending, {...view, lockMask: 4}), false);
  assert.equal(pendingPostconditionMet(pending, {...view, lockedRevision: [0n, 3n, 0n]}), false);
});

test("base reads use fallback only after primary error or null", async () => {
  const calls: string[] = [];
  const primary = async () => { calls.push("primary"); return "base"; };
  const fallback = async () => { calls.push("fallback"); return "backup"; };
  assert.equal(await primaryThenFallback(primary, fallback), "base");
  assert.deepEqual(calls, ["primary"]);
  assert.equal(await primaryThenFallback(async () => null, fallback), "backup");
  assert.equal(await primaryThenFallback(async () => { throw new Error("down"); }, fallback), "backup");
});

test("network timeout, loading boundary, and retry boundary are explicit", async () => {
  await assert.rejects(withTimeout(new Promise(() => undefined), 5, "rpc read"), /rpc read timed out/);
  assert.match(source("src/app/loading.tsx"), /Loading verified room state/);
  assert.match(source("src/app/error.tsx"), /reset\(\)/);
  assert.match(source("src/lib/tradetable.ts"), /AbortSignal\.timeout/);
});

test("landing routes to room-scoped proof and never constructs a consequence", () => {
  const page = source("src/app/page.tsx");
  const proof = source("src/app/rooms/[core]/proof/page.tsx");
  assert.match(page, /href="\/proof"/);
  assert.match(page, /Open earned demo/);
  assert.doesNotMatch(page, /sendBase|sendErWithFallback|CONSEQUENCE ROUTER/);
  assert.match(proof, /canonicalRoomAddress/);
  assert.match(proof, /loadRoom/);
  assert.match(proof, /buildRoomEvidence/);
});

test("proof worker validates exact settlement semantics before writing evidence", () => {
  const ops = source("scripts/ops.ts");
  for (const claim of [
    /SETTLE_COMMITTED_DISCRIMINATOR/,
    /validateRoomLinkage/,
    /validateSettlementInstruction/,
    /validateTransferChecked/,
    /selectedMask/,
    /PUBLIC DEVNET EVIDENCE BOUNDARY/,
  ]) assert.match(ops, claim);
  assert.ok(ops.indexOf("validateSettlementInstruction") < ops.indexOf("writeFileSync(\"submission/proof.md\""));
});

test("the local source is an explicit Deploy-ready artifact without claiming publication", () => {
  const artifact = source("../../debug-results/deploy-ready-local-verification.md");
  assert.match(artifact, /P7-FE-001: LOCALLY READY/);
  assert.match(artifact, /Owner: Deploy/);
  assert.match(artifact, /not yet published/);
});
