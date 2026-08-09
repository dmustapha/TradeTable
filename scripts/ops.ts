// File: scripts/ops.ts
import {execFileSync} from "child_process";
import {mkdirSync, readFileSync, writeFileSync} from "fs";
import {utils} from "@coral-xyz/anchor";
import {TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {Connection, Keypair, ParsedTransactionWithMeta, PublicKey, Transaction} from "@solana/web3.js";
import {BASE_RPC, ER_RPC, destinationAta, explorerAddress, explorerTx, vaultAta, vaultAuthorityPda, withTimeout} from "../src/lib/tradetable";

const command = process.argv[2];
const connection = new Connection(BASE_RPC, "confirmed");
const erConnection = new Connection(ER_RPC, "confirmed");
const SETTLE_COMMITTED_DISCRIMINATOR = Buffer.from([207, 70, 245, 29, 227, 227, 171, 243]);

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

type ProofCore = {participants: PublicKey[]; live: PublicKey; mints: PublicKey[]; vaults: PublicKey[]; selectedMask: number; returnedMask: number; allocationHash: Buffer};
type ProofLive = {core: PublicKey; selectedSlots: number[]; destinations: number[]; allocationHash: Buffer};

function decodeProofCore(data: Buffer): ProofCore {
  if (data.length < 1254) throw new Error("RoomCore proof account is truncated");
  return {
    participants: [0, 1, 2].map(index => new PublicKey(data.subarray(52 + index * 32, 84 + index * 32))),
    live: new PublicKey(data.subarray(148, 180)),
    mints: [0, 1, 2, 3, 4, 5].map(index => new PublicKey(data.subarray(180 + index * 169, 212 + index * 169))),
    vaults: [0, 1, 2, 3, 4, 5].map(index => new PublicKey(data.subarray(212 + index * 169, 244 + index * 169))),
    selectedMask: data[1196], returnedMask: data[1195], allocationHash: data.subarray(1222, 1254),
  };
}

function decodeProofLive(data: Buffer): ProofLive {
  if (data.length < 193) throw new Error("RoomLive proof account is truncated");
  return {core: new PublicKey(data.subarray(10, 42)), selectedSlots: [...data.subarray(154, 157)], destinations: [...data.subarray(158, 161)], allocationHash: data.subarray(161, 193)};
}

function validateRoomLinkage(program: PublicKey, room: PublicKey, live: PublicKey, roomInfo: NonNullable<Awaited<ReturnType<Connection["getAccountInfo"]>>>, liveInfo: NonNullable<Awaited<ReturnType<Connection["getAccountInfo"]>>>) {
  if (!roomInfo.owner.equals(program) || !liveInfo.owner.equals(program)) throw new Error("room and committed live accounts must be owned by the deployed program");
  const core = decodeProofCore(roomInfo.data);
  const liveState = decodeProofLive(liveInfo.data);
  if (!core.live.equals(live) || !liveState.core.equals(room)) throw new Error("RoomCore and RoomLive linkage mismatch");
  if (!core.allocationHash.equals(liveState.allocationHash)) throw new Error("committed allocation hash mismatch");
  const selectedMask = liveState.selectedSlots.reduce((mask, slot) => mask | (1 << slot), 0);
  if (core.selectedMask !== selectedMask || core.returnedMask !== (63 & ~selectedMask)) throw new Error("selectedMask or returnedMask does not match committed evidence");
  return {core, liveState};
}

function parsedTransfers(transaction: ParsedTransactionWithMeta) {
  return (transaction.meta?.innerInstructions ?? []).flatMap(group => group.instructions).filter((instruction: any) => instruction.program === "spl-token" && instruction.parsed?.type === "transferChecked");
}

function validateTransferChecked(transaction: ParsedTransactionWithMeta, expected: Array<{mint: PublicKey; vault: PublicKey; destination: PublicKey}>) {
  const transfers = parsedTransfers(transaction);
  if (transfers.length !== 3 || changedTokenAccounts(transaction as any) !== 6) throw new Error("settlement must contain exactly three unit transfers and six token-account deltas");
  transfers.forEach((instruction: any, index: number) => {
    const info = instruction.parsed.info;
    const leg = expected[index];
    if (info.source !== leg.vault.toBase58() || info.mint !== leg.mint.toBase58() || info.destination !== leg.destination.toBase58()) throw new Error(`settlement transfer ${index} account mismatch`);
    if (info.tokenAmount.amount !== "1" || info.tokenAmount.decimals !== 0) throw new Error(`settlement transfer ${index} must move one zero-decimal token`);
  });
}

function validateSettlementInstruction(transaction: ParsedTransactionWithMeta, program: PublicKey, room: PublicKey, live: PublicKey, core: ProofCore, liveState: ProofLive) {
  const instruction = transaction.transaction.message.instructions.find((value: any) => value.programId?.equals(program)) as any;
  if (!instruction?.accounts || !Buffer.from(utils.bytes.bs58.decode(instruction.data)).subarray(0, 8).equals(SETTLE_COMMITTED_DISCRIMINATOR)) throw new Error("exact settle_committed instruction not found");
  const [vaultAuthority] = vaultAuthorityPda(room);
  const legs = liveState.selectedSlots.map((slot, index) => ({mint: core.mints[slot], vault: core.vaults[slot], destination: destinationAta(core.participants[liveState.destinations[index]], core.mints[slot])}));
  const expected = [room, live, vaultAuthority, TOKEN_PROGRAM_ID, ...legs.flatMap(leg => [leg.mint, leg.vault, leg.destination])];
  if (instruction.accounts.length !== 14 || !expected.every((key, index) => instruction.accounts[index + 1].equals(key))) throw new Error("settle_committed instruction account order mismatch");
  legs.forEach((leg, index) => { if (!leg.vault.equals(vaultAta(room, leg.mint))) throw new Error(`settlement vault ${index} is not canonical`); });
  validateTransferChecked(transaction, legs);
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
  const [programInfo, roomInfo, liveInfo, commitTransaction, transactions, settlement] = await withTimeout(Promise.all([
    connection.getAccountInfo(program, "confirmed"), connection.getAccountInfo(room, "confirmed"), connection.getAccountInfo(live, "confirmed"),
    erConnection.getTransaction(commitSignature, {commitment: "confirmed", maxSupportedTransactionVersion: 0}),
    Promise.all([...new Set([...signatures, settlementSignature, ...returnSignatures])].map(signature => connection.getTransaction(signature, {commitment: "confirmed", maxSupportedTransactionVersion: 0}))),
    connection.getParsedTransaction(settlementSignature, {commitment: "confirmed", maxSupportedTransactionVersion: 0}),
  ]), 45_000, "public proof read-back");
  if (!programInfo?.executable || !roomInfo || !liveInfo || !commitTransaction || commitTransaction.meta?.err || transactions.some(value => !value || value.meta?.err) || !settlement || settlement.meta?.err) throw new Error("proof read-back failed");
  if (!commitTransaction.meta?.logMessages?.includes("Program log: Instruction: FinalizeCommitOnly") || !commitTransaction.meta.logMessages.some(line => line === `Program ${program.toBase58()} invoke [1]`)) throw new Error("commit signature is not the exact deployed finalize_commit_only instruction");
  const {core, liveState} = validateRoomLinkage(program, room, live, roomInfo, liveInfo);
  validateSettlementInstruction(settlement, program, room, live, core, liveState);
  const returns = await withTimeout(Promise.all(returnSignatures.map(value => connection.getParsedTransaction(value, {commitment: "confirmed", maxSupportedTransactionVersion: 0}))), 30_000, "return proof reads");
  if (returns.some(value => !value || changedTokenAccounts(value as any) !== 2)) throw new Error("each return must change exactly one vault and one owner balance");
  if (!measurements.commitOnlyDevnet || !measurements.normalSettlementDevnet || Object.values(measurements).some(value => value.wireBytes > 1_232 || value.budgetWithMargin > 1_400_000)) throw new Error("public measurement report failed proof ceilings or evidence boundary");
  const lines = ["# TradeTable Devnet Proof", "", "## PUBLIC DEVNET EVIDENCE BOUNDARY", "", "Public proof is commit-only ER finalization followed by a separate base settlement. Local composed-action evidence is not claimed as public Devnet evidence.", "", `- Program: ${explorerAddress(program)}`, `- RoomCore: ${explorerAddress(room)}`, `- RoomLive: ${explorerAddress(live)}`, `- Commit-only ER: ${commitSignature} (confirmed through ${ER_RPC})`, `- Settlement: ${explorerTx(settlementSignature)} (exact settle_committed; 3 transferChecked instructions; amount 1; decimals 0; selectedMask ${core.selectedMask})`, ...returnSignatures.map(value => `- Return: ${explorerTx(value)} (separate one-asset base transaction)`), ...signatures.map(value => `- Transaction: ${explorerTx(value)}`), `- Measurements: ${JSON.stringify(measurements)}`, ""];
  mkdirSync("submission", {recursive: true});
  writeFileSync("submission/proof.md", lines.join("\n"));
  process.stdout.write(lines.join("\n"));
}

const actions: Record<string, () => Promise<void>> = {seed, measure, prove};
if (!actions[command]) throw new Error("command must be seed, measure, or prove");
actions[command]().catch(error => { console.error(error); process.exitCode = 1; });
