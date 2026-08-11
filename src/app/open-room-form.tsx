"use client";

import {useRouter} from "next/navigation";
import {FormEvent, useState} from "react";
import {PublicKey} from "@solana/web3.js";

function canonical(value: string): string {
  try { return new PublicKey(value.trim()).toBase58(); }
  catch { throw new Error("Enter a valid Solana RoomCore address."); }
}

export default function OpenRoomForm() {
  const router = useRouter();
  const [room, setRoom] = useState("");
  const [error, setError] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try { setError(""); router.push(`/rooms/${canonical(room)}`); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }

  return <form className="controlRail" onSubmit={submit} noValidate>
    <label htmlFor="room-address">RoomCore address</label>
    <input id="room-address" name="room" value={room} onChange={event => setRoom(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "room-address-error" : undefined} autoComplete="off" placeholder="Paste a Solana room address" />
    <button type="submit">OPEN VERIFIED ROOM</button>
    {error ? <p id="room-address-error" role="alert">{error}</p> : null}
  </form>;
}
