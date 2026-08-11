import {notFound} from "next/navigation";
import {PublicKey} from "@solana/web3.js";

import RoomClient from "../../room-client";
import {RoomNotFoundError, canonicalRoomAddress, loadRoom, roomStateForClient} from "@/lib/room-loader";

function short(value: string) { return `${value.slice(0, 6)}…${value.slice(-5)}`; }

export default async function RoomPage({params}: {params: Promise<{core: string}>}) {
  let address: string;
  try { address = canonicalRoomAddress((await params).core); }
  catch { notFound(); }

  let room;
  try { room = await loadRoom(new PublicKey(address)); }
  catch (error) { if (error instanceof RoomNotFoundError) notFound(); throw error; }

  const networkLabel = process.env.NEXT_PUBLIC_NETWORK_LABEL ?? "SOLANA DEVNET";
  return <main>
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i className="live" /> {networkLabel}</div><a href={`/rooms/${address}/proof`}>Room proof ↗</a></nav>
    <header className="proofHero roomHero"><p className="kicker">ROOM / {short(address)}</p><h1>Shared room.<br /><em>Authoritative state.</em></h1><p className="lede">Custody is read from Solana base. Negotiation is read from {room.authority === "magicblock-er" ? "the room’s current MagicBlock ER authority" : "the program-owned base account"}. No missing state is simulated.</p></header>
    <RoomClient room={address} initialCore={roomStateForClient(room.core)} initialLive={roomStateForClient(room.live)} initialAuthority={room.authority} initialDelegated={room.delegated} initialObservedAt={room.observedAt} />
  </main>;
}
