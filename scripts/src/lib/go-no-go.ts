import type { CompanyData } from './company-store.js';
import type { PriceBand } from './winprice-query.js';
import { candidateHasRealProduct } from './price-prefill.js';
import { checkPriceSanity } from './price-sanity.js';
import type { ExtractedText, ProductMatch, TenderAnalysis } from './types.js';
import {
  DEFAULT_GO_NO_GO_WEIGHTS,
  GO_NO_GO_WEIGHTS,
  type GoNoGoWeightName,
  type GoNoGoWeights,
} from './go-no-go-config.js';

export const GO_SCORE_THRESHOLD = 75;
export const CONSIDER_SCORE_THRESHOLD = 45;

// Firemní limit odpovídá horní hranici preferovaného pásma v existujícím monitorovacím filtru.
export const COMPANY_PRICE_CEILING_CZK = 10_000_000;

// Zachované exporty kvůli kompatibilitě; aktivní váhy načítá GO_NO_GO_WEIGHTS z configu.
export const SECTOR_WEIGHT = DEFAULT_GO_NO_GO_WEIGHTS.sector;
export const BUDGET_WEIGHT = DEFAULT_GO_NO_GO_WEIGHTS.budget;
export const PRICED_ITEMS_WEIGHT = DEFAULT_GO_NO_GO_WEIGHTS.priced_items;
export const WIN_PRICE_WEIGHT = DEFAULT_GO_NO_GO_WEIGHTS.win_price;
export const DEADLINE_WEIGHT = DEFAULT_GO_NO_GO_WEIGHTS.deadline;

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

export const GO_NO_GO_FACTOR_NAMES = ['sector', 'budget', 'priced_items', 'win_price', 'deadline'] as const;
export const BID_FACTOR_NAMES = [
  'margin', 'absolute_profit', 'match_quality', 'win_price',
  'below_market_penalty', 'nonexistent_candidate_penalty', 'hard_flags_cap',
] as const;

export interface ScoreFeature {
  nazev: string;
  surova_hodnota: unknown;
  normalizovana_hodnota: number | null;
  vaha: number;
  prispevek: number;
  duvod: string | null;
}

export interface ScoreFeatureVector {
  typ: 'gonogo' | 'bid';
  faktory: ScoreFeature[];
  skore: number;
  doporuceni: 'GO' | 'ZVAZIT' | 'NOGO';
}

interface FactorObservation {
  name: string;
  raw: unknown;
  factor: Factor | null;
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
  weights: GoNoGoWeights = GO_NO_GO_WEIGHTS,
): GoNoGoResult {
  const factors = collectGoNoGoFactors(analysis, productMatch, winBand, weights)
    .flatMap((observation) => observation.factor ? [observation.factor] : []);

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

/**
 * Serializuje všechny vstupy go/no-go skóre, včetně právě nedostupných faktorů.
 * Funkce je čistá a používá stejné faktorové funkce jako samotný výpočet skóre.
 */
export function serializeGoNoGoFeatureVector(
  analysis: AnalysisWithScoringContext,
  productMatch?: ProductMatch,
  winBand?: PriceBand,
  weights: GoNoGoWeights = GO_NO_GO_WEIGHTS,
): ScoreFeatureVector {
  const result = scoreGoNoGo(analysis, productMatch, winBand, weights);
  const observations = collectGoNoGoFactors(analysis, productMatch, winBand, weights);
  return {
    typ: 'gonogo',
    faktory: weightedFeatures(observations, weights),
    skore: result.score,
    doporuceni: result.doporuceni,
  };
}

function collectGoNoGoFactors(
  analysis: AnalysisWithScoringContext,
  productMatch?: ProductMatch,
  winBand?: PriceBand,
  weights: GoNoGoWeights = GO_NO_GO_WEIGHTS,
): FactorObservation[] {
  const comparedPrice = totalMatchedPrice(productMatch) ?? analysis.zakazka.predpokladana_hodnota;
  const pricedItems = productMatch?.polozky_match ?? [];
  const successfulPricedItems = pricedItems.filter((item) => {
    const candidate = item.kandidati[item.vybrany_index];
    const price = item.cenova_uprava?.nabidkova_cena_s_dph ?? candidate?.cena_s_dph;
    const hard = item.sanity_flags?.some((finding) => finding.level === 'hard') ?? false;
    return isPositiveNumber(price) && !hard && (item.cena_max_s_dph == null || price <= item.cena_max_s_dph);
  }).length;
  const deadlineMs = Date.parse(analysis.terminy.lhuta_nabidek ?? '');
  const extractedMs = Date.parse(analysis.extractedAt ?? '');
  const deadlineDays = Number.isFinite(deadlineMs) && Number.isFinite(extractedMs)
    ? Math.ceil((deadlineMs - extractedMs) / 86_400_000)
    : null;

  return [
    {
      name: GO_NO_GO_FACTOR_NAMES[0],
      raw: { obory: analysis.obory ?? null, keyword_filters: analysis.keyword_filters ?? null, predmet: analysis.zakazka.predmet },
      factor: scoreSectorMatch(analysis),
    },
    {
      name: GO_NO_GO_FACTOR_NAMES[1],
      raw: { predpokladana_hodnota: analysis.zakazka.predpokladana_hodnota ?? null, firemni_limit: COMPANY_PRICE_CEILING_CZK },
      factor: scoreBudget(analysis.zakazka.predpokladana_hodnota),
    },
    {
      name: GO_NO_GO_FACTOR_NAMES[2],
      raw: productMatch?.polozky_match?.length
        ? { polozek_celkem: pricedItems.length, polozek_uspesne: successfulPricedItems }
        : { legacy_kandidatu: productMatch?.kandidati?.length ?? 0, vybrany_index: productMatch?.vybrany_index ?? null },
      factor: scorePricedItems(productMatch),
    },
    {
      name: GO_NO_GO_FACTOR_NAMES[3],
      raw: { porovnavana_cena: comparedPrice ?? null, median: winBand?.median ?? null, pocet: winBand?.pocet ?? null },
      factor: scoreWinPrice(analysis, productMatch, winBand),
    },
    {
      name: GO_NO_GO_FACTOR_NAMES[4],
      raw: { lhuta_nabidek: analysis.terminy.lhuta_nabidek ?? null, extracted_at: analysis.extractedAt ?? null, zbyva_dni: deadlineDays },
      factor: scoreDeadline(analysis.terminy.lhuta_nabidek, analysis.extractedAt),
    },
  ].map((observation) => ({
    ...observation,
    factor: observation.factor
      ? { ...observation.factor, weight: weights[observation.name as GoNoGoWeightName] }
      : null,
  }));
}

function weightedFeatures(
  observations: FactorObservation[],
  goNoGoWeights: GoNoGoWeights = GO_NO_GO_WEIGHTS,
): ScoreFeature[] {
  const totalWeight = observations.reduce((sum, observation) => sum + (observation.factor?.weight ?? 0), 0);
  return observations.map(({ name, raw, factor }) => ({
    nazev: name,
    surova_hodnota: raw,
    normalizovana_hodnota: factor?.value ?? null,
    vaha: factor?.weight ?? factorWeight(name, goNoGoWeights),
    prispevek: factor && totalWeight > 0 ? (factor.value * factor.weight / totalWeight) * 100 : 0,
    duvod: factor?.reason ?? null,
  }));
}

function factorWeight(name: string, goNoGoWeights: GoNoGoWeights): number {
  const weights: Record<string, number> = {
    ...goNoGoWeights,
    margin: BID_MARGIN_WEIGHT, absolute_profit: BID_ABS_PROFIT_WEIGHT,
    match_quality: BID_MATCH_QUALITY_WEIGHT,
  };
  return weights[name] ?? 0;
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
// WARN za prodej pod ověřenou nákupní cenou skóre viditelně sníží, ale sám nevynutí NOGO.
export const BID_BELOW_MARKET_PENALTY = 15;
// Každý AI kandidát doloženě vyvrácený fází 1 snižuje důvěru v kvalitu shod.
export const BID_NONEXISTENT_CANDIDATE_PENALTY = 5;

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
  ztratovych_polozek: number;
  neexistujicich_kandidatu: number;
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
  polozka_index?: number;
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
  sanity_flags?: Array<{ level?: string; code?: string }>;
  overeni_ceny?: { kandidat_neexistuje?: boolean };
}

function normalizeBidItems(productMatch?: ProductMatch): BidLineItem[] {
  if (!productMatch) return [];
  if (productMatch.polozky_match?.length) return productMatch.polozky_match as BidLineItem[];
  // Legacy single-product tvar: kandidati + cenova_uprava na kořeni objektu.
  if (productMatch.kandidati?.length) {
    return [{
      polozka_index: -1,
      mnozstvi: 1,
      vybrany_index: productMatch.vybrany_index ?? 0,
      kandidati: productMatch.kandidati,
      cenova_uprava: productMatch.cenova_uprava,
      sanity_flags: [],
      overeni_ceny: productMatch.overeni_ceny,
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
  const currentSanityItems = productMatch?.polozky_match?.length
    ? productMatch.polozky_match
    : productMatch?.kandidati?.length
      ? [{
          polozka_nazev: 'Položka',
          polozka_index: -1,
          mnozstvi: 1,
          typ: 'produkt' as const,
          kandidati: productMatch.kandidati,
          vybrany_index: productMatch.vybrany_index ?? 0,
          oduvodneni_vyberu: productMatch.oduvodneni_vyberu ?? '',
          cenova_uprava: productMatch.cenova_uprava,
          overeni_ceny: productMatch.overeni_ceny,
        }]
      : [];
  const currentFindings = checkPriceSanity(currentSanityItems, {});
  let obrat = 0;
  let naklady = 0;
  let vazenyZisk = 0;
  let slabych = 0;
  let hardFlagu = 0;
  let ztratovychPolozek = 0;
  let neexistujicichKandidatu = 0;

  for (const item of items) {
    const mnozstvi = isPositiveNumber(item.mnozstvi) ? item.mnozstvi : 1;
    const candidate = item.kandidati?.[item.vybrany_index ?? -1];
    const itemFindings = currentFindings.filter((finding) => finding.polozka_index === item.polozka_index);
    hardFlagu += itemFindings.filter((finding) => finding.level === 'hard').length;
    if (itemFindings.some((finding) => finding.code === 'cena_pod_nakupem')) ztratovychPolozek++;
    if (item.overeni_ceny?.kandidat_neexistuje === true) neexistujicichKandidatu++;

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
    ztratovych_polozek: ztratovychPolozek,
    neexistujicich_kandidatu: neexistujicichKandidatu,
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
  precomputedEconomics?: BidEconomics,
): BidScoreResult {
  const econ = precomputedEconomics ?? computeBidEconomics(productMatch);

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

  const target = isPositiveNumber(company?.default_marze_procent)
    ? company!.default_marze_procent!
    : DEFAULT_TARGET_MARGIN_PROCENT;
  const factors = collectBidWeightedFactors(econ, target, winBand)
    .flatMap((observation) => observation.factor ? [observation.factor] : []);

  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const weightedScore = factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0);
  let score = clamp(Math.round((weightedScore / totalWeight) * 100), 0, 100);

  const duvody = factors.map((factor) => factor.reason);

  if (econ.ztratovych_polozek > 0) {
    score = Math.max(0, score - BID_BELOW_MARKET_PENALTY);
    duvody.unshift(`${econ.ztratovych_polozek} položek by se prodávalo pod reálnou nákupní cenou.`);
  }

  if (econ.neexistujicich_kandidatu > 0) {
    const penalty = econ.neexistujicich_kandidatu * BID_NONEXISTENT_CANDIDATE_PENALTY;
    score = Math.max(0, score - penalty);
    duvody.unshift(
      `${econ.neexistujicich_kandidatu}× AI navržený produkt byl webovým ověřením vyvrácen (srážka ${penalty} bodů za kvalitu shod).`,
    );
  }

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

/** Čistá serializace všech vážených faktorů i následných korekcí bid skóre. */
export function serializeBidFeatureVector(
  analysis: TenderAnalysis,
  productMatch?: ProductMatch,
  company?: Pick<CompanyData, 'default_marze_procent'> | null,
  winBand?: PriceBand,
  precomputedEconomics?: BidEconomics,
  precomputedResult?: BidScoreResult,
): ScoreFeatureVector {
  const econ = precomputedEconomics ?? computeBidEconomics(productMatch);
  const result = precomputedResult ?? scoreBid(analysis, productMatch, company, winBand, econ);
  const target = isPositiveNumber(company?.default_marze_procent)
    ? company!.default_marze_procent!
    : DEFAULT_TARGET_MARGIN_PROCENT;
  const weighted = weightedFeatures(collectBidWeightedFactors(econ, target, winBand));
  const baseScore = Math.round(weighted.reduce((sum, factor) => sum + factor.prispevek, 0));
  let runningScore = baseScore;
  const belowMarket = econ.ztratovych_polozek > 0 ? Math.min(BID_BELOW_MARKET_PENALTY, runningScore) : 0;
  runningScore -= belowMarket;
  const nonexistentRequested = econ.neexistujicich_kandidatu * BID_NONEXISTENT_CANDIDATE_PENALTY;
  const nonexistent = Math.min(nonexistentRequested, runningScore);
  runningScore -= nonexistent;
  const hardCap = econ.hard_flagu > 0 ? Math.max(0, runningScore - (CONSIDER_SCORE_THRESHOLD - 1)) : 0;

  const corrections: ScoreFeature[] = [
    {
      nazev: BID_FACTOR_NAMES[4], surova_hodnota: { ztratovych_polozek: econ.ztratovych_polozek },
      normalizovana_hodnota: econ.ztratovych_polozek > 0 ? 1 : 0, vaha: BID_BELOW_MARKET_PENALTY,
      prispevek: -belowMarket, duvod: econ.ztratovych_polozek > 0 ? `${econ.ztratovych_polozek} položek pod nákupní cenou.` : null,
    },
    {
      nazev: BID_FACTOR_NAMES[5], surova_hodnota: { neexistujicich_kandidatu: econ.neexistujicich_kandidatu },
      normalizovana_hodnota: econ.neexistujicich_kandidatu, vaha: BID_NONEXISTENT_CANDIDATE_PENALTY,
      prispevek: -nonexistent, duvod: econ.neexistujicich_kandidatu > 0 ? 'Srážka za webem vyvrácené AI kandidáty.' : null,
    },
    {
      nazev: BID_FACTOR_NAMES[6], surova_hodnota: { hard_flagu: econ.hard_flagu, strop: CONSIDER_SCORE_THRESHOLD - 1 },
      normalizovana_hodnota: econ.hard_flagu > 0 ? 1 : 0, vaha: 0,
      prispevek: -hardCap, duvod: econ.hard_flagu > 0 ? 'HARD flag omezuje skóre stropem a vynucuje NOGO.' : null,
    },
  ];
  return { typ: 'bid', faktory: [...weighted, ...corrections], skore: result.score, doporuceni: result.doporuceni };
}

function collectBidWeightedFactors(econ: BidEconomics, target: number, winBand?: PriceBand): FactorObservation[] {
  const marginValue = econ.marze_procent <= 0 ? 0 : clamp(econ.marze_procent / target, 0, 1);
  const profitValue = econ.vazeny_zisk <= 0 ? 0 : clamp(econ.vazeny_zisk / BID_TARGET_PROFIT_CZK, 0, 1);
  const goodItems = econ.polozek - econ.slabych_polozek;
  return [
    {
      name: BID_FACTOR_NAMES[0], raw: { marze_procent: econ.marze_procent, cil_procent: target },
      factor: econ.polozek === 0 ? null : { value: marginValue, weight: BID_MARGIN_WEIGHT, reason: econ.marze_procent <= 0
        ? 'Nabídka nemá kladnou přirážku — hrozí ztrátová zakázka.'
        : `Obchodní přirážka ${econ.marze_procent.toFixed(1)} % z nákladů (cíl ${target} %).` },
    },
    {
      name: BID_FACTOR_NAMES[1], raw: { zisk_kc: econ.zisk_kc, vazeny_zisk: econ.vazeny_zisk, cil_kc: BID_TARGET_PROFIT_CZK },
      factor: econ.polozek === 0 ? null : { value: profitValue, weight: BID_ABS_PROFIT_WEIGHT, reason: `Očekávaný hrubý zisk ${formatCzk(econ.zisk_kc)} (spolehlivostí vážený ${formatCzk(Math.round(econ.vazeny_zisk))}).` },
    },
    {
      name: BID_FACTOR_NAMES[2], raw: { polozek_celkem: econ.polozek, spolehlivych_polozek: goodItems },
      factor: econ.polozek === 0 ? null : { value: goodItems / econ.polozek, weight: BID_MATCH_QUALITY_WEIGHT, reason: `${goodItems} z ${econ.polozek} položek má spolehlivou reálnou shodu.` },
    },
    {
      name: BID_FACTOR_NAMES[3], raw: { nase_cena: econ.obrat_bez_dph, median: winBand?.median ?? null, p75: winBand?.p75 ?? null, pocet: winBand?.pocet ?? null },
      factor: econ.polozek === 0 ? null : scoreBidWinPrice(econ.obrat_bez_dph, winBand),
    },
  ];
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
