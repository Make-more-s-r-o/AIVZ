import { z } from 'zod';

import { candidateFingerprint } from './candidate-fingerprint.js';
import { calculateItemPrice, roundCurrency } from './price-calculator.js';
import { selectCheapestRealPriceSource } from './price-reality.js';
import { refreshProductMatchPriceSanity } from './price-sanity.js';
import { PriceOverrideSchema, type PolozkaMatch, type ProductMatch } from './types.js';

export const ApplyMarketPricesBodySchema = z.object({
  polozka_indexy: z.array(z.number().int().nonnegative()).optional(),
}).strict().superRefine((value, context) => {
  if (value.polozka_indexy && new Set(value.polozka_indexy).size !== value.polozka_indexy.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'polozka_indexy nesmí obsahovat duplicity' });
  }
});

export type MarketPriceSkipReason = 'orientacni' | 'bez_zdroje' | 'zmeneny_kandidat';

export interface MarketPriceSkippedItem {
  polozka_index: number;
  duvod: MarketPriceSkipReason;
}

export interface ApplyMarketPricesResult {
  upraveno: number;
  preskoceno: number;
  duvody_preskoceni: Record<MarketPriceSkipReason, number>;
  preskocene_polozky: MarketPriceSkippedItem[];
  nova_celkova_cena_bez_dph: number;
  nova_celkova_cena_s_dph: number;
  zrusena_potvrzeni: number[];
}

export class UnknownMarketPriceItemError extends Error {}
export class MultiItemProductMatchRequiredError extends Error {}

function appendVerifiedSourceNote(existing: string | undefined, supplier: string | null): string {
  const addition = `cena z ověřeného zdroje (${supplier?.trim() || 'neznámý dodavatel'})`;
  const current = existing?.trim();
  if (!current) return addition;
  if (current.toLocaleLowerCase('cs-CZ').includes(addition.toLocaleLowerCase('cs-CZ'))) return current;
  return `${current}; ${addition}`;
}

function lineOfferWithoutVat(item: PolozkaMatch): number {
  const selected = item.kandidati[item.vybrany_index];
  const unit = item.cenova_uprava?.nabidkova_cena_bez_dph ?? selected?.cena_bez_dph ?? 0;
  return unit * (item.mnozstvi || 1);
}

/**
 * Předvyplní doložené tržní náklady. Funkce nikdy nepotvrzuje cenu a orientační
 * zdroje odmítá; lidský money-gate tak zůstává beze změny.
 */
export function applyMarketPrices(
  productMatch: ProductMatch,
  defaultMarginPercent: number,
  requestedItemIndexes?: readonly number[],
): ApplyMarketPricesResult {
  const items = productMatch.polozky_match;
  if (!Array.isArray(items)) {
    throw new MultiItemProductMatchRequiredError('Hromadné použití reálných cen vyžaduje polozky_match.');
  }

  const knownIndexes = new Set(items.map((item) => item.polozka_index));
  const requested = requestedItemIndexes ? new Set(requestedItemIndexes) : null;
  const unknown = requestedItemIndexes?.filter((index) => !knownIndexes.has(index)) ?? [];
  if (unknown.length > 0) {
    throw new UnknownMarketPriceItemError(`Neznámé polozka_indexy: ${unknown.join(', ')}`);
  }

  const skipped: MarketPriceSkippedItem[] = [];
  let updated = 0;
  const invalidatedReviews: number[] = [];

  for (const item of items) {
    if (requested && !requested.has(item.polozka_index)) continue;

    const selected = item.kandidati[item.vybrany_index];
    const currentFingerprint = selected
      ? candidateFingerprint(selected, item.vybrany_index)
      : null;
    const verification = item.overeni_ceny;

    if (!verification) {
      skipped.push({ polozka_index: item.polozka_index, duvod: 'bez_zdroje' });
      continue;
    }
    if (!verification.kandidat_fingerprint || verification.kandidat_fingerprint !== currentFingerprint) {
      skipped.push({ polozka_index: item.polozka_index, duvod: 'zmeneny_kandidat' });
      continue;
    }

    const sources = verification.zdroje ?? [];
    const hasOnlyOrientationalSources = sources.length > 0 && sources.every((source) => source.orientacni === true);
    if (verification.stav === 'orientacni' || hasOnlyOrientationalSources) {
      skipped.push({ polozka_index: item.polozka_index, duvod: 'orientacni' });
      continue;
    }

    const cheapest = selectCheapestRealPriceSource(sources, item.mnozstvi || 1);
    if (!cheapest) {
      skipped.push({ polozka_index: item.polozka_index, duvod: 'bez_zdroje' });
      continue;
    }

    const purchaseWithoutVat = roundCurrency(cheapest.unitPriceWithoutVat);
    const margin = item.cenova_uprava?.marze_procent ?? defaultMarginPercent;
    const calculated = calculateItemPrice(purchaseWithoutVat, margin);
    if (item.cenova_uprava?.potvrzeno || item.cenova_uprava?.zkontrolovano_at) {
      invalidatedReviews.push(item.polozka_index);
    }
    item.cenova_uprava = PriceOverrideSchema.parse({
      ...calculated,
      potvrzeno: false,
      zdroj_nakupu: {
        url: cheapest.source.url,
        dodavatel: cheapest.source.dodavatel,
      },
      poznamka: appendVerifiedSourceNote(item.cenova_uprava?.poznamka, cheapest.source.dodavatel),
    });
    updated += 1;
  }

  refreshProductMatchPriceSanity(productMatch);
  const totalWithoutVat = roundCurrency(items.reduce((sum, item) => sum + lineOfferWithoutVat(item), 0));
  const reasons: Record<MarketPriceSkipReason, number> = {
    orientacni: 0,
    bez_zdroje: 0,
    zmeneny_kandidat: 0,
  };
  for (const item of skipped) reasons[item.duvod] += 1;

  return {
    upraveno: updated,
    preskoceno: skipped.length,
    duvody_preskoceni: reasons,
    preskocene_polozky: skipped,
    nova_celkova_cena_bez_dph: totalWithoutVat,
    nova_celkova_cena_s_dph: roundCurrency(totalWithoutVat * 1.21),
    zrusena_potvrzeni: invalidatedReviews,
  };
}
