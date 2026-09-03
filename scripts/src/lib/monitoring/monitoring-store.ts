/**
 * Monitoring store — feed nových veřejných zakázek ze zdroje (NEN / Hlídač státu)
 * v tabulce monitoring_zakazky (migrace 014, kategorie 017, CPV 024).
 * Modelováno dle crm-store.ts nad db.ts.
 *
 * Graceful degradace: bez DB (getPool() === null) čtení vrací prázdno,
 * zápisy vyhazují 'db_unavailable' (endpoint to přeloží na 503).
 *
 * Normalizační funkce (toNenFeedInput / toHlidacFeedInput) jsou čisté a testovatelné
 * bez DB — mapují surové záznamy zdroje na jednotný vstup pro upsert.
 */
import { query, queryOne, getPool } from '../db.js';
import {
  categorizeTender, DOMAIN_CATEGORY_VALUES, normalizeCpvCodes, type DomainCategory,
} from './domain-registry.js';
import type { NenTenderCandidate } from './nen-client.js';
import type { HlidacTenderCandidate } from './hlidac-client.js';

export type MonitoringStav = 'nova' | 'prevzata' | 'ignorovana';

/** Jednotný vstup pro upsert — výstup normalizace libovolného zdroje. */
export interface FeedUpsertInput {
  zdroj: string;
  zdroj_id: string;
  nazev: string;
  kategorie: DomainCategory;
  cpv: string[];
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
  kategorie: DomainCategory;
  cpv: string[];
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
  kategorie, cpv,
  predpokladana_hodnota::float8 AS predpokladana_hodnota,
  to_char(lhuta_nabidek, 'YYYY-MM-DD') AS lhuta_nabidek,
  url, raw, stav, tender_id, created_at`;

type FeedDbRow = Omit<FeedItem, 'predpokladana_hodnota' | 'kategorie' | 'cpv'> & {
  predpokladana_hodnota: number | string | null;
  kategorie?: string | null;
  cpv?: unknown;
};

/**
 * Dodatečná ochrana pro mocky/starší ovladače, které NUMERIC vracejí jako string.
 * Starému řádku kategorii dopočítá v paměti; CPV přitom opraví i dřívější titulkový odhad.
 */
export function normalizeFeedRow(row: FeedDbRow): FeedItem {
  const value = row.predpokladana_hodnota;
  const numeric = value == null ? null : Number(value);
  const cpv = normalizeCpvCodes(Array.isArray(row.cpv) ? row.cpv : []);
  return {
    ...row,
    kategorie: cpv.length > 0
      ? categorizeTender(row.nazev, cpv)
      : isDomainCategory(row.kategorie)
        ? row.kategorie
        : categorizeTender(row.nazev),
    cpv,
    predpokladana_hodnota: numeric == null || Number.isFinite(numeric) ? numeric : null,
  };
}

function isDomainCategory(value: unknown): value is DomainCategory {
  return typeof value === 'string'
    && DOMAIN_CATEGORY_VALUES.includes(value as DomainCategory);
}

/** Líně doplní nebo CPV-first opraví kategorii; chyba backfillu nesmí znepřístupnit feed. */
async function backfillCategories(rows: FeedDbRow[], items: FeedItem[]): Promise<void> {
  await Promise.all(rows.map(async (row, index) => {
    if (row.kategorie === items[index].kategorie) return;
    try {
      await query(
        `UPDATE monitoring_zakazky SET kategorie = $2
         WHERE id = $1::bigint AND kategorie IS DISTINCT FROM $2`,
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
         (zdroj, zdroj_id, nazev, kategorie, cpv, zadavatel, predpokladana_hodnota, lhuta_nabidek, url, raw)
       VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10)
       ON CONFLICT (zdroj, zdroj_id) DO UPDATE SET
         nazev = EXCLUDED.nazev,
         kategorie = EXCLUDED.kategorie,
         cpv = EXCLUDED.cpv,
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
        item.cpv,
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
  options: FeedListOptions = {},
): Promise<FeedItem[]> {
  if (!dbReady()) return [];
  try {
    const built = buildListFeedQuery(stav, limit, options);
    const r = await query<FeedDbRow>(built.sql, built.params);
    const items = r.rows.map(normalizeFeedRow);
    await backfillCategories(r.rows, items);
    return items;
  } catch {
    return [];
  }
}

/** Sestavení SQL je oddělené, aby šlo regresně ověřit pořadí filtrů před LIMIT. */
export function buildListFeedQuery(
  stav?: MonitoringStav,
  limit = 200,
  options: FeedListOptions = {},
): { sql: string; params: unknown[] } {
    const { where, params } = buildFeedFilter(stav, options);
    params.push(limit);
    return {
      sql: `SELECT ${FEED_COLS} FROM monitoring_zakazky ${where}
       ORDER BY (lhuta_nabidek IS NULL), lhuta_nabidek ASC, created_at DESC
       LIMIT $${params.length}`,
      params,
    };
}

export interface FeedListOptions {
  includeExpired?: boolean;
  category?: DomainCategory;
}

function buildFeedFilter(
  stav: MonitoringStav | undefined,
  options: FeedListOptions,
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (stav) {
    params.push(stav);
    conditions.push(`stav = $${params.length}`);
  }
  if (options.category) {
    params.push(options.category);
    conditions.push(`kategorie = $${params.length}`);
  }
  if (!options.includeExpired) {
    conditions.push('(lhuta_nabidek IS NULL OR lhuta_nabidek >= CURRENT_DATE)');
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/** Přesný počet řádků před interním limitem feedu, se stejnými SQL filtry jako listFeed. */
export async function countFeed(
  stav?: MonitoringStav,
  options: FeedListOptions = {},
): Promise<number> {
  if (!dbReady()) return 0;
  try {
    const built = buildCountFeedQuery(stav, options);
    const row = await queryOne<{ total: number | string }>(built.sql, built.params);
    const total = Number(row?.total ?? 0);
    return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : 0;
  } catch {
    return 0;
  }
}

/** Sestavení COUNT dotazu sdílí přesně stejné podmínky jako omezený seznam. */
export function buildCountFeedQuery(
  stav?: MonitoringStav,
  options: FeedListOptions = {},
): { sql: string; params: unknown[] } {
  const { where, params } = buildFeedFilter(stav, options);
  return {
    sql: `SELECT COUNT(*)::int AS total FROM monitoring_zakazky ${where}`,
    params,
  };
}

export interface FeedCutSummary {
  limit: number;
  total: number;
  returned: number;
  discarded: number;
  truncated: boolean;
}

/** Jednotná, snadno testovatelná metrika jednoho limitního řezu. */
export function summarizeFeedCut(total: number, returned: number, limit: number): FeedCutSummary {
  const normalizedReturned = Math.max(0, Math.trunc(returned));
  const normalizedTotal = Math.max(normalizedReturned, Math.max(0, Math.trunc(total)));
  const normalizedLimit = Math.max(0, Math.trunc(limit));
  const discarded = normalizedTotal - normalizedReturned;
  return {
    limit: normalizedLimit,
    total: normalizedTotal,
    returned: normalizedReturned,
    discarded,
    truncated: discarded > 0,
  };
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
    await backfillCategories([row], [item]);
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
  const cpv: string[] = [];
  return {
    zdroj: 'nen',
    zdroj_id: candidate.zdroj_id,
    nazev: candidate.nazev,
    kategorie: categorizeTender(candidate.nazev, cpv),
    cpv,
    zadavatel: candidate.zadavatel,
    predpokladana_hodnota: null, // v seznamu NEN není, doplní se až z detailu při zpracování
    lhuta_nabidek: candidate.lhuta_nabidek,
    url: candidate.url,
    raw: candidate,
  };
}

/** Normalizuje kandidáta z Hlídače státu na jednotný upsert vstup. */
export function toHlidacFeedInput(candidate: HlidacTenderCandidate): FeedUpsertInput {
  const cpv = normalizeCpvCodes(candidate.cpv);
  return {
    zdroj: 'hlidac',
    zdroj_id: candidate.id,
    nazev: candidate.nazev,
    kategorie: categorizeTender(candidate.nazev, cpv),
    cpv,
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
