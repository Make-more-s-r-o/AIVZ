import type { ProductMatch } from './types.js';

export interface UnconfirmedPrices {
  count: number;
  names: string[];
}

/**
 * Vrátí nepotvrzené ceny, které skutečně patří do podávaných částí zakázky.
 * Prázdný/neurčený výběr znamená všechny části. Funkce je čistá, aby stejný
 * money-gate používal API řetězec i přímé spuštění generate-bid.ts.
 */
export function findUnconfirmedPrices(
  productMatch: ProductMatch,
  selectedPartIds?: ReadonlySet<string> | null,
): UnconfirmedPrices {
  if (productMatch.polozky_match) {
    const relevant = productMatch.polozky_match.filter((item) => {
      if (!selectedPartIds || selectedPartIds.size === 0 || !item.cast_id) return true;
      return selectedPartIds.has(item.cast_id);
    });
    const unconfirmed = relevant.filter((item) => !item.cenova_uprava?.potvrzeno);
    return {
      count: unconfirmed.length,
      names: unconfirmed.map((item) => item.polozka_nazev),
    };
  }

  return productMatch.cenova_uprava?.potvrzeno
    ? { count: 0, names: [] }
    : { count: 1, names: ['cenová kalkulace'] };
}

/** Tvrdý gate přímého generování: bez lidského potvrzení cen vždy vyhodí chybu. */
export function assertPricesConfirmedForGeneration(
  productMatch: ProductMatch,
  selectedPartIds?: ReadonlySet<string> | null,
): void {
  const unconfirmed = findUnconfirmedPrices(productMatch, selectedPartIds);
  if (unconfirmed.count > 0) {
    throw new Error(
      `Generování nelze spustit nad nepotvrzenými cenami (${unconfirmed.count}): ${unconfirmed.names.join(', ')}.`,
    );
  }
}
