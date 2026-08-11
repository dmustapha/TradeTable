import {PublicKey} from "@solana/web3.js";

import OpenRoomForm from "../open-room-form";

function configuredRoom(value: string | undefined): string | null {
  try { return value ? new PublicKey(value).toBase58() : null; }
  catch { return null; }
}

export default function Proof() {
  const featuredRoom = configuredRoom(process.env.NEXT_PUBLIC_DEMO_ROOM);
  if (featuredRoom) return <FeaturedProofLink featuredRoom={featuredRoom} />;
  return <main className="proofPage">
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i /> ROOM-SCOPED EVIDENCE</div><a href="/">Home ↗</a></nav>
    <header className="proofHero"><p className="kicker">PROOF ROUTER</p><h1>Evidence needs<br /><em>a room.</em></h1><p className="lede">No featured RoomCore is configured, so this route does not fabricate proof. Open a verified room to inspect its current base and authority state.</p></header>
    <section className="liveControls"><div><p className="kicker">OPEN / ROOM PROOF</p><h2>Resolve a RoomCore.</h2><p>After the room opens, choose its room-scoped proof link. Dynamic rooms without indexed history show current account state only.</p></div><OpenRoomForm /></section>
    <footer><strong>Proof is identity-bound.</strong><span>Missing evidence stays missing.</span><a href="/">Return home ↗</a></footer>
  </main>;
}

function FeaturedProofLink({featuredRoom}: {featuredRoom: string}) {
  return <main className="proofPage">
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i /> EARNED PROOF</div><a href="/">Home ↗</a></nav>
    <header className="proofHero"><p className="kicker">FEATURED / EARNED DEVNET ROOM</p><h1>Proof before<br /><em>promise.</em></h1><p className="lede">The historical evidence now lives at its verified RoomCore identity. The earned signatures, accounts, and exact settlement boundary remain intact.</p><div className="heroActions"><a className="primary" href={`/rooms/${featuredRoom}/proof`}>OPEN ROOM PROOF ↗</a><a className="secondary" href={`/rooms/${featuredRoom}`}>OPEN WORKSPACE ↗</a></div></header>
    <section className="proofBoundary"><strong>PUBLIC EVIDENCE BOUNDARY</strong><p>Public Devnet evidence is commit-only ER finalization followed by one selected-three base settlement and three separate base returns. Local composed-action evidence remains distinct.</p></section>
  </main>;
}
