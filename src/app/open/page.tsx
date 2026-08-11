import OpenRoomForm from "../open-room-form";
import SiteNav from "../site-nav";

export default function OpenRoomPage() {
  return <main>
    <SiteNav />
    <header className="proofHero workflowHero">
      <p className="kicker">OPEN / READ OR ACT</p>
      <h1>Return to the <em>shared table.</em></h1>
      <p className="lede">Open authoritative Solana base and MagicBlock ER state from one canonical RoomCore address. Missing or foreign accounts never become demo data.</p>
    </header>
    <section className="liveControls workflowPanel">
      <div>
        <p className="kicker">ROOM ROUTER / VERIFIED</p>
        <h2>One address.<br />Exact authority.</h2>
        <p className="lede">The route validates the RoomCore owner, discriminator, version, canonical Live PDA, roster, expiry, and current delegation before rendering.</p>
      </div>
      <OpenRoomForm />
    </section>
    <footer><strong>Starting fresh?</strong><a href="/create">Create a room ↗</a><a href="/">Back to landing ↗</a></footer>
  </main>;
}
