import type { ProductMatch } from './types.js';

export const VAT_PERCENT = 21;

export interface PriceCalculation {
  nakupni_cena_bez_dph: number;
  nakupni_cena_s_dph: number;
  marze_procent: number;
  nabidkova_cena_bez_dph: number;
  nabidkova_cena_s_dph: number;
}

export interface PriceRecapPartDefinition {
  id: string;
  nazev: string;
}

export interface PartPriceRecap {
  id: string;
  nazev: string;
  cena_bez_dph: number;
  cena_s_dph: number;
  pocet_polozek: number;
}

export interface UnassignedPartPriceItem {
  polozka_index: number;
  polozka_nazev: string;
}

export interface TenderPriceRecap {
  celkova_cena_bez_dph: number;
  celkova_cena_s_dph: number;
  pocet_polozek: number;
  casti: PartPriceRecap[];
  polozky_bez_cast_id: UnassignedPartPriceItem[];
}

interface RecapLine {
  polozka_index: number;
  polozka_nazev: string;
  cast_id?: string;
  cena_bez_dph: number;
  cena_s_dph: number;
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

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Musí zůstat shodné s historickým round2 v generate-bid/data-resolver. Přidání
// Number.EPSILON by u hraniční hodnoty 1.005 změnilo nedělenou zakázku z 1.00 na 1.01.
function roundRecapCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

function productMatchLines(productMatch: ProductMatch): RecapLine[] {
  if (Array.isArray(productMatch.polozky_match)) {
    return productMatch.polozky_match.map((item) => {
      const selected = item.kandidati?.[item.vybrany_index];
      const quantity = item.mnozstvi || 1;
      const unitWithoutVat = item.cenova_uprava?.nabidkova_cena_bez_dph
        ?? selected?.cena_bez_dph;
      const unitWithVat = item.cenova_uprava?.nabidkova_cena_s_dph
        ?? selected?.cena_s_dph;
      return {
        polozka_index: item.polozka_index,
        polozka_nazev: item.polozka_nazev,
        cast_id: item.cast_id,
        cena_bez_dph: roundRecapCurrency(finiteNumber(unitWithoutVat) * quantity),
        cena_s_dph: roundRecapCurrency(finiteNumber(unitWithVat) * quantity),
      };
    });
  }

  const selected = productMatch.kandidati?.[productMatch.vybrany_index ?? 0];
  return [{
    polozka_index: -1,
    polozka_nazev: 'Zakázka',
    cena_bez_dph: roundRecapCurrency(finiteNumber(
      productMatch.cenova_uprava?.nabidkova_cena_bez_dph ?? selected?.cena_bez_dph,
    )),
    cena_s_dph: roundRecapCurrency(finiteNumber(
      productMatch.cenova_uprava?.nabidkova_cena_s_dph ?? selected?.cena_s_dph,
    )),
  }];
}

/**
 * Jediný výpočet cenové rekapitulace pro generování i kontroly. Řádky se nejprve
 * zaokrouhlí na haléře a teprve potom sčítají. Cena s DPH se bere ze skutečné
 * potvrzené ceny, nikoli dopočtem, aby šlo korektně kontrolovat oba druhy stropu.
 */
export function calculateTenderPriceRecap(
  productMatch: ProductMatch,
  declaredParts: readonly PriceRecapPartDefinition[] = [],
  selectedPartIds: ReadonlySet<string> | null = null,
): TenderPriceRecap {
  const divided = declaredParts.length > 1 && Array.isArray(productMatch.polozky_match);
  const allLines = productMatchLines(productMatch);
  const lines = divided && selectedPartIds
    ? allLines.filter((line) => !line.cast_id || selectedPartIds.has(line.cast_id))
    : allLines;
  const sum = (values: number[]) => roundRecapCurrency(values.reduce((total, value) => total + value, 0));

  const casti = divided
    ? declaredParts
      .map((part) => {
        const partLines = allLines.filter((line) => line.cast_id === part.id);
        return {
          id: part.id,
          nazev: part.nazev,
          cena_bez_dph: sum(partLines.map((line) => line.cena_bez_dph)),
          cena_s_dph: sum(partLines.map((line) => line.cena_s_dph)),
          pocet_polozek: partLines.length,
        };
      })
    : [];

  return {
    celkova_cena_bez_dph: sum(lines.map((line) => line.cena_bez_dph)),
    celkova_cena_s_dph: sum(lines.map((line) => line.cena_s_dph)),
    pocet_polozek: lines.length,
    casti,
    polozky_bez_cast_id: divided
      ? lines
        .filter((line) => !line.cast_id)
        .map(({ polozka_index, polozka_nazev }) => ({ polozka_index, polozka_nazev }))
      : [],
  };
}
