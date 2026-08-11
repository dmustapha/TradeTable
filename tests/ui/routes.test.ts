import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {PublicKey} from "@solana/web3.js";

import {
  RoomAvailabilityError,
  RoomIntegrityError,
  canonicalRoomAddress,
  pollForInitializedRoom,
  readAccountFromSources,
  readDelegatedRoomLive,
  roomExpiryUnix,
  roomStateForClient,
  validateRoomAccounts,
} from "../../src/lib/room-loader";
import {ER_VALIDATOR, erValidatorForBase} from "../../src/lib/tradetable";
import {
  ConfirmationUnavailableError, OnChainTransactionError, confirmBaseSignature,
  assertWalletSnapshot, createFailureState, createSubmittedState, type CreateIntent,
} from "../../src/lib/create-room-state";

const PROGRAM = new PublicKey("FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3");
const CREATOR = new PublicKey(Uint8Array.from({length: 32}, () => 9));
const NONCE = 42n;
const nonceBytes = Buffer.alloc(8);
nonceBytes.writeBigUInt64LE(NONCE);
const CORE = PublicKey.findProgramAddressSync([Buffer.from("room"), CREATOR.toBuffer(), nonceBytes], PROGRAM)[0];
const LIVE = PublicKey.findProgramAddressSync([Buffer.from("live"), CORE.toBuffer()], PROGRAM)[0];

function coreFixture() {
  const data = Buffer.alloc(1_350);
  Buffer.from([159, 7, 60, 81, 143, 33, 177, 65, 1]).copy(data);
  CREATOR.toBuffer().copy(data, 12); data.writeBigUInt64LE(NONCE, 44);
  [11, 12, 13].forEach((seed, index) => Buffer.alloc(32, seed).copy(data, 52 + index * 32));
  LIVE.toBuffer().copy(data, 148); data.writeBigInt64LE(2_000_000_000n, 1_206);
  return {owner: PROGRAM, data};
}

function liveFixture() {
  const data = Buffer.alloc(420);
  Buffer.from([245, 92, 71, 83, 30, 246, 85, 29, 1]).copy(data);
  CORE.toBuffer().copy(data, 10);
  [11, 12, 13].forEach((seed, index) => Buffer.alloc(32, seed).copy(data, 42 + index * 32));
  data.writeBigInt64LE(2_000_000_000n, 138);
  return {owner: PROGRAM, data};
}

test("canonicalizes a valid room address and rejects malformed input", () => {
  assert.equal(canonicalRoomAddress(`  ${CORE.toBase58()}  `), CORE.toBase58());
  assert.throws(() => canonicalRoomAddress("not a Solana address"), /valid Solana room address/i);
});

test("selects the configured ER validator for local and public base RPCs", () => {
  assert.equal(erValidatorForBase("http://127.0.0.1:8899").toBase58(), "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
  assert.equal(erValidatorForBase("https://api.devnet.solana.com").toBase58(), "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
});

test("serializes decoded room bytes into plain client-safe arrays", () => {
  const value = roomStateForClient({key: Uint8Array.from([1, 2]), nested: [Uint8Array.from([3])]});
  assert.deepEqual(value, {key: [1, 2], nested: [[3]]});
  assert.equal(value.key instanceof Uint8Array, false);
});

test("rejects an account that is not owned by the TradeTable program", () => {
  assert.throws(
    () => validateRoomAccounts(CORE, {owner: PublicKey.default, data: Buffer.alloc(1_350)}, null, PROGRAM),
    (error: unknown) => error instanceof RoomIntegrityError && /not owned/i.test(error.message),
  );
});

test("accepts canonical linked Core and Live accounts", () => {
  const result = validateRoomAccounts(CORE, coreFixture(), liveFixture(), PROGRAM);
  assert.equal(result.liveAddress.toBase58(), LIVE.toBase58());
  assert.equal(result.live?.expiresAt, result.core.expiresAt);
});

test("rejects a RoomLive whose backlink differs from the requested RoomCore", () => {
  const live = liveFixture();
  PublicKey.default.toBuffer().copy(live.data, 10);
  assert.throws(() => validateRoomAccounts(CORE, coreFixture(), live, PROGRAM), /link back/i);
});

test("distinguishes a confirmed missing account from an inconclusive RPC outage", async () => {
  const offline = {label: "offline", read: async () => { throw new Error("offline"); }};
  await assert.rejects(() => readAccountFromSources(CORE, [offline], 20), RoomAvailabilityError);
  const missing = await readAccountFromSources(CORE, [offline, {label: "fallback", read: async () => null}], 20);
  assert.deepEqual(missing, {kind: "missing"});
});

test("falls back from Router to direct ER only for a current configured delegation", async () => {
  let directReads = 0;
  const result = await readDelegatedRoomLive(
    LIVE,
    Promise.resolve({status: 0, validator: ER_VALIDATOR}),
    {label: "router", read: async () => null},
    {label: "direct ER", read: async () => { directReads += 1; return liveFixture(); }},
    20,
  );
  assert.equal(result.endpoint, "direct ER");
  assert.equal(directReads, 1);
  await assert.rejects(() => readDelegatedRoomLive(
    LIVE, Promise.resolve({status: 1, validator: ER_VALIDATOR}),
    {label: "router", read: async () => liveFixture()},
    {label: "direct ER", read: async () => liveFixture()}, 20,
  ), /not current/i);
});

test("rejects unavailable delegation truth and skips an invalid Router candidate for direct ER", async () => {
  const invalidRouter = {...liveFixture(), owner: PublicKey.default};
  const validator = (account: ReturnType<typeof liveFixture>) => account.owner.equals(PROGRAM);
  const result = await readDelegatedRoomLive(
    LIVE, Promise.resolve({status: 0, validator: ER_VALIDATOR}),
    {label: "router", read: async () => invalidRouter},
    {label: "direct ER", read: async () => liveFixture()}, 20, validator,
  );
  assert.equal(result.endpoint, "direct ER");
  await assert.rejects(() => readDelegatedRoomLive(
    LIVE, new Promise(() => undefined),
    {label: "router", read: async () => liveFixture()},
    {label: "direct ER", read: async () => liveFixture()}, 10, validator,
  ), RoomAvailabilityError);
});

test("create failure distinguishes unsigned, explicitly failed, and ambiguous outcomes", () => {
  const intent: CreateIntent = {core: CORE.toBase58(), live: LIVE.toBase58()};
  const declined = createFailureState(null, new Error("approval declined"));
  assert.deepEqual(declined, {phase: "idle", error: "approval declined", canSubmit: true});
  const signed = createSubmittedState(intent);
  const uncertain = createFailureState(signed.intent, new Error("confirmation unavailable"));
  assert.equal(uncertain.phase, "unreconciled");
  if (uncertain.phase !== "unreconciled") return;
  assert.deepEqual(uncertain.intent, intent);
  assert.equal(uncertain.canSubmit, false);
  const withSignature = createSubmittedState(intent, "base-signature").intent;
  const failed = createFailureState(withSignature, new OnChainTransactionError("confirmed failed"));
  assert.equal(failed.phase, "idle");
  if (failed.phase === "idle") {
    assert.equal(failed.canSubmit, true);
    assert.equal(failed.confirmedFailed, true);
    assert.deepEqual(failed.failedIntent, withSignature);
  }
});

test("wallet snapshot rejects an account change before signing", () => {
  assert.doesNotThrow(() => assertWalletSnapshot(CREATOR.toBase58(), CREATOR.toBase58()));
  assert.throws(() => assertWalletSnapshot(CREATOR.toBase58(), PublicKey.default.toBase58()), /account changed/i);
  assert.throws(() => assertWalletSnapshot(CREATOR.toBase58(), null), /account changed/i);
});

test("confirmation separates explicit on-chain failure from unavailable RPC evidence", async () => {
  let fallbackCalls = 0;
  await assert.rejects(() => confirmBaseSignature("sig", [
    {label: "primary", confirm: async () => ({err: {InstructionError: [0, "Custom"]}})},
    {label: "fallback", confirm: async () => { fallbackCalls += 1; return {err: null}; }},
  ], 20), OnChainTransactionError);
  assert.equal(fallbackCalls, 0);
  await assert.rejects(() => confirmBaseSignature("sig", [
    {label: "primary", confirm: async () => { throw new Error("offline"); }},
  ], 20), ConfirmationUnavailableError);
  await confirmBaseSignature("sig", [
    {label: "primary", confirm: async () => { throw new Error("offline"); }},
    {label: "fallback", confirm: async () => ({err: null})},
  ], 20);
});

test("post-create polling is globally bounded and returns only fully linked accounts", async () => {
  const validSource = {label: "base", read: async (address: PublicKey) => address.equals(CORE) ? coreFixture() : liveFixture()};
  const verified = await pollForInitializedRoom(CORE, LIVE, PROGRAM, [validSource], {rpcTimeoutMs: 20, totalTimeoutMs: 80, pollMs: 1});
  assert.equal(verified.core.roomNonce, NONCE);

  const invalidLive = liveFixture(); PublicKey.default.toBuffer().copy(invalidLive.data, 10);
  const invalidSource = {label: "base", read: async (address: PublicKey) => address.equals(CORE) ? coreFixture() : invalidLive};
  await assert.rejects(() => pollForInitializedRoom(CORE, LIVE, PROGRAM, [invalidSource], {rpcTimeoutMs: 20, totalTimeoutMs: 80, pollMs: 1}), /link back/i);

  const started = Date.now();
  const never = {label: "hung", read: async () => new Promise<null>(() => undefined)};
  await assert.rejects(() => pollForInitializedRoom(CORE, LIVE, PROGRAM, [never], {rpcTimeoutMs: 10, totalTimeoutMs: 40, pollMs: 1}), /bounded wait/i);
  assert.ok(Date.now() - started < 200, "the whole polling operation must remain bounded");
});

test("room expiry rejects the exact twenty-minute edge and accepts twenty-one minutes", () => {
  assert.throws(() => roomExpiryUnix(1_000_000, 20), /at least 21 minutes/i);
  assert.equal(roomExpiryUnix(1_000_000, 21), 1_000n + 21n * 60n);
});

test("landing is routing-only and preserves truthful settlement boundaries", async () => {
  const source = await readFile(new URL("../../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Six assets enter custody/i);
  assert.match(source, /selected three settle atomically/i);
  assert.match(source, /three separate base transactions/i);
  assert.match(source, /CreateRoomForm/);
  assert.match(source, /OpenRoomForm/);
  assert.match(source, /NEXT_PUBLIC_NETWORK_LABEL/);
  assert.match(source, /NEXT_PUBLIC_DEMO_ROOM/);
  assert.match(source, /20-minute protocol minimum/i);
  assert.match(source, /one-minute submission buffer/i);
  assert.doesNotMatch(source, /className="live"/);
  assert.doesNotMatch(source, /tradeTable|PROOF PATH SELECTOR|RoomClient/);
});

test("room route has controlled route shells and validated loading", async () => {
  const [page, client, loading, error, missing] = await Promise.all([
    readFile(new URL("../../src/app/rooms/[core]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/room-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/rooms/[core]/loading.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/rooms/[core]/error.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/rooms/[core]/not-found.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /canonicalRoomAddress/);
  assert.match(page, /loadRoom/);
  assert.match(page, /RoomClient/);
  assert.match(page, /initialCore=\{roomStateForClient\(room\.core\)\}/);
  assert.match(page, /initialLive=\{roomStateForClient\(room\.live\)\}/);
  assert.match(client, /decodeRoomCore/);
  assert.match(client, /decodeRoomLive/);
  assert.doesNotMatch(client, /function decodeLive/);
  assert.match(loading, /TRADE<span>TABLE<\/span>/);
  assert.match(error, /reset\(\)/);
  assert.match(missing, /Open another room/i);
});

test("room creation associates participant and expiry validation with each field", async () => {
  const source = await readFile(new URL("../../src/app/create-room-form.tsx", import.meta.url), "utf8");
  for (const field of ["participant-b", "participant-c", "expiry-minutes"]) {
    assert.match(source, new RegExp(`id=\\"${field}\\"[^>]*aria-invalid=`));
    assert.match(source, new RegExp(`aria-describedby=\\{[^}]*${field}-error`));
    assert.match(source, new RegExp(`id=\\"${field}-error\\"[^>]*role=\\"alert\\"`));
  }
  assert.match(source, /validateCreateFields/);
  assert.match(source, /mapCreateFieldError/);
  assert.match(source, /participantB && participantC && participantB\.equals\(participantC\)/);
});

test("room route is compact and the shared table precedes proposal detail", async () => {
  const [page, client] = await Promise.all([
    readFile(new URL("../../src/app/rooms/[core]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../../src/app/room-client.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /className="proofHero roomHero"/);
  assert.ok(client.indexOf("<SharedTable") < client.indexOf("<ConsentPanel"));
  assert.match(client, /data-stale=\{stale\}/);
});
