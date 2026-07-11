export const VAT_PERCENT = 21;

/**
 * Výchozí marže v %, dokud se nenačte firemní default z backendu — zrcadlí
 * fallback resolveDefaultMarzeProcent v scripts/src/lib/company-store.ts.
 */
export const DEFAULT_MARZE_PROCENT = 10;

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

/** Stejný money-path jako backend: marže z ceny bez DPH, potom 21 % DPH. */
export function calculateItemPrice(
  nakupniCenaBezDph: number,
  marzeProcent: number,
  vatPercent = VAT_PERCENT,
): PriceCalculation {
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
