// File: scripts/ops.ts
import {execFileSync} from "child_process";
import {mkdirSync, readFileSync, writeFileSync} from "fs";
import {Connection, Keypair, PublicKey, Transaction} from "@solana/web3.js";
import {BASE_RPC, ER_RPC, explorerAddress, explorerTx} from "../src/lib/tradetable";

const command = process.argv[2];
const connection = new Connection(BASE_RPC, "confirmed");
const erConnection = new Connection(ER_RPC, "confirmed");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function run(binary: string, args: string[]): string {
  return execFileSync(binary, args, {encoding: "utf8", stdio: ["ignore", "pipe", "inherit"]}).trim();
}

async function seed(): Promise<void> {
  const marker = process.env.DEMO_SEED_NAMESPACE ?? "tradetable-v1";
  const output = run("npx", ["tsx", "tests/tradetable.ts", "--seed-only", marker]);
  process.stdout.write(`${output}\n`);
}

async function measure(): Promise<void> {
  const payerPath = requireEnv("DEMO_PAYER_KEYPAIR");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8")) as number[]));
  const paths = {
    magicAction: requireEnv("MAGIC_ACTION_TRANSACTION_JSON"),
    normalSettlement: requireEnv("NORMAL_SETTLEMENT_TRANSACTION_JSON"),
  };
  const results: Record<string, {wireBytes: number; accountKeys: number; unitsConsumed: number; budgetWithMargin: number}> = {};
  for (const [name, transactionPath] of Object.entries(paths)) results[name] = await measureTransaction(transactionPath, payer);
  const output = requireEnv("MEASUREMENT_OUTPUT_JSON");
  writeFileSync(output, JSON.stringify(results, null, 2));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

async function measureTransaction(transactionPath: string, payer: Keypair) {
  const encoded = JSON.parse(readFileSync(transactionPath, "utf8")) as number[];
  const transaction = Transaction.from(Buffer.from(encoded));
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  transaction.partialSign(payer);
  const wireBytes = transaction.serialize().length;
  const simulation = await connection.simulateTransaction(transaction);
  const unitsConsumed = simulation.value.unitsConsumed ?? 0;
  const budgetWithMargin = Math.ceil(unitsConsumed * 1.10);
  if (wireBytes > 1_232 || budgetWithMargin > 1_400_000 || simulation.value.err) throw new Error(`settlement measurement gate failed: ${transactionPath}`);
  return {wireBytes, accountKeys: transaction.compileMessage().accountKeys.length, unitsConsumed, budgetWithMargin};
}

function changedTokenAccounts(transaction: NonNullable<Awaited<ReturnType<Connection["getTransaction"]>>>): number {
  const before = new Map((transaction.meta?.preTokenBalances ?? []).map(value => [value.accountIndex, value.uiTokenAmount.amount]));
  return (transaction.meta?.postTokenBalances ?? []).filter(value => before.get(value.accountIndex) !== value.uiTokenAmount.amount).length;
}

async function prove(): Promise<void> {
  const program = new PublicKey(requireEnv("NEXT_PUBLIC_PROGRAM_ID"));
  const room = new PublicKey(requireEnv("NEXT_PUBLIC_DEMO_ROOM"));
  const live = new PublicKey(requireEnv("NEXT_PUBLIC_DEMO_LIVE"));
  const commitSignature = requireEnv("COMMIT_SIGNATURE");
  const signatures = requireEnv("PROOF_SIGNATURES").split(",").filter(Boolean);
  const settlementSignature = requireEnv("SETTLEMENT_SIGNATURE");
  const returnSignatures = requireEnv("RETURN_SIGNATURES").split(",").filter(Boolean);
  if (returnSignatures.length !== 3) throw new Error("RETURN_SIGNATURES must contain exactly three signatures");
  const measurements = JSON.parse(readFileSync(requireEnv("MEASUREMENT_OUTPUT_JSON"), "utf8")) as Record<string, {wireBytes: number; budgetWithMargin: number}>;
  const [programInfo, roomInfo, liveInfo, commitTransaction, transactions] = await Promise.all([
    connection.getAccountInfo(program, "confirmed"),
    connection.getAccountInfo(room, "confirmed"),
    connection.getAccountInfo(live, "confirmed"),
    erConnection.getTransaction(commitSignature, {commitment: "confirmed", maxSupportedTransactionVersion: 0}),
    Promise.all([...new Set([...signatures, settlementSignature, ...returnSignatures])].map(signature => connection.getTransaction(signature, {commitment: "confirmed", maxSupportedTransactionVersion: 0}))),
  ]);
  if (!programInfo?.executable || !roomInfo || !liveInfo || !commitTransaction || commitTransaction.meta?.err || transactions.some(value => !value || value.meta?.err)) throw new Error("proof read-back failed");
  const settlement = await connection.getTransaction(settlementSignature, {commitment: "confirmed", maxSupportedTransactionVersion: 0});
  const returns = await Promise.all(returnSignatures.map(value => connection.getTransaction(value, {commitment: "confirmed", maxSupportedTransactionVersion: 0})));
  if (!settlement || changedTokenAccounts(settlement) !== 6) throw new Error("settlement must change exactly three vault and three destination balances");
  if (returns.some(value => !value || changedTokenAccounts(value) !== 2)) throw new Error("each return must change exactly one vault and one owner balance");
  if (Object.keys(measurements).length !== 2 || Object.values(measurements).some(value => value.wireBytes > 1_232 || value.budgetWithMargin > 1_400_000)) throw new Error("measurement report failed proof ceilings");
  const lines = ["# TradeTable Devnet Proof", "", `- Program: ${explorerAddress(program)}`, `- RoomCore: ${explorerAddress(room)}`, `- RoomLive: ${explorerAddress(live)}`, `- Commit-only ER: ${commitSignature} (confirmed through ${ER_RPC})`, `- Settlement: ${explorerTx(settlementSignature)} (6 token-account deltas = 3 transfers)`, ...returnSignatures.map(value => `- Return: ${explorerTx(value)} (2 token-account deltas)`), ...signatures.map(value => `- Transaction: ${explorerTx(value)}`), `- Measurements: ${JSON.stringify(measurements)}`, ""];
  mkdirSync("submission", {recursive: true});
  writeFileSync("submission/proof.md", lines.join("\n"));
  process.stdout.write(lines.join("\n"));
}

const actions: Record<string, () => Promise<void>> = {seed, measure, prove};
if (!actions[command]) throw new Error("command must be seed, measure, or prove");
actions[command]().catch(error => { console.error(error); process.exitCode = 1; });
