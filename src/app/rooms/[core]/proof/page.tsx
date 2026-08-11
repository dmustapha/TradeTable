import {notFound} from "next/navigation";
import {PublicKey} from "@solana/web3.js";

import {buildRoomEvidence, type FeaturedRoomEvidence, type RoomEvidenceSnapshot} from "@/lib/evidence";
import {RoomNotFoundError, canonicalRoomAddress, loadRoom} from "@/lib/room-loader";

function short(value: string) { return `${value.slice(0, 7)}…${value.slice(-6)}`; }

function LinkValue({value, href}: {value: string; href: string | null}) {
  return <>{<code>{value}</code>}{href ? <a href={href}>SOLANA EXPLORER ↗</a> : <small>No public Explorer target for the configured base endpoint.</small>}</>;
}

function CurrentAccounts({evidence}: {evidence: RoomEvidenceSnapshot}) {
  return <section className="proofLedger" aria-labelledby="current-accounts-title">
    <div><p className="kicker">CURRENT VERIFIED BASE STATE</p><h2 id="current-accounts-title">Accounts and custody.</h2></div>
    <ol>
      <li id={evidence.identity.coreAnchor}><span>ROOM CORE</span><LinkValue value={evidence.identity.roomCore} href={evidence.identity.coreHref} /></li>
      <li id={evidence.identity.liveAnchor}><span>ROOM LIVE</span><LinkValue value={evidence.identity.roomLive} href={evidence.identity.liveHref} /></li>
      {evidence.current.vaults.map(vault => <li id={vault.anchor} key={vault.anchor}>
        <span>SLOT {vault.slot} · {vault.returned ? "RETURNED" : vault.selected ? "SELECTED" : vault.deposited ? "IN CUSTODY" : "NOT DEPOSITED"}</span>
        <code>{vault.vault ?? "No vault recorded"}</code>
        {vault.href ? <a href={vault.href}>SOLANA EXPLORER ↗</a> : <small>{vault.mint ? "No public Explorer target for this base endpoint." : "No mint or vault is recorded for this slot."}</small>}
      </li>)}
    </ol>
  </section>;
}

function ErEvidence({featured}: {featured: FeaturedRoomEvidence | null}) {
  return <section className="proofLedger" aria-labelledby="er-evidence-title">
    <div><p className="kicker">MAGICBLOCK ER / COLLABORATION</p><h2 id="er-evidence-title">Raw ER evidence.</h2></div>
    {featured ? <><ol>{featured.er.transactions.map(item => <li id={item.anchor} key={item.anchor}>
      <span>{item.label}</span><code>{item.signature}</code><a href={item.href}>RAW ER ENDPOINT ↗</a>
    </li>)}</ol><p>{featured.er.note} No Solana Explorer claim is made for an ER-only signature.</p></>
      : <div className="proofBoundary"><strong>ER history not indexed</strong><p>This room has no indexed proposal, lock, or commit signature history. Only its current verified account state is shown; no events are inferred.</p></div>}
  </section>;
}

function TransactionRows({items}: {items: readonly {anchor: string; label: string; signature: string; href: string}[]}) {
  return <>{items.map(item => <li id={item.anchor} key={item.anchor}><span>{item.label}</span><code>{item.signature}</code><a href={item.href}>SOLANA EXPLORER ↗</a></li>)}</>;
}

function EarnedBaseEvidence({featured}: {featured: FeaturedRoomEvidence | null}) {
  if (!featured) return <section className="proofBoundary"><strong>BASE HISTORY NOT INDEXED</strong><p>Current RoomCore, RoomLive, and recorded vault state are verified above. Historical settlement and return transactions are not claimed for this room.</p></section>;
  return <section className="proofLedger" aria-labelledby="base-evidence-title">
    <div><p className="kicker">SOLANA BASE / CUSTODY + CONSEQUENCES</p><h2 id="base-evidence-title">Earned Devnet evidence.</h2></div>
    <ol>
      {featured.base.accounts.map(item => <li id={item.anchor} key={item.anchor}><span>{item.label}</span><code>{item.address}</code><a href={item.href}>SOLANA EXPLORER ↗</a></li>)}
      <TransactionRows items={featured.base.maintenance} />
      <TransactionRows items={featured.base.settlement} />
      <TransactionRows items={featured.base.returns} />
    </ol>
  </section>;
}

export default async function RoomProofPage({params}: {params: Promise<{core: string}>}) {
  let address: string;
  try { address = canonicalRoomAddress((await params).core); }
  catch { notFound(); }
  let room;
  try { room = await loadRoom(new PublicKey(address)); }
  catch (error) { if (error instanceof RoomNotFoundError) notFound(); throw error; }
  const evidence = buildRoomEvidence(room);
  return <main className="proofPage">
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i /> ROOM-SCOPED EVIDENCE</div><a href={`/rooms/${address}`}>Room workspace ↗</a></nav>
    <header className="proofHero"><p className="kicker">ROOM PROOF / {short(address)}</p><h1>State before<br /><em>story.</em></h1><p className="lede">This ledger binds evidence to one verified RoomCore. MagicBlock ER records collaboration; Solana base records custody and consequences. Missing history stays missing.</p></header>
    <section className="proofGrid">
      <article className="proofCard"><span>CURRENT AUTHORITY</span><strong>{evidence.current.authority === "magicblock-er" ? "MAGICBLOCK ER" : "SOLANA BASE"}</strong><code>{evidence.current.authorityEndpoint}</code><small>{evidence.current.delegated ? "RoomLive is currently delegated." : "RoomLive is currently program-owned on base."}</small></article>
      <article className="proofCard"><span>VERIFIED LIFECYCLE</span><strong>{evidence.current.coreStatus} / {evidence.current.livePhase}</strong><code>revision {evidence.current.revision.toString()} · locks {evidence.current.lockMask}/7</code><small>{evidence.current.settlementReason}</small></article>
      <article className="proofCard"><span>ATOMIC BOUNDARY</span><strong>3 SELECTED + 3 RETURNS</strong><code>one base settlement · three base returns</code><small>{evidence.boundary.selected} {evidence.boundary.returns}</small></article>
    </section>
    <CurrentAccounts evidence={evidence} />
    <ErEvidence featured={evidence.featured} />
    <EarnedBaseEvidence featured={evidence.featured} />
    <section className="proofBoundary"><strong>FAILURE BOUNDARY</strong><p>{evidence.boundary.failure} An ER-only Finalized room is not settlement eligible; wait and inspect, then use expiry recovery only when eligible.</p></section>
    <footer><strong>MagicBlock speeds the conversation.</strong><span>Solana secures the consequence.</span><a href={`/rooms/${address}`}>Return to room ↗</a></footer>
  </main>;
}
