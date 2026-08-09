// File: tests/tradetable.ts
import {AnchorProvider, BN, Program, setProvider, workspace} from "@coral-xyz/anchor";
import {AuthorityType, closeAccount, createMint, getAccount, getMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority} from "@solana/spl-token";
import {Connection, Keypair, LAMPORTS_PER_SOL, PublicKey} from "@solana/web3.js";
import {strict as assert} from "assert";
import {createHash} from "crypto";
import {
  allocationHash,
  destinationAta,
  destinations,
  livePda,
  programId,
  roomPda,
  vaultAta,
  vaultAuthorityPda,
} from "../src/lib/tradetable";

type Test = {name: string; run: () => void};

function fixtureKey(namespace: string, label: string): Keypair {
  return Keypair.fromSeed(createHash("sha256").update(`${namespace}:${label}`).digest().subarray(0, 32));
}

function withProgramId<T>(callback: () => T): T {
  const previous = process.env.NEXT_PUBLIC_PROGRAM_ID;
  process.env.NEXT_PUBLIC_PROGRAM_ID = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
  try {
    return callback();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_PROGRAM_ID;
    else process.env.NEXT_PUBLIC_PROGRAM_ID = previous;
  }
}

function expectedAllocationHash(
  core: PublicKey,
  revision: bigint,
  expiry: bigint,
  slots: [number, number, number],
  cycle: "forward" | "reverse",
): Buffer {
  const revisionBytes = Buffer.alloc(8);
  const expiryBytes = Buffer.alloc(8);
  revisionBytes.writeBigUInt64LE(revision);
  expiryBytes.writeBigInt64LE(expiry);
  const cycleByte = cycle === "forward" ? 0 : 1;
  const route = cycle === "forward" ? [1, 2, 0] : [2, 0, 1];
  return createHash("sha256").update(Buffer.concat([
    Buffer.from("tradetable-allocation-v1"),
    core.toBuffer(),
    revisionBytes,
    expiryBytes,
    Buffer.from(slots),
    Buffer.from([cycleByte]),
    Buffer.from(route),
  ])).digest();
}

const behavioralTests: Test[] = [
  {
    name: "forward and reverse cycles are exact full derangements",
    run: () => {
      assert.deepEqual(destinations("forward"), [1, 2, 0]);
      assert.deepEqual(destinations("reverse"), [2, 0, 1]);
      for (const route of [destinations("forward"), destinations("reverse")]) {
        assert.equal(new Set(route).size, 3);
        route.forEach((recipient, owner) => assert.notEqual(recipient, owner));
      }
    },
  },
  {
    name: "allocation hash matches the byte-level protocol contract",
    run: () => {
      const core = fixtureKey("hash", "core").publicKey;
      const actual = allocationHash(core, 9n, 1_800_000_000n, [1, 2, 5], "reverse");
      assert.deepEqual(Buffer.from(actual), expectedAllocationHash(core, 9n, 1_800_000_000n, [1, 2, 5], "reverse"));
    },
  },
  {
    name: "allocation hash binds revision, expiry, slots, cycle, and core",
    run: () => {
      const core = fixtureKey("hash", "core-a").publicKey;
      const otherCore = fixtureKey("hash", "core-b").publicKey;
      const baseline = Buffer.from(allocationHash(core, 2n, 1_800_000_000n, [0, 3, 4], "forward")).toString("hex");
      const variants = [
        allocationHash(core, 3n, 1_800_000_000n, [0, 3, 4], "forward"),
        allocationHash(core, 2n, 1_800_000_001n, [0, 3, 4], "forward"),
        allocationHash(core, 2n, 1_800_000_000n, [1, 3, 4], "forward"),
        allocationHash(core, 2n, 1_800_000_000n, [0, 3, 4], "reverse"),
        allocationHash(otherCore, 2n, 1_800_000_000n, [0, 3, 4], "forward"),
      ];
      variants.forEach(value => assert.notEqual(Buffer.from(value).toString("hex"), baseline));
    },
  },
  {
    name: "room, live, and vault PDAs are deterministic and domain-separated",
    run: () => withProgramId(() => {
      const creator = fixtureKey("pda", "creator").publicKey;
      const [roomA] = roomPda(creator, 42n);
      const [roomAgain] = roomPda(creator, 42n);
      const [roomOtherNonce] = roomPda(creator, 43n);
      const [live] = livePda(roomA);
      const [vaultAuthority] = vaultAuthorityPda(roomA);
      assert(roomA.equals(roomAgain));
      assert(!roomA.equals(roomOtherNonce));
      assert(!live.equals(vaultAuthority));
      assert(!roomA.equals(live));
    }),
  },
  {
    name: "vault and destination ATAs use different canonical authorities",
    run: () => withProgramId(() => {
      const creator = fixtureKey("ata", "creator").publicKey;
      const recipient = fixtureKey("ata", "recipient").publicKey;
      const mint = fixtureKey("ata", "mint").publicKey;
      const [core] = roomPda(creator, 1n);
      const vault = vaultAta(core, mint);
      const destination = destinationAta(recipient, mint);
      assert(!vault.equals(destination));
      assert(vault.equals(vaultAta(core, mint)));
      assert(destination.equals(destinationAta(recipient, mint)));
    }),
  },
  {
    name: "missing program ID fails before deriving deployment addresses",
    run: () => {
      const previous = process.env.NEXT_PUBLIC_PROGRAM_ID;
      delete process.env.NEXT_PUBLIC_PROGRAM_ID;
      try {
        assert.throws(() => programId(), /required after anchor keys sync/);
      } finally {
        if (previous !== undefined) process.env.NEXT_PUBLIC_PROGRAM_ID = previous;
      }
    },
  },
];

function runBehavioralAssertions(): void {
  for (const test of behavioralTests) {
    test.run();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  process.stdout.write(`TradeTable behavioral harness passed ${behavioralTests.length} checks\n`);
}

function anchorProgram(): {provider: AnchorProvider; program: any} {
  const provider = AnchorProvider.env();
  setProvider(provider);
  return {provider, program: workspace.Tradetable as Program};
}

async function fund(provider: AnchorProvider, wallet: PublicKey): Promise<void> {
  const signature = await provider.connection.requestAirdrop(wallet, 2 * LAMPORTS_PER_SOL);
  await provider.connection.confirmTransaction(signature, "confirmed");
}

async function immutableAsset(provider: AnchorProvider, owner: Keypair, mintKeypair: Keypair): Promise<{mint: PublicKey; ata: PublicKey}> {
  const payer = (provider.wallet as AnchorProvider["wallet"] & {payer: Keypair}).payer;
  let mint = mintKeypair.publicKey;
  if (!await provider.connection.getAccountInfo(mint, "confirmed")) {
    mint = await createMint(provider.connection, payer, payer.publicKey, payer.publicKey, 0, mintKeypair);
    const created = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, owner.publicKey);
    await mintTo(provider.connection, payer, mint, created.address, payer, 1);
    await setAuthority(provider.connection, payer, mint, payer, AuthorityType.MintTokens, null);
    const freezeAuthoritySignature = await setAuthority(provider.connection, payer, mint, payer, AuthorityType.FreezeAccount, null);
    await provider.connection.confirmTransaction(freezeAuthoritySignature, "confirmed");
  }
  const mintState = await waitForImmutableMint(provider, mint);
  if (mintState.decimals !== 0 || mintState.supply !== 1n || mintState.mintAuthority || mintState.freezeAuthority) throw new Error(`fixture mint policy mismatch: ${mint}`);
  const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, owner.publicKey)).address;
  const token = await getAccount(provider.connection, ata, "confirmed");
  if (!token.owner.equals(owner.publicKey) || token.amount !== 1n) throw new Error(`fixture owner balance mismatch: ${mint}`);
  return {mint, ata};
}

async function waitForImmutableMint(provider: AnchorProvider, mint: PublicKey) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await getMint(provider.connection, mint, "confirmed");
    if (state.decimals === 0 && state.supply === 1n && !state.mintAuthority && !state.freezeAuthority) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return getMint(provider.connection, mint, "confirmed");
}

async function waitForTokenAmount(provider: AnchorProvider, address: PublicKey, amount: bigint) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const account = await getAccount(provider.connection, address, "confirmed");
      if (account.amount === amount) return account;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return getAccount(provider.connection, address, "confirmed");
}

async function waitForMissingAccount(provider: AnchorProvider, address: PublicKey): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!await provider.connection.getAccountInfo(address, "confirmed")) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await provider.connection.getAccountInfo(address, "confirmed"), null);
}

async function expectRejected(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    assert.fail(`${label}: transaction unexpectedly succeeded`);
  } catch (error) {
    assert(!String(error).includes("unexpectedly succeeded"), `${label}: transaction unexpectedly succeeded`);
  }
  process.stdout.write(`PASS ${label}\n`);
}

async function custodySuite(namespace: string): Promise<void> {
  const {provider, program} = anchorProgram();
  const payer = (provider.wallet as AnchorProvider["wallet"] & {payer: Keypair}).payer;
  const nonce = BigInt(`0x${createHash("sha256").update(namespace).digest("hex").slice(0, 14)}`);
  const participants = [0, 1, 2].map(index => fixtureKey(namespace, `participant-${index}`));
  const outsider = fixtureKey(namespace, "outsider");
  await Promise.all([...participants, outsider].map(value => fund(provider, value.publicKey)));
  const [core] = roomPda(provider.wallet.publicKey, nonce);
  const [live] = livePda(core);
  const [vaultAuthority] = vaultAuthorityPda(core);
  const expiry = Math.floor(Date.now() / 1000) + 3_600;
  await program.methods.initializeRoom(new BN(nonce.toString()), participants.map(value => value.publicKey), new BN(expiry)).accounts({creator: provider.wallet.publicKey, roomCore: core, roomLive: live}).rpc();
  let state = await program.account.roomCore.fetch(core) as any;
  assert.equal(state.depositedMask, 0);
  assert.equal(state.returnedMask, 0);
  assert.equal(state.status.funding !== undefined, true);
  assert.equal(state.liveRoom.toBase58(), live.toBase58());
  process.stdout.write("PASS initialization stores exact custody state\n");

  const assets = [] as Array<{mint: PublicKey; ata: PublicKey}>;
  for (let slot = 0; slot < 6; slot += 1) {
    assets.push(await immutableAsset(provider, participants[Math.floor(slot / 2)], fixtureKey(namespace, `mint-${slot}`)));
  }
  const invalidMint = await createMint(provider.connection, payer, payer.publicKey, null, 1);
  const invalidSource = await getOrCreateAssociatedTokenAccount(provider.connection, payer, invalidMint, participants[0].publicKey);
  await mintTo(provider.connection, payer, invalidMint, invalidSource.address, payer, 1);
  await expectRejected("ineligible mint policy is rejected", () => program.methods.depositAsset(0).accounts({participant: participants[0].publicKey, roomCore: core, mint: invalidMint, source: invalidSource.address, vault: vaultAta(core, invalidMint)}).signers([participants[0]]).rpc());
  await expectRejected("wrong participant cannot deposit another slot", () => program.methods.depositAsset(0).accounts({participant: participants[1].publicKey, roomCore: core, mint: assets[0].mint, source: assets[0].ata, vault: vaultAta(core, assets[0].mint)}).signers([participants[1]]).rpc());
  state = await program.account.roomCore.fetch(core) as any;
  assert.equal(state.depositedMask, 0);

  for (let slot = 0; slot < 6; slot += 1) {
    const participant = participants[Math.floor(slot / 2)];
    const vault = vaultAta(core, assets[slot].mint);
    await program.methods.depositAsset(slot).accounts({participant: participant.publicKey, roomCore: core, mint: assets[slot].mint, source: assets[slot].ata, vault}).signers([participant]).rpc();
    const sourceState = await waitForTokenAmount(provider, assets[slot].ata, 0n);
    const vaultState = await waitForTokenAmount(provider, vault, 1n);
    assert.equal(sourceState.amount, 0n, `slot ${slot} source amount`);
    assert.equal(vaultState.amount, 1n, `slot ${slot} vault amount`);
    assert.equal(vaultState.owner.toBase58(), vaultAuthority.toBase58(), `slot ${slot} vault authority`);
  }
  state = await program.account.roomCore.fetch(core) as any;
  assert.equal(state.depositedMask, 63);
  process.stdout.write("PASS six eligible assets move into six exact PDA-owned vaults\n");

  await expectRejected("premature expiry cancellation is rejected", () => program.methods.cancelExpired().accounts({caller: outsider.publicKey, roomCore: core}).signers([outsider]).rpc());
  await expectRejected("outsider participant cancellation is rejected", () => program.methods.cancelByParticipant().accounts({participant: outsider.publicKey, roomCore: core}).signers([outsider]).rpc());
  await program.methods.cancelByParticipant().accounts({participant: participants[1].publicKey, roomCore: core}).signers([participants[1]]).rpc();
  state = await program.account.roomCore.fetch(core) as any;
  assert.equal(state.status.cancelled !== undefined, true);
  process.stdout.write("PASS participant cancellation opens deterministic return path\n");

  const closeSignature = await closeAccount(provider.connection, payer, assets[0].ata, payer.publicKey, participants[0]);
  await provider.connection.confirmTransaction(closeSignature, "confirmed");
  await waitForMissingAccount(provider, assets[0].ata);
  for (let slot = 0; slot < 6; slot += 1) {
    await program.methods.returnAsset(slot).accounts({caller: provider.wallet.publicKey, roomCore: core, mint: assets[slot].mint, vault: vaultAta(core, assets[slot].mint), originalOwner: participants[Math.floor(slot / 2)].publicKey, originalAta: assets[slot].ata}).rpc();
    const returned = await waitForTokenAmount(provider, assets[slot].ata, 1n);
    assert.equal(returned.amount, 1n, `slot ${slot} returned amount`);
    assert.equal(returned.owner.toBase58(), participants[Math.floor(slot / 2)].publicKey.toBase58(), `slot ${slot} returned owner`);
  }
  state = await program.account.roomCore.fetch(core) as any;
  assert.equal(state.returnedMask, 63);
  assert.equal(state.status.closed !== undefined, true);
  process.stdout.write("PASS closed canonical ATA is recreated and all six assets return\n");
  await expectRejected("return replay is rejected", () => program.methods.returnAsset(0).accounts({caller: provider.wallet.publicKey, roomCore: core, mint: assets[0].mint, vault: vaultAta(core, assets[0].mint), originalOwner: participants[0].publicKey, originalAta: assets[0].ata}).rpc());
  assert.equal((await getAccount(provider.connection, assets[0].ata, "confirmed")).amount, 1n);
  process.stdout.write(JSON.stringify({core: core.toBase58(), live: live.toBase58(), returnedMask: state.returnedMask, status: "closed"}));
}

async function waitForLive(program: any, live: PublicKey): Promise<any> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return await program.account.roomLive.fetch(live); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return program.account.roomLive.fetch(live);
}

async function stateSuite(namespace: string): Promise<void> {
  await seedOnly(namespace);
  process.stdout.write("\n");
  const {provider, program} = anchorProgram();
  const nonce = BigInt(`0x${createHash("sha256").update(namespace).digest("hex").slice(0, 14)}`);
  const participants = [0, 1, 2].map(index => fixtureKey(namespace, `participant-${index}`));
  const outsider = fixtureKey(namespace, "outsider");
  await fund(provider, outsider.publicKey);
  const [core] = roomPda(provider.wallet.publicKey, nonce);
  const [live] = livePda(core);
  const localValidator = new PublicKey("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");
  await program.methods.activateAndDelegateLive().accounts({participant: participants[0].publicKey, roomCore: core, roomLive: live}).remainingAccounts([{pubkey: localValidator, isSigner: false, isWritable: false}]).signers([participants[0]]).rpc();
  const coreState = await program.account.roomCore.fetch(core) as any;
  assert.equal(coreState.status.active !== undefined, true);
  process.stdout.write("PASS fully funded room activates and delegates live state\n");

  const erProvider = new AnchorProvider(new Connection("http://127.0.0.1:7799", "confirmed"), provider.wallet, provider.opts);
  const erProgram = new Program(program.idl, erProvider) as any;
  await waitForLive(erProgram, live);
  await erProgram.methods.propose(new BN(0), [0, 2, 4], {forward: {}}).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc();
  let liveState = await waitForLive(erProgram, live);
  assert.equal(liveState.revision.toNumber(), 1);
  const firstHash = [...liveState.allocationHash];
  await expectRejected("outsider cannot mutate delegated negotiation", () => erProgram.methods.propose(new BN(1), [1, 3, 5], {reverse: {}}).accounts({actor: outsider.publicKey, roomCore: core, roomLive: live}).signers([outsider]).rpc());
  await erProgram.methods.lock(new BN(1), firstHash).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc();
  liveState = await erProgram.account.roomLive.fetch(live);
  assert.equal(liveState.lockMask, 1);
  await erProgram.methods.propose(new BN(1), [1, 3, 5], {reverse: {}}).accounts({actor: participants[1].publicKey, roomCore: core, roomLive: live}).signers([participants[1]]).rpc();
  liveState = await erProgram.account.roomLive.fetch(live);
  assert.equal(liveState.revision.toNumber(), 2);
  assert.equal(liveState.lockMask, 0);
  assert.equal(liveState.lockedRevision[0].toNumber(), 0);
  process.stdout.write("PASS proposal revision invalidates every prior lock\n");
  await expectRejected("stale revision lock is rejected", () => erProgram.methods.lock(new BN(1), firstHash).accounts({actor: participants[0].publicKey, roomCore: core, roomLive: live}).signers([participants[0]]).rpc());

  const secondHash = [...liveState.allocationHash];
  for (let index = 0; index < 3; index += 1) {
    await erProgram.methods.lock(new BN(2), secondHash).accounts({actor: participants[index].publicKey, roomCore: core, roomLive: live}).signers([participants[index]]).rpc();
  }
  liveState = await erProgram.account.roomLive.fetch(live);
  assert.equal(liveState.lockMask, 7);
  assert.equal(liveState.phase.finalizing !== undefined, true);
  process.stdout.write("PASS third exact lock freezes the agreement\n");
  await expectRejected("third-lock replay is rejected after freeze", () => erProgram.methods.lock(new BN(2), secondHash).accounts({actor: participants[2].publicKey, roomCore: core, roomLive: live}).signers([participants[2]]).rpc());
  await expectRejected("proposal race loses after third-lock freeze", () => erProgram.methods.propose(new BN(2), [0, 2, 4], {forward: {}}).accounts({actor: participants[1].publicKey, roomCore: core, roomLive: live}).signers([participants[1]]).rpc());
  liveState = await erProgram.account.roomLive.fetch(live);
  assert.equal(liveState.revision.toNumber(), 2);
  assert.equal(liveState.lockMask, 7);
  process.stdout.write(JSON.stringify({core: core.toBase58(), live: live.toBase58(), revision: 2, lockMask: 7, phase: "finalizing"}));
}

async function seedOnly(namespace: string): Promise<void> {
  const {provider, program} = anchorProgram();
  const nonce = BigInt(`0x${createHash("sha256").update(namespace).digest("hex").slice(0, 14)}`);
  const [core] = roomPda(provider.wallet.publicKey, nonce);
  const [live] = livePda(core);
  const existing = await provider.connection.getAccountInfo(core, "confirmed");
  const participants = [fixtureKey(namespace, "participant-0"), fixtureKey(namespace, "participant-1"), fixtureKey(namespace, "participant-2")];
  await Promise.all(participants.map(value => fund(provider, value.publicKey)));
  if (existing) {
    const state = await program.account.roomCore.fetch(core) as any;
    if (state.depositedMask !== 63 || !state.participants.every((key: PublicKey, index: number) => key.equals(participants[index].publicKey))) throw new Error("existing deterministic room is partial or roster-mismatched; choose a fresh DEMO_SEED_NAMESPACE");
    const existingMints: string[] = [];
    for (let slot = 0; slot < 6; slot += 1) {
      const record = state.assets[slot];
      const mint = await getMint(provider.connection, record.mint, "confirmed");
      const vault = await getAccount(provider.connection, record.vault, "confirmed");
      if (mint.decimals !== 0 || mint.supply !== 1n || mint.mintAuthority || mint.freezeAuthority || vault.amount !== 1n || !vault.mint.equals(record.mint)) throw new Error(`existing slot ${slot} fails custody policy`);
      existingMints.push(record.mint.toBase58());
    }
    process.stdout.write(JSON.stringify({core: core.toBase58(), live: live.toBase58(), participants: participants.map(value => value.publicKey.toBase58()), mints: existingMints, reused: true}));
    return;
  }
  const assets = [] as Array<{mint: PublicKey; ata: PublicKey}>;
  for (let ownerIndex = 0; ownerIndex < participants.length; ownerIndex += 1) {
    assets.push(await immutableAsset(provider, participants[ownerIndex], fixtureKey(namespace, `mint-${ownerIndex * 2}`)));
    assets.push(await immutableAsset(provider, participants[ownerIndex], fixtureKey(namespace, `mint-${ownerIndex * 2 + 1}`)));
  }
  const expiry = Math.floor(Date.now() / 1000) + 3_600;
  await program.methods.initializeRoom(new BN(nonce.toString()), participants.map(value => value.publicKey), new BN(expiry)).accounts({creator: provider.wallet.publicKey, roomCore: core, roomLive: live}).rpc();
  let coreState = await program.account.roomCore.fetch(core) as any;
  for (let slot = 0; slot < 6; slot += 1) {
    if ((coreState.depositedMask & (1 << slot)) !== 0) continue;
    const participant = participants[Math.floor(slot / 2)];
    await program.methods.depositAsset(slot).accounts({participant: participant.publicKey, roomCore: core, mint: assets[slot].mint, source: assets[slot].ata, vault: vaultAta(core, assets[slot].mint)}).signers([participant]).rpc();
  }
  coreState = await program.account.roomCore.fetch(core) as any;
  assert.equal(coreState.depositedMask, 63);
  process.stdout.write(JSON.stringify({core: core.toBase58(), live: live.toBase58(), participants: participants.map(value => value.publicKey.toBase58()), mints: assets.map(value => value.mint.toBase58()), reused: false}));
}

const seedIndex = process.argv.indexOf("--seed-only");
const custodyIndex = process.argv.indexOf("--custody-suite");
const stateIndex = process.argv.indexOf("--state-suite");
const execution = stateIndex >= 0
  ? stateSuite(process.argv[stateIndex + 1] ?? `state-${Date.now()}`)
  : custodyIndex >= 0
  ? custodySuite(process.argv[custodyIndex + 1] ?? `custody-${Date.now()}`)
  : seedIndex >= 0
  ? seedOnly(process.argv[seedIndex + 1] ?? "tradetable-v1")
  : Promise.resolve().then(runBehavioralAssertions);
execution.catch(error => { console.error(error); process.exitCode = 1; });
