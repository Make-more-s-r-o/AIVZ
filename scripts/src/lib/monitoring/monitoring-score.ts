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
  scoreGoNoGo,
  type GoNoGoResult,
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

  const base = scoreGoNoGo({
    ...analysis,
    // extractedAt = referenční „teď", aby faktor lhůty počítal zbývající dny.
    extractedAt: now.toISOString(),
    obory: company?.obory,
    keyword_filters: company?.keyword_filters,
  });

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
