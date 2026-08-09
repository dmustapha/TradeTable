import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {resolve} from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path));
const text = (path: string) => read(path).toString("utf8");

test("public UI separates local composed proof from public Devnet proof", () => {
  const page = text("src/app/page.tsx");
  assert.match(page, /LOCAL-VALIDATOR PROOF ONLY/);
  assert.match(page, /PUBLIC DEVNET: COMMIT-ONLY \+ BASE SETTLEMENT/);
});

test("public UI explains failed-action state and pre-scheduling recovery", () => {
  const page = text("src/app/page.tsx");
  assert.match(page, /base custody unchanged/i);
  assert.match(page, /ER can remain Finalized\/stuck/);
  assert.match(page, /not an ER rollback/i);
  assert.match(page, /choose Normal Settlement before scheduling/i);
});

test("public copy never claims all six assets transfer atomically", () => {
  const publicCopy = [text("src/app/page.tsx"), text("src/app/layout.tsx")].join("\n");
  assert.doesNotMatch(publicCopy, /all six.{0,40}(atomically|atomic)|(?:atomically|atomic).{0,40}all six/i);
  assert.match(publicCopy, /ATOMIC BOUNDARY: SELECTED THREE ONLY/);
});

test("public proof contains Devnet commit-only and base settlement evidence only", () => {
  const proof = text("submission/proof.md");
  assert.match(proof, /Commit-only ER:/);
  assert.match(proof, /Settlement: https:\/\/explorer\.solana\.com\/tx\//);
  assert.doesNotMatch(proof, /composed magic action/i);
});

test("checked-in and generated IDLs are byte-identical", () => {
  const client = read("src/idl/tradetable.json");
  const generated = read("target/idl/tradetable.json");
  assert.deepEqual(client, generated);
  assert.equal(createHash("sha256").update(client).digest("hex"), "49a63aef51ed0cc4534d1157c51eda6de8ef4defead0f3c0ce6c7bd0df3dbfc5");
});

test("headless validator deviation preserves lifecycle and has real health evidence", () => {
  const evidence = text(".local-env-evidence.md");
  assert.match(evidence, /--lifecycle ephemeral --no-tui/);
  assert.match(evidence, /"result":"ok"/);
  assert.match(evidence, /ephemeral-validator PID \d+: TCP 127\.0\.0\.1:7799 \(LISTEN\)/);
});
