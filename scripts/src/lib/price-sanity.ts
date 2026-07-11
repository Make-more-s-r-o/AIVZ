import type { PolozkaMatch, PriceSanityFlag, ProductMatch } from './types.js';
import { compareAiVsMarket, informationalCostForQuantity } from './price-reality.js';

// Položka nad 40 % celkové nabídky vyžaduje kontrolu u nabídek s více než třemi položkami.
export const BID_SHARE_THRESHOLD = 0.40;

// Položka nad 10 % nabídky vyžaduje kontrolu, pokud má vybraný kandidát nízkou spolehlivost ceny.
export const LOW_CONFIDENCE_BIG_THRESHOLD = 0.10;

// Orientační nákup nad nabídkou varuje až od 20% rozdílu; nikdy nejde o HARD gate.
export const ORIENTATIONAL_PRICE_WARN_RATIO = 1.20;

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

/**
 * Přepočítá a uloží aktuální cenové nálezy do všech položek product-match objektu.
 * Legacy single-product formát vrací nálezy volajícímu, ale nemá kam `sanity_flags`
 * perzistovat bez změny historického schématu.
 */
export function refreshProductMatchPriceSanity(productMatch: ProductMatch): PriceSanityFlag[] {
  const items: PolozkaMatch[] = Array.isArray(productMatch.polozky_match)
    ? productMatch.polozky_match
    : Array.isArray(productMatch.kandidati)
      ? [{
          polozka_nazev: 'Položka',
          polozka_index: -1,
          mnozstvi: 1,
          typ: 'produkt',
          kandidati: productMatch.kandidati,
          vybrany_index: productMatch.vybrany_index ?? 0,
          oduvodneni_vyberu: productMatch.oduvodneni_vyberu ?? '',
          cenova_uprava: productMatch.cenova_uprava,
          overeni_ceny: productMatch.overeni_ceny,
        }]
      : [];
  const findings = checkPriceSanity(items, {});
  if (Array.isArray(productMatch.polozky_match)) {
    for (const item of productMatch.polozky_match) {
      item.sanity_flags = findings.filter((finding) => finding.polozka_index === item.polozka_index);
    }
  }
  return findings;
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

/** Platná auditovaná výjimka dovolí vědomě potvrdit prodej pod nákupem. */
export function hasAuditedLossOverride(item: PolozkaMatch): boolean {
  const override = item.cenova_uprava?.override_pod_nakupem;
  return override?.potvrzeno === true && override.duvod.trim().length >= 10;
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

    const auditedLossOverride = hasAuditedLossOverride(item);
    if (price.unitWithoutVat < price.purchaseWithoutVat && !auditedLossOverride) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'hard',
        code: 'below_cost',
        message: `Nabídková cena ${formatPrice(price.unitWithoutVat)} Kč bez DPH je nižší než nákupní cena ${formatPrice(price.purchaseWithoutVat)} Kč bez DPH.`,
      });
    }

    const currentReality = compareAiVsMarket(
      null,
      item.overeni_ceny?.zdroje ?? [],
      price.quantity,
    );
    const realMarketPrice = currentReality.nejlevnejsi_bez_dph;
    if (
      typeof realMarketPrice === 'number'
      && Number.isFinite(realMarketPrice)
      && realMarketPrice > 0
      && price.unitWithoutVat < realMarketPrice
      && !auditedLossOverride
    ) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'hard',
        code: 'cena_pod_nakupem',
        message: `Nabídková cena ${formatPrice(price.unitWithoutVat)} Kč bez DPH je nižší než reálný jednotkový nákupní náklad ${formatPrice(realMarketPrice)} Kč pro množství ${formatPrice(price.quantity)} (zdroj: ${currentReality.nejlevnejsi_dodavatel ?? currentReality.nejlevnejsi_zdroj_url ?? 'neznámý dodavatel'}). Bez auditované výjimky nelze cenu potvrdit ani nabídku podat.`,
      });
    }

    const orientationalUnitPrices = (item.overeni_ceny?.zdroje ?? [])
      .filter((source) => source.orientacni === true)
      .map((source) => informationalCostForQuantity(source, price.quantity))
      .filter((cost): cost is number => cost !== null)
      .map((cost) => cost / price.quantity);
    const cheapestOrientational = orientationalUnitPrices.length > 0
      ? Math.min(...orientationalUnitPrices)
      : null;
    if (
      cheapestOrientational !== null
      && price.unitWithoutVat > 0
      && cheapestOrientational >= price.unitWithoutVat * ORIENTATIONAL_PRICE_WARN_RATIO
    ) {
      addFinding({
        polozka_index: item.polozka_index,
        level: 'warn',
        code: 'orientacni_cena_nad_nabidkou',
        message: `Orientační nákupní cena ${formatPrice(cheapestOrientational)} Kč bez DPH je výrazně nad nabídkovou cenou ${formatPrice(price.unitWithoutVat)} Kč. Parametry produktu nejsou doložené; zdroj ručně ověřte.`,
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
