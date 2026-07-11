import type { PolozkaMatch, PriceSanityFlag } from './types.js';

// Položka nad 40 % celkové nabídky vyžaduje kontrolu u nabídek s více než třemi položkami.
export const BID_SHARE_THRESHOLD = 0.40;

// Položka nad 10 % nabídky vyžaduje kontrolu, pokud má vybraný kandidát nízkou spolehlivost ceny.
export const LOW_CONFIDENCE_BIG_THRESHOLD = 0.10;

// Jednotková cena nad padesátinásobkem mediánu ostatních položek je podezřelá odchylka.
export const OUTLIER_VS_BATCH_MULTIPLIER = 50;

// --- Tvrdý (HARD) extrémní outlier — nezávislý na cenovém stropu zakázky ---
// Motivace: položka BEZ per-item stropu (`cena_max_s_dph == null`) může projít deterministickým
// gatem, i když má nesmyslnou cenu (prod N-485400: halucinovaný „adaptér" za 280 000 Kč = 78 %
// celé nabídky). Overcap kontrola ji nechytí (žádný strop), bid_share/outlier jsou jen WARN.
// Proto tyto extrémy povyšujeme na HARD (blokuje potvrzení i podání).
//
// Ochrana proti false-HARD: pravidlo se aplikuje jen u nabídek s dostatkem položek
// (EXTREME_OUTLIER_MIN_ITEMS), aby legitimně drahá JEDNOTLIVÁ položka (single-item zakázka)
// neshodila gate.

// Položka bez stropu tvořící přes 60 % celé nabídky je extrémní dominance jedné ceny.
export const EXTREME_OUTLIER_BID_SHARE = 0.60;

// Položka bez stropu s jednotkovou cenou nad třicetinásobkem mediánu ostatních je extrémní odchylka.
export const EXTREME_OUTLIER_MEDIAN_MULTIPLIER = 30;

// Extrémní outlier povyšujeme na HARD jen od tohoto počtu položek v nabídce (jinak by
// legitimně drahá jediná položka spadla do bloku).
export const EXTREME_OUTLIER_MIN_ITEMS = 5;

export interface PriceSanityOptions {
  /** Omezí vrácené nálezy podle polozka_index; poměry se stále počítají z celého bidu. */
  polozkaIndexes?: readonly number[];
}

interface NormalizedPrice {
  unitWithoutVat: number;
  unitWithVat: number;
  purchaseWithoutVat: number;
  quantity: number;
  lineTotalWithVat: number;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSelectedCandidate(item: PolozkaMatch) {
  return item.kandidati?.[item.vybrany_index];
}

function normalizePrice(item: PolozkaMatch): NormalizedPrice {
  const selected = getSelectedCandidate(item);
  const override = item.cenova_uprava;
  const unitWithoutVat = override
    ? asFiniteNumber(override.nabidkova_cena_bez_dph)
    : asFiniteNumber(selected?.cena_bez_dph);
  const unitWithVat = override
    ? asFiniteNumber(override.nabidkova_cena_s_dph)
    : asFiniteNumber(selected?.cena_s_dph);
  const purchaseWithoutVat = override
    ? asFiniteNumber(override.nakupni_cena_bez_dph)
    : asFiniteNumber(selected?.cena_bez_dph);
  const quantity = item.mnozstvi == null ? 1 : asFiniteNumber(item.mnozstvi, 1);

  return {
    unitWithoutVat,
    unitWithVat,
    purchaseWithoutVat,
    quantity,
    lineTotalWithVat: unitWithVat * quantity,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function formatPrice(value: number): string {
  return value.toLocaleString('cs-CZ', { maximumFractionDigits: 2 });
}

function formatShare(value: number): string {
  return (value * 100).toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
}

/**
 * Deterministicky zkontroluje ceny všech položek bez zápisu nebo změny vstupních dat.
 */
export function checkPriceSanity(
  polozkyMatch: readonly PolozkaMatch[],
  options: PriceSanityOptions = {},
): PriceSanityFlag[] {
  const findings: PriceSanityFlag[] = [];
  const normalized = polozkyMatch.map(normalizePrice);
  const bidTotalWithVat = normalized.reduce((sum, price) => sum + price.lineTotalWithVat, 0);
  const includedIndexes = options.polozkaIndexes
    ? new Set(options.polozkaIndexes)
    : null;

  const addFinding = (finding: PriceSanityFlag) => {
    if (!includedIndexes || includedIndexes.has(finding.polozka_index)) findings.push(finding);
  };

  for (let index = 0; index < polozkyMatch.length; index++) {
    const item = polozkyMatch[index]!;
    const price = normalized[index]!;

    if (item.cena_max_s_dph != null && price.unitWithVat > item.cena_max_s_dph) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'hard',
        code: 'overcap',
        message: `Nabídková cena ${formatPrice(price.unitWithVat)} Kč s DPH za jednotku překračuje strop ${formatPrice(item.cena_max_s_dph)} Kč.`,
      });
    }

    if (price.unitWithVat <= 0) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'hard',
        code: 'zero_price',
        message: 'Položka nemá nabídkovou cenu vyšší než 0 Kč.',
      });
    }

    if (price.unitWithoutVat < price.purchaseWithoutVat) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'hard',
        code: 'below_cost',
        message: `Nabídková cena ${formatPrice(price.unitWithoutVat)} Kč bez DPH je nižší než nákupní cena ${formatPrice(price.purchaseWithoutVat)} Kč bez DPH.`,
      });
    }

    const realMarketPrice = item.overeni_ceny?.realita?.nejlevnejsi_bez_dph;
    if (
      item.overeni_ceny?.realita?.pod_trhem === true
      && typeof realMarketPrice === 'number'
      && Number.isFinite(realMarketPrice)
      && realMarketPrice > 0
      && price.unitWithoutVat < realMarketPrice
    ) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'warn',
        code: 'ai_cena_pod_trhem',
        message: `Nabídková cena ${formatPrice(price.unitWithoutVat)} Kč je pod reálnou nákupní cenou ${formatPrice(realMarketPrice)} Kč (zdroj: ${item.overeni_ceny.dodavatel ?? 'neznámý dodavatel'}) — nabídka by byla ztrátová.`,
      });
    }

    const share = bidTotalWithVat > 0 ? price.lineTotalWithVat / bidTotalWithVat : 0;
    if (polozkyMatch.length > 3 && share > BID_SHARE_THRESHOLD) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'warn',
        code: 'bid_share',
        message: `Položka tvoří ${formatShare(share)} % celkové ceny nabídky (kontrolní hranice je 40 %).`,
      });
    }

    const selected = getSelectedCandidate(item);
    if (selected?.cena_spolehlivost === 'nizka' && share > LOW_CONFIDENCE_BIG_THRESHOLD) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'warn',
        code: 'low_confidence_big',
        message: `Položka tvoří ${formatShare(share)} % nabídky a cena vybraného kandidáta má nízkou spolehlivost.`,
      });
    }

    // Odchylka jednotkové ceny vůči zbytku dávky. Medián ostatních položek spočítáme jednou
    // a využijeme pro WARN (outlier_vs_batch) i HARD (extreme_outlier bez stropu).
    if (polozkyMatch.length >= EXTREME_OUTLIER_MIN_ITEMS && price.unitWithVat > 0) {
      const otherUnitPrices = normalized
        .filter((_, otherIndex) => otherIndex !== index)
        .map((other) => other.unitWithVat)
        .filter((unitPrice) => unitPrice > 0);
      const otherMedian = median(otherUnitPrices);

      if (
        polozkyMatch.length >= 8 &&
        otherMedian != null && otherMedian > 0 &&
        price.unitWithVat > OUTLIER_VS_BATCH_MULTIPLIER * otherMedian
      ) {
        addFinding({
          polozka_index: item.polozka_index,
          level: 'warn',
          code: 'outlier_vs_batch',
          message: `Jednotková cena ${formatPrice(price.unitWithVat)} Kč s DPH je více než ${OUTLIER_VS_BATCH_MULTIPLIER}× vyšší než medián ostatních položek (${formatPrice(otherMedian)} Kč).`,
        });
      }

      // HARD extrémní outlier — jen u položky BEZ per-item stropu (se stropem řeší overcap výše).
      // Blokuje potvrzení i podání POUZE když cena SOUČASNĚ dominuje nabídce A extrémně vybočuje
      // z mediánu (AND, ne OR). Tím se chytí „otrávená" cena (280k adaptér mezi 57 položkami =
      // 78 % bidu A 280× medián), ale NEblokuje se legitimní jedna drahá položka (např. server
      // 150k mezi levným spotřebičem — vysoký násobek mediánu, ale malý podíl na bidu).
      if (item.cena_max_s_dph == null) {
        const dominatesBid = share > EXTREME_OUTLIER_BID_SHARE;
        const farOverMedian =
          otherMedian != null && otherMedian > 0 &&
          price.unitWithVat > EXTREME_OUTLIER_MEDIAN_MULTIPLIER * otherMedian;
        if (dominatesBid && farOverMedian) {
          addFinding({
            polozka_index: item.polozka_index,
            level: 'hard',
            code: 'extreme_outlier',
            message: `Položka bez cenového stropu má extrémní cenu ${formatPrice(price.unitWithVat)} Kč s DPH za jednotku — tvoří ${formatShare(share)} % celé nabídky a zároveň je více než ${EXTREME_OUTLIER_MEDIAN_MULTIPLIER}× vyšší než medián ostatních položek (${formatPrice(otherMedian!)} Kč). Ověřte cenu a produkt před podáním.`,
          });
        }
      }
    }
  }

  return findings;
}
