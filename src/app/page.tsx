import {PublicKey} from "@solana/web3.js";

import CreateRoomForm from "./create-room-form";
import OpenRoomForm from "./open-room-form";
import {explorerAddress} from "@/lib/tradetable";

function configuredAddress(value: string | undefined): string | null {
  try { return value ? new PublicKey(value).toBase58() : null; }
  catch { return null; }
}

export default function Home() {
  const networkLabel = process.env.NEXT_PUBLIC_NETWORK_LABEL ?? "SOLANA DEVNET";
  const demoRoom = configuredAddress(process.env.NEXT_PUBLIC_DEMO_ROOM);
  const program = configuredAddress(process.env.NEXT_PUBLIC_PROGRAM_ID);

  return <main>
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i /> {networkLabel} · MAGICBLOCK ER</div><a href="/proof">Proof ledger ↗</a></nav>
    <header className="hero">
      <div className="heroCopy">
        <p className="kicker">COLLABORATIVE CUSTODY / ROOM ROUTER</p>
        <h1>Six assets enter custody.<br /><em>One agreement leaves.</em></h1>
        <p className="lede">Three collectors fund two assets each. They negotiate one exact cyclic proposal together. The selected three settle atomically in one Solana base transaction; the unselected three return through three separate base transactions.</p>
        <div className="heroActions">
          <a className="primary" href="#create-room">Create a room ↓</a>
          {demoRoom ? <a className="secondary" href={`/rooms/${demoRoom}`}>Open earned demo ↗</a> : null}
          {program ? <a className="secondary" href={explorerAddress(new PublicKey(program))}>Inspect program ↗</a> : null}
        </div>
      </div>
      <div className="equation" aria-label="Six assets in, three settle atomically, three return separately">
        <div><strong>6</strong><span>IN</span></div><b>→</b><div><strong>3</strong><span>SELECTED</span></div><b>+</b><div><strong>3</strong><span>RETURN</span></div>
        <small>ONE SELECTED-THREE BASE TRANSACTION · THREE SEPARATE RETURN TRANSACTIONS</small>
      </div>
    </header>

    <section className="liveControls" id="create-room">
      <div><p className="kicker">CREATE / PARTICIPANT A</p><h2>Start an earned room.</h2><p className="lede">Your connected wallet becomes Participant A. Add two distinct counterparties. The 20-minute protocol minimum becomes 21 minutes here, adding a one-minute submission buffer.</p></div>
      <CreateRoomForm />
    </section>
    <section className="liveControls">
      <div><p className="kicker">OPEN / READ OR ACT</p><h2>Return to any room.</h2><p className="lede">A valid RoomCore address opens authoritative base and ER state. Missing or foreign accounts never become demo data.</p></div>
      <OpenRoomForm />
    </section>
    {demoRoom ? <section className="operations"><div><p className="kicker">FEATURED / EARNED DEVNET ROOM</p><h2>Inspect the recorded room.</h2><p>The featured room is configured evidence, not a fabricated fixture. Open its workspace or verify the account directly on Solana.</p></div><div className="heroActions"><a className="primary" href={`/rooms/${demoRoom}`}>OPEN ROOM</a><a className="secondary" href={explorerAddress(new PublicKey(demoRoom))}>BASE ACCOUNT ↗</a></div></section> : null}
    <footer><strong>MagicBlock speeds the conversation.</strong><span>Solana secures the consequence.</span><a href="/proof">Open proof ledger ↗</a></footer>
  </main>;
}
