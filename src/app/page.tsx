import {PublicKey} from "@solana/web3.js";

import SiteNav from "./site-nav";
import {explorerAddress} from "@/lib/tradetable";

function configuredAddress(value: string | undefined): string | null {
  try { return value ? new PublicKey(value).toBase58() : null; }
  catch { return null; }
}

function Hero({demoRoom}: {demoRoom: string | null}) {
  return <header className="hero">
    <div className="heroCopy">
      <p className="kicker">COLLABORATIVE CUSTODY / ROOM ROUTER</p>
      <h1>Three collectors.<br />One table.<br /><em>No middleman.</em></h1>
      <p className="lede">Six assets enter custody. Three collectors negotiate one exact cyclic proposal. The selected three settle atomically in one Solana base transaction; the unselected three return through three separate base transactions.</p>
      <div className="heroActions"><a className="primary" href="/create">Create a room →</a><a className="secondary" href="/open">Open a room ↗</a>{demoRoom ? <a className="secondary" href={`/rooms/${demoRoom}`}>Earned demo ↗</a> : null}</div>
    </div>
    <div className="equation" aria-label="Six assets in, three settle atomically, three return separately">
      <div><strong>6</strong><span>IN</span></div><b>→</b><div><strong>3</strong><span>SELECTED</span></div><b>+</b><div><strong>3</strong><span>RETURN</span></div>
      <small>ONE SELECTED-THREE BASE TRANSACTION · THREE SEPARATE RETURN TRANSACTIONS</small>
    </div>
  </header>;
}

function RouteIndex() {
  return <section className="routeIndex" aria-labelledby="route-index-title">
    <div><p className="kicker">THREE ENTRY POINTS</p><h2 id="route-index-title">Choose your path.</h2></div>
    <ol>
      <li><b>01</b><a href="/create"><strong>Create a room</strong><span>Fix a three-wallet roster and open base custody.</span></a></li>
      <li><b>02</b><a href="/open"><strong>Open a room</strong><span>Load exact Core, Live, role, and authority state.</span></a></li>
      <li><b>03</b><a href="/proof"><strong>Verify evidence</strong><span>Separate ER collaboration from base consequences.</span></a></li>
    </ol>
  </section>;
}

function FeaturedRoom({room, program}: {room: string | null; program: string | null}) {
  if (!room) return null;
  return <section className="operations"><div><p className="kicker">FEATURED / EARNED DEVNET ROOM</p><h2>Inspect the recorded room.</h2><p>The featured room is configured evidence, never a fabricated fixture.</p></div><div className="heroActions"><a className="primary" href={`/rooms/${room}`}>OPEN ROOM</a><a className="secondary" href={explorerAddress(new PublicKey(room))}>BASE ACCOUNT ↗</a>{program ? <a className="secondary" href={explorerAddress(new PublicKey(program))}>PROGRAM ↗</a> : null}</div></section>;
}

export default function Home() {
  const room = configuredAddress(process.env.NEXT_PUBLIC_DEMO_ROOM);
  const program = configuredAddress(process.env.NEXT_PUBLIC_PROGRAM_ID);
  return <main><SiteNav /><Hero demoRoom={room} /><RouteIndex /><FeaturedRoom room={room} program={program} /><footer><strong>MagicBlock speeds the conversation.</strong><span>Solana secures the consequence.</span><a href="/proof">Open proof ledger ↗</a></footer></main>;
}
