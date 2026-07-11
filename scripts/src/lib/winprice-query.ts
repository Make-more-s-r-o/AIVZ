/**
 * Win-price query — hledání podobných historických výher/smluv dle předmětu.
 *
 * Kombinuje dvě strategie: fulltext (tsvector, přesné termy) + trigram similarity
 * (pg_trgm, fuzzy překlepy/varianty). Vrací záznamy s cenou seřazené dle relevance.
 *
 * Samostatný query modul používaný CLI i read-only win-price API vrstvou.
 */
import { query } from './db.js';
import type { KomoditaKategorie } from './winprice-store.js';

export interface SimilarWin {
  id: number;
  zdroj: string;
  datum: string | null;
  zadavatel_nazev: string | null;
  dodavatel_nazev: string | null;
  dodavatel_ico: string | null;
  predmet: string;
  komodita_kategorie: string;
  cena_bez_dph: number | null;
  cena_s_dph: number | null;
  mena: string;
  url: string | null;
  similarity: number; // 0..1 trigram podobnost předmětu vůči dotazu
}

export interface FindSimilarOptions {
  kategorie?: KomoditaKategorie;
  limit?: number;
  minSimilarity?: number; // práh trigram podobnosti (0..1)
  onlyWithPrice?: boolean; // jen záznamy s cenou (default true)
}

/**
 * Dopočet ceny bez DPH z ceny s DPH (sazba 21 %) pro záznamy, kde Registr smluv
 * uvádí jen hodnotu včetně DPH (~25 % importovaných řádků — bez dopočtu se jejich
 * cena v pásmech nevyužije). Jen pro CZK — u cizí měny přepočet nedává smysl.
 */
export function deriveCenaBezDph(
  cenaBezDph: number | null,
  cenaSDph: number | null,
  mena: string,
): number | null {
  if (cenaBezDph !== null && cenaBezDph > 0) return cenaBezDph;
  if (cenaSDph !== null && cenaSDph > 0 && mena === 'CZK') {
    return Math.round((cenaSDph / 1.21) * 100) / 100;
  }
  return cenaBezDph;
}

/**
 * Najde historické záznamy s předmětem podobným dotazu.
 *
 * Skóre relevance = kombinace trigram similarity a fulltext match.
 * Řadí primárně dle toho, zda záznam vyhověl fulltextu, pak dle similarity.
 */
export async function findSimilarWins(
  predmet: string,
  options: FindSimilarOptions = {},
): Promise<SimilarWin[]> {
  const {
    kategorie,
    limit = 20,
    minSimilarity = 0.1,
    onlyWithPrice = true,
  } = options;

  const params: unknown[] = [predmet, minSimilarity];
  const where: string[] = [
    // Kandidát = trigram podobný NEBO fulltext match (websearch nad simple config).
    `(similarity(predmet, $1) >= $2 OR search_vector @@ websearch_to_tsquery('simple', $1))`,
  ];

  if (onlyWithPrice) {
    where.push('(cena_bez_dph IS NOT NULL OR cena_s_dph IS NOT NULL)');
  }
  if (kategorie) {
    params.push(kategorie);
    where.push(`komodita_kategorie = $${params.length}`);
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  // ORDER BY nesmí odkazovat na output-aliasy uvnitř výrazu → subquery.
  const sql = `
    SELECT id, zdroj, datum, zadavatel_nazev, dodavatel_nazev, dodavatel_ico,
           predmet, komodita_kategorie, cena_bez_dph, cena_s_dph, mena, url, similarity
    FROM (
      SELECT id, zdroj, datum::text AS datum, zadavatel_nazev, dodavatel_nazev,
             dodavatel_ico, predmet, komodita_kategorie,
             cena_bez_dph, cena_s_dph, mena, url,
             ROUND(similarity(predmet, $1)::numeric, 3)::float8 AS similarity,
             ts_rank(search_vector, websearch_to_tsquery('simple', $1)) AS rank
      FROM win_prices
      WHERE ${where.join(' AND ')}
    ) q
    ORDER BY (rank * 2 + similarity) DESC, datum DESC NULLS LAST
    LIMIT ${limitParam}
  `;

  const { rows } = await query<SimilarWin>(sql, params);
  // pg vrací NUMERIC jako string → převedeme cenové sloupce na number.
  // Chybějící cenu bez DPH dopočítáme z ceny s DPH (viz deriveCenaBezDph),
  // ať se čtvrtina záznamů „jen s DPH" neztrácí z pásem ani ze vzorků.
  return rows.map((r) => {
    const cenaSDph = r.cena_s_dph === null ? null : Number(r.cena_s_dph);
    const cenaBezDph = r.cena_bez_dph === null ? null : Number(r.cena_bez_dph);
    return {
      ...r,
      cena_bez_dph: deriveCenaBezDph(cenaBezDph, cenaSDph, r.mena),
      cena_s_dph: cenaSDph,
      similarity: Number(r.similarity),
    };
  });
}

/** Agregovaná cenová statistika nad množinou podobných výher. */
export interface PriceBand {
  pocet: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
  prumer: number | null;
}

/** Lineárně interpolovaný percentil nad vzestupně seřazenými cenami. */
function percentile(sorted: number[], ratio: number): number {
  const position = (sorted.length - 1) * ratio;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return Math.round((lower + (upper - lower) * (position - lowerIndex)) * 100) / 100;
}

/**
 * Vrátí cenové pásmo (min/P25/median/P75/max/průměr cen bez DPH) pro předmět.
 * Slouží jako čistě informační win-price signál v nacenění.
 */
export async function priceBandForSubject(
  predmet: string,
  options: FindSimilarOptions = {},
): Promise<PriceBand> {
  const wins = await findSimilarWins(predmet, { ...options, limit: options.limit ?? 200 });
  const ceny = wins
    .map((w) => w.cena_bez_dph)
    .filter((c): c is number => c !== null && c > 0)
    .sort((a, b) => a - b);

  if (ceny.length === 0) {
    return { pocet: 0, min: null, p25: null, median: null, p75: null, max: null, prumer: null };
  }
  const mid = Math.floor(ceny.length / 2);
  const median = ceny.length % 2 ? ceny[mid] : (ceny[mid - 1] + ceny[mid]) / 2;
  const prumer = ceny.reduce((a, b) => a + b, 0) / ceny.length;
  return {
    pocet: ceny.length,
    min: ceny[0],
    p25: percentile(ceny, 0.25),
    median,
    p75: percentile(ceny, 0.75),
    max: ceny[ceny.length - 1],
    prumer: Math.round(prumer * 100) / 100,
  };
}

export interface WinPriceStats {
  count: number;
  last_date: string | null;
}

/** Vrátí základní stav importovaných win-price dat. */
export async function getWinPriceStats(): Promise<WinPriceStats> {
  const { rows } = await query<{ count: string | number; last_date: string | null }>(`
    SELECT COUNT(*) AS count, MAX(datum)::text AS last_date
    FROM win_prices
  `);
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    last_date: row?.last_date ?? null,
  };
}
