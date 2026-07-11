import type { CompanyData } from './company-store.js';
import type { PriceBand } from './winprice-query.js';
import { candidateHasRealProduct } from './price-prefill.js';
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

export const MISSING_BUDGET_REASON = 'Zadavatel neuvedl předpokládanou hodnotu — rozpočtový faktor nezapočítán';

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

  const duvody = factors.map((factor) => factor.reason);
  if (!isPositiveNumber(analysis.zakazka.predpokladana_hodnota)) {
    duvody.unshift(MISSING_BUDGET_REASON);
  }

  // Bez jediného dostupného signálu vracíme neutrální výsledek, ne falešnou jistotu.
  if (factors.length === 0) {
    return {
      score: 50,
      doporuceni: 'ZVAZIT',
      duvody,
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

  return { score, doporuceni, duvody };
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

// ===========================================================================
// PROFIT-AWARE BID SCORE
//
// Zatímco `scoreGoNoGo` (výše) je VSTUPNÍ skóre počítané PŘED nacenením (jen
// z analýzy ZD + volitelně win-price), `scoreBid` je DRUHÉ skóre počítané PO
// nacenění z reálných dat product-match.json: hrubý zisk v Kč, obchodní přirážka,
// kvalita cenových shod, HARD sanity flagy a pozice naší celkové ceny vůči
// historickému cenovému pásmu výher. Nemění ceny ani stav — je čistě
// informativní stejně jako go/no-go.
// ===========================================================================

export const BID_MARGIN_WEIGHT = 30;
export const BID_ABS_PROFIT_WEIGHT = 20;
export const BID_MATCH_QUALITY_WEIGHT = 25;
export const BID_WIN_PRICE_WEIGHT = 25;

// Cílový absolutní hrubý zisk, při kterém je faktor plně nasycen (value = 1).
export const BID_TARGET_PROFIT_CZK = 50_000;
// Výchozí cílová přirážka, pokud firma žádnou nemá (historický název pole je marze_procent).
export const DEFAULT_TARGET_MARGIN_PROCENT = 10;
// Nepotvrzená cena je jen odhad — do váženého zisku vstupuje s poloviční vahou.
export const UNCONFIRMED_PRICE_WEIGHT = 0.5;

export interface BidEconomics {
  zisk_kc: number;          // nominální hrubý zisk (potvrzené i nepotvrzené) v Kč, bez DPH
  marze_procent: number;    // obchodní přirážka % = zisk / náklady bez DPH (historický název pole)
  obrat_bez_dph: number;    // Σ nabídkových cen bez DPH × množství
  naklady_bez_dph: number;  // Σ nákupních cen bez DPH × množství
  vazeny_zisk: number;      // hrubý zisk vážený spolehlivostí (nepotvrzené × 0,5)
  polozek: number;
  slabych_polozek: number;  // bez reálné shody / nízká spolehlivost / bez ceny
  hard_flagu: number;
}

export interface BidScoreResult {
  score: number;
  doporuceni: 'GO' | 'ZVAZIT' | 'NOGO';
  duvody: string[];
  zisk_kc: number;
  marze_procent: number;
}

// Minimální strukturální tvar položky — sjednocuje multi-product i legacy single-product.
interface BidLineItem {
  mnozstvi?: number | null;
  vybrany_index?: number;
  kandidati?: Array<{
    vyrobce?: string;
    model?: string;
    popis?: string;
    cena_bez_dph?: number;
    cena_spolehlivost?: string;
    zadna_shoda?: boolean;
  }>;
  cenova_uprava?: {
    nakupni_cena_bez_dph?: number;
    nabidkova_cena_bez_dph?: number;
    potvrzeno?: boolean;
  };
  sanity_flags?: Array<{ level?: string }>;
}

function normalizeBidItems(productMatch?: ProductMatch): BidLineItem[] {
  if (!productMatch) return [];
  if (productMatch.polozky_match?.length) return productMatch.polozky_match as BidLineItem[];
  // Legacy single-product tvar: kandidati + cenova_uprava na kořeni objektu.
  if (productMatch.kandidati?.length) {
    return [{
      mnozstvi: 1,
      vybrany_index: productMatch.vybrany_index ?? 0,
      kandidati: productMatch.kandidati,
      cenova_uprava: productMatch.cenova_uprava,
      sanity_flags: [],
    }];
  }
  return [];
}

/**
 * Spočítá reálnou ekonomiku nabídky z product-match.json. Náklad známe jen z
 * `cenova_uprava` (kupní cena), takže do obratu i zisku vstupuje jen položka
 * s vyplněnou nabídkovou cenou v úpravě. Nikdy nevyhazuje — vadná data → nuly.
 */
export function computeBidEconomics(productMatch?: ProductMatch): BidEconomics {
  const items = normalizeBidItems(productMatch);
  let obrat = 0;
  let naklady = 0;
  let vazenyZisk = 0;
  let slabych = 0;
  let hardFlagu = 0;

  for (const item of items) {
    const mnozstvi = isPositiveNumber(item.mnozstvi) ? item.mnozstvi : 1;
    const candidate = item.kandidati?.[item.vybrany_index ?? -1];
    hardFlagu += item.sanity_flags?.filter((f) => f?.level === 'hard').length ?? 0;

    const uprava = item.cenova_uprava;
    const nabidkova = isPositiveNumber(uprava?.nabidkova_cena_bez_dph)
      ? uprava!.nabidkova_cena_bez_dph!
      : (isPositiveNumber(candidate?.cena_bez_dph) ? candidate!.cena_bez_dph! : null);

    // Slabá položka = bez reálné shody, nízká spolehlivost, nebo bez použitelné ceny.
    const weak = !candidate
      || candidate.zadna_shoda === true
      || !candidateHasRealProduct(candidate)
      || candidate.cena_spolehlivost === 'nizka'
      || nabidkova == null;
    if (weak) slabych++;

    // Ekonomiku počítáme jen z cenové úpravy (jediný zdroj kupní ceny).
    if (uprava && isPositiveNumber(uprava.nabidkova_cena_bez_dph)) {
      const nakupni = isPositiveNumber(uprava.nakupni_cena_bez_dph) ? uprava.nakupni_cena_bez_dph : 0;
      const nab = uprava.nabidkova_cena_bez_dph;
      const potvrzeno = uprava.potvrzeno === true;
      obrat += nab * mnozstvi;
      naklady += nakupni * mnozstvi;
      vazenyZisk += (nab - nakupni) * mnozstvi * (potvrzeno ? 1 : UNCONFIRMED_PRICE_WEIGHT);
    }
  }

  const zisk = obrat - naklady;
  // Firemní cíl i calculateItemPrice používají markup: zisk / nákupní náklady.
  const marze = naklady > 0 ? (zisk / naklady) * 100 : 0;
  return {
    zisk_kc: Math.round(zisk),
    marze_procent: Math.round(marze * 10) / 10,
    obrat_bez_dph: Math.round(obrat),
    naklady_bez_dph: Math.round(naklady),
    vazeny_zisk: vazenyZisk,
    polozek: items.length,
    slabych_polozek: slabych,
    hard_flagu: hardFlagu,
  };
}

/**
 * Profit-aware bid skóre počítané PO nacenění. Vstupem je product-match (reálné
 * kupní/nabídkové ceny), firemní cílová přirážka a volitelné historické cenové pásmo.
 */
export function scoreBid(
  analysis: TenderAnalysis,
  productMatch?: ProductMatch,
  company?: Pick<CompanyData, 'default_marze_procent'> | null,
  winBand?: PriceBand,
): BidScoreResult {
  const econ = computeBidEconomics(productMatch);

  // Bez naceněných položek nemá bid skóre z čeho počítat — neutrální výsledek.
  if (econ.polozek === 0) {
    return {
      score: 50,
      doporuceni: 'ZVAZIT',
      duvody: ['Bid skóre zatím nelze spočítat — chybí nacenění položek.'],
      zisk_kc: 0,
      marze_procent: 0,
    };
  }

  const factors: Factor[] = [];

  // (b) Obchodní přirážka (zisk/náklady) vs firemní cíl.
  const target = isPositiveNumber(company?.default_marze_procent)
    ? company!.default_marze_procent!
    : DEFAULT_TARGET_MARGIN_PROCENT;
  const marginValue = econ.marze_procent <= 0 ? 0 : clamp(econ.marze_procent / target, 0, 1);
  factors.push({
    value: marginValue,
    weight: BID_MARGIN_WEIGHT,
    reason: econ.marze_procent <= 0
      ? 'Nabídka nemá kladnou přirážku — hrozí ztrátová zakázka.'
      : `Obchodní přirážka ${econ.marze_procent.toFixed(1)} % z nákladů (cíl ${target} %).`,
  });

  // (a) Absolutní hrubý zisk, vážený spolehlivostí cen (nepotvrzené s poloviční vahou).
  const profitValue = econ.vazeny_zisk <= 0 ? 0 : clamp(econ.vazeny_zisk / BID_TARGET_PROFIT_CZK, 0, 1);
  factors.push({
    value: profitValue,
    weight: BID_ABS_PROFIT_WEIGHT,
    reason: `Očekávaný hrubý zisk ${formatCzk(econ.zisk_kc)} (spolehlivostí vážený ${formatCzk(Math.round(econ.vazeny_zisk))}).`,
  });

  // (c) Podíl položek s reálnou shodou a solidní spolehlivostí.
  const goodItems = econ.polozek - econ.slabych_polozek;
  factors.push({
    value: goodItems / econ.polozek,
    weight: BID_MATCH_QUALITY_WEIGHT,
    reason: `${goodItems} z ${econ.polozek} položek má spolehlivou reálnou shodu.`,
  });

  // (e) Win-price: naše celková cena vs historické pásmo výher.
  const winFactor = scoreBidWinPrice(econ.obrat_bez_dph, winBand);
  if (winFactor) factors.push(winFactor);

  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const weightedScore = factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0);
  let score = clamp(Math.round((weightedScore / totalWeight) * 100), 0, 100);

  const duvody = factors.map((factor) => factor.reason);

  // (d) HARD sanity flag = automatická srážka a NOGO strop — cena není důvěryhodná.
  if (econ.hard_flagu > 0) {
    duvody.unshift(`${econ.hard_flagu}× HARD cenový flag — nabídka není důvěryhodná bez ruční opravy.`);
    score = Math.min(score, CONSIDER_SCORE_THRESHOLD - 1);
  }

  // (f) Pokrytí kvalifikace zatím do bid skóre nezapočítáno (viz handoff/decisions).

  const doporuceni = econ.hard_flagu > 0
    ? 'NOGO'
    : score >= GO_SCORE_THRESHOLD
      ? 'GO'
      : score >= CONSIDER_SCORE_THRESHOLD
        ? 'ZVAZIT'
        : 'NOGO';

  return { score, doporuceni, duvody, zisk_kc: econ.zisk_kc, marze_procent: econ.marze_procent };
}

function scoreBidWinPrice(ourTotal: number, winBand?: PriceBand): Factor | null {
  if (!winBand || winBand.pocet <= 0 || !isPositiveNumber(ourTotal) || !isPositiveNumber(winBand.median)) {
    return null;
  }
  if (isPositiveNumber(winBand.p75) && ourTotal > winBand.p75) {
    return {
      value: 0.2,
      weight: BID_WIN_PRICE_WEIGHT,
      reason: `Naše cena ${formatCzk(ourTotal)} je nad P75 historických výher — nízká šance uspět.`,
    };
  }
  if (ourTotal <= winBand.median) {
    return {
      value: 1,
      weight: BID_WIN_PRICE_WEIGHT,
      reason: `Naše cena ${formatCzk(ourTotal)} je pod mediánem výher — dobrá cenová pozice.`,
    };
  }
  return {
    value: 0.6,
    weight: BID_WIN_PRICE_WEIGHT,
    reason: `Naše cena ${formatCzk(ourTotal)} je mezi mediánem a P75 výher.`,
  };
}

function formatCzk(value: number): string {
  return `${Math.round(value).toLocaleString('cs-CZ')} Kč`;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
