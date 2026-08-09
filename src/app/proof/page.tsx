const explorer = "https://explorer.solana.com";
const cluster = "?cluster=devnet";

const accounts = [
  ["PROGRAM", "FRtW8QWScLWgDSwSWxnRTBhD8kMXg82aLV2qA3WCtXq3"],
  ["ROOM CORE", "9uxuWPcyhqAh2U6zhVPQnMeHVsqjE1yvseErgboq6DTo"],
  ["ROOM LIVE", "46r8db8EKsrtzz2btXfxLz8A3vSX1FHmbw3ynpzSAbD1"],
] as const;

const transactions = [
  ["SELECTED-THREE SETTLEMENT", "2vsmk7HDrWzRTAG1sbY9U7oFS14mgZ4CgZQZ5nDCSmxSPoe71wWUAXKZFmSF2UKwdsCMBdtSbKzXyqScMpTH6BX5"],
  ["SEPARATE RETURN 01", "5fArNw2GtfLHK5vq344wPnqqGrb9t2bYzabfLYQNrwAbJs5egj4ydhcposp5NWBZR3mtQToepCb6NXCdSN7391ms"],
  ["SEPARATE RETURN 02", "3u98udn2X1XBzYzepb8Mm8wvHsKcuM7Vc3Gq6A4pX5CG83VoiSJBM3qucxbiyJtYa9xvV1xwrr7bqXLnTMUGR26y"],
  ["SEPARATE RETURN 03", "4zWBZnCW2y4dEygfLoL8cFVNCXAKAxQo1tBiYp7YYsdDJRz7EjVPhKoCQHf5GnD2Zazoxsipz5fH8fMcQx9nFHVj"],
] as const;

export default function Proof() {
  return <main className="proofPage">
    <nav><a className="brand" href="/">TRADE<span>TABLE</span></a><div className="network"><i className="live" /> SOLANA DEVNET · EARNED PROOF</div><a href="/">Live table ↗</a></nav>
    <header className="proofHero">
      <p className="kicker">PUBLIC EVIDENCE / DEVNET</p>
      <h1>Proof before<br /><em>promise.</em></h1>
      <p className="lede">Public evidence shows commit-only ER finalization, then one base transaction for the selected three. The unselected three return in separate base transactions. Local composed-action evidence is not presented as public Devnet proof.</p>
    </header>
    <section className="proofGrid">
      <article className="proofCard"><span>PUBLIC MAGICBLOCK STEP</span><strong>COMMIT-ONLY ER</strong><code>2fpZgMn89JbMQBWfcxDkoFmqcZeGNmbiskc9v5ym97uqYxUdaND2KP8coc3GJbTtNCbuUV6TBtjJCXYuaRby7yJc</code><small>Raw signature confirmed through <a href="https://devnet-as.magicblock.app/">devnet-as.magicblock.app ↗</a>. No Solana Explorer claim is made for this ER-only signature.</small></article>
      <article className="proofCard"><span>ATOMIC BOUNDARY</span><strong>3 SELECTED</strong><code>selectedMask 21</code><small>3 transferChecked · amount 1 · decimals 0</small></article>
      <article className="proofCard"><span>SEPARATE RECOVERY</span><strong>3 RETURNS</strong><code>one asset per transaction</code><small>Not part of the selected-three atomic settlement</small></article>
    </section>
    <section className="proofLedger" id="base-consequences">
      <div><p className="kicker">ONCHAIN IDENTITIES</p><h2>Resolve every account.</h2></div>
      <ol>{accounts.map(([label, address]) => <li key={address}><span>{label}</span><code>{address}</code><a href={`${explorer}/address/${address}${cluster}`}>EXPLORER ↗</a></li>)}</ol>
    </section>
    <section className="proofLedger">
      <div><p className="kicker">BASE CONSEQUENCES</p><h2>Inspect exact transactions.</h2></div>
      <ol>{transactions.map(([label, signature]) => <li key={signature}><span>{label}</span><code>{signature}</code><a href={`${explorer}/tx/${signature}${cluster}`}>EXPLORER ↗</a></li>)}</ol>
    </section>
    <section className="proofBoundary" id="local-only"><strong>LOCAL-ONLY BOUNDARY</strong><p>Fresh composed-action delivery is reliability-bounded local evidence. A failed asynchronous Magic Action can leave ER state Finalized/stuck while base custody remains unchanged. That is not an ER rollback.</p></section>
    <footer><strong>MagicBlock speeds the conversation.</strong><span>Solana secures the consequence.</span><a href="/">Return to table ↗</a></footer>
  </main>;
}
