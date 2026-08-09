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
export type AuthoritySource = "base-ws" | "base-poll" | "router-ws" | "router-poll" | "er-ws" | "er-poll";
export type LiveProjection = { revision: bigint; allocationHash: Uint8Array; lockMask: number; phase: string; source: AuthoritySource; observedAt: number };
export type SourceWatermarks = Record<AuthoritySource, number>;

export const emptyWatermarks = (): SourceWatermarks => ({"base-ws": 0, "base-poll": 0, "router-ws": 0, "router-poll": 0, "er-ws": 0, "er-poll": 0});

export function acceptSourceSlot(watermarks: SourceWatermarks, source: AuthoritySource, slot: number): boolean {
  if (slot < watermarks[source]) return false;
  watermarks[source] = slot;
  return true;
}

export function liveSourceIsAuthoritative(source: AuthoritySource, delegated: boolean, directValidator: boolean): boolean {
  if (!delegated) return source === "base-ws" || source === "base-poll";
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
      transaction.recentBlockhash = (await endpoint.getLatestBlockhash("confirmed")).blockhash;
      const signed = await wallet.signTransaction(transaction);
      return await endpoint.sendRawTransaction(signed.serialize(), {skipPreflight: false});
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function sendErWithFallback(wallet: Wallet, instruction: TransactionInstruction): Promise<string> {
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = wallet.publicKey;
  try {
    const router = routerConnection();
    transaction.recentBlockhash = await accountAwareRouterBlockhash(instruction);
    const signed = await wallet.signTransaction(transaction);
    return router.sendRawTransaction(signed.serialize(), {skipPreflight: true});
  } catch (routerError) {
    const er = directErConnection();
    transaction.recentBlockhash = (await er.getLatestBlockhash("confirmed")).blockhash;
    const signed = await wallet.signTransaction(transaction);
    const signature = await er.sendRawTransaction(signed.serialize(), {skipPreflight: true});
    console.warn("router send failed; direct ER used", routerError);
    return signature;
  }
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
  let delegated = false;
  let directValidator = false;
  const publishCore = (data: Buffer, source: AuthoritySource, slot: number) => { if (acceptSourceSlot(coreWatermarks, source, slot)) onCore(data, source); };
  const publishLive = (data: Buffer, source: AuthoritySource, slot: number) => {
    if (liveSourceIsAuthoritative(source, delegated, directValidator) && acceptSourceSlot(liveWatermarks, source, slot)) onLive(data, source);
  };
  const baseCoreId = base.onAccountChange(core, (value, context) => publishCore(value.data, "base-ws", context.slot), "confirmed");
  const baseLiveId = base.onAccountChange(live, (value, context) => {
    delegated = value.owner.equals(DELEGATION_PROGRAM_ID);
    publishLive(value.data, "base-ws", context.slot);
  }, "confirmed");
  const routerLiveId = router.onAccountChange(live, (value, context) => publishLive(value.data, "router-ws", context.slot), "confirmed");
  const erLiveId = er.onAccountChange(live, (value, context) => publishLive(value.data, "er-ws", context.slot), "confirmed");
  const pollId = setInterval(async () => {
    const baseReader = baseFallback ?? base;
    const [coreResult, baseLiveResult, delegation] = await Promise.all([
      baseReader.getAccountInfoAndContext(core, "confirmed"),
      baseReader.getAccountInfoAndContext(live, "confirmed"),
      getDelegationRecord(baseReader, live, "confirmed").catch(() => null),
    ]);
    delegated = Boolean(baseLiveResult.value?.owner.equals(DELEGATION_PROGRAM_ID) && delegation?.status === 0);
    directValidator = Boolean(delegated && delegation?.status === 0 && delegation.validator.equals(ER_VALIDATOR));
    if (coreResult.value) publishCore(coreResult.value.data, "base-poll", coreResult.context.slot);
    if (!delegated && baseLiveResult.value) publishLive(baseLiveResult.value.data, "base-poll", baseLiveResult.context.slot);
    if (delegated) {
      const connection = directValidator ? er : router;
      const result = await connection.getAccountInfoAndContext(live, "confirmed").catch(() => null);
      if (result?.value) publishLive(result.value.data, directValidator ? "er-poll" : "router-poll", result.context.slot);
    }
  }, 1_000);
  return async () => {
    clearInterval(pollId);
    await Promise.all([base.removeAccountChangeListener(baseCoreId), base.removeAccountChangeListener(baseLiveId), router.removeAccountChangeListener(routerLiveId), er.removeAccountChangeListener(erLiveId)]);
  };
}

export async function waitForBaseSettlement(core: PublicKey, predicate: (data: Buffer) => boolean, timeoutMs = 60_000): Promise<Buffer> {
  const connection = baseConnection();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await connection.getAccountInfo(core, "confirmed");
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
