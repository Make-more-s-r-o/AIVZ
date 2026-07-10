export const VAT_PERCENT = 21;

export interface PriceCalculation {
  nakupni_cena_bez_dph: number;
  nakupni_cena_s_dph: number;
  marze_procent: number;
  nabidkova_cena_bez_dph: number;
  nabidkova_cena_s_dph: number;
}

/** Zaokrouhlí peněžní částku na haléře. */
export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Spočítá nákupní a nabídkovou cenu jednotky. DPH se vždy odvozuje až od
 * příslušné ceny bez DPH, aby backend a cenový kalkulátor používaly stejný tok.
 */
export function calculateItemPrice(
  nakupniCenaBezDph: number,
  marzeProcent: number,
  vatPercent = VAT_PERCENT,
): PriceCalculation {
  if (![nakupniCenaBezDph, marzeProcent, vatPercent].every(Number.isFinite)) {
    throw new Error('Cena, marže a sazba DPH musí být konečná čísla.');
  }

  const nakupniCenaSdph = roundCurrency(nakupniCenaBezDph * (1 + vatPercent / 100));
  const nabidkovaCenaBezDph = roundCurrency(nakupniCenaBezDph * (1 + marzeProcent / 100));
  const nabidkovaCenaSdph = roundCurrency(nabidkovaCenaBezDph * (1 + vatPercent / 100));

  return {
    nakupni_cena_bez_dph: nakupniCenaBezDph,
    nakupni_cena_s_dph: nakupniCenaSdph,
    marze_procent: marzeProcent,
    nabidkova_cena_bez_dph: nabidkovaCenaBezDph,
    nabidkova_cena_s_dph: nabidkovaCenaSdph,
  };
}
