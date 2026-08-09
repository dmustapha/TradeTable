import {AnchorProvider, BN, Program, setProvider, workspace} from "@coral-xyz/anchor";
import {
  AuthorityType,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  setAuthority,
} from "@solana/spl-token";
import {Connection, Keypair, PublicKey, SystemProgram, Transaction} from "@solana/web3.js";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {after, test} from "node:test";
import {
  destinationAta,
  ephemeralTarget,
  livePda,
  programId,
  roomPda,
  vaultAta,
  vaultAuthorityPda,
} from "../src/lib/tradetable";

const U64_MAX = "18446744073709551615";
process.env.NEXT_PUBLIC_PROGRAM_ID ??= "FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3";
const testConnections: Connection[] = [];
after(() => testConnections.forEach(connection => (connection as any)._rpcWebSocket?.close()));

function fixtureKey(namespace: string, label: string): Keypair {
  return Keypair.fromSeed(createHash("sha256").update(`${namespace}:${label}`).digest().subarray(0, 32));
}

function anchorProgram() {
  const provider = AnchorProvider.env();
  testConnections.push(provider.connection);
  setProvider(provider);
  return {provider, program: workspace.Tradetable as any};
}

function nonceFor(namespace: string): bigint {
  return BigInt(`0x${createHash("sha256").update(namespace).digest("hex").slice(0, 14)}`);
}

async function rejected(label: string, operation: () => Promise<unknown>): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: transaction unexpectedly succeeded`);
}

async function fund(provider: AnchorProvider, wallet: PublicKey): Promise<void> {
  if (await provider.connection.getBalance(wallet, "confirmed") >= 20_000_000) return;
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey,
    toPubkey: wallet,
    lamports: 20_000_000,
  })));
}

async function immutableAsset(provider: AnchorProvider, owner: Keypair, namespace: string, freeze = false) {
  const payer = (provider.wallet as AnchorProvider["wallet"] & {payer: Keypair}).payer;
  const mint = await createMint(provider.connection, payer, payer.publicKey, freeze ? payer.publicKey : null, 0);
  const source = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, owner.publicKey);
  await mintTo(provider.connection, payer, mint, source.address, payer, 1);
  await setAuthority(provider.connection, payer, mint, payer, AuthorityType.MintTokens, null);
  return {mint, source: source.address, namespace};
}

async function seedTrade(provider: AnchorProvider, program: any, namespace: string) {
  const payer = (provider.wallet as AnchorProvider["wallet"] & {payer: Keypair}).payer;
  const participants = [payer, fixtureKey(namespace, "participant-1"), fixtureKey(namespace, "participant-2")];
  await Promise.all(participants.slice(1).map(key => fund(provider, key.publicKey)));
  const nonce = nonceFor(namespace);
  const [core] = roomPda(payer.publicKey, nonce);
  const [live] = livePda(core);
  const expiry = Math.floor(Date.now() / 1000) + 3_600;
  await program.methods.initializeRoom(new BN(nonce.toString()), participants.map(key => key.publicKey), new BN(expiry))
    .accounts({creator: payer.publicKey, roomCore: core, roomLive: live}).rpc();
  const assets = [] as Array<{mint: PublicKey; source: PublicKey; namespace: string}>;
  for (let slot = 0; slot < 6; slot += 1) {
    const owner = participants[Math.floor(slot / 2)];
    const asset = await immutableAsset(provider, owner, `${namespace}-asset-${slot}`);
    assets.push(asset);
    await program.methods.depositAsset(slot).accounts({
      participant: owner.publicKey, roomCore: core, mint: asset.mint,
      source: asset.source, vault: vaultAta(core, asset.mint),
    }).signers(owner === payer ? [] : [owner]).rpc();
  }
  return {participants, core, live, mints: assets.map(asset => asset.mint)};
}

async function waitForLive(program: any, live: PublicKey): Promise<any> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      return await program.account.roomLive.fetch(live);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  return program.account.roomLive.fetch(live);
}

async function waitForBaseOwner(connection: Connection, live: PublicKey): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const owner = (await connection.getAccountInfo(live, "confirmed"))?.owner;
    if (owner?.equals(programId())) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal((await connection.getAccountInfo(live, "confirmed"))?.owner.toBase58(), programId().toBase58());
}

async function tokenAmounts(provider: AnchorProvider, addresses: PublicKey[]): Promise<bigint[]> {
  return Promise.all(addresses.map(async address => (await getAccount(provider.connection, address, "confirmed")).amount));
}

test("all public contract instructions reject adversarial boundaries without custody drift", async () => {
  try {
  const {provider, program} = anchorProgram();
  const payer = (provider.wallet as AnchorProvider["wallet"] & {payer: Keypair}).payer;
  const namespace = `debug-p5-contracts-${Date.now()}`;
  const owners = [0, 1, 2].map(index => fixtureKey(namespace, `owner-${index}`));
  const outsider = fixtureKey(namespace, "outsider");
  const maxCreator = fixtureKey(namespace, "max-creator");
  await Promise.all([...owners, outsider, maxCreator].map(key => fund(provider, key.publicKey)));

  const clockSlot = await provider.connection.getSlot("confirmed");
  const chainTime = await provider.connection.getBlockTime(clockSlot) ?? Math.floor(Date.now() / 1000);
  const badRosters = [
    [PublicKey.default, owners[1].publicKey, owners[2].publicKey],
    [owners[0].publicKey, owners[0].publicKey, owners[2].publicKey],
  ];
  for (let index = 0; index < badRosters.length; index += 1) {
    const nonce = nonceFor(`${namespace}-bad-roster-${index}`);
    const [core] = roomPda(payer.publicKey, nonce);
    const [live] = livePda(core);
    await rejected("invalid participant roster", () => program.methods
      .initializeRoom(new BN(nonce.toString()), badRosters[index], new BN(chainTime + 3_600))
      .accounts({creator: payer.publicKey, roomCore: core, roomLive: live}).rpc());
    assert.equal(await provider.connection.getAccountInfo(core, "confirmed"), null);
  }

  const tooSoonNonce = nonceFor(`${namespace}-expiry-minus-one`);
  const [tooSoonCore] = roomPda(payer.publicKey, tooSoonNonce);
  const [tooSoonLive] = livePda(tooSoonCore);
  await rejected("expiry below minimum boundary", () => program.methods
    .initializeRoom(new BN(tooSoonNonce.toString()), owners.map(value => value.publicKey), new BN(chainTime + 1_199))
    .accounts({creator: payer.publicKey, roomCore: tooSoonCore, roomLive: tooSoonLive}).rpc());

  const [maxCore] = roomPda(maxCreator.publicKey, BigInt(U64_MAX));
  const [maxLive] = livePda(maxCore);
  await program.methods.initializeRoom(new BN(U64_MAX), owners.map(value => value.publicKey), new BN(chainTime + 1_205))
    .accounts({creator: maxCreator.publicKey, roomCore: maxCore, roomLive: maxLive}).signers([maxCreator]).rpc();
  assert.equal((await program.account.roomCore.fetch(maxCore) as any).roomNonce.toString(), U64_MAX);

  const asset = await immutableAsset(provider, owners[0], `${namespace}-asset`);
  await program.methods.depositAsset(0).accounts({
    participant: owners[0].publicKey, roomCore: maxCore, mint: asset.mint,
    source: asset.source, vault: vaultAta(maxCore, asset.mint),
  }).signers([owners[0]]).rpc();
  await rejected("deposit slot replay", () => program.methods.depositAsset(0).accounts({
    participant: owners[0].publicKey, roomCore: maxCore, mint: asset.mint,
    source: asset.source, vault: vaultAta(maxCore, asset.mint),
  }).signers([owners[0]]).rpc());
  await rejected("duplicate mint in second owner slot", () => program.methods.depositAsset(1).accounts({
    participant: owners[0].publicKey, roomCore: maxCore, mint: asset.mint,
    source: asset.source, vault: vaultAta(maxCore, asset.mint),
  }).signers([owners[0]]).rpc());
  await rejected("slot above upper boundary", () => program.methods.depositAsset(6).accounts({
    participant: owners[0].publicKey, roomCore: maxCore, mint: asset.mint,
    source: asset.source, vault: vaultAta(maxCore, asset.mint),
  }).signers([owners[0]]).rpc());
  await rejected("activation before all six deposits", () => program.methods.activateAndDelegateLive()
    .accounts({participant: owners[0].publicKey, roomCore: maxCore, roomLive: maxLive})
    .signers([owners[0]]).rpc());
  assert.equal((await getAccount(provider.connection, vaultAta(maxCore, asset.mint), "confirmed")).amount, 1n);

  const frozen = await immutableAsset(provider, owners[0], `${namespace}-frozen`, true);
  const freezeNonce = nonceFor(`${namespace}-freeze-policy`);
  const [freezeCore] = roomPda(payer.publicKey, freezeNonce);
  const [freezeLive] = livePda(freezeCore);
  await program.methods.initializeRoom(new BN(freezeNonce.toString()), owners.map(value => value.publicKey), new BN(chainTime + 3_600))
    .accounts({creator: payer.publicKey, roomCore: freezeCore, roomLive: freezeLive}).rpc();
  await rejected("freeze-authority mint", () => program.methods.depositAsset(0).accounts({
    participant: owners[0].publicKey, roomCore: freezeCore, mint: frozen.mint,
    source: frozen.source, vault: vaultAta(freezeCore, frozen.mint),
  }).signers([owners[0]]).rpc());
  assert.equal((await getAccount(provider.connection, frozen.source, "confirmed")).amount, 1n);

  const tradeNamespace = `${namespace}-trade`;
  const {participants: tradeParticipants, core, live, mints} = await seedTrade(provider, program, tradeNamespace);
  const vaults = mints.map(mint => vaultAta(core, mint));
  const beforeActivation = await tokenAmounts(provider, vaults);
  await rejected("outsider activation", () => program.methods.activateAndDelegateLive()
    .accounts({participant: outsider.publicKey, roomCore: core, roomLive: live}).signers([outsider]).rpc());
  assert.deepEqual(await tokenAmounts(provider, vaults), beforeActivation);

  const target = ephemeralTarget(provider.connection.rpcEndpoint);
  await program.methods.activateAndDelegateLive().accounts({
    participant: tradeParticipants[0].publicKey, roomCore: core, roomLive: live,
  }).remainingAccounts([{pubkey: target.validator, isSigner: false, isWritable: false}])
    .signers([tradeParticipants[0]]).rpc();
  const erConnection = new Connection(target.rpc, "confirmed");
  testConnections.push(erConnection);
  const erProgram = new Program(program.idl, new AnchorProvider(erConnection, provider.wallet, provider.opts)) as any;
  await waitForLive(erProgram, live);

  for (const selection of [[2, 2, 4], [0, 1, 4], [0, 2, 255]]) {
    await rejected("selection violates one-per-owner bounds", () => erProgram.methods
      .propose(new BN(0), selection, {forward: {}})
      .accounts({actor: tradeParticipants[0].publicKey, roomCore: core, roomLive: live})
      .signers([tradeParticipants[0]]).rpc());
  }
  await rejected("maximum stale revision", () => erProgram.methods
    .propose(new BN(U64_MAX), [0, 2, 4], {forward: {}})
    .accounts({actor: tradeParticipants[0].publicKey, roomCore: core, roomLive: live})
    .signers([tradeParticipants[0]]).rpc());
  await rejected("outsider proposal", () => erProgram.methods.propose(new BN(0), [0, 2, 4], {forward: {}})
    .accounts({actor: outsider.publicKey, roomCore: core, roomLive: live}).signers([outsider]).rpc());

  await erProgram.methods.propose(new BN(0), [0, 2, 4], {forward: {}})
    .accounts({actor: tradeParticipants[0].publicKey, roomCore: core, roomLive: live})
    .signers([tradeParticipants[0]]).rpc();
  let liveState = await erProgram.account.roomLive.fetch(live) as any;
  const proposalHash = [...liveState.allocationHash];
  const staleHash = [...proposalHash]; staleHash[31] ^= 0xff;
  await rejected("revoke before lock", () => erProgram.methods.revokeLock(new BN(1), proposalHash)
    .accounts({actor: tradeParticipants[0].publicKey, roomCore: core, roomLive: live})
    .signers([tradeParticipants[0]]).rpc());
  await rejected("stale hash lock", () => erProgram.methods.lock(new BN(1), staleHash)
    .accounts({actor: tradeParticipants[0].publicKey, roomCore: core, roomLive: live})
    .signers([tradeParticipants[0]]).rpc());
  for (const participant of tradeParticipants) {
    await erProgram.methods.lock(new BN(1), proposalHash)
      .accounts({actor: participant.publicKey, roomCore: core, roomLive: live}).signers([participant]).rpc();
  }
  await rejected("proposal after third-lock freeze", () => erProgram.methods.propose(new BN(1), [1, 3, 5], {reverse: {}})
    .accounts({actor: tradeParticipants[1].publicKey, roomCore: core, roomLive: live})
    .signers([tradeParticipants[1]]).rpc());
  await rejected("lock replay after freeze", () => erProgram.methods.lock(new BN(1), proposalHash)
    .accounts({actor: tradeParticipants[2].publicKey, roomCore: core, roomLive: live})
    .signers([tradeParticipants[2]]).rpc());

  const selected = [0, 2, 4];
  const recipients = [tradeParticipants[1], tradeParticipants[2], tradeParticipants[0]];
  const destinations: PublicKey[] = [];
  for (let leg = 0; leg < 3; leg += 1) {
    destinations.push((await getOrCreateAssociatedTokenAccount(provider.connection, payer, mints[selected[leg]], recipients[leg].publicKey)).address);
  }
  await erProgram.methods.finalizeCommitOnly().accounts({
    payer: tradeParticipants[0].publicKey, roomCore: core, roomLive: live,
  }).signers([tradeParticipants[0]]).rpc();
  await waitForBaseOwner(provider.connection, live);
  const [vaultAuthority] = vaultAuthorityPda(core);
  const settlement = {
    roomCore: core, roomLive: live, vaultAuthority,
    mint0: mints[0], vault0: vaults[0], destination0: destinations[0],
    mint1: mints[2], vault1: vaults[2], destination1: destinations[1],
    mint2: mints[4], vault2: vaults[4], destination2: destinations[2],
  };
  const preSettlementVaults = await tokenAmounts(provider, vaults);
  await rejected("manual settle_action cannot substitute for Magic action context", () => program.methods.settleAction()
    .accounts(settlement).rpc());
  assert.deepEqual(await tokenAmounts(provider, vaults), preSettlementVaults);

  const wrongThirdDestination = (await getOrCreateAssociatedTokenAccount(
    provider.connection, payer, mints[5], tradeParticipants[0].publicKey,
  )).address;
  await rejected("third-leg mint/vault/destination substitution", () => program.methods.settleCommitted().accounts({
    caller: outsider.publicKey, ...settlement,
    mint2: mints[5], vault2: vaults[5], destination2: wrongThirdDestination,
  }).signers([outsider]).rpc());
  assert.deepEqual(await tokenAmounts(provider, vaults), preSettlementVaults);
  assert.deepEqual(await tokenAmounts(provider, destinations), [0n, 0n, 0n]);
  assert.equal((await program.account.roomCore.fetch(core) as any).selectedMask, 0);

  await program.methods.settleCommitted().accounts({caller: outsider.publicKey, ...settlement}).signers([outsider]).rpc();
  const settledVaults = await tokenAmounts(provider, vaults);
  assert.deepEqual(settledVaults, [0n, 1n, 0n, 1n, 0n, 1n]);
  await rejected("double settlement", () => program.methods.settleCommitted()
    .accounts({caller: outsider.publicKey, ...settlement}).signers([outsider]).rpc());
  assert.deepEqual(await tokenAmounts(provider, vaults), settledVaults);

  const returnAccounts = (slot: number) => ({
    caller: outsider.publicKey, roomCore: core, mint: mints[slot], vault: vaults[slot],
    originalOwner: tradeParticipants[Math.floor(slot / 2)].publicKey,
    originalAta: destinationAta(tradeParticipants[Math.floor(slot / 2)].publicKey, mints[slot]),
  });
  await rejected("selected asset cannot return", () => program.methods.returnAsset(0)
    .accounts(returnAccounts(0)).signers([outsider]).rpc());
  await rejected("wrong vault substitution on return", () => program.methods.returnAsset(1).accounts({
    ...returnAccounts(1), vault: vaults[3],
  }).signers([outsider]).rpc());
  assert.equal((await getAccount(provider.connection, vaults[1], "confirmed")).amount, 1n);
  await program.methods.returnAsset(1).accounts(returnAccounts(1)).signers([outsider]).rpc();
  await rejected("double return", () => program.methods.returnAsset(1)
    .accounts(returnAccounts(1)).signers([outsider]).rpc());
  for (const slot of [3, 5]) {
    await program.methods.returnAsset(slot).accounts(returnAccounts(slot)).signers([outsider]).rpc();
  }
  const complete = await program.account.roomCore.fetch(core) as any;
  assert.equal(complete.status.complete !== undefined, true);
  assert.equal(complete.selectedMask, 21);
  assert.equal(complete.returnedMask, 42);

  await rejected("participant cancellation after completion", () => program.methods.cancelByParticipant()
    .accounts({participant: tradeParticipants[0].publicKey, roomCore: core})
    .signers([tradeParticipants[0]]).rpc());
  await rejected("expiry cancellation before expiry", () => program.methods.cancelExpired()
    .accounts({caller: outsider.publicKey, roomCore: maxCore}).signers([outsider]).rpc());
  } catch (error) {
    console.error("P5_CONTRACT_FAILURE", error);
    throw error;
  }
});
