import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {resolve} from "node:path";
import {Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction} from "@solana/web3.js";
import type {Wallet} from "@coral-xyz/anchor";
import {
  acceptSourceSlot,
  emptyWatermarks,
  isProjectionStale,
  liveSourceIsAuthoritative,
  sendErWithFallback,
  subscribeAuthoritative,
} from "../src/lib/tradetable";

const APP = "https://app-gray-seven-93.vercel.app";
const PROGRAM = "FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3";
const ROOM = new PublicKey("9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo");
const LIVE = new PublicKey("46r8db8EKsrtzz2btXfxLz8A3vSX1FHmbw3ynpzSAbD1");
const source = (path: string) => readFileSync(resolve(path), "utf8");

test("wallet-absent and empty-data states keep writes disabled and render honest fallbacks", () => {
  const client = source("src/app/room-client.tsx");
  const page = source("src/app/page.tsx");
  assert.match(client, /!wallet\?\.publicKey \|\| !view \|\| stale \|\| Boolean\(pending\) \|\| view\.phase !== 0/);
  assert.match(client, /An injected Solana wallet is required/);
  assert.match(page, /AWAITING ROOM/);
  assert.match(page, /NO FABRICATED ASSET/);
  assert.match(page, /Proof is unavailable, never simulated/);
});

test("slow or stale projections cross the five-second write-disable boundary exactly", () => {
  assert.equal(isProjectionStale(1_000, 6_000), false);
  assert.equal(isProjectionStale(1_000, 6_001), true);
  assert.equal(isProjectionStale(10_000, 9_999), false);
});

test("authority switches reject old sources while preserving independent source watermarks", () => {
  assert.equal(liveSourceIsAuthoritative("base-poll", false, false), true);
  assert.equal(liveSourceIsAuthoritative("base-poll", true, true), false);
  assert.equal(liveSourceIsAuthoritative("router-poll", true, false), true);
  assert.equal(liveSourceIsAuthoritative("er-poll", true, true), true);
  assert.equal(liveSourceIsAuthoritative("er-poll", true, false), false);
  const watermarks = emptyWatermarks();
  assert.equal(acceptSourceSlot(watermarks, "base-poll", 200), true);
  assert.equal(acceptSourceSlot(watermarks, "router-poll", 10), true);
  assert.equal(acceptSourceSlot(watermarks, "base-poll", 199), false);
});

test("injected wallet rejection propagates once without a second direct-ER signing prompt", async () => {
  let signCalls = 0;
  const publicKey = Keypair.generate().publicKey;
  const wallet = {
    publicKey,
    signTransaction: async <T extends Transaction | VersionedTransaction>(_value: T): Promise<T> => {
      signCalls += 1;
      throw new Error("USER_REJECTED");
    },
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(values: T[]): Promise<T[]> => values,
  } as Wallet;
  const instruction = new TransactionInstruction({programId: new PublicKey(PROGRAM), keys: [{pubkey: LIVE, isSigner: false, isWritable: true}]});
  await assert.rejects(sendErWithFallback(wallet, instruction), /USER_REJECTED/);
  assert.equal(signCalls, 1);
});

test("real public app exposes proof-first states with no API dependency", async () => {
  const response = await fetch(APP, {signal: AbortSignal.timeout(20_000)});
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /ATOMIC BOUNDARY: SELECTED THREE ONLY/);
  assert.match(html, /CONNECT PRIMARY WALLET/);
  assert.doesNotMatch(html, /all six.{0,40}(atomically|atomic)/i);
});

test("real authority subscriptions stop cleanly and suppress post-cleanup publishes", async () => {
  process.env.NEXT_PUBLIC_PROGRAM_ID = PROGRAM;
  let publishes = 0;
  const stop = subscribeAuthoritative(ROOM, LIVE, () => { publishes += 1; }, () => { publishes += 1; });
  await new Promise(resolveDelay => setTimeout(resolveDelay, 2_300));
  await stop();
  const stoppedAt = publishes;
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1_300));
  assert.equal(publishes, stoppedAt);
});

test("pending suppression, recovery messaging, and public proof boundaries remain explicit", () => {
  const client = source("src/app/room-client.tsx");
  const page = source("src/app/page.tsx");
  assert.match(client, /setPending\(marker\)/);
  assert.match(client, /Boolean\(pending\)/);
  assert.match(client, /setPending\(null\); setError/);
  assert.match(page, /LOCAL-VALIDATOR PROOF ONLY/);
  assert.match(page, /PUBLIC DEVNET: COMMIT-ONLY \+ BASE SETTLEMENT/);
  assert.match(page, /not an ER rollback/);
  assert.doesNotMatch(page, /all six.{0,40}(atomically|atomic)/i);
});

test("responsive rules preserve mobile stacking and long-signature containment", () => {
  const css = source("src/app/globals.css");
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(css, /\.tradeTable\{grid-template-columns:1fr\}/);
  assert.match(css, /\.liveControls,\.operations\{grid-template-columns:1fr/);
  assert.match(css, /overflow-wrap:anywhere/);
});
