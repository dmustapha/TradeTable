"use client";

import React from "react";
import {PublicKey} from "@solana/web3.js";
import type {RoomCore, RoomLive} from "@/lib/room-state";
import {seatRadioModel, type WorkspaceDraft} from "@/lib/workspace-state";

type Props = {core: RoomCore; live: RoomLive; draft: WorkspaceDraft; editable: boolean; onSelect(slot: number): void};
const short = (value: Uint8Array) => new PublicKey(value).toBase58().replace(/^(.{5}).*(.{4})$/, "$1…$2");

function flags(core: RoomCore, live: RoomLive, slot: number): string[] {
  const states = [];
  if (core.depositedMask & (1 << slot)) states.push("Deposited");
  if (core.selectedMask & (1 << slot)) states.push("Selected");
  else if (live.revision > 0n && live.selectedSlots.includes(slot)) states.push("Authoritative proposal");
  if (core.returnedMask & (1 << slot)) states.push("Returned");
  return states.length ? states : ["Not deposited"];
}

function assetLabel(core: RoomCore, slot: number): string {
  if (!(core.depositedMask & (1 << slot))) return `Slot ${slot} · mint required`;
  return `Slot ${slot} · ${short(core.assets[slot].mint)}`;
}

export function SharedTable({core, live, draft, editable, onSelect}: Props) {
  return <section className="sharedTable" aria-label="Shared custody table">
    {seatRadioModel(draft.proposal.selectedSlots).map(group => <fieldset role="radiogroup" aria-label={`Participant ${group.seat} asset selection`} key={group.seat}>
      <legend>Participant {group.seat}</legend>
      {group.options.map(option => <label className="assetChoice" aria-disabled={!editable} key={option.slot}>
        <input type="radio" name={group.name} checked={option.checked} disabled={!editable} onChange={() => onSelect(option.slot)} />
        <strong>{assetLabel(core, option.slot)}</strong><small>{flags(core, live, option.slot).join(" · ")}</small>
      </label>)}
    </fieldset>)}
    <div className="lockLedger" aria-label="Exact revision locks">
      {(["A", "B", "C"] as const).map((seat, index) => {
        const locked = Boolean(live.lockMask & (1 << index));
        return <div data-lock-row={seat} data-locked={locked} key={seat}><span>Seat {seat}</span><strong>{locked ? `Locked r${live.lockedRevision[index]}` : "Open"}</strong></div>;
      })}
    </div>
  </section>;
}
