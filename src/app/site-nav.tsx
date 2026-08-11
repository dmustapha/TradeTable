export default function SiteNav() {
  const networkLabel = process.env.NEXT_PUBLIC_NETWORK_LABEL ?? "SOLANA DEVNET";
  return <nav>
    <a className="brand" href="/">TRADE<span>TABLE</span></a>
    <div className="network"><i /> {networkLabel} · MAGICBLOCK ER</div>
    <a href="/proof">Proof ledger ↗</a>
  </nav>;
}
