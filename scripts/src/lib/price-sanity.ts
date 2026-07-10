import type { PolozkaMatch, PriceSanityFlag } from './types.js';

// Položka nad 40 % celkové nabídky vyžaduje kontrolu u nabídek s více než třemi položkami.
export const BID_SHARE_THRESHOLD = 0.40;

// Položka nad 10 % nabídky vyžaduje kontrolu, pokud má vybraný kandidát nízkou spolehlivost ceny.
export const LOW_CONFIDENCE_BIG_THRESHOLD = 0.10;

// Jednotková cena nad padesátinásobkem mediánu ostatních položek je podezřelá odchylka.
export const OUTLIER_VS_BATCH_MULTIPLIER = 50;

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

    if (polozkyMatch.length >= 8 && price.unitWithVat > 0) {
      const otherUnitPrices = normalized
        .filter((_, otherIndex) => otherIndex !== index)
        .map((other) => other.unitWithVat)
        .filter((unitPrice) => unitPrice > 0);
      const otherMedian = median(otherUnitPrices);
      if (otherMedian != null && otherMedian > 0 && price.unitWithVat > OUTLIER_VS_BATCH_MULTIPLIER * otherMedian) {
        addFinding({
          polozka_index: item.polozka_index,
          level: 'warn',
          code: 'outlier_vs_batch',
          message: `Jednotková cena ${formatPrice(price.unitWithVat)} Kč s DPH je více než ${OUTLIER_VS_BATCH_MULTIPLIER}× vyšší než medián ostatních položek (${formatPrice(otherMedian)} Kč).`,
        });
      }
    }
  }

  return findings;
}
