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
export const ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

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
  if (slot < watermarks[source]) return false;
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
  const endpoints = [connection, ...(BASE_RPC_FALLBACK ? [new Connection(BASE_RPC_FALLBACK, "confirmed")] : [])];
  let lastError: unknown;
  for (const endpoint of endpoints) {
    try {
      const transaction = new Transaction().add(instruction);
      transaction.feePayer = wallet.publicKey;
      transaction.recentBlockhash = (await withTimeout(endpoint.getLatestBlockhash("confirmed"), 10_000, "base blockhash read")).blockhash;
      const signed = await wallet.signTransaction(transaction);
      return await withTimeout(endpoint.sendRawTransaction(signed.serialize(), {skipPreflight: false}), 20_000, "base transaction send");
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function sendErWithFallback(wallet: Wallet, instruction: TransactionInstruction): Promise<string> {
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = wallet.publicKey;
  let routerFailure: unknown;
  try {
    transaction.recentBlockhash = await accountAwareRouterBlockhash(instruction);
  } catch (error) { return sendDirectEr(wallet, instruction, error); }
  const signed = await wallet.signTransaction(transaction);
  try { return await withTimeout(routerConnection().sendRawTransaction(signed.serialize(), {skipPreflight: true}), 20_000, "router transaction send"); }
  catch (error) { routerFailure = error; }
  return sendDirectEr(wallet, instruction, routerFailure);
}

async function sendDirectEr(wallet: Wallet, instruction: TransactionInstruction, routerError: unknown): Promise<string> {
  const er = directErConnection();
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (await withTimeout(er.getLatestBlockhash("confirmed"), 10_000, "direct ER blockhash read")).blockhash;
  const signed = await wallet.signTransaction(transaction);
  const signature = await withTimeout(er.sendRawTransaction(signed.serialize(), {skipPreflight: true}), 20_000, "direct ER transaction send");
  console.warn("router send failed; direct ER used", routerError);
  return signature;
}

export function subscribeAuthoritative(
  core: PublicKey,
  live: PublicKey,
  onCore: (data: Buffer, source: AuthoritySource) => void,
  onLive: (data: Buffer, source: AuthoritySource) => void,
): () => Promise<void> {
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
  };
  const pollId = setInterval(() => { void poll().catch(error => {
    if (!pollFailureReported) console.warn("authority poll failed; projection will become stale", error);
    pollFailureReported = true;
  }); }, 1_000);
  return async () => {
    active = false;
    clearInterval(pollId);
    await Promise.allSettled([base.removeAccountChangeListener(baseCoreId), base.removeAccountChangeListener(baseLiveId), router.removeAccountChangeListener(routerLiveId), er.removeAccountChangeListener(erLiveId)]);
  };
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
