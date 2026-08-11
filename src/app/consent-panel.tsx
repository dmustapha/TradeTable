"use client";

import React from "react";
import {PublicKey} from "@solana/web3.js";
import type {Cycle, RoomLive} from "@/lib/room-state";
import type {WorkspaceDraft} from "@/lib/workspace-state";

type CycleProps = {cycle: Cycle; disabled: boolean; onChange(cycle: Cycle): void};
export function CycleControl({cycle, disabled, onChange}: CycleProps) {
  return <fieldset className="cycleControl" role="radiogroup" aria-label="Asset routing cycle">
    <legend>Route selected assets</legend>
    {(["forward", "reverse"] as const).map(value => <label key={value}>
      <input type="radio" name="routing-cycle" checked={cycle === value} disabled={disabled} onChange={() => onChange(value)} />
      {value === "forward" ? "Forward · A → B → C → A" : "Reverse · A → C → B → A"}
    </label>)}
  </fieldset>;
}

const short = (value: Uint8Array) => new PublicKey(value).toBase58().replace(/^(.{6}).*(.{5})$/, "$1…$2");
const route = (live: RoomLive) => live.selectedSlots.map((slot, index) => `${"ABC"[index]}${slot} → ${"ABC"[live.destinations[index]]}`).join(" · ");

export function ConsentPanel({live, draft, editable, onCycle}: {live: RoomLive; draft: WorkspaceDraft; editable: boolean; onCycle(cycle: Cycle): void}) {
  const initialized = live.revision === 0n;
  return <section className="consentPanel">
    <article className="authorityProposal">
      <p className="kicker">{initialized ? "INITIALIZED BASELINE · NO AUTHORITATIVE PROPOSAL YET" : `AUTHORITATIVE REVISION ${live.revision.toString()}`}</p>
      <h2>{route(live)}</h2>
      <dl><div><dt>Hash</dt><dd><code>{short(live.allocationHash)}</code></dd></div><div><dt>Cycle</dt><dd>{live.cycle}</dd></div><div><dt>Locks</dt><dd>{live.lockMask.toString(2).padStart(3, "0")}</dd></div><div><dt>Last change</dt><dd>{live.lastAction} by {short(live.lastActor)}</dd></div></dl>
    </article>
    <aside className="draftTray" data-conflict={draft.conflict}>
      <p className="kicker">YOUR UNSUBMITTED DRAFT · BASE REVISION {draft.baseRevision.toString()}</p>
      <strong>{initialized ? "This baseline has no protocol effect until revision one is proposed." : draft.outdated ? "Outdated — rebase or review before consent." : draft.dirty ? "Local changes have no protocol effect yet." : "Matches authority exactly."}</strong>
      <p>Proposing creates a new revision and clears every existing lock.</p>
      <CycleControl cycle={draft.proposal.cycle} disabled={!editable} onChange={onCycle} />
    </aside>
  </section>;
}
