/**
 * Detekce zastaralých vygenerovaných dokumentů vůči poslední změně cen.
 *
 * Když operátor po vygenerování dokumentů (krok "Dokumenty") ještě upraví/potvrdí
 * cenu položky (PUT price / price/bulk / select kandidáta), vygenerované .docx/.xlsx
 * v output/<tender>/ tu změnu už neobsahují — obsahují starou cenu. UI to dřív nijak
 * nehlásilo, takže hrozilo podání nabídky se starou cenou.
 *
 * `isStale` je čistá funkce (žádné I/O) — porovná čas poslední změny cen
 * (product-match.json.prices_updated_at) s časem vygenerování dokumentů (mtime
 * NEJSTARŠÍHO generovaného souboru z dávky — záměrně MIN, ne MAX: i jediný zastaralý
 * dokument z dávky má banner vyvolat, radši false positive než tichá stará cena
 * v nabídce).
 */
export function isStale(
  docsGeneratedAtMs: number | null | undefined,
  pricesUpdatedAtIso: string | null | undefined,
): boolean {
  if (!docsGeneratedAtMs || !pricesUpdatedAtIso) return false;
  const pricesTs = Date.parse(pricesUpdatedAtIso);
  if (Number.isNaN(pricesTs)) return false;
  return pricesTs > docsGeneratedAtMs;
}
