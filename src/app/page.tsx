import {Connection, PublicKey} from "@solana/web3.js";
import {DELEGATION_PROGRAM_ID, getDelegationRecord} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  BASE_RPC, BASE_RPC_FALLBACK, ER_RPC, ER_VALIDATOR, ROUTER_RPC, alternateExplorerTx,
  explorerAddress, explorerTx, livePda,
} from "@/lib/tradetable";
import RoomClient from "./room-client";

type Mode = "action" | "committed" | "recover";
type LocatedAccount = {value: NonNullable<Awaited<ReturnType<Connection["getAccountInfo"]>>>; source: string; refreshedAt: number};

function key(value: string | undefined): PublicKey | null {
  try { return value ? new PublicKey(value) : null; } catch { return null; }
}

async function firstAccount(address: PublicKey | null, sources: Array<[string, Connection]>): Promise<LocatedAccount | null> {
  if (!address) return null;
  for (const [source, connection] of sources) {
    try {
      const value = await connection.getAccountInfo(address, "confirmed");
      if (value) return {value, source, refreshedAt: Date.now()};
    } catch {}
  }
  return null;
}

function decodeCore(data?: Buffer) {
  if (!data || data.length < 1198) return null;
  return {
    participants: [0, 1, 2].map(index => new PublicKey(data.subarray(52 + index * 32, 84 + index * 32))),
    mints: [0, 1, 2, 3, 4, 5].map(index => new PublicKey(data.subarray(180 + index * 169, 212 + index * 169))),
    deposited: data[1194], returned: data[1195], selected: data[1196], status: data[1197],
  };
}

function decodeLive(data?: Buffer) {
  if (!data || data.length < 356) return null;
  const mask = data[313];
  return {revision: data.readBigUInt64LE(146), locks: [0, 1, 2].filter(index => mask & (1 << index)).length, phase: data[314]};
}

function short(value: PublicKey) { return `${value.toBase58().slice(0, 5)}…${value.toBase58().slice(-4)}`; }

export default async function Home({searchParams}: {searchParams: Promise<{mode?: string}>}) {
  const room = key(process.env.NEXT_PUBLIC_DEMO_ROOM);
  const program = key(process.env.NEXT_PUBLIC_PROGRAM_ID);
  const live = room && program ? livePda(room)[0] : null;
  const base = new Connection(BASE_RPC, "confirmed");
  const fallback = BASE_RPC_FALLBACK ? new Connection(BASE_RPC_FALLBACK, "confirmed") : base;
  const router = new Connection(ROUTER_RPC, "confirmed");
  const er = new Connection(ER_RPC, "confirmed");
  const coreResult = await firstAccount(room, [["base", base], ["base fallback", fallback]]);
  const baseLiveResult = await firstAccount(live, [["base", base], ["base fallback", fallback]]);
  const delegated = Boolean(baseLiveResult?.value.owner.equals(DELEGATION_PROGRAM_ID));
  const delegation = delegated && live ? await getDelegationRecord(base, live, "confirmed").catch(() => null) : null;
  const delegatedSources: Array<[string, Connection]> = [["router", router]];
  if (delegation?.status === 0 && delegation.validator.equals(ER_VALIDATOR)) delegatedSources.push(["direct ER", er]);
  const liveResult = delegated ? await firstAccount(live, delegatedSources) : baseLiveResult;
  const core = decodeCore(coreResult?.value.data);
  const liveState = decodeLive(liveResult?.value.data);
  const mintInfos = core ? await base.getMultipleAccountsInfo(core.mints, "confirmed").catch(() => []) : [];
  const signatures = room ? await base.getSignaturesForAddress(room, {limit: 8}, "confirmed").catch(() => []) : [];
  const requested = (await searchParams).mode;
  const mode: Mode = requested === "committed" || requested === "recover" ? requested : "action";
  const seats = core?.participants ?? [];
  const mints = core?.mints ?? [];

  return <main>
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i /> SOLANA DEVNET · MAGICBLOCK ER</div><a href="/proof">Proof ledger ↗</a></nav>
    <header className="hero">
      <div className="heroCopy">
        <p className="kicker">COLLABORATIVE CUSTODY / 001</p>
        <h1>Three collectors.<br />One table.<br /><em>No middleman.</em></h1>
        <p className="lede">Build one cyclic collectible deal together. Every lock binds the exact revision. The chosen three move in one base transaction—or none move.</p>
        <div className="heroActions">
          {room ? <a className="primary" href={explorerAddress(room)}>Inspect live room ↗</a> : <span className="primary mutedButton">Demo deployment pending</span>}
          {program ? <a className="secondary" href={explorerAddress(program)}>Program {short(program)} ↗</a> : null}
        </div>
      </div>
      <div className="equation" aria-label="Six assets in, three trade, three return">
        <div><strong>6</strong><span>IN</span></div><b>→</b><div><strong>3</strong><span>TRADE</span></div><b>+</b><div><strong>3</strong><span>RETURN</span></div>
        <small>ATOMIC BOUNDARY: SELECTED THREE ONLY</small>
      </div>
    </header>

    <section className="tableSection">
      <div className="sectionHead"><div><p className="kicker">THE SHARED SURFACE</p><h2>Six assets enter. Consensus chooses three.</h2></div><div className="authority"><span>READ AUTHORITY</span><strong>{liveResult?.source ?? "UNAVAILABLE"}</strong></div></div>
      <div className="tradeTable">
        {(seats.length ? seats : [0, 1, 2]).map((seat, seatIndex) => {
          const participant = seat instanceof PublicKey ? seat : null;
          return <article className="seat" key={participant?.toBase58() ?? seatIndex}>
            <header><span className="seatNumber">0{seatIndex + 1}</span><div><strong>{participant ? short(participant) : "AWAITING ROOM"}</strong><small>PRIMARY COLLECTOR</small></div><span className={`lockDot ${liveState && liveState.locks > seatIndex ? "locked" : ""}`} /></header>
            <div className="assetPair">{[0, 1].map(localIndex => {
              const slot = seatIndex * 2 + localIndex;
              const mint = mints[slot];
              const selected = Boolean(core && core.selected & (1 << slot));
              return mint ? <a className={`asset ${selected ? "selected" : ""}`} href={explorerAddress(mint)} key={mint.toBase58()}>
                <span className={`art art${slot}`}><i>#{slot}</i></span><span className="assetMeta"><strong>SLOT {slot}</strong><small>{short(mint)} · {mintInfos[slot] ? "RPC VERIFIED" : "UNAVAILABLE"}</small></span>
              </a> : <div className="asset placeholder" key={slot}><span className={`art art${slot}`}><i>#{slot}</i></span><span className="assetMeta"><strong>SLOT {slot}</strong><small>NO FABRICATED ASSET</small></span></div>;
            })}</div>
          </article>;
        })}
        <div className="tableCenter"><span>EXACT REVISION</span><strong>{liveState?.revision.toString() ?? "—"}</strong><small>{liveState?.locks ?? 0} / 3 LOCKS</small></div>
      </div>
    </section>

    <section className="telemetry">
      <article><span>CORE AUTHORITY</span><strong>{coreResult ? "BASE" : "—"}</strong><small>{coreResult ? `${coreResult.value.data.length} bytes · confirmed` : "RPC unavailable"}</small></article>
      <article><span>LIVE REVISION</span><strong>{liveState?.revision.toString() ?? "—"}</strong><small>{liveResult?.source ?? "authority unavailable"}</small></article>
      <article><span>LOCK CONSENSUS</span><strong>{liveState?.locks ?? 0}<i>/3</i></strong><small>{liveState?.phase === 1 ? "FROZEN" : liveState?.phase === 2 ? "FINALIZED" : "NEGOTIATING"}</small></article>
      <article><span>CUSTODY MASK</span><strong>{core?.deposited ?? 0}<i>/63</i></strong><small>{core ? `selected ${core.selected} · returned ${core.returned}` : "unavailable"}</small></article>
    </section>

    {room ? <RoomClient room={room.toBase58()} /> : <section className="notice"><strong>Read-only shell.</strong> Set `NEXT_PUBLIC_DEMO_ROOM` to an earned room; this page will never invent one.</section>}

    <section className="operations">
      <div><p className="kicker">CONSEQUENCE ROUTER</p><h2>A signature schedules.<br />Base state proves.</h2><p>Action acceptance is pending until RoomCore records settlement. A failed asynchronous intent is shown as stuck—not success.</p></div>
      <div className="modes">
        <a aria-current={mode === "action"} href="?mode=action"><b>01</b><span><strong>COMPOSED ACTION</strong><small>Commit, undelegate, settle chosen three</small></span></a>
        <a aria-current={mode === "committed"} href="?mode=committed"><b>02</b><span><strong>NORMAL SETTLEMENT</strong><small>Commit-only, then base consequence</small></span></a>
        <a aria-current={mode === "recover"} href="?mode=recover"><b>03</b><span><strong>BASE RECOVERY</strong><small>Cancel, expire, permissionless returns</small></span></a>
      </div>
    </section>

    <section className="timeline">
      <div className="sectionHead"><div><p className="kicker">PROVENANCE / BASE</p><h2>Every consequence leaves a trail.</h2></div></div>
      {signatures.length ? <ol>{signatures.map((item, index) => <li key={item.signature}><b>{String(index + 1).padStart(2, "0")}</b><code>{item.signature}</code><span>SLOT {item.slot}</span><span className={item.err ? "failed" : "confirmed"}>{item.err ? "FAILED" : "CONFIRMED"}</span><a href={explorerTx(item.signature)}>SOLANA ↗</a><a href={alternateExplorerTx(item.signature)}>ALT ↗</a></li>)}</ol> : <p className="empty">No confirmed room signatures returned. Proof is unavailable, never simulated.</p>}
    </section>
    <footer><strong>MagicBlock speeds the conversation.</strong><span>Solana secures the consequence.</span><a href="/proof">Open proof ledger ↗</a></footer>
  </main>;
}
