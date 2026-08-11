import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("browser lifecycle fixtures are explicitly gated and use the real room client", async () => {
  const page = await readFile(new URL("src/app/test-fixtures/rooms/[scenario]/page.tsx", root), "utf8");
  assert.match(page, /UI_TEST_FIXTURES/);
  assert.match(page, /notFound\(\)/);
  assert.match(page, /from "\.\.\/\.\.\/\.\.\/room-client"/);
  assert.match(page, /<RoomClient/);
  assert.match(page, /fixtureRoom/);
});

test("fixture catalog covers every browser-visible lifecycle boundary", async () => {
  const source = await readFile(new URL("src/lib/ui-test-fixtures.ts", root), "utf8");
  for (const scenario of [
    "funding", "funded", "negotiating", "finalizing", "er-stuck", "settle-ready",
    "returning", "cancelled", "complete", "expired", "pending-timeout",
  ]) assert.match(source, new RegExp(`\\b${scenario.replace("-", "\\-")}\\b`));
});

test("normal room subscriptions are disabled only for explicit test fixtures", async () => {
  const source = await readFile(new URL("src/app/room-client.tsx", root), "utf8");
  assert.match(source, /testFixture/);
  assert.match(source, /initialSignedRecovery/);
  assert.match(source, /Deterministic browser fixtures never sign or broadcast/);
  assert.match(source, /if \(disabled\) return/);
});
