/**
 * Propustí jen absolutní http(s) URL — cokoli jiného (`javascript:`, `data:`, relativní cesty
 * z neověřených zdrojů) vrátí undefined, aby se URL z AI/scrapingu nedala zneužít k XSS přes href.
 * Sanitizace probíhá i u zdroje (price-verifier.ts); tohle je druhá vrstva (defense-in-depth).
 */
export function safeHttpUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}
