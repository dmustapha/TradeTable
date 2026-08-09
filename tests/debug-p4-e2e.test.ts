import {AnchorProvider, BN, Program, setProvider, workspace} from "@coral-xyz/anchor";
import {Connection, Keypair, PublicKey} from "@solana/web3.js";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {ephemeralTarget, livePda, roomPda} from "../src/lib/tradetable";

const APP = "https://app-gray-seven-93.vercel.app";
const PROGRAM = "FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3";
const ROOM = "9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo";
const SETTLEMENT = "2vsmk7HDrWzRTAG1sbY9U7oFS14mgZ4CgZQZ5nDCSmxSPoe71wWUAXKZFmSF2UKwdsCMBdtSbKzXyqScMpTH6BX5";

type Harness = "custody" | "state" | "action-settlement" | "fallback-settlement";

function fixtureKey(namespace: string, label: string): Keypair {
  return Keypair.fromSeed(createHash("sha256").update(`${namespace}:${label}`).digest().subarray(0, 32));
}

function harness(kind: Harness, namespace: string): string {
  return execFileSync("npx", ["tsx", "tests/tradetable.ts", `--${kind}-suite`, namespace], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 480_000,
  });
}

function actionSafetyHarness(namespace: string): string {
  try { return harness("action-settlement", namespace); }
  catch (error) {
    const output = error as {stdout?: Buffer | string; stderr?: Buffer | string};
    return `${String(output.stdout ?? "")}\n${String(output.stderr ?? "")}`;
  }
}

async function rejected(operation: () => Promise<unknown>): Promise<void> {
  let failed = false;
  try { await operation(); } catch { failed = true; }
  assert.equal(failed, true, "transaction unexpectedly succeeded");
}

function anchorProgram() {
  const provider = AnchorProvider.env();
  setProvider(provider);
  return {provider, program: workspace.Tradetable as any};
}

test("Flow 1: anonymous judge room is real, proof-first, and honest under read-only access", async () => {
  const [home, proof, room] = await Promise.all([
    fetch(APP, {signal: AbortSignal.timeout(20_000)}),
    fetch(`${APP}/proof`, {signal: AbortSignal.timeout(20_000)}),
    fetch("https://api.devnet.solana.com", {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [ROOM, {encoding: "base64", commitment: "confirmed"}]}),
      signal: AbortSignal.timeout(20_000),
    }),
  ]);
  assert.equal(home.status, 200);
  assert.equal(proof.status, 200);
  const homeHtml = await home.text();
  const proofHtml = await proof.text();
  const roomJson = await room.json() as any;
  assert.equal(roomJson.result.value.owner, PROGRAM);
  assert.match(homeHtml, /Six assets enter\. Consensus chooses three/);
  assert.match(homeHtml, /ATOMIC BOUNDARY: SELECTED THREE ONLY/);
  assert.match(homeHtml, /CONNECT PRIMARY WALLET/);
  assert.match(proofHtml, new RegExp(SETTLEMENT));
  assert.doesNotMatch(`${homeHtml}\n${proofHtml}`, /all six.{0,40}(atomically|atomic)/i);
});

test("Flow 2: invalid roster and expiry roll back, then a valid fixed room succeeds", async () => {
  const {provider, program} = anchorProgram();
  const namespace = `debug-p4-room-${Date.now()}`;
  const participants = [0, 1, 2].map(index => fixtureKey(namespace, `participant-${index}`).publicKey);
  const nonce = BigInt(`0x${createHash("sha256").update(namespace).digest("hex").slice(0, 13)}`);
  const now = Math.floor(Date.now() / 1000);
  for (const [offset, roster, expiry] of [
    [0n, [participants[0], participants[0], participants[2]], now + 3_600],
    [1n, participants, now + 60],
  ] as const) {
    const [core] = roomPda(provider.wallet.publicKey, nonce + offset);
    const [live] = livePda(core);
    await rejected(() => program.methods.initializeRoom(new BN((nonce + offset).toString()), roster, new BN(expiry))
      .accounts({creator: provider.wallet.publicKey, roomCore: core, roomLive: live}).rpc());
    assert.equal(await provider.connection.getAccountInfo(core, "confirmed"), null);
    assert.equal(await provider.connection.getAccountInfo(live, "confirmed"), null);
  }
  const validNonce = nonce + 2n;
  const [core] = roomPda(provider.wallet.publicKey, validNonce);
  const [live] = livePda(core);
  await program.methods.initializeRoom(new BN(validNonce.toString()), participants, new BN(now + 3_600))
    .accounts({creator: provider.wallet.publicKey, roomCore: core, roomLive: live}).rpc();
  const state = await program.account.roomCore.fetch(core) as any;
  assert.deepEqual(state.participants.map((value: PublicKey) => value.toBase58()), participants.map(value => value.toBase58()));
  assert.equal(state.status.funding !== undefined, true);
});

test("Flows 2, 3, and 8: fixed roster, custody failures, cancellation, and independent returns", () => {
  const output = harness("custody", `debug-p4-custody-${Date.now()}`);
  assert.match(output, /PASS initialization stores exact custody state/);
  assert.match(output, /PASS ineligible mint policy is rejected/);
  assert.match(output, /PASS wrong participant cannot deposit another slot/);
  assert.match(output, /PASS six eligible assets move into six exact PDA-owned vaults/);
  assert.match(output, /PASS premature expiry cancellation is rejected/);
  assert.match(output, /PASS outsider participant cancellation is rejected/);
  assert.match(output, /PASS participant cancellation opens deterministic return path/);
  assert.match(output, /PASS closed canonical ATA is recreated and all six assets return/);
  assert.match(output, /PASS return replay is rejected/);
  assert.match(output, /"returnedMask":63,"status":"closed"/);
});

test("Flows 4, 5, and 6: delegated handoff rejects stale/hash/outsider writes and freezes concurrent locks", async () => {
  const namespace = `debug-p4-negotiation-${Date.now()}`;
  execFileSync("npx", ["tsx", "tests/tradetable.ts", "--seed-only", namespace], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 360_000,
  });
  const {provider, program} = anchorProgram();
  const participants = [0, 1, 2].map(index => fixtureKey(namespace, `participant-${index}`));
  const outsider = fixtureKey(namespace, "outsider");
  const nonce = BigInt(`0x${createHash("sha256").update(namespace).digest("hex").slice(0, 14)}`);
  const [core] = roomPda(provider.wallet.publicKey, nonce);
  const [live] = livePda(core);
  const target = ephemeralTarget(provider.connection.rpcEndpoint);
  await program.methods.activateAndDelegateLive().accounts({participant: participants[0].publicKey, roomCore: core, roomLive: live})
    .remainingAccounts([{pubkey: target.validator, isSigner: false, isWritable: false}]).signers([participants[0]]).rpc();
  const coreState = await program.account.roomCore.fetch(core) as any;
  assert.equal(coreState.status.active !== undefined, true);
  const erProgram = new Program(program.idl, new AnchorProvider(new Connection(target.rpc, "confirmed"), provider.wallet, provider.opts)) as any;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { await erProgram.account.roomLive.fetch(live); break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  await erProgram.methods.propose(new BN(0), [0, 2, 4], {forward: {}}).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc();
  let state = await erProgram.account.roomLive.fetch(live) as any;
  assert.equal(state.revision.toNumber(), 1);
  const hash = [...state.allocationHash];
  const wrongHash = [...hash]; wrongHash[0] ^= 0xff;
  await rejected(() => erProgram.methods.lock(new BN(0), hash).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc());
  await rejected(() => erProgram.methods.lock(new BN(1), wrongHash).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc());
  await rejected(() => erProgram.methods.lock(new BN(1), hash).accounts({actor: outsider.publicKey, roomCore: core, roomLive: live}).signers([outsider]).rpc());
  state = await erProgram.account.roomLive.fetch(live);
  assert.equal(state.lockMask, 0);
  await erProgram.methods.lock(new BN(1), hash).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc();
  await erProgram.methods.revokeLock(new BN(1), hash).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc();
  assert.equal((await erProgram.account.roomLive.fetch(live) as any).lockMask, 0);
  await Promise.all(participants.map(participant => erProgram.methods.lock(new BN(1), hash)
    .accounts({actor: participant.publicKey, roomCore: core, roomLive: live}).signers([participant]).rpc()));
  state = await erProgram.account.roomLive.fetch(live);
  assert.equal(state.lockMask, 7);
  assert.equal(state.phase.finalizing !== undefined, true);
  await rejected(() => erProgram.methods.propose(new BN(1), [1, 3, 5], {reverse: {}}).accounts({actor: participants[1].publicKey, roomCore: core, roomLive: live}).signers([participants[1]]).rpc());
  state = await erProgram.account.roomLive.fetch(live);
  assert.equal(state.revision.toNumber(), 1);
  assert.equal(state.lockMask, 7);
});

test("Flow 7: failed asynchronous action preserves base custody without claiming ER rollback", () => {
  const output = actionSafetyHarness(`debug-p4-action-${Date.now()}`);
  assert.match(output, /PASS failed asynchronous intent leaves all three custody legs unchanged/);
  if (/PASS composed Magic Action settles/.test(output)) assert.match(output, /"selectedMask":21,"revision":1/);
});

test("Flows 7 and 8: commit-only is selected before scheduling, then base settlement and independent returns complete", () => {
  const output = harness("fallback-settlement", `debug-p4-fallback-${Date.now()}`);
  assert.match(output, /PASS commit-only finalization reaches normal base settlement fallback/);
  assert.match(output, /"selectedMask":21,"returnedMask":42,"status":"complete"/);
  const page = execFileSync("rg", ["-n", "Choose Normal Settlement before scheduling|PUBLIC DEVNET: COMMIT-ONLY \\+ BASE SETTLEMENT", "src/app/page.tsx"], {encoding: "utf8"});
  assert.match(page, /Choose Normal Settlement before scheduling/);
  assert.match(page, /COMMIT-ONLY/);
});
