export default function LoadingRoom() {
  const networkLabel = process.env.NEXT_PUBLIC_NETWORK_LABEL ?? "SOLANA DEVNET";
  return <main><nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network">{networkLabel}</div><a href="/proof">Proof ledger ↗</a></nav><section className="notice" role="status"><strong>Loading authoritative room state.</strong><p>Reading bounded Solana base and current delegation authority. No placeholder room will be fabricated.</p></section></main>;
}
