import type { OvereniCeny, PriceOverride, WebPriceSource } from '../types/tender';
import { calculateItemPrice, roundCurrency } from './price-calculator';
import { safeHttpUrl } from './url';

export interface WebPriceDraftInput {
  cena_bez_dph?: number | null;
  cena_s_dph?: number | null;
  url?: string | null;
  dodavatel?: string | null;
}

/** Legacy top-level ověření převede na stejný vstup jako nový řádkový zdroj. */
export function webPriceInputFromVerification(overeni: OvereniCeny): WebPriceDraftInput {
  return {
    cena_bez_dph: overeni.web_cena_bez_dph,
    cena_s_dph: overeni.web_cena_s_dph,
    url: overeni.zdroj_url,
    dodavatel: overeni.dodavatel,
  };
}

/** Cena s DPH pro zobrazení; chybějící hodnotu dopočítá standardní sazbou 21 %. */
export function webPriceGross(source: WebPriceDraftInput): number | undefined {
  if (source.cena_s_dph != null) return source.cena_s_dph;
  if (source.cena_bez_dph != null) return calculateItemPrice(source.cena_bez_dph, 0).nakupni_cena_s_dph;
  return undefined;
}

/**
 * Jednotný převod webového nálezu na cenový draft. Předaná marže se zachová;
 * volající tak může použít firemní default i právě rozepsanou marži operátora.
 */
export function buildDraftFromWeb(source: WebPriceDraftInput | WebPriceSource, marzeProcent: number): PriceOverride {
  const bezDph = source.cena_bez_dph
    ?? (source.cena_s_dph != null ? roundCurrency(source.cena_s_dph / 1.21) : 0);
  const sDph = source.cena_s_dph ?? calculateItemPrice(bezDph, 0).nakupni_cena_s_dph;
  const nabidka = calculateItemPrice(bezDph, marzeProcent);
  const safeUrl = safeHttpUrl(source.url);

  return {
    nakupni_cena_bez_dph: bezDph,
    nakupni_cena_s_dph: sDph,
    marze_procent: marzeProcent,
    nabidkova_cena_bez_dph: nabidka.nabidkova_cena_bez_dph,
    nabidkova_cena_s_dph: nabidka.nabidkova_cena_s_dph,
    potvrzeno: false,
    poznamka: safeUrl ? `Cena z webu: ${safeUrl}` : 'Cena z webu',
    ...(safeUrl ? {
      zdroj_nakupu: {
        url: safeUrl,
        dodavatel: source.dodavatel?.trim() || null,
      },
    } : {}),
  };
}

/** Zapíše řádkový draft do nové mapy, aby jej individuální i hromadné potvrzení četlo stejně. */
export function withPriceDraft(
  drafts: ReadonlyMap<number, PriceOverride>,
  itemIndex: number,
  draft: PriceOverride,
): Map<number, PriceOverride> {
  return new Map(drafts).set(itemIndex, draft);
}

/** Vytvoří jediný webový draft a stejnou instanci předá rodiči kalkulátoru. */
export function applyWebSource(
  source: WebPriceDraftInput | WebPriceSource,
  marzeProcent: number,
  onApplied?: (draft: PriceOverride) => void,
): PriceOverride {
  const draft = buildDraftFromWeb(source, marzeProcent);
  onApplied?.(draft);
  return draft;
}
