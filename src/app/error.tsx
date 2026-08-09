"use client";

export default function ErrorBoundary({reset}: {error: Error & {digest?: string}; reset: () => void}) {
  return <main><section className="notice" role="alert"><strong>Verified room state is unavailable.</strong><p>No replacement state was fabricated. Retry the bounded reads when the network recovers.</p><button type="button" onClick={() => reset()}>RETRY VERIFIED READS</button></section></main>;
}
