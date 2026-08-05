// File: tests/tradetable.ts
import {AnchorProvider, BN, Program, setProvider, workspace} from "@coral-xyz/anchor";
import {AuthorityType, createMint, getAccount, getMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority} from "@solana/spl-token";
import {Keypair, LAMPORTS_PER_SOL, PublicKey} from "@solana/web3.js";
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

function anchorProgram(): {provider: AnchorProvider; program: Program} {
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
    await setAuthority(provider.connection, payer, mint, payer, AuthorityType.FreezeAccount, null);
  }
  const mintState = await getMint(provider.connection, mint, "confirmed");
  if (mintState.decimals !== 0 || mintState.supply !== 1n || mintState.mintAuthority || mintState.freezeAuthority) throw new Error(`fixture mint policy mismatch: ${mint}`);
  const ata = (await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, owner.publicKey)).address;
  const token = await getAccount(provider.connection, ata, "confirmed");
  if (!token.owner.equals(owner.publicKey) || token.amount !== 1n) throw new Error(`fixture owner balance mismatch: ${mint}`);
  return {mint, ata};
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
const execution = seedIndex >= 0
  ? seedOnly(process.argv[seedIndex + 1] ?? "tradetable-v1")
  : Promise.resolve().then(runBehavioralAssertions);
execution.catch(error => { console.error(error); process.exitCode = 1; });
