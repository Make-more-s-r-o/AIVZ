/**
 * Quick go/no-go skóre pro položku monitoringového feedu.
 *
 * Feed má jen hrubá pole (název, zadavatel, hodnota, lhůta) — žádnou plnou analýzu ani
 * nacenění. Sestavíme proto minimální vstup pro existující `scoreGoNoGo`; chybějící
 * signály (nacenění, win-price) prostě vynecháme — scorer je robustní a skóre kvůli nim
 * neshodí (váží jen dostupné faktory). Sektor a rozpočet přiblížíme z firemního profilu.
 */
import {
  CONSIDER_SCORE_THRESHOLD,
  GO_SCORE_THRESHOLD,
  serializeGoNoGoFeatureVector,
  scoreGoNoGo,
  type GoNoGoResult,
  type ScoreFeatureVector,
} from '../go-no-go.js';
import type { TenderAnalysis } from '../types.js';
import { categorizeCommodity, type KomoditaKategorie } from '../winprice-store.js';
import type { MonitoringConfig } from './monitoring-config.js';

export interface FeedScoreInput {
  nazev: string;
  kategorie?: KomoditaKategorie;
  zadavatel: string | null;
  predpokladana_hodnota: number | null;
  lhuta_nabidek: string | null; // 'YYYY-MM-DD' | null
}

export interface CompanyScoringProfile {
  obory?: string[];
  keyword_filters?: Record<string, string[]>;
}

/** Spočítá informativní go/no-go skóre feed položky. Nikdy nevyhazuje. */
export function scoreFeedItem(
  item: FeedScoreInput,
  company?: CompanyScoringProfile,
  now: Date = new Date(),
  monitoring?: MonitoringConfig,
): GoNoGoResult {
  const analysis = buildFeedAnalysis(item, company, now);

  const base = scoreGoNoGo(analysis);

  if (!monitoring) return base;

  if (isFeedItemExcluded(item, monitoring)) {
    return {
      score: 0,
      doporuceni: 'NOGO',
      duvody: [...base.duvody, 'Název obsahuje vyloučené slovo z nastavení monitoringu.'],
    };
  }

  let score = base.score;
  const duvody = [...base.duvody];
  if (monitoring.kategorie_zajmu.length > 0) {
    const category = item.kategorie ?? categorizeCommodity(item.nazev);
    const matches = monitoring.kategorie_zajmu.includes(category);
    // Kategorie je pro vstupní relevanci rozhodující: shoda tvoří 60 % výsledku.
    score = Math.round(base.score * 0.4 + (matches ? 60 : 0));
    duvody.push(matches
      ? 'Kategorie zakázky odpovídá nastavenému zájmu.'
      : 'Kategorie zakázky je mimo nastavený zájem.');
  }

  if (item.predpokladana_hodnota != null) {
    if (monitoring.min_hodnota != null && item.predpokladana_hodnota < monitoring.min_hodnota) {
      score -= 20;
      duvody.push('Předpokládaná hodnota je pod nastaveným minimem.');
    } else if (monitoring.max_hodnota != null && item.predpokladana_hodnota > monitoring.max_hodnota) {
      score -= 20;
      duvody.push('Předpokládaná hodnota překračuje nastavené maximum.');
    }
  }

  score = Math.max(0, Math.min(100, score));
  const doporuceni = score >= GO_SCORE_THRESHOLD
    ? 'GO'
    : score >= CONSIDER_SCORE_THRESHOLD
      ? 'ZVAZIT'
      : 'NOGO';
  return { score, doporuceni, duvody };
}

function buildFeedAnalysis(item: FeedScoreInput, company: CompanyScoringProfile | undefined, now: Date) {
  // Minimální validní TenderAnalysis — vyplníme jen to, co feed reálně zná.
  const analysis = {
    zakazka: {
      nazev: item.nazev,
      zadavatel: { nazev: item.zadavatel ?? 'Neznámý zadavatel' },
      predmet: item.nazev,
      predpokladana_hodnota: item.predpokladana_hodnota ?? null,
      typ_zakazky: '',
      typ_rizeni: '',
    },
    kvalifikace: [],
    hodnotici_kriteria: [],
    terminy: { lhuta_nabidek: item.lhuta_nabidek },
    casti: [],
    polozky: [{ nazev: item.nazev, specifikace: '' }],
    technicke_pozadavky: [],
    rizika: [],
    doporuceni: { rozhodnuti: 'ZVAZIT', oduvodneni: '', klicove_body: [] },
  } as unknown as TenderAnalysis;
  return {
    ...analysis,
    // extractedAt = referenční „teď", aby faktor lhůty počítal zbývající dny.
    extractedAt: now.toISOString(),
    obory: company?.obory,
    keyword_filters: company?.keyword_filters,
  };
}

/** Feature vektor přesně odpovídající skóre uloženému při převzetí z monitoringu. */
export function serializeFeedItemFeatureVector(
  item: FeedScoreInput,
  company?: CompanyScoringProfile,
  now: Date = new Date(),
  monitoring?: MonitoringConfig,
): ScoreFeatureVector {
  const analysis = buildFeedAnalysis(item, company, now);
  const vector = serializeGoNoGoFeatureVector(analysis);
  const result = scoreFeedItem(item, company, now, monitoring);
  if (monitoring) {
    const category = item.kategorie ?? categorizeCommodity(item.nazev);
    const categoryActive = monitoring.kategorie_zajmu.length > 0;
    const categoryMatches = categoryActive && monitoring.kategorie_zajmu.includes(category);
    const belowMinimum = item.predpokladana_hodnota != null && monitoring.min_hodnota != null
      && item.predpokladana_hodnota < monitoring.min_hodnota;
    const aboveMaximum = item.predpokladana_hodnota != null && monitoring.max_hodnota != null
      && item.predpokladana_hodnota > monitoring.max_hodnota;
    vector.faktory.push(
      {
        nazev: 'monitoring_category',
        surova_hodnota: { kategorie: category, kategorie_zajmu: monitoring.kategorie_zajmu },
        normalizovana_hodnota: categoryActive ? (categoryMatches ? 1 : 0) : null,
        vaha: categoryActive ? 60 : 0, prispevek: 0,
        duvod: categoryActive ? 'Kategorie upravuje monitoringové skóre.' : null,
      },
      {
        nazev: 'monitoring_value_range',
        surova_hodnota: { hodnota: item.predpokladana_hodnota, minimum: monitoring.min_hodnota, maximum: monitoring.max_hodnota },
        normalizovana_hodnota: belowMinimum || aboveMaximum ? 0 : 1,
        vaha: 20, prispevek: belowMinimum || aboveMaximum ? -20 : 0,
        duvod: belowMinimum || aboveMaximum ? 'Hodnota je mimo monitoringové pásmo.' : null,
      },
      {
        nazev: 'monitoring_excluded_word',
        surova_hodnota: { nazev: item.nazev, vyloucena_slova: monitoring.vyloucena_slova },
        normalizovana_hodnota: isFeedItemExcluded(item, monitoring) ? 0 : 1,
        vaha: 0, prispevek: isFeedItemExcluded(item, monitoring) ? -vector.skore : 0,
        duvod: isFeedItemExcluded(item, monitoring) ? 'Vyloučené slovo vynutilo NOGO.' : null,
      },
    );
  }
  vector.skore = result.score;
  vector.doporuceni = result.doporuceni;
  return vector;
}

/** Tvrdý filtr názvu; bez diakritiky a bez ohledu na velikost písmen. */
export function isFeedItemExcluded(
  item: Pick<FeedScoreInput, 'nazev'>,
  monitoring: Pick<MonitoringConfig, 'vyloucena_slova'>,
): boolean {
  const title = normalizeText(item.nazev);
  return monitoring.vyloucena_slova.some((word) => title.includes(normalizeText(word)));
}

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/**
 * Vytvoří bezpečný název složky zakázky z názvu ze zdroje. Diakritika → ASCII,
 * mezery/oddělovače → pomlčky, bez lomítek a `..` (kompatibilní s isSafePath).
 */
export function slugifyTender(nazev: string, fallback: string): string {
  const base = nazev
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base || fallback;
}
