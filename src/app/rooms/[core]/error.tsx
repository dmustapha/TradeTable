"use client";

export default function RoomError({reset}: {error: Error & {digest?: string}; reset: () => void}) {
  return <main><nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network">ROOM READ FAILED</div><a href="/proof">Proof ledger ↗</a></nav><section className="notice" role="alert"><strong>Verified room state is unavailable.</strong><p>The account failed ownership, linkage, decoding, or bounded authority checks. Nothing was replaced with demo state.</p><button type="button" onClick={() => reset()}>RETRY AUTHORITATIVE READS</button></section></main>;
}
