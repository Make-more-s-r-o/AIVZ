import type { CompanyData } from './company-store.js';
import type { PriceBand } from './winprice-query.js';
import type { ExtractedText, ProductMatch, TenderAnalysis } from './types.js';

export const GO_SCORE_THRESHOLD = 75;
export const CONSIDER_SCORE_THRESHOLD = 45;

// Firemní limit odpovídá horní hranici preferovaného pásma v existujícím monitorovacím filtru.
export const COMPANY_PRICE_CEILING_CZK = 10_000_000;

export const SECTOR_WEIGHT = 20;
export const BUDGET_WEIGHT = 20;
export const PRICED_ITEMS_WEIGHT = 25;
export const WIN_PRICE_WEIGHT = 20;
export const DEADLINE_WEIGHT = 15;

export const COMFORTABLE_DEADLINE_DAYS = 14;
export const TIGHT_DEADLINE_DAYS = 7;
export const CRITICAL_DEADLINE_DAYS = 3;

export const WIN_PRICE_CLOSE_RATIO = 0.15;
export const WIN_PRICE_ACCEPTABLE_RATIO = 0.35;
export const WIN_PRICE_FAR_RATIO = 0.60;
export const WIN_PRICE_FULL_SAMPLE = 10;

type AnalysisWithScoringContext = TenderAnalysis
  & Partial<Pick<ExtractedText, 'extractedAt'>>
  & Partial<Pick<CompanyData, 'obory' | 'keyword_filters'>>;

export interface GoNoGoResult {
  score: number;
  doporuceni: 'GO' | 'ZVAZIT' | 'NOGO';
  duvody: string[];
}

interface Factor {
  value: number;
  weight: number;
  reason: string;
}

/**
 * Čisté informativní skóre: pracuje jen s předanými daty a nemění ceny ani stav pipeline.
 * Volitelný kontext `extractedAt`, `obory` a `keyword_filters` používá reálná pole z extrakce
 * a firemního profilu; volající je může připojit k analýze bez jejich ukládání do analysis.json.
 */
export function scoreGoNoGo(
  analysis: AnalysisWithScoringContext,
  productMatch?: ProductMatch,
  winBand?: PriceBand,
): GoNoGoResult {
  const factors: Factor[] = [];

  const sectorFactor = scoreSectorMatch(analysis);
  if (sectorFactor) factors.push(sectorFactor);

  const budgetFactor = scoreBudget(analysis.zakazka.predpokladana_hodnota);
  if (budgetFactor) factors.push(budgetFactor);

  const pricedFactor = scorePricedItems(productMatch);
  if (pricedFactor) factors.push(pricedFactor);

  const winPriceFactor = scoreWinPrice(analysis, productMatch, winBand);
  if (winPriceFactor) factors.push(winPriceFactor);

  const deadlineFactor = scoreDeadline(analysis.terminy.lhuta_nabidek, analysis.extractedAt);
  if (deadlineFactor) factors.push(deadlineFactor);

  // Bez jediného dostupného signálu vracíme neutrální výsledek, ne falešnou jistotu.
  if (factors.length === 0) {
    return {
      score: 50,
      doporuceni: 'ZVAZIT',
      duvody: ['Pro spolehlivější skóre zatím chybí hodnotitelné podklady.'],
    };
  }

  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const weightedScore = factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0);
  const score = clamp(Math.round((weightedScore / totalWeight) * 100), 0, 100);
  const doporuceni = score >= GO_SCORE_THRESHOLD
    ? 'GO'
    : score >= CONSIDER_SCORE_THRESHOLD
      ? 'ZVAZIT'
      : 'NOGO';

  return { score, doporuceni, duvody: factors.map((factor) => factor.reason) };
}

function scoreSectorMatch(analysis: AnalysisWithScoringContext): Factor | null {
  const companySectors = analysis.obory?.map(normalize).filter(Boolean) ?? [];
  const filters = analysis.keyword_filters;
  if (companySectors.length === 0 || !filters || Object.keys(filters).length === 0) return null;

  const tenderText = normalize([
    analysis.zakazka.predmet,
    analysis.zakazka.typ_zakazky,
    ...analysis.polozky.map((item) => `${item.nazev} ${item.specifikace}`),
  ].join(' '));
  const matchingSectors = Object.entries(filters)
    .filter(([, keywords]) => keywords.some((keyword) => tenderText.includes(normalize(keyword))))
    .map(([sector]) => normalize(sector));

  if (matchingSectors.some((sector) => companySectors.includes(sector))) {
    return { value: 1, weight: SECTOR_WEIGHT, reason: 'Předmět zakázky odpovídá oborům firmy.' };
  }
  if (matchingSectors.length > 0) {
    return { value: 0, weight: SECTOR_WEIGHT, reason: 'Předmět zakázky je mimo uvedené obory firmy.' };
  }
  return { value: 0.5, weight: SECTOR_WEIGHT, reason: 'Sektor zakázky nelze z dostupných údajů určit jednoznačně.' };
}

function scoreBudget(expectedValue: number | null | undefined): Factor | null {
  if (!isPositiveNumber(expectedValue)) return null;
  const ratio = expectedValue / COMPANY_PRICE_CEILING_CZK;
  if (ratio <= 0.8) {
    return { value: 1, weight: BUDGET_WEIGHT, reason: 'Předpokládaná hodnota je bezpečně pod firemním cenovým limitem.' };
  }
  if (ratio <= 1) {
    return { value: 0.8, weight: BUDGET_WEIGHT, reason: 'Předpokládaná hodnota se blíží firemnímu cenovému limitu.' };
  }
  if (ratio <= 1.25) {
    return { value: 0.4, weight: BUDGET_WEIGHT, reason: 'Předpokládaná hodnota mírně překračuje firemní cenový limit.' };
  }
  return { value: 0, weight: BUDGET_WEIGHT, reason: 'Předpokládaná hodnota výrazně překračuje firemní cenový limit.' };
}

function scorePricedItems(productMatch?: ProductMatch): Factor | null {
  if (!productMatch) return null;

  const items = productMatch.polozky_match;
  if (items && items.length > 0) {
    const successful = items.filter((item) => {
      const candidate = item.kandidati[item.vybrany_index];
      const price = item.cenova_uprava?.nabidkova_cena_s_dph ?? candidate?.cena_s_dph;
      const hasHardFinding = item.sanity_flags?.some((finding) => finding.level === 'hard') ?? false;
      return isPositiveNumber(price)
        && !hasHardFinding
        && (item.cena_max_s_dph == null || price <= item.cena_max_s_dph);
    }).length;
    const ratio = successful / items.length;
    return {
      value: ratio,
      weight: PRICED_ITEMS_WEIGHT,
      reason: `${successful} z ${items.length} položek je úspěšně naceněno v mezích.`,
    };
  }

  if (productMatch.kandidati?.length) {
    const candidate = productMatch.kandidati[productMatch.vybrany_index ?? -1];
    const price = productMatch.cenova_uprava?.nabidkova_cena_s_dph ?? candidate?.cena_s_dph;
    const successful = isPositiveNumber(price);
    return {
      value: successful ? 1 : 0,
      weight: PRICED_ITEMS_WEIGHT,
      reason: successful ? 'Zakázka má použitelnou vybranou cenu.' : 'Zakázka nemá použitelnou vybranou cenu.',
    };
  }

  return null;
}

function scoreWinPrice(
  analysis: TenderAnalysis,
  productMatch?: ProductMatch,
  winBand?: PriceBand,
): Factor | null {
  if (!winBand || winBand.pocet <= 0 || !isPositiveNumber(winBand.median)) return null;
  const comparedPrice = totalMatchedPrice(productMatch) ?? analysis.zakazka.predpokladana_hodnota;
  if (!isPositiveNumber(comparedPrice)) return null;

  const deviation = Math.abs(comparedPrice - winBand.median) / winBand.median;
  const proximity = deviation <= WIN_PRICE_CLOSE_RATIO
    ? 1
    : deviation <= WIN_PRICE_ACCEPTABLE_RATIO
      ? 0.7
      : deviation <= WIN_PRICE_FAR_RATIO
        ? 0.4
        : 0.1;
  const sampleAvailability = Math.min(winBand.pocet / WIN_PRICE_FULL_SAMPLE, 1);
  const value = proximity * 0.7 + sampleAvailability * 0.3;
  const percent = Math.round(deviation * 100);

  return {
    value,
    weight: WIN_PRICE_WEIGHT,
    reason: `Cena je ${percent} % od mediánu ${winBand.pocet} historických výher.`,
  };
}

function scoreDeadline(deadline: string | null | undefined, extractedAt: string | undefined): Factor | null {
  if (!deadline || !extractedAt) return null;
  const deadlineMs = Date.parse(deadline);
  const referenceMs = Date.parse(extractedAt);
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(referenceMs)) return null;

  const days = Math.ceil((deadlineMs - referenceMs) / 86_400_000);
  if (days > COMFORTABLE_DEADLINE_DAYS) {
    return { value: 1, weight: DEADLINE_WEIGHT, reason: `Na přípravu zbývá ${days} dní.` };
  }
  if (days > TIGHT_DEADLINE_DAYS) {
    return { value: 0.75, weight: DEADLINE_WEIGHT, reason: `Na přípravu zbývá ${days} dní; termín se blíží.` };
  }
  if (days >= CRITICAL_DEADLINE_DAYS) {
    return { value: 0.45, weight: DEADLINE_WEIGHT, reason: `Na přípravu zbývá jen ${days} dní.` };
  }
  if (days >= 0) {
    return { value: 0.15, weight: DEADLINE_WEIGHT, reason: `Lhůta končí za ${days} dní; příprava je kritická.` };
  }
  return { value: 0, weight: DEADLINE_WEIGHT, reason: 'Lhůta pro podání už uplynula.' };
}

function totalMatchedPrice(productMatch?: ProductMatch): number | null {
  if (!productMatch?.polozky_match?.length) return null;
  let total = 0;
  for (const item of productMatch.polozky_match) {
    const candidate = item.kandidati[item.vybrany_index];
    const unitPrice = item.cenova_uprava?.nabidkova_cena_bez_dph ?? candidate?.cena_bez_dph;
    if (!isPositiveNumber(unitPrice)) return null;
    total += unitPrice * (item.mnozstvi ?? 1);
  }
  return total > 0 ? total : null;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
