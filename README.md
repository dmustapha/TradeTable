# TradeTable: Three collectors, one exact-revision trade

TradeTable is a three-party collectible barter protocol on Solana Devnet. Three collectors negotiate one cyclic allocation, lock the exact same revision, and settle the selected three assets in one base-layer transaction. MagicBlock accelerates the shared negotiation while Solana retains custody and recovery.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![Anchor](https://img.shields.io/badge/Anchor-0.32-6E56CF)](https://www.anchor-lang.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Live:** https://tradetable-solana.vercel.app

## Live Demo

Open [TradeTable on Vercel](https://tradetable-solana.vercel.app) to create a room, resolve any verified RoomCore, or enter the [earned Devnet room](https://tradetable-solana.vercel.app/rooms/9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo). Its [room-scoped proof ledger](https://tradetable-solana.vercel.app/rooms/9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo/proof) links the public program, room accounts, settlement transaction, and three separate return transactions.

## What Is TradeTable?

Sequential three-way transfers force someone to move first. TradeTable replaces that first-mover risk with revision-bound consensus and program-controlled custody.

Each of three fixed participants deposits two eligible classic SPL collectibles. The group chooses one asset per owner and a forward or reverse cycle. Every new proposal clears prior locks. The third matching lock freezes the deal.

Exactly three selected assets settle atomically. Three unselected assets return separately. Public Devnet evidence uses commit-only ER finalization followed by a base settlement transaction.

## Features

- **Three-party consensus:** three independent primary wallets must lock the same revision and allocation hash.
- **Visible stale-consent protection:** every proposal increments the revision and clears all previous locks.
- **Six-asset custody:** six canonical vault ATAs remain under a Solana PDA authority.
- **Two cyclic routes:** selected assets move in a complete forward or reverse derangement.
- **Selected-three atomicity:** three `transfer_checked` instructions execute in one base transaction.
- **Deterministic returns:** unselected or cancelled assets return to immutable owner destinations.
- **Authority-aware client:** the browser switches between base, Router, and direct ER authority.
- **Proof-first judge surface:** addresses, signatures, masks, and provenance stay visible without wallet access.

## How It Works

```text
Collector A ----|
Collector B ----|--> RoomLive (MagicBlock ER)
Collector C ----|      proposal + revision + exact locks
                       |
                       | commit and undelegate
                       v
RoomCore + six vault ATAs (Solana Devnet)
                       |
                       +--> one base transaction: 3 selected transfers
                       |
                       +--> three base transactions: 3 returns
```

### State split

| Account | Location | Responsibility |
|---|---|---|
| `RoomCore` | Solana base | Roster, custody ledger, expiry, masks, and settlement state |
| `RoomLive` | MagicBlock during negotiation | Revision, selected slots, cycle, locks, and allocation hash |
| Vault authority | Solana base | PDA signer for six canonical token vaults |

### Consensus rule

The allocation hash binds the room, revision, expiry, selected slots, cycle, and destinations. A lock records the current revision and hash. Any new proposal invalidates all existing consent.

### Settlement boundary

The public proof path commits and undelegates `RoomLive`, then calls permissionless `settle_committed` on Solana. That transaction moves only the selected three assets. Each unselected asset returns in its own later transaction.

The composed Magic Action path has local-validator evidence. It is not presented as public Devnet composed-action proof.

## Tech Stack

| Layer | Technology |
|---|---|
| Product UI | Next.js 15, React 19, TypeScript 5.9 |
| Solana client | `@solana/web3.js`, Anchor client, SPL Token |
| Program | Rust, Anchor 0.32.1 |
| Fast state | MagicBlock Ephemeral Rollups SDK 0.16.2 |
| Custody | Classic SPL Token vault ATAs |
| Hosting | Vercel |
| Network | Solana Devnet and MagicBlock Devnet ER |

## Testing

Run the deterministic frontend behavior gate:

```bash
npm run test:frontend
npm run typecheck
npm run build
```

Run the full Anchor program and behavioral gate when a local validator and ER are available:

```bash
npm test
```

The redesigned frontend gate contains 97 deterministic tests. The protocol pipeline also passed its behavioral, debug, wire, and stress suites. Coverage includes eligibility, authorization, revision races, settlement account substitution, cancellation, expiry, deterministic returns, client routing, pending-write reconciliation, wallet changes, and proof integrity.

## Try It (3 minutes)

1. Open the [live app](https://tradetable-solana.vercel.app).
2. Choose **Open earned demo** to enter the verified room route.
3. Inspect the six custody slots, authoritative revision, selected cards, and three exact locks.
4. Open the room's [Proof Ledger](https://tradetable-solana.vercel.app/rooms/9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo/proof).
5. Follow the base settlement signature to Solana Explorer.
6. Verify that it contains the selected three transfers.
7. Compare the three separate return signatures.

Wallet writes require one of the fixed room participants and an active negotiating room. The public earned room is provided as read-only evidence.

## Smart Contract

| Program | Address | Description |
|---|---|---|
| TradeTable | `FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3` | Three-party custody, consensus, settlement, cancellation, and returns |

## On-Chain Verification

| What | Address / Link |
|---|---|
| Program | [Solana Explorer](https://explorer.solana.com/address/FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3?cluster=devnet) |
| Security upgrade | [Solana Explorer](https://explorer.solana.com/tx/3yhzSXkxDny8DY345Pirf7qfxJWtDSwnUkuYucdcRM6xxHdRL6vMW9LE75NVxkdqiM7cyuPPczCsXpfaFFftmkja?cluster=devnet) |
| RoomCore | [Solana Explorer](https://explorer.solana.com/address/9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo?cluster=devnet) |
| Selected-three settlement | [Solana Explorer](https://explorer.solana.com/tx/2vsmk7HDrWzRTAG1sbY9U7oFS14mgZ4CgZQZ5nDCSmxSPoe71wWUAXKZFmSF2UKwdsCMBdtSbKzXyqScMpTH6BX5?cluster=devnet) |
| Proof manifest | [`submission/proof.md`](submission/proof.md) |

## Running Locally

```bash
git clone https://github.com/dmustapha/TradeTable.git
cd TradeTable
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000`.

### Required Environment Variables

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_PROGRAM_ID` | Deployed TradeTable program |
| `NEXT_PUBLIC_DEMO_ROOM` | Public RoomCore account |
| `NEXT_PUBLIC_DEMO_LIVE` | Linked RoomLive account |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Solana Devnet RPC endpoint |
| `NEXT_PUBLIC_SOLANA_WS_URL` | Solana Devnet WebSocket endpoint |
| `NEXT_PUBLIC_MAGIC_ROUTER_RPC` | MagicBlock Router RPC endpoint |
| `NEXT_PUBLIC_MAGIC_ROUTER_WS` | MagicBlock Router WebSocket endpoint |
| `NEXT_PUBLIC_MAGIC_ER_RPC` | Direct MagicBlock ER RPC endpoint |
| `NEXT_PUBLIC_MAGIC_ER_WS` | Direct MagicBlock ER WebSocket endpoint |
| `DEMO_PAYER_KEYPAIR` | Local path used only by operator scripts |

Public defaults are documented in [`.env.example`](.env.example). Never commit an operator keypair.

## Project Structure

```text
src/app/rooms/[core]/       Verified room workspace and proof routes
src/app/room-client.tsx     Reactive lifecycle and action workspace
src/lib/room-state.ts       Canonical decoders and legal UI state derivation
src/lib/room-actions.ts     Instruction builders and pending postconditions
src/lib/room-loader.ts      Server-side account validation and authority loading
src/lib/tradetable.ts       RPC transports, subscriptions, PDAs, and hashes
src/idl/                    Generated program interface
programs/tradetable/        Anchor program
scripts/ops.ts              Seed, measure, and proof commands
tests/ui/                   Deterministic redesign behavior tests
submission/                 Public Devnet proof and measurements
```

Built for [Solana Blitz v7](https://build.magicblock.app/?event=10&stage=blitz) with MagicBlock.

## License

MIT
