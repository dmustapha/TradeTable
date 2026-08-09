import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import {resolve} from "node:path";
import {PublicKey} from "@solana/web3.js";
import {
  alternateExplorerTx,
  explorerAddress,
  explorerTx,
  livePda,
  programId,
} from "../src/lib/tradetable";

const PROGRAM = "FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3";
const ROOM = "9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo";
const LIVE = "46r8db8EKsrtzz2btXfxLz8A3vSX1FHmbw3ynpzSAbD1";
const SETTLEMENT = "2vsmk7HDrWzRTAG1sbY9U7oFS14mgZ4CgZQZ5nDCSmxSPoe71wWUAXKZFmSF2UKwdsCMBdtSbKzXyqScMpTH6BX5";
const COMMIT_ONLY = "2fpZgMn89JbMQBWfcxDkoFmqcZeGNmbiskc9v5ym97uqYxUdaND2KP8coc3GJbTtNCbuUV6TBtjJCXYuaRby7yJc";
const RETURNS = [
  "5fArNw2GtfLHK5vq344wPnqqGrb9t2bYzabfLYQNrwAbJs5egj4ydhcposp5NWBZR3mtQToepCb6NXCdSN7391ms",
  "3u98udn2X1XBzYzepb8Mm8wvHsKcuM7Vc3Gq6A4pX5CG83VoiSJBM3qucxbiyJtYa9xvV1xwrr7bqXLnTMUGR26y",
  "4zWBZnCW2y4dEygfLoL8cFVNCXAKAxQo1tBiYp7YYsdDJRz7EjVPhKoCQHf5GnD2Zazoxsipz5fH8fMcQx9nFHVj",
] as const;
const BASE_RPC = "https://api.devnet.solana.com";
const ROUTER_RPC = "https://devnet-router.magicblock.app";
const ER_RPC = "https://devnet-as.magicblock.app/";
const APP = "https://app-gray-seven-93.vercel.app";

type RpcReply<T> = {result?: T; error?: {code: number; message: string}};

async function rpc<T>(endpoint: string, method: string, params: unknown[] = []): Promise<RpcReply<T>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
        signal: AbortSignal.timeout(15_000),
      });
      assert.equal(response.ok, true, `${endpoint} returned HTTP ${response.status}`);
      return await response.json() as RpcReply<T>;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function wsRpc<T>(endpoint: string, method: string, params: unknown[]): Promise<RpcReply<T>> {
  return new Promise((resolveReply, reject) => {
    const socket = new WebSocket(endpoint);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`${endpoint} websocket timed out`));
    }, 15_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({jsonrpc: "2.0", id: 7, method, params})));
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data)) as RpcReply<T> & {id?: number};
      if (reply.id !== 7) return;
      clearTimeout(timeout);
      socket.close();
      resolveReply(reply);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`${endpoint} websocket failed`));
    });
  });
}

function changedTokenAccounts(transaction: any): number {
  const before = new Map(transaction.meta.preTokenBalances.map((value: any) => [value.accountIndex, value.uiTokenAmount.amount]));
  return transaction.meta.postTokenBalances.filter((value: any) => before.get(value.accountIndex) !== value.uiTokenAmount.amount).length;
}

function transferChecked(transaction: any): any[] {
  return transaction.meta.innerInstructions.flatMap((group: any) => group.instructions)
    .filter((instruction: any) => instruction.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && instruction.parsed?.type === "transferChecked");
}

test("Next client and proof surface resolve against public Devnet evidence", async () => {
  const [home, proof, program, room] = await Promise.all([
    fetch(APP, {signal: AbortSignal.timeout(15_000)}),
    fetch(`${APP}/proof`, {signal: AbortSignal.timeout(15_000)}),
    rpc<any>(BASE_RPC, "getAccountInfo", [PROGRAM, {encoding: "base64", commitment: "confirmed"}]),
    rpc<any>(BASE_RPC, "getAccountInfo", [ROOM, {encoding: "base64", commitment: "confirmed"}]),
  ]);
  assert.equal(home.status, 200);
  assert.equal(proof.status, 200);
  assert.equal(program.result?.value.executable, true);
  assert.equal(room.result?.value.owner, PROGRAM);
  const html = await proof.text();
  assert.match(html, new RegExp(PROGRAM));
  assert.match(html, /ATOMIC BOUNDARY: SELECTED THREE ONLY/);
  assert.match(html, new RegExp(SETTLEMENT));
  assert.match(html, /Action acceptance is pending until RoomCore records settlement/);
  assert.doesNotMatch(html, /all six.{0,40}(atomically|atomic)/i);
});

test("base, Router, and direct ER JSON-RPC read the deployed live account", async () => {
  const [baseHealth, base, router, erHealth, er] = await Promise.all([
    rpc<string>(BASE_RPC, "getHealth"),
    rpc<any>(BASE_RPC, "getAccountInfo", [LIVE, {encoding: "base64", commitment: "confirmed"}]),
    rpc<any>(ROUTER_RPC, "getAccountInfo", [LIVE, {encoding: "base64", commitment: "confirmed"}]),
    rpc<string>(ER_RPC, "getHealth"),
    rpc<any>(ER_RPC, "getAccountInfo", [LIVE, {encoding: "base64", commitment: "confirmed"}]),
  ]);
  assert.equal(baseHealth.result, "ok");
  assert.equal(erHealth.result, "ok");
  for (const reply of [base, router, er]) {
    assert.equal(reply.result?.value.owner, PROGRAM);
    assert.equal(reply.result?.value.space, 420);
  }
  const routerBlockhash = await rpc<any>(ROUTER_RPC, "getBlockhashForAccounts", [[LIVE]]);
  assert.match(routerBlockhash.result?.blockhash ?? "", /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const invalid = await rpc<any>(ROUTER_RPC, "getAccountInfo", ["not-a-public-key"]);
  assert.equal(invalid.error?.code, -32602);
});

test("base, Router, and direct ER WebSockets accept real account subscriptions and clean errors", async () => {
  const endpoints = [
    "wss://api.devnet.solana.com",
    "wss://devnet-router.magicblock.app",
    "wss://devnet-as.magicblock.app/",
  ];
  for (const endpoint of endpoints) {
    const valid = await wsRpc<number>(endpoint, "accountSubscribe", [LIVE, {encoding: "base64", commitment: "confirmed"}]);
    assert.equal(typeof valid.result, "number", endpoint);
    const invalid = await wsRpc<any>(endpoint, "accountSubscribe", ["not-a-public-key"]);
    assert.equal(invalid.error?.code, -32602, endpoint);
  }
});

test("Anchor settlement invokes SPL Token for exactly the selected three assets", async () => {
  const reply = await rpc<any>(BASE_RPC, "getTransaction", [SETTLEMENT, {encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0}]);
  const transaction = reply.result;
  assert.ok(transaction);
  assert.equal(transaction.meta.err, null);
  assert(transaction.meta.logMessages.includes(`Program ${PROGRAM} invoke [1]`));
  assert(transaction.meta.logMessages.includes("Program log: Instruction: SettleCommitted"));
  const transfers = transferChecked(transaction);
  assert.equal(transfers.length, 3);
  assert(transfers.every(value => value.parsed.info.tokenAmount.amount === "1" && value.parsed.info.tokenAmount.decimals === 0));
  assert.equal(new Set(transfers.map(value => value.parsed.info.mint)).size, 3);
  assert.equal(changedTokenAccounts(transaction), 6);
});

test("three unselected returns are separate one-asset transactions", async () => {
  const replies = await Promise.all(RETURNS.map(signature => rpc<any>(BASE_RPC, "getTransaction", [signature, {encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0}])));
  for (const reply of replies) {
    assert.equal(reply.result?.meta.err, null);
    assert.equal(transferChecked(reply.result).length, 1);
    assert.equal(changedTokenAccounts(reply.result), 2);
  }
});

test("Magic commit/action evidence preserves the local versus public boundary", async () => {
  const source = readFileSync(resolve("programs/tradetable/src/lib.rs"), "utf8");
  const report = readFileSync(resolve("../../BUILD-REPORT.md"), "utf8");
  const proof = readFileSync(resolve("submission/proof.md"), "utf8");
  assert.match(source, /commit_and_undelegate/);
  assert.match(source, /add_post_commit_actions/);
  assert.match(source, /pub fn settle_action/);
  assert.match(source, /pub fn settle_committed/);
  assert.match(report, /composed Magic Action proof is local-validator evidence/);
  assert.match(report, /failed asynchronous action leaves base custody unchanged but the ER live account Finalized\/stuck/);
  assert.match(proof, /Commit-only ER:/);
  assert.doesNotMatch(proof, /composed Magic Action/i);
  assert.match(report, /not described as ER rollback/i);
  const commit = await rpc<any>(ER_RPC, "getTransaction", [COMMIT_ONLY, {encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0}]);
  assert.equal(commit.result?.meta.err, null);
  assert(commit.result?.meta.logMessages.includes("Program log: Instruction: FinalizeCommitOnly"));
  assert(commit.result?.meta.logMessages.some((line: string) => line.startsWith("ScheduledCommitSent signature:")));
});

test("proof and Explorer links are constructed from exact public identifiers", () => {
  process.env.NEXT_PUBLIC_PROGRAM_ID = PROGRAM;
  const program = programId();
  assert.equal(explorerAddress(program), `https://explorer.solana.com/address/${PROGRAM}?cluster=devnet`);
  assert.equal(explorerTx(SETTLEMENT), `https://explorer.solana.com/tx/${SETTLEMENT}?cluster=devnet`);
  assert.equal(alternateExplorerTx(SETTLEMENT), `https://solana.fm/tx/${SETTLEMENT}?cluster=devnet-solana`);
  assert.equal(livePda(new PublicKey(ROOM))[0].toBase58(), LIVE);
});

test("tracked IDL, generated IDL, client methods, and deployed identity agree", () => {
  const tracked = readFileSync(resolve("src/idl/tradetable.json"));
  const generated = readFileSync(resolve("target/idl/tradetable.json"));
  const idl = JSON.parse(tracked.toString("utf8"));
  const client = readFileSync(resolve("src/app/room-client.tsx"), "utf8");
  assert.deepEqual(tracked, generated);
  assert.equal(idl.address, PROGRAM);
  assert.equal(createHash("sha256").update(tracked).digest("hex"), "49a63aef51ed0cc4534d1157c51eda6de8ef4defead0f3c0ce6c7bd0df3dbfc5");
  const instructions = new Set(idl.instructions.map((value: any) => value.name));
  assert(instructions.has("propose"));
  assert(instructions.has("lock"));
  assert.match(client, /program\.methods\.propose/);
  assert.match(client, /program\.methods\.lock/);
  assert.match(client, /Generated IDL program ID mismatch/);
});

test("DEV-001 headless validator flag preserves the real lifecycle", () => {
  const evidence = readFileSync(resolve(".local-env-evidence.md"), "utf8");
  assert.match(evidence, /--lifecycle ephemeral --no-tui/);
  assert.match(evidence, /"result":"ok"/);
  assert.match(evidence, /ephemeral-validator PID \d+: TCP 127\.0\.0\.1:7799 \(LISTEN\)/);
});
