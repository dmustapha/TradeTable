# TradeTable Domain Guide

TradeTable is a three-party cyclic barter protocol. Three fixed participants each deposit two immutable classic SPL assets. The group collaboratively chooses one asset from each owner and sends those three assets around a cycle; the remaining three assets are returned to their original owners.

## Core concepts

1. **Three-party cyclic barter** — exactly three distinct primary wallets negotiate a single cyclic exchange. There are no arbitrary recipients.
2. **6 IN / 3 TRADE / 3 RETURN** — six assets enter base-layer custody, exactly three selected assets trade atomically, and the three unselected assets return separately.
3. **One-per-owner selection** — the chosen set contains one of slots 0–1, one of slots 2–3, and one of slots 4–5.
4. **Full derangement** — no selected asset returns to its owner. Forward routes owners to `[1,2,0]`; reverse routes them to `[2,0,1]`.
5. **Revision** — every accepted proposal increments the live revision. A stale expected revision is rejected.
6. **Allocation hash** — `allocation_hash` is the SHA-256 deal fingerprint over the domain separator, RoomCore, revision, expiry, selected slots, cycle, and destinations.
7. **Lock** — a participant approves exactly the current revision and allocation hash. The signer’s roster index is derived, never supplied.
8. **Freeze** — the third valid lock changes RoomLive to Finalizing; proposals and lock revocation can no longer mutate the deal.
9. **Base custody** — RoomCore and all six token vaults remain authoritative on Solana base, so an ER outage cannot trap deposited assets.
10. **Vault ATA** — each vault is the canonical classic-token ATA for the vault-authority PDA and its immutable mint.
11. **Token authority** — the vault-authority PDA has no private key; the program signs transfers with its canonical seeds.
12. **Delegated state** — only RoomLive is delegated to the ephemeral rollup for low-latency proposals and locks.
13. **Commit** — final RoomLive bytes are sealed back to the base layer before base settlement is accepted.
14. **Undelegate** — finalized live state returns to base ownership as part of the primary consequence path.
15. **Magic Action** — finalize schedules the base settlement handler after committing and undelegating RoomLive.
16. **Post-commit handler** — the handler revalidates the committed live state and all dynamic settlement accounts, then executes exactly three `transfer_checked` CPIs.
17. **Rollback** — a failed settlement leg reverts the whole transaction: no partial token transfer, RoomCore mutation, or successful commit/action claim is allowed.
18. **Permissionless return** — after cancellation or settlement, any fee payer may call `return_asset` for a returnable slot. The stored original owner and mint derive the immutable canonical return ATA; the instruction verifies an existing ATA or safely creates it when absent.
19. **Authoritative projection** — RoomCore is read from base; RoomLive is read from the router/direct ER while delegated and from base after undelegation. The UI labels its source and never invents state.
20. **Earned proof** — program addresses, room addresses, signatures, token deltas, transaction size, and compute measurements are published only after successful network read-back.

## Business rules

- A room has exactly three distinct, non-default participants and six unique eligible classic SPL mints.
- Each mint has decimals `0`, supply `1`, and no mint or freeze authority. Token-2022 and programmable/compressed assets are excluded.
- Participant 0 owns slots 0–1, participant 1 owns slots 2–3, and participant 2 owns slots 4–5. Only that primary wallet may deposit its slot.
- Activation requires all six deposit bits (`deposited_mask == 63`) and an unexpired room. Only RoomLive is delegated.
- A proposal selects exactly one funded slot per owner, uses a forward or reverse full derangement, increments revision, recomputes the allocation hash, and clears every prior lock.
- A lock binds one primary participant to the current revision and allocation hash. Three exact locks freeze the live deal.
- Settlement is authorized only by freshly committed Finalized RoomLive state that exactly matches RoomCore, the locks, allocation hash, mints, vaults, and canonical destination ATAs.
- The selected three transfer in one Solana transaction or none do. RoomCore is updated only after all three token CPIs succeed.
- Cancellation and settlement race on writable RoomCore; Solana ordering gives exactly one consequence path.
- In Returning state only unselected funded slots are returnable. In Cancelled state every funded slot is returnable. Replays are rejected.
- Returns are permissionless but destinations are not: the immutable original owner and mint determine the canonical `original_ata`. If that ATA was closed, `return_asset` uses the fee payer plus the Associated Token and System programs to recreate it before transfer; a noncanonical or mismatched account is rejected.
- A router or WebSocket failure may degrade routing or freshness, never custody authority or settlement truth.
- The literal System Program ID `11111111111111111111111111111111` in bootstrap configuration is only a compile sentinel. It is not a TradeTable deployment address or proof.

## Code glossary

| Product language | Code name | Meaning |
|---|---|---|
| table | `RoomCore` | Base-authoritative roster, custody inventory, consequence state, and recovery record |
| live negotiation | `RoomLive` | Delegatable proposal, revision, lock, and finalization state |
| approval | `lock` | Participant approval of an exact revision and allocation hash |
| deal fingerprint | `allocation_hash` | Deterministic SHA-256 digest of the proposed allocation |
| chosen three | `selected_mask` | RoomCore bitmask of the three atomically transferred slots |
| put back | `return_asset` | Permissionless transfer to the verified or safely recreated canonical ATA for the stored original owner and mint |

## Allocation hash bytes

```text
sha256(
  "tradetable-allocation-v1" ||
  room_core[32] || revision_le[8] || expires_at_le[8] ||
  selected_slots[3] || cycle[1] || destinations[3]
)
```

`Forward = 0` and destinations `[1,2,0]`. `Reverse = 1` and destinations `[2,0,1]`.

## Source map

| Knowledge | Canonical source |
|---|---|
| Product thesis, included/excluded behavior, P0/P1 scope | `../PRD.md` §1 and §4 |
| RoomCore, RoomLive, vault authority, asset records, allocation hash | `../ARCHITECTURE.md` §3 |
| Signers, account constraints, transitions, race semantics, fallbacks, errors | `../ARCHITECTURE.md` §4 |
| Client authority and routing behavior | `../ARCHITECTURE.md` §6 |
| Proof generation and deterministic seed behavior | `../ARCHITECTURE.md` §8 |
| This guide’s required concepts and vocabulary mappings | `../ARCHITECTURE.md` §9 |
| Acceptance assertions and compute/transaction gates | `../ARCHITECTURE.md` §14 |
| Local and Devnet service sequence | `../ARCHITECTURE.md` §16 |
| External integration boundaries and health checks | `../ARCHITECTURE.md` §19 |
