/**
 * CRM store (M6) — perzistentní termíny/lhůty zakázky ve sdíleném Postgresu (vz_warehouse).
 * Modelováno dle crm-store.ts (M2/M3): graceful degradace — bez DB (getPool()===null) vrací
 * prázdno; zápisy vyhazují 'db_unavailable' (endpoint → 503). datum přes to_char (TZ off-by-one).
 */
import { query, queryOne, getPool } from './db.js';

export interface TerminRow {
  id: string;
  tender_id: string;
  typ: string;
  datum: string | null; // 'YYYY-MM-DD'
  cas: string | null;
  popis: string | null;
  pripominka: number | null;
  seed_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function dbReady(): boolean {
  return getPool() !== null;
}

const TERMIN_COLS = `id::text, tender_id, typ,
  to_char(datum, 'YYYY-MM-DD') AS datum,
  cas, popis, pripominka, seed_key, created_by, created_at, updated_at`;

export async function getTerminy(tenderId: string): Promise<TerminRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<TerminRow>(
      `SELECT ${TERMIN_COLS} FROM crm_terminy WHERE tender_id = $1 ORDER BY datum ASC, id ASC`,
      [tenderId],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/** Termíny v rozsahu datumů napříč zakázkami (podklad pro Kalendář). */
export async function getAllTerminy(from?: string, to?: string): Promise<TerminRow[]> {
  if (!dbReady()) return [];
  try {
    const conds: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (from) { conds.push(`datum >= $${i++}`); params.push(from); }
    if (to) { conds.push(`datum <= $${i++}`); params.push(to); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query<TerminRow>(
      `SELECT ${TERMIN_COLS} FROM crm_terminy ${where} ORDER BY datum ASC, id ASC`,
      params,
    );
    return r.rows;
  } catch {
    return [];
  }
}

export interface CreateTerminInput {
  tender_id: string;
  typ: string;
  datum: string;
  cas?: string | null;
  popis?: string | null;
  pripominka?: number | null;
  created_by?: string | null;
}

export async function createTermin(input: CreateTerminInput): Promise<TerminRow> {
  if (!dbReady()) throw new Error('db_unavailable');
  const row = await queryOne<TerminRow>(
    `INSERT INTO crm_terminy (tender_id, typ, datum, cas, popis, pripominka, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${TERMIN_COLS}`,
    [
      input.tender_id, input.typ, input.datum, input.cas ?? null,
      input.popis ?? null, input.pripominka ?? null, input.created_by ?? null,
    ],
  );
  return row!;
}

const UPDATABLE = ['typ', 'datum', 'cas', 'popis', 'pripominka'] as const;

export async function updateTermin(id: string, patch: Record<string, unknown>): Promise<TerminRow | null> {
  if (!dbReady()) throw new Error('db_unavailable');
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const col of UPDATABLE) {
    if (col in patch && patch[col] !== undefined) {
      sets.push(`${col} = $${i++}`);
      params.push(patch[col]);
    }
  }
  if (sets.length === 0) {
    return queryOne<TerminRow>(`SELECT ${TERMIN_COLS} FROM crm_terminy WHERE id = $1::bigint`, [id]);
  }
  sets.push('updated_at = NOW()');
  params.push(id);
  return await queryOne<TerminRow>(
    `UPDATE crm_terminy SET ${sets.join(', ')} WHERE id = $${i}::bigint RETURNING ${TERMIN_COLS}`,
    params,
  );
}

export async function deleteTermin(id: string): Promise<boolean> {
  if (!dbReady()) throw new Error('db_unavailable');
  const r = await query('DELETE FROM crm_terminy WHERE id = $1::bigint', [id]);
  return (r.rowCount ?? 0) > 0;
}

export interface SeedTerminItem {
  typ: string;
  datum: string;
  cas?: string | null;
  seed_key: string;
}

/** Idempotentní seed termínů z analysis.terminy. Vrací počet nově vložených. */
export async function seedTerminy(tenderId: string, items: SeedTerminItem[]): Promise<number> {
  if (!dbReady()) throw new Error('db_unavailable');
  if (items.length === 0) return 0;
  const rows: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const it of items) {
    rows.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(tenderId, it.typ, it.datum, it.cas ?? null, it.seed_key);
  }
  const r = await query(
    `INSERT INTO crm_terminy (tender_id, typ, datum, cas, seed_key)
     VALUES ${rows.join(', ')}
     ON CONFLICT (tender_id, seed_key) WHERE seed_key IS NOT NULL DO NOTHING`,
    params,
  );
  return r.rowCount ?? 0;
}

/**
 * Termíny, u nichž je čas na připomínku (datum - pripominka dní <= dnes) a ještě neproběhla.
 * Konzumuje M7 reminder sweep. Bez DB → [].
 */
export async function getDueReminders(): Promise<TerminRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<TerminRow>(
      `SELECT ${TERMIN_COLS} FROM crm_terminy
       WHERE pripominka IS NOT NULL AND pripomenuto_at IS NULL
         AND datum - (pripominka || ' days')::interval <= CURRENT_DATE
         AND datum >= CURRENT_DATE`,
    );
    return r.rows;
  } catch {
    return [];
  }
}

export async function markReminded(id: string): Promise<void> {
  if (!dbReady()) return;
  try {
    await query('UPDATE crm_terminy SET pripomenuto_at = NOW() WHERE id = $1::bigint', [id]);
  } catch {
    // best-effort
  }
}
