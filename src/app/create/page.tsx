import CreateRoomForm from "../create-room-form";
import SiteNav from "../site-nav";

export default function CreateRoomPage() {
  return <main>
    <SiteNav />
    <header className="proofHero workflowHero">
      <p className="kicker">CREATE / PARTICIPANT A</p>
      <h1>Start an <em>earned room.</em></h1>
      <p className="lede">Participant A opens one shared custody room, then invites two distinct counterparties. No assets move until each owner deposits their assigned slots.</p>
    </header>
    <section className="liveControls workflowPanel">
      <div>
        <p className="kicker">ROOM PARAMETERS / BASE</p>
        <h2>Fix the roster.<br />Set the clock.</h2>
        <p className="lede">Your connected wallet becomes Participant A. The 20-minute protocol minimum becomes 21 minutes here, adding a one-minute submission buffer.</p>
      </div>
      <CreateRoomForm />
    </section>
    <footer><strong>Need an existing room?</strong><a href="/open">Open by RoomCore ↗</a><a href="/">Back to landing ↗</a></footer>
  </main>;
}
