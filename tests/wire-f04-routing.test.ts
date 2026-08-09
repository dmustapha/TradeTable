import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {basePollSource} from "../src/lib/tradetable";

test("base fallback polling remains visible in projection provenance", () => {
  assert.equal(basePollSource(false), "base-poll");
  assert.equal(basePollSource(true), "base-fallback-poll");
});

test("fallback account discovery also routes dependent mint and signature reads", () => {
  const page = readFileSync("src/app/page.tsx", "utf8");
  assert.match(page, /const baseReader = coreResult\?\.connection \?\? base/);
  assert.match(page, /baseReader\.getMultipleAccountsInfo/);
  assert.match(page, /baseReader\.getSignaturesForAddress/);
  assert.match(page, /getDelegationRecord\(baseLiveResult\?\.connection \?\? base/);
});
