/**
 * Quick go/no-go skóre pro položku monitoringového feedu.
 *
 * Feed má jen hrubá pole (název, zadavatel, hodnota, lhůta) — žádnou plnou analýzu ani
 * nacenění. Sestavíme proto minimální vstup pro existující `scoreGoNoGo`; chybějící
 * signály (nacenění, win-price) prostě vynecháme — scorer je robustní a skóre kvůli nim
 * neshodí (váží jen dostupné faktory). Sektor a rozpočet přiblížíme z firemního profilu.
 */
import { scoreGoNoGo, type GoNoGoResult } from '../go-no-go.js';
import type { TenderAnalysis } from '../types.js';

export interface FeedScoreInput {
  nazev: string;
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

  return scoreGoNoGo({
    ...analysis,
    // extractedAt = referenční „teď", aby faktor lhůty počítal zbývající dny.
    extractedAt: now.toISOString(),
    obory: company?.obory,
    keyword_filters: company?.keyword_filters,
  });
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
