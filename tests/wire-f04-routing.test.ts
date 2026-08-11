import assert from "node:assert/strict";
import {test} from "node:test";
import {PublicKey} from "@solana/web3.js";
import {basePollSource} from "../src/lib/tradetable";
import {readAccountFromSources} from "../src/lib/room-loader";

test("base fallback polling remains visible in projection provenance", () => {
  assert.equal(basePollSource(false), "base-poll");
  assert.equal(basePollSource(true), "base-fallback-poll");
});

test("fallback account discovery reports the authoritative endpoint", async () => {
  const address = PublicKey.default;
  const account = {owner: PublicKey.default, data: Buffer.alloc(8)};
  const result = await readAccountFromSources(address, [
    {label: "primary", read: async () => { throw new Error("offline"); }},
    {label: "fallback", read: async () => account},
  ], 20);
  assert.equal(result.kind, "found");
  if (result.kind === "found") {
    assert.equal(result.endpoint, "fallback");
    assert.equal(result.account, account);
  }
});
