// File: src/lib/tradetable.ts
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID, getDelegationRecord } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {sha256} from "@noble/hashes/sha256";
import {concatBytes} from "@noble/hashes/utils";

export const BASE_RPC = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
export const BASE_RPC_FALLBACK = process.env.NEXT_PUBLIC_SOLANA_RPC_FALLBACK_URL;
export const ROUTER_RPC = process.env.NEXT_PUBLIC_MAGIC_ROUTER_RPC ?? "https://devnet-router.magicblock.app";
export const ROUTER_WS = process.env.NEXT_PUBLIC_MAGIC_ROUTER_WS ?? "wss://devnet-router.magicblock.app";
export const ER_RPC = process.env.NEXT_PUBLIC_MAGIC_ER_RPC ?? "https://devnet-as.magicblock.app/";
export const ER_WS = process.env.NEXT_PUBLIC_MAGIC_ER_WS ?? "wss://devnet-as.magicblock.app/";
const LOCAL_ER_VALIDATOR = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
const DEVNET_ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

export function erValidatorForBase(endpoint: string): PublicKey {
  return isLocalRpcEndpoint(endpoint) ? LOCAL_ER_VALIDATOR : DEVNET_ER_VALIDATOR;
}

export const ER_VALIDATOR = erValidatorForBase(BASE_RPC);

export function programId(): PublicKey {
  const value = process.env.NEXT_PUBLIC_PROGRAM_ID;
  if (!value) throw new Error("NEXT_PUBLIC_PROGRAM_ID is required after anchor keys sync");
  return new PublicKey(value);
}

export type Cycle = "forward" | "reverse";
export type AuthoritySource = "base-ws" | "base-poll" | "base-fallback-poll" | "router-ws" | "router-poll" | "er-ws" | "er-poll";
export type LiveProjection = { revision: bigint; allocationHash: Uint8Array; lockMask: number; phase: string; source: AuthoritySource; observedAt: number };
export type SourceWatermarks = Record<AuthoritySource, number>;
export type ProposalPending = {kind: "propose"; actorIndex: number; revision: bigint; slots: [number, number, number]; cycle: Cycle; allocationHash: number[]};
export type LockPending = {kind: "lock"; actorIndex: number; revision: bigint; allocationHash: number[]};
export type PendingPostcondition = ProposalPending | LockPending;
export type PostconditionView = {revision: bigint; selectedSlots: [number, number, number]; cycle: Cycle; allocationHash: number[]; lockMask: number; lockedRevision: bigint[]; lockedHash: number[][]};

const equalBytes = (left: number[], right: number[]) => left.length === right.length && left.every((value, index) => value === right[index]);

export function selectedSlotsFromChoices(choices: [number, number, number]): [number, number, number] {
  if (choices.some(choice => choice !== 0 && choice !== 1)) throw new Error("each owner choice must be zero or one");
  return choices.map((choice, owner) => owner * 2 + choice) as [number, number, number];
}

export function pendingPostconditionMet(pending: PendingPostcondition, view: PostconditionView): boolean {
  if (view.revision !== pending.revision || !equalBytes(view.allocationHash, pending.allocationHash)) return false;
  if (pending.kind === "propose") return view.cycle === pending.cycle && view.selectedSlots.every((slot, index) => slot === pending.slots[index]);
  const bit = 1 << pending.actorIndex;
  return Boolean(view.lockMask & bit) && view.lockedRevision[pending.actorIndex] === pending.revision
    && equalBytes(view.lockedHash[pending.actorIndex], pending.allocationHash);
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function primaryThenFallback<T>(primary: () => Promise<T | null>, fallback?: () => Promise<T | null>): Promise<T | null> {
  try {
    const value = await primary();
    if (value !== null) return value;
  } catch (error) {
    if (!fallback) throw error;
  }
  return fallback ? fallback() : null;
}

export const emptyWatermarks = (): SourceWatermarks => ({"base-ws": 0, "base-poll": 0, "base-fallback-poll": 0, "router-ws": 0, "router-poll": 0, "er-ws": 0, "er-poll": 0});

export const basePollSource = (usingFallback: boolean): AuthoritySource => usingFallback ? "base-fallback-poll" : "base-poll";

export function acceptSourceSlot(watermarks: SourceWatermarks, source: AuthoritySource, slot: number): boolean {
  const domain = source.startsWith("base-") ? ["base-ws", "base-poll", "base-fallback-poll"] as AuthoritySource[]
    : ["router-ws", "router-poll", "er-ws", "er-poll"] as AuthoritySource[];
  if (slot < Math.max(...domain.map(candidate => watermarks[candidate]))) return false;
  watermarks[source] = slot;
  return true;
}

export function liveSourceIsAuthoritative(source: AuthoritySource, delegated: boolean, directValidator: boolean): boolean {
  if (!delegated) return source === "base-ws" || source === "base-poll" || source === "base-fallback-poll";
  if (source === "router-ws" || source === "router-poll") return true;
  return directValidator && (source === "er-ws" || source === "er-poll");
}

export function isProjectionStale(observedAt: number, now = Date.now(), thresholdMs = 5_000): boolean {
  return now - observedAt > thresholdMs;
}

export function isLocalRpcEndpoint(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function fixtureFundingLamports(endpoint: string, balance: number): number | null {
  if (isLocalRpcEndpoint(endpoint)) return null;
  return Math.max(0, 10_000_000 - balance);
}

export function seedRoomMissingSlots(depositedMask: number, actualRoster: string[], expectedRoster: string[]): number[] {
  if (depositedMask < 0 || depositedMask > 63) throw new Error("invalid deposit mask on deterministic room");
  if (actualRoster.length !== expectedRoster.length || actualRoster.some((value, index) => value !== expectedRoster[index])) throw new Error("existing deterministic room is roster-mismatched");
  return [0, 1, 2, 3, 4, 5].filter(slot => (depositedMask & (1 << slot)) === 0);
}

export function ephemeralTarget(baseEndpoint: string): {rpc: string; validator: PublicKey} {
  if (isLocalRpcEndpoint(baseEndpoint)) return {rpc: "http://127.0.0.1:7799", validator: new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev")};
  return {rpc: ER_RPC, validator: ER_VALIDATOR};
}

export function immutableMintRecovery(supply: bigint, mintAuthority: PublicKey | null, freezeAuthority: PublicKey | null, payer: PublicKey) {
  if (supply < 0n || supply > 1n) throw new Error("invalid supply for deterministic mint recovery");
  if (mintAuthority && !mintAuthority.equals(payer)) throw new Error("foreign mint authority on deterministic fixture");
  if (freezeAuthority && !freezeAuthority.equals(payer)) throw new Error("foreign freeze authority on deterministic fixture");
  if (supply === 0n && !mintAuthority) throw new Error("missing mint authority on empty deterministic fixture");
  return {mint: supply === 0n, revokeMint: Boolean(mintAuthority), revokeFreeze: Boolean(freezeAuthority)};
}

export function roomPda(creator: PublicKey, nonce: bigint): [PublicKey, number] {
  const value = new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0, nonce, true);
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("room"), creator.toBytes(), value], programId());
}

export function livePda(core: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("live"), core.toBytes()], programId());
}

export function vaultAuthorityPda(core: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("vault_authority"), core.toBytes()], programId());
}

export function vaultAta(core: PublicKey, mint: PublicKey): PublicKey {
  const [authority] = vaultAuthorityPda(core);
  return getAssociatedTokenAddressSync(mint, authority, true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function destinationAta(recipient: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function destinations(cycle: Cycle): [number, number, number] {
  return cycle === "forward" ? [1, 2, 0] : [2, 0, 1];
}

export function allocationHash(core: PublicKey, revision: bigint, expiry: bigint, slots: [number, number, number], cycle: Cycle): Uint8Array {
  const revisionBytes = new Uint8Array(8);
  const expiryBytes = new Uint8Array(8);
  new DataView(revisionBytes.buffer).setBigUint64(0, revision, true);
  new DataView(expiryBytes.buffer).setBigInt64(0, expiry, true);
  const payload = concatBytes(
    new TextEncoder().encode("tradetable-allocation-v1"), core.toBytes(), revisionBytes, expiryBytes,
    Uint8Array.from(slots), Uint8Array.from([cycle === "forward" ? 0 : 1]), Uint8Array.from(destinations(cycle)),
  );
  return sha256(payload);
}

export function programFor(idl: Idl, wallet: Wallet, connection = baseConnection()): Program {
  const provider = new AnchorProvider(connection, wallet, {commitment: "confirmed"});
  return new Program(idl, provider);
}

export function baseConnection(): Connection {
  return new Connection(BASE_RPC, {commitment: "confirmed", wsEndpoint: process.env.NEXT_PUBLIC_SOLANA_WS_URL});
}

export function routerConnection(): ConnectionMagicRouter {
  return new ConnectionMagicRouter(ROUTER_RPC, {wsEndpoint: ROUTER_WS});
}

export function directErConnection(): Connection {
  return new Connection(ER_RPC, {commitment: "confirmed", wsEndpoint: ER_WS});
}

export function routerSubscriptionConnection(): Connection {
  return new Connection(ROUTER_RPC, {commitment: "confirmed", wsEndpoint: ROUTER_WS});
}

async function accountAwareRouterBlockhash(instruction: TransactionInstruction): Promise<string> {
  const writable = instruction.keys.filter(meta => meta.isWritable).map(meta => meta.pubkey.toBase58());
  const response = await fetch(ROUTER_RPC, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [writable]}),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as {result?: {blockhash?: string}; error?: unknown};
  if (!response.ok || !payload.result?.blockhash) throw new Error(`router blockhash failed: ${JSON.stringify(payload.error)}`);
  return payload.result.blockhash;
}

export async function sendBase(connection: Connection, wallet: Wallet, instruction: TransactionInstruction): Promise<string> {
  return sendBaseInstructions(connection, wallet, [instruction]);
}

async function baseBlockhashEndpoint(primary: Connection, fallback?: Connection): Promise<{connection: Connection; blockhash: string}> {
  try {
    const value = await withTimeout(primary.getLatestBlockhash("confirmed"), 10_000, "base blockhash read");
    return {connection: primary, blockhash: value.blockhash};
  } catch (error) {
    if (!fallback) throw error;
    const value = await withTimeout(fallback.getLatestBlockhash("confirmed"), 10_000, "fallback base blockhash read");
    return {connection: fallback, blockhash: value.blockhash};
  }
}

export async function sendBaseInstructions(connection: Connection, wallet: Wallet, instructions: TransactionInstruction[], fallbackConnection?: Connection, onSigned?: (intent: SignedIntent) => void): Promise<string> {
  if (!instructions.length) throw new Error("at least one base instruction is required");
  const configuredFallback = fallbackConnection ?? (BASE_RPC_FALLBACK ? new Connection(BASE_RPC_FALLBACK, "confirmed") : undefined);
  const selected = await baseBlockhashEndpoint(connection, configuredFallback);
  const transaction = new Transaction().add(...instructions);
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = selected.blockhash;
  const signed = await wallet.signTransaction(transaction);
  if (signed.signature) onSigned?.({signature: base58Encode(signed.signature), endpoint: "base", recentBlockhash: selected.blockhash, rpcUrl: selected.connection.rpcEndpoint});
  try { return await withTimeout(selected.connection.sendRawTransaction(signed.serialize(), {skipPreflight: false}), 20_000, "base transaction send"); }
  catch (error) {
    if (!signed.signature) throw error;
    const signature = base58Encode(signed.signature);
    if (deterministicSendRejection(error)) throw new SignedTransactionRejectedError(signature, "base", selected.blockhash, selected.connection.rpcEndpoint, error);
    throw new AmbiguousBroadcastError(signature, "base", selected.blockhash, selected.connection.rpcEndpoint, error);
  }
}

export type ErTransport = {
  routerBlockhash(instruction: TransactionInstruction): Promise<string>;
  directBlockhash(): Promise<string>;
  sendRouter(transaction: Transaction): Promise<string>;
  sendDirect(transaction: Transaction): Promise<string>;
};
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (let index = zeros; index < bytes.length; index += 1) {
    let carry = bytes[index];
    for (let digit = 0; digit < digits.length; digit += 1) {
      carry += digits[digit] * 256;
      digits[digit] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return "1".repeat(zeros) + digits.reverse().map(value => BASE58_ALPHABET[value]).join("");
}

export type SignedEndpoint = "base" | "router" | "direct";
export type SignedIntent = {signature: string; endpoint: SignedEndpoint; recentBlockhash: string; rpcUrl: string};

export class AmbiguousBroadcastError extends Error {
  constructor(public readonly signature: string, public readonly endpoint: SignedEndpoint, public readonly recentBlockhash: string, public readonly rpcUrl: string, cause: unknown) {
    super(`${endpoint} broadcast outcome is ambiguous for signed transaction ${signature}`, {cause});
  }
}

export class SignedTransactionRejectedError extends Error {
  constructor(public readonly signature: string, public readonly endpoint: SignedEndpoint, public readonly recentBlockhash: string, public readonly rpcUrl: string, cause: unknown) {
    super(`${endpoint} rejected signed transaction ${signature}`, {cause});
  }
}

function deterministicSendRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /simulation failed|custom program error|instruction error|signature verification|blockhash not found/i.test(message);
}

export function ambiguousBroadcastSignature(error: unknown): string | null {
  return error instanceof AmbiguousBroadcastError ? error.signature : null;
}

async function selectErEndpoint(instruction: TransactionInstruction, transport: ErTransport) {
  try { return {kind: "router" as const, blockhash: await transport.routerBlockhash(instruction)}; }
  catch { return {kind: "direct" as const, blockhash: await transport.directBlockhash()}; }
}

export async function sendErWithTransport(wallet: Wallet, instruction: TransactionInstruction, transport: ErTransport, onSigned?: (intent: SignedIntent) => void): Promise<string> {
  const selected = await selectErEndpoint(instruction, transport);
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = selected.blockhash;
  const signed = await wallet.signTransaction(transaction);
  if (signed.signature) onSigned?.({signature: base58Encode(signed.signature), endpoint: selected.kind, recentBlockhash: selected.blockhash, rpcUrl: selected.kind === "router" ? ROUTER_RPC : ER_RPC});
  try { return await (selected.kind === "router" ? transport.sendRouter(signed) : transport.sendDirect(signed)); }
  catch (error) {
    if (!signed.signature) throw error;
    const signature = base58Encode(signed.signature);
    const rpcUrl = selected.kind === "router" ? ROUTER_RPC : ER_RPC;
    if (deterministicSendRejection(error)) throw new SignedTransactionRejectedError(signature, selected.kind, selected.blockhash, rpcUrl, error);
    throw new AmbiguousBroadcastError(signature, selected.kind, selected.blockhash, rpcUrl, error);
  }
}

export function sendErWithFallback(wallet: Wallet, instruction: TransactionInstruction, onSigned?: (intent: SignedIntent) => void): Promise<string> {
  const router = routerConnection();
  const direct = directErConnection();
  return sendErWithTransport(wallet, instruction, {
    routerBlockhash: accountAwareRouterBlockhash,
    directBlockhash: async () => (await withTimeout(direct.getLatestBlockhash("confirmed"), 10_000, "direct ER blockhash read")).blockhash,
    sendRouter: transaction => withTimeout(router.sendRawTransaction(transaction.serialize(), {skipPreflight: true}), 20_000, "router transaction send"),
    sendDirect: transaction => withTimeout(direct.sendRawTransaction(transaction.serialize(), {skipPreflight: true}), 20_000, "direct ER transaction send"),
  }, onSigned);
}

export type SignedOutcomeReader = {signatureStatus(signature: string): Promise<{err: unknown} | null>; blockhashValid(blockhash: string): Promise<boolean>};
function connectionOutcomeReader(connection: Connection): SignedOutcomeReader {
  return {signatureStatus: async signature => {
    const status = (await connection.getSignatureStatuses([signature], {searchTransactionHistory: true})).value[0];
    return status ? {err: status.err} : null;
  }, blockhashValid: async blockhash => (await connection.isBlockhashValid(blockhash, {commitment: "confirmed"})).value};
}

export async function readSignedOutcome(intent: SignedIntent, injected?: SignedOutcomeReader): Promise<{status: {err: unknown} | null; blockhashValid: boolean | null}> {
  const reader = injected ?? connectionOutcomeReader(new Connection(intent.rpcUrl, "confirmed"));
  let status: {err: unknown} | null = null;
  try { status = await reader.signatureStatus(intent.signature); }
  catch { return {status: null, blockhashValid: null}; }
  if (status) return {status: {err: status.err}, blockhashValid: null};
  try { return {status: null, blockhashValid: await reader.blockhashValid(intent.recentBlockhash)}; }
  catch { return {status: null, blockhashValid: null}; }
}

export function subscribeAuthoritative(
  core: PublicKey,
  live: PublicKey,
  onCore: (data: Buffer, source: AuthoritySource) => void,
  onLive: (data: Buffer, source: AuthoritySource) => void,
  onHealth?: (ready: boolean, error?: unknown) => void,
): (() => Promise<void>) & {refresh(): Promise<void>} {
  const base = baseConnection();
  const baseFallback = BASE_RPC_FALLBACK ? new Connection(BASE_RPC_FALLBACK, "confirmed") : null;
  const router = routerSubscriptionConnection();
  const er = directErConnection();
  const coreWatermarks = emptyWatermarks();
  const liveWatermarks = emptyWatermarks();
  let active = true;
  let delegated = false;
  let directValidator = false;
  let pollFailureReported = false;
  let inFlight: Promise<void> | null = null;
  const publishCore = (data: Buffer, source: AuthoritySource, slot: number) => { if (active && acceptSourceSlot(coreWatermarks, source, slot)) onCore(data, source); };
  const publishLive = (data: Buffer, source: AuthoritySource, slot: number) => {
    if (active && liveSourceIsAuthoritative(source, delegated, directValidator) && acceptSourceSlot(liveWatermarks, source, slot)) onLive(data, source);
  };
  const baseCoreId = base.onAccountChange(core, (value, context) => publishCore(value.data, "base-ws", context.slot), "confirmed");
  const baseLiveId = base.onAccountChange(live, (value, context) => {
    delegated = value.owner.equals(DELEGATION_PROGRAM_ID);
    publishLive(value.data, "base-ws", context.slot);
  }, "confirmed");
  const routerLiveId = router.onAccountChange(live, (value, context) => publishLive(value.data, "router-ws", context.slot), "confirmed");
  const erLiveId = er.onAccountChange(live, (value, context) => publishLive(value.data, "er-ws", context.slot), "confirmed");
  const readBase = async (reader: Connection) => {
    const values = await withTimeout(Promise.all([
      reader.getAccountInfoAndContext(core, "confirmed"),
      reader.getAccountInfoAndContext(live, "confirmed"),
    ]), 10_000, "base authority poll");
    return values.every(value => value.value) ? {reader, values} : null;
  };
  const poll = async () => {
    const primary = () => readBase(base);
    const fallback = baseFallback ? () => readBase(baseFallback) : undefined;
    let baseValues = await primaryThenFallback(primary, fallback);
    if (!baseValues) throw new Error("base authority accounts unavailable");
    let [coreResult, baseLiveResult] = baseValues.values;
    let delegation = await withTimeout(getDelegationRecord(baseValues.reader, live, "confirmed"), 10_000, "delegation read").catch(() => null);
    if (baseLiveResult.value?.owner.equals(DELEGATION_PROGRAM_ID) && !delegation && baseFallback && baseValues.reader === base) {
      const recovered = await readBase(baseFallback);
      if (recovered) {
        baseValues = recovered;
        [coreResult, baseLiveResult] = recovered.values;
        delegation = await withTimeout(getDelegationRecord(baseFallback, live, "confirmed"), 10_000, "fallback delegation read").catch(() => null);
      }
    }
    delegated = Boolean(baseLiveResult.value?.owner.equals(DELEGATION_PROGRAM_ID) && delegation?.status === 0);
    directValidator = Boolean(delegated && delegation?.status === 0 && delegation.validator.equals(ER_VALIDATOR));
    const baseSource = basePollSource(Boolean(baseFallback && baseValues.reader === baseFallback));
    if (coreResult.value) publishCore(coreResult.value.data, baseSource, coreResult.context.slot);
    if (!delegated && baseLiveResult.value) publishLive(baseLiveResult.value.data, baseSource, baseLiveResult.context.slot);
    if (delegated) {
      const connection = directValidator ? er : router;
      const result = await withTimeout(connection.getAccountInfoAndContext(live, "confirmed"), 10_000, "live authority poll").catch(() => null);
      if (result?.value) publishLive(result.value.data, directValidator ? "er-poll" : "router-poll", result.context.slot);
    }
    pollFailureReported = false;
    if (active) onHealth?.(true);
  };
  const refresh = () => {
    if (!active) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = poll().catch(error => {
      if (active) onHealth?.(false, error);
    if (!pollFailureReported) console.warn("authority poll failed; projection will become stale", error);
    pollFailureReported = true;
    }).finally(() => {inFlight = null;});
    return inFlight;
  };
  const pollId = setInterval(() => {void refresh();}, 1_000);
  void refresh();
  const stop = async () => {
    active = false;
    clearInterval(pollId);
    await Promise.allSettled([base.removeAccountChangeListener(baseCoreId), base.removeAccountChangeListener(baseLiveId), router.removeAccountChangeListener(routerLiveId), er.removeAccountChangeListener(erLiveId)]);
  };
  stop.refresh = refresh;
  return stop;
}

export async function waitForBaseSettlement(core: PublicKey, predicate: (data: Buffer) => boolean, timeoutMs = 60_000): Promise<Buffer> {
  const connection = baseConnection();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await withTimeout(connection.getAccountInfo(core, "confirmed"), 10_000, "base settlement read");
    if (value && predicate(value.data)) return value.data;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error("base settlement did not converge before timeout");
}

export function explorerAddress(address: PublicKey): string {
  return `https://explorer.solana.com/address/${address.toBase58()}?cluster=devnet`;
}

export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function alternateExplorerTx(signature: string): string {
  const root = process.env.NEXT_PUBLIC_SOLANAFM_URL ?? "https://solana.fm";
  return `${root}/tx/${signature}?cluster=devnet-solana`;
}

export const bn = (value: bigint): BN => new BN(value.toString());
export const systemProgram = SystemProgram.programId;
