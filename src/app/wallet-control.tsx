"use client";

import React from "react";
import type {WalletState} from "@/lib/workspace-state";
import {walletLabel} from "@/lib/workspace-state";

type Props = {state: WalletState; networkReady: boolean; onConnect(): void};

export function WalletControl({state, networkReady, onConnect}: Props) {
  const label = walletLabel(state);
  const busy = state.status === "connecting";
  return <div className="walletControl" data-wallet-state={state.status}>
    <span aria-hidden="true" className="walletIcon">◈</span>
    <button type="button" aria-label={`Wallet: ${label}`} disabled={busy} onClick={onConnect}>{label}</button>
    <span className="walletNetwork" data-ready={networkReady}>{networkReady ? "Devnet ready" : "RPC unavailable"}</span>
  </div>;
}
