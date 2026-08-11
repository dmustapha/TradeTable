import {DELEGATION_PROGRAM_ID, getDelegationRecord} from "@magicblock-labs/ephemeral-rollups-sdk";
import {Connection, PublicKey, type AccountInfo} from "@solana/web3.js";

import {decodeRoomCore, decodeRoomLive, type RoomCore, type RoomLive} from "./room-state";
import {
  BASE_RPC, BASE_RPC_FALLBACK, ER_RPC, ER_VALIDATOR, ROUTER_RPC, livePda, programId, withTimeout,
} from "./tradetable";

export type RoomAccount = Pick<AccountInfo<Buffer>, "data" | "owner">;
type LocatedAccount = RoomAccount & {connection: Connection};
export type AccountReadSource<T extends RoomAccount = RoomAccount> = {
  label: string;
  read(address: PublicKey): Promise<T | null>;
};
type AccountReadResult<T extends RoomAccount> = {kind: "found"; account: T; endpoint: string} | {kind: "missing"};
export type LoadedRoom = {
  address: PublicKey;
  liveAddress: PublicKey;
  core: RoomCore;
  live: RoomLive;
  authority: "solana-base" | "magicblock-er";
  authorityEndpoint: string;
  delegated: boolean;
  observedAt: number;
};

export class RoomNotFoundError extends Error {}
export class RoomIntegrityError extends Error {}
export class RoomAvailabilityError extends RoomIntegrityError {}

export function roomStateForClient<T>(value: T): T {
  if (value instanceof Uint8Array) return Array.from(value) as T;
  if (Array.isArray(value)) return value.map(roomStateForClient) as T;
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roomStateForClient(item)])) as T;
}

const same = (left: Uint8Array, right: Uint8Array) => left.length === right.length
  && left.every((value, index) => value === right[index]);

export function canonicalRoomAddress(value: string): string {
  try { return new PublicKey(value.trim()).toBase58(); }
  catch { throw new Error("Enter a valid Solana room address."); }
}

export function roomExpiryUnix(nowMs: number, minutes: number): bigint {
  if (!Number.isInteger(minutes) || minutes < 21) throw new Error("Expiry must be at least 21 minutes.");
  return BigInt(Math.floor(nowMs / 1_000)) + BigInt(minutes * 60);
}

function canonicalCorePda(core: RoomCore, owner: PublicKey): PublicKey {
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, core.roomNonce, true);
  return PublicKey.findProgramAddressSync([
    new TextEncoder().encode("room"), core.creator, nonce,
  ], owner)[0];
}

function canonicalLivePda(core: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("live"), core.toBytes()], owner)[0];
}

function validateCore(address: PublicKey, account: RoomAccount, owner: PublicKey): RoomCore {
  if (!account.owner.equals(owner)) throw new RoomIntegrityError("RoomCore is not owned by the TradeTable program.");
  const core = decodeRoomCore(account.data);
  if (!canonicalCorePda(core, owner).equals(address)) throw new RoomIntegrityError("RoomCore is not its canonical room PDA.");
  return core;
}

function validateLiveLink(address: PublicKey, liveAddress: PublicKey, core: RoomCore, live: RoomLive) {
  if (!same(core.liveRoom, liveAddress.toBytes())) throw new RoomIntegrityError("RoomCore does not link to its canonical RoomLive.");
  if (!same(live.core, address.toBytes())) throw new RoomIntegrityError("RoomLive does not link back to RoomCore.");
  if (!core.participants.every((item, index) => same(item, live.participants[index]))) throw new RoomIntegrityError("RoomLive roster does not match RoomCore.");
  if (core.expiresAt !== live.expiresAt) throw new RoomIntegrityError("RoomCore and RoomLive expiry do not match.");
}

export function validateRoomAccounts(address: PublicKey, coreAccount: RoomAccount, liveAccount: RoomAccount | null, owner: PublicKey) {
  const core = validateCore(address, coreAccount, owner);
  const liveAddress = canonicalLivePda(address, owner);
  if (!new PublicKey(core.liveRoom).equals(liveAddress)) throw new RoomIntegrityError("RoomCore contains a non-canonical RoomLive PDA.");
  if (!liveAccount) return {core, liveAddress, live: null};
  const legalOwner = liveAccount.owner.equals(owner) || liveAccount.owner.equals(DELEGATION_PROGRAM_ID);
  if (!legalOwner) throw new RoomIntegrityError("RoomLive has an invalid owner.");
  const live = decodeRoomLive(liveAccount.data);
  validateLiveLink(address, liveAddress, core, live);
  return {core, liveAddress, live};
}

export async function readAccountFromSources<T extends RoomAccount>(address: PublicKey, sources: AccountReadSource<T>[], timeoutMs = 10_000): Promise<AccountReadResult<T>> {
  let confirmedMissing = false;
  for (const source of sources) {
    try {
      const account = await withTimeout(source.read(address), timeoutMs, `${source.label} account read`);
      if (account) return {kind: "found", account, endpoint: source.label};
      confirmedMissing = true;
    } catch {}
  }
  if (confirmedMissing) return {kind: "missing"};
  throw new RoomAvailabilityError("Every configured RPC failed; room existence is inconclusive.");
}

function connectionSource(connection: Connection): AccountReadSource<LocatedAccount> {
  return {label: connection.rpcEndpoint, read: async address => {
    const account = await connection.getAccountInfo(address, "confirmed");
    return account ? {...account, connection} : null;
  }};
}

function baseSources(): AccountReadSource<LocatedAccount>[] {
  const connections = [new Connection(BASE_RPC, "confirmed"), ...(BASE_RPC_FALLBACK ? [new Connection(BASE_RPC_FALLBACK, "confirmed")] : [])];
  return connections.map(connectionSource);
}

async function optionalSource<T extends RoomAccount>(address: PublicKey, source: AccountReadSource<T>, timeoutMs: number) {
  try {
    const account = await withTimeout(source.read(address), timeoutMs, `${source.label} account read`);
    return account ? {...account, endpoint: source.label} : null;
  } catch { return null; }
}

async function currentDelegation(read: Promise<{status: number; validator?: PublicKey} | null>, timeoutMs: number) {
  try { return await withTimeout(read, timeoutMs, "delegation read"); }
  catch { throw new RoomAvailabilityError("Current RoomLive delegation could not be read."); }
}

function candidateValid<T extends RoomAccount>(candidate: T | null, validate?: (account: T) => boolean): boolean {
  if (!candidate) return false;
  try { return validate ? validate(candidate) : true; }
  catch { return false; }
}

export async function readDelegatedRoomLive<T extends RoomAccount>(address: PublicKey, delegationRead: Promise<{status: number; validator?: PublicKey} | null>, router: AccountReadSource<T>, directEr: AccountReadSource<T>, timeoutMs = 10_000, validate?: (account: T) => boolean) {
  const [delegation, routed] = await Promise.all([
    currentDelegation(delegationRead, timeoutMs),
    optionalSource(address, router, timeoutMs),
  ]);
  if (delegation?.status !== 0 || !delegation.validator?.equals(ER_VALIDATOR)) throw new RoomIntegrityError("RoomLive delegation is not current for the configured ER validator.");
  if (candidateValid(routed, validate)) return routed!;
  const direct = await optionalSource(address, directEr, timeoutMs);
  if (candidateValid(direct, validate)) return direct!;
  if (routed || direct) throw new RoomIntegrityError("Router and direct ER returned invalid RoomLive candidates.");
  throw new RoomAvailabilityError("Router and direct ER could not provide authoritative RoomLive state.");
}

type PollOptions = {rpcTimeoutMs?: number; totalTimeoutMs?: number; pollMs?: number};
type ResolvedPoll = Required<PollOptions> & {deadlineAt: number};

function validateInitializedPair(coreAddress: PublicKey, liveAddress: PublicKey, owner: PublicKey, coreRead: AccountReadResult<RoomAccount>, liveRead: AccountReadResult<RoomAccount>) {
  if (coreRead.kind !== "found" || liveRead.kind !== "found") return null;
  if (!liveRead.account.owner.equals(owner)) throw new RoomIntegrityError("New RoomLive is not program-owned on Solana base.");
  const checked = validateRoomAccounts(coreAddress, coreRead.account, liveRead.account, owner);
  if (!checked.liveAddress.equals(liveAddress) || !checked.live) throw new RoomIntegrityError("New room linkage is incomplete.");
  return {core: checked.core, live: checked.live};
}

async function pollUntilInitialized(coreAddress: PublicKey, liveAddress: PublicKey, owner: PublicKey, sources: AccountReadSource[], options: ResolvedPoll) {
  while (Date.now() < options.deadlineAt) {
    try {
      const rpcTimeout = Math.max(1, Math.min(options.rpcTimeoutMs, options.deadlineAt - Date.now()));
      const [coreRead, liveRead] = await Promise.all([
        readAccountFromSources(coreAddress, sources, rpcTimeout),
        readAccountFromSources(liveAddress, sources, rpcTimeout),
      ]);
      const verified = validateInitializedPair(coreAddress, liveAddress, owner, coreRead, liveRead);
      if (verified) return verified;
    } catch (error) { if (!(error instanceof RoomAvailabilityError)) throw error; }
    const pause = Math.max(0, Math.min(options.pollMs, options.deadlineAt - Date.now()));
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
  }
  throw new RoomAvailabilityError("Authoritative room state did not appear before the bounded wait ended.");
}

export function pollForInitializedRoom(coreAddress: PublicKey, liveAddress: PublicKey, owner: PublicKey, sources: AccountReadSource[], options: PollOptions = {}) {
  const totalTimeoutMs = options.totalTimeoutMs ?? 20_000;
  const resolved = {rpcTimeoutMs: options.rpcTimeoutMs ?? 5_000, totalTimeoutMs, pollMs: options.pollMs ?? 750, deadlineAt: Date.now() + totalTimeoutMs};
  return withTimeout(pollUntilInitialized(coreAddress, liveAddress, owner, sources, resolved), resolved.totalTimeoutMs, "post-create bounded wait");
}

export async function loadRoom(address: PublicKey): Promise<LoadedRoom> {
  const owner = programId();
  const liveAddress = livePda(address)[0];
  const sources = baseSources();
  const [coreAccount, baseLive] = await Promise.all([
    readAccountFromSources(address, sources), readAccountFromSources(liveAddress, sources),
  ]);
  if (coreAccount.kind === "missing") throw new RoomNotFoundError("RoomCore was not found on Solana base.");
  if (baseLive.kind === "missing") throw new RoomIntegrityError("Canonical RoomLive was not found on Solana base.");
  const base = validateRoomAccounts(address, coreAccount.account, baseLive.account, owner);
  const delegated = baseLive.account.owner.equals(DELEGATION_PROGRAM_ID);
  const authoritative = delegated ? await delegatedAuthority(address, coreAccount.account, baseLive.account, liveAddress, owner) : {...baseLive.account, endpoint: baseLive.endpoint};
  if (!authoritative.owner.equals(owner)) throw new RoomIntegrityError("Authoritative RoomLive is not owned by the TradeTable program.");
  const checked = validateRoomAccounts(address, coreAccount.account, authoritative, owner);
  if (!checked.live) throw new RoomIntegrityError("Authoritative RoomLive could not be decoded.");
  return {address, liveAddress, core: base.core, live: checked.live, delegated,
    authority: delegated ? "magicblock-er" : "solana-base", authorityEndpoint: authoritative.endpoint, observedAt: Date.now()};
}

function delegatedAuthority(coreAddress: PublicKey, coreAccount: LocatedAccount, baseLive: LocatedAccount, liveAddress: PublicKey, owner: PublicKey) {
  const delegation = getDelegationRecord(baseLive.connection, liveAddress, "confirmed");
  const router = connectionSource(new Connection(ROUTER_RPC, "confirmed"));
  const direct = connectionSource(new Connection(ER_RPC, "confirmed"));
  const validate = (candidate: LocatedAccount) => {
    if (!candidate.owner.equals(owner)) return false;
    return Boolean(validateRoomAccounts(coreAddress, coreAccount, candidate, owner).live);
  };
  return readDelegatedRoomLive(liveAddress, delegation, router, direct, 10_000, validate);
}
