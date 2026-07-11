/**
 * Monitoring store — feed nových veřejných zakázek ze zdroje (NEN / Hlídač státu)
 * v tabulce monitoring_zakazky (migrace 014). Modelováno dle crm-store.ts nad db.ts.
 *
 * Graceful degradace: bez DB (getPool() === null) čtení vrací prázdno,
 * zápisy vyhazují 'db_unavailable' (endpoint to přeloží na 503).
 *
 * Normalizační funkce (toNenFeedInput / toHlidacFeedInput) jsou čisté a testovatelné
 * bez DB — mapují surové záznamy zdroje na jednotný vstup pro upsert.
 */
import { query, queryOne, getPool } from '../db.js';
import {
  categorizeCommodity, KOMODITA_KATEGORIE_VALUES, type KomoditaKategorie,
} from '../winprice-store.js';
import type { NenTenderCandidate } from './nen-client.js';
import type { HlidacTenderCandidate } from './hlidac-client.js';

export type MonitoringStav = 'nova' | 'prevzata' | 'ignorovana';

/** Jednotný vstup pro upsert — výstup normalizace libovolného zdroje. */
export interface FeedUpsertInput {
  zdroj: string;
  zdroj_id: string;
  nazev: string;
  kategorie: KomoditaKategorie;
  zadavatel: string | null;
  predpokladana_hodnota: number | null;
  lhuta_nabidek: string | null; // 'YYYY-MM-DD' | null
  url: string;
  raw: unknown;
}

export interface FeedItem {
  id: string;
  zdroj: string;
  zdroj_id: string;
  nazev: string;
  kategorie: KomoditaKategorie;
  zadavatel: string | null;
  predpokladana_hodnota: number | null;
  lhuta_nabidek: string | null; // 'YYYY-MM-DD' | null
  url: string | null;
  raw: unknown;
  stav: MonitoringStav;
  tender_id: string | null;
  created_at: string;
}

function dbReady(): boolean {
  return getPool() !== null;
}

// lhuta_nabidek přes to_char, jinak node-pg parsuje DATE na JS Date v lokální půlnoci
// a JSON.stringify ji posune o TZ offset → off-by-one (viz TASK_COLS v crm-store).
const FEED_COLS = `id::text, zdroj, zdroj_id, nazev, zadavatel,
  kategorie,
  predpokladana_hodnota::float8 AS predpokladana_hodnota,
  to_char(lhuta_nabidek, 'YYYY-MM-DD') AS lhuta_nabidek,
  url, raw, stav, tender_id, created_at`;

type FeedDbRow = Omit<FeedItem, 'predpokladana_hodnota' | 'kategorie'> & {
  predpokladana_hodnota: number | string | null;
  kategorie?: string | null;
};

/**
 * Dodatečná ochrana pro mocky/starší ovladače, které NUMERIC vracejí jako string.
 * Starému řádku bez kategorie ji dopočítá v paměti; čtecí funkce ji následně líně uloží.
 */
export function normalizeFeedRow(row: FeedDbRow): FeedItem {
  const value = row.predpokladana_hodnota;
  const numeric = value == null ? null : Number(value);
  return {
    ...row,
    kategorie: isCommodityCategory(row.kategorie)
      ? row.kategorie
      : categorizeCommodity(row.nazev),
    predpokladana_hodnota: numeric == null || Number.isFinite(numeric) ? numeric : null,
  };
}

function isCommodityCategory(value: unknown): value is KomoditaKategorie {
  return typeof value === 'string'
    && KOMODITA_KATEGORIE_VALUES.includes(value as KomoditaKategorie);
}

/** Líně doplní kategorii starších řádků; chyba backfillu nesmí znepřístupnit feed. */
async function backfillMissingCategories(rows: FeedDbRow[], items: FeedItem[]): Promise<void> {
  await Promise.all(rows.map(async (row, index) => {
    if (isCommodityCategory(row.kategorie)) return;
    try {
      await query(
        `UPDATE monitoring_zakazky SET kategorie = $2 WHERE id = $1::bigint AND kategorie IS NULL`,
        [row.id, items[index].kategorie],
      );
    } catch {
      // Migrace může při rolling deployi ještě dobíhat; hodnota je i tak dostupná v odpovědi.
    }
  }));
}

/**
 * Idempotentní upsert feedu. Nové položky vloží, existující (dle zdroj+zdroj_id)
 * jen aktualizuje o čerstvá metadata; NIKDY nepřepíše `stav` ani `tender_id`
 * (operátorovo rozhodnutí „převzato/ignorováno" musí přežít další sync).
 * Vrací počet nově vložených řádků.
 */
export async function upsertFeed(items: FeedUpsertInput[]): Promise<number> {
  if (!dbReady()) throw new Error('db_unavailable');
  if (items.length === 0) return 0;

  let inserted = 0;
  for (const item of items) {
    const row = await queryOne<{ inserted: boolean }>(
      `INSERT INTO monitoring_zakazky
         (zdroj, zdroj_id, nazev, kategorie, zadavatel, predpokladana_hodnota, lhuta_nabidek, url, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (zdroj, zdroj_id) DO UPDATE SET
         nazev = EXCLUDED.nazev,
         kategorie = EXCLUDED.kategorie,
         zadavatel = EXCLUDED.zadavatel,
         predpokladana_hodnota = EXCLUDED.predpokladana_hodnota,
         lhuta_nabidek = EXCLUDED.lhuta_nabidek,
         url = EXCLUDED.url,
         raw = EXCLUDED.raw
       RETURNING (xmax = 0) AS inserted`,
      [
        item.zdroj,
        item.zdroj_id,
        item.nazev,
        item.kategorie,
        item.zadavatel,
        item.predpokladana_hodnota,
        item.lhuta_nabidek,
        item.url,
        item.raw == null ? null : JSON.stringify(item.raw),
      ],
    );
    if (row?.inserted) inserted += 1;
  }
  return inserted;
}

/**
 * Seznam feedu; volitelně filtrovaný stavem. Bez DB → prázdno.
 * Prošlé lhůty se defaultně skrývají (NEN nechává zakázky po lhůtě jako „Neukončen",
 * ale podat se do nich už nedá) — includeExpired: true je vrátí (audit/přehled).
 */
export async function listFeed(
  stav?: MonitoringStav,
  limit = 200,
  options: { includeExpired?: boolean } = {},
): Promise<FeedItem[]> {
  if (!dbReady()) return [];
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (stav) {
      params.push(stav);
      conditions.push(`stav = $${params.length}`);
    }
    if (!options.includeExpired) {
      conditions.push('(lhuta_nabidek IS NULL OR lhuta_nabidek >= CURRENT_DATE)');
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const r = await query<FeedDbRow>(
      `SELECT ${FEED_COLS} FROM monitoring_zakazky ${where}
       ORDER BY (lhuta_nabidek IS NULL), lhuta_nabidek ASC, created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    const items = r.rows.map(normalizeFeedRow);
    await backfillMissingCategories(r.rows, items);
    return items;
  } catch {
    return [];
  }
}

export async function getFeedItem(id: string): Promise<FeedItem | null> {
  if (!dbReady()) return null;
  try {
    const row = await queryOne<FeedDbRow>(
      `SELECT ${FEED_COLS} FROM monitoring_zakazky WHERE id = $1::bigint`,
      [id],
    );
    if (!row) return null;
    const item = normalizeFeedRow(row);
    await backfillMissingCategories([row], [item]);
    return item;
  } catch {
    return null;
  }
}

/** Změní stav feed položky (převzata/ignorovana); u převzetí uloží i tender_id. */
export async function setFeedStav(
  id: string,
  stav: MonitoringStav,
  tenderId: string | null = null,
): Promise<FeedItem | null> {
  if (!dbReady()) throw new Error('db_unavailable');
  const row = await queryOne<FeedDbRow>(
    `UPDATE monitoring_zakazky
       SET stav = $2, tender_id = COALESCE($3, tender_id)
     WHERE id = $1::bigint
     RETURNING ${FEED_COLS}`,
    [id, stav, tenderId],
  );
  return row ? normalizeFeedRow(row) : null;
}

// --- Čisté normalizace záznamů zdroje (testovatelné bez DB) ---

/** Normalizuje kandidáta z NEN na jednotný upsert vstup. */
export function toNenFeedInput(candidate: NenTenderCandidate): FeedUpsertInput {
  return {
    zdroj: 'nen',
    zdroj_id: candidate.zdroj_id,
    nazev: candidate.nazev,
    kategorie: categorizeCommodity(candidate.nazev),
    zadavatel: candidate.zadavatel,
    predpokladana_hodnota: null, // v seznamu NEN není, doplní se až z detailu při zpracování
    lhuta_nabidek: candidate.lhuta_nabidek,
    url: candidate.url,
    raw: candidate,
  };
}

/** Normalizuje kandidáta z Hlídače státu na jednotný upsert vstup. */
export function toHlidacFeedInput(candidate: HlidacTenderCandidate): FeedUpsertInput {
  return {
    zdroj: 'hlidac',
    zdroj_id: candidate.id,
    nazev: candidate.nazev,
    kategorie: categorizeCommodity(candidate.nazev),
    zadavatel: candidate.zadavatel || null,
    predpokladana_hodnota: candidate.budget,
    lhuta_nabidek: toIsoDate(candidate.lhuta),
    url: candidate.url,
    raw: candidate,
  };
}

/** Bezpečně zredukuje libovolný datum/čas string na ISO datum (YYYY-MM-DD) nebo null. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  // Už ISO datum na začátku? Vem prvních 10 znaků.
  const isoPrefix = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (isoPrefix) return `${isoPrefix[1]}-${isoPrefix[2]}-${isoPrefix[3]}`;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}
