/** Čistá příprava nákupních položek z product-match a webových nálezů. */
import type { ProductMatch } from './types.js';
import type { WebFindingRow } from './web-findings-store.js';
import type { NakupItemInput } from './nakupy-store.js';

interface ExistingNakup {
  polozka_index: number;
  objednano?: boolean;
}

interface SupplierLink {
  dodavatel: string | null;
  url: string | null;
}

/** Porovnávací cena: přednost má cena bez DPH, jinak dostupná cena s DPH. */
function sourcePrice(source: { cena_bez_dph?: number | null; cena_s_dph?: number | null }): number {
  if (typeof source.cena_bez_dph === 'number') return source.cena_bez_dph;
  if (typeof source.cena_s_dph === 'number') return source.cena_s_dph;
  return Number.POSITIVE_INFINITY;
}

function cheapest<T extends { cena_bez_dph?: number | null; cena_s_dph?: number | null }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((best, item) => (
    !best || sourcePrice(item) < sourcePrice(best) ? item : best
  ), undefined);
}

/** Priorita zdroje: multi-source ověření → legacy ověření → findings → prázdno. */
export function selectSupplierLink(
  item: NonNullable<ProductMatch['polozky_match']>[number],
  findings: WebFindingRow[],
): SupplierLink {
  const sources = item.overeni_ceny?.zdroje?.filter((source) => !!source.url) ?? [];
  if (sources.length > 0) {
    const selected = cheapest(sources)!;
    return { dodavatel: selected.dodavatel ?? null, url: selected.url };
  }

  if (item.overeni_ceny?.zdroj_url) {
    return {
      dodavatel: item.overeni_ceny.dodavatel ?? null,
      url: item.overeni_ceny.zdroj_url,
    };
  }

  const matchingFindings = findings.filter((finding) => finding.polozka_index === item.polozka_index);
  const selectedFinding = cheapest(matchingFindings);
  if (selectedFinding) {
    return { dodavatel: selectedFinding.dodavatel ?? null, url: selectedFinding.url };
  }

  return { dodavatel: null, url: null };
}

/**
 * Vrátí jen potvrzené a dosud chybějící položky. Vstupy nemění; existující
 * položka (včetně objednáno) je při opakovaném seedu zcela vynechána.
 */
export function buildNakupySeedItems(
  productMatch: ProductMatch,
  findings: WebFindingRow[],
  existing: ExistingNakup[] = [],
): NakupItemInput[] {
  const existingIndexes = new Set(existing.map((item) => item.polozka_index));
  return (productMatch.polozky_match ?? [])
    .filter((item) => item.cenova_uprava?.potvrzeno === true && !existingIndexes.has(item.polozka_index))
    .map((item) => {
      const supplier = selectSupplierLink(item, findings);
      return {
        polozka_index: item.polozka_index,
        polozka_nazev: item.polozka_nazev,
        mnozstvi: item.mnozstvi ?? null,
        jednotka: item.jednotka ?? null,
        nakupni_cena_bez_dph: item.cenova_uprava!.nakupni_cena_bez_dph,
        dodavatel: supplier.dodavatel,
        url: supplier.url,
      };
    });
}
