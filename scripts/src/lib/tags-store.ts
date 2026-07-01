/**
 * CRM store (M9b) — štítky (tags) k zakázkám. Vzor crm-store: čtení degradují bez DB ([]/mapa),
 * zápisy vyhazují 'db_unavailable' (endpoint → 503). Barva = preset key (validuje endpoint).
 */
import { query, queryOne, getPool } from './db.js';

export interface TagRow {
  id: string;
  nazev: string;
  barva: string;
  created_by: string | null;
  created_at: string;
}

function dbReady(): boolean {
  return getPool() !== null;
}

const TAG_COLS = `id::text, nazev, barva, created_by, created_at`;

/** Globální číselník štítků. */
export async function getTags(): Promise<TagRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<TagRow>(`SELECT ${TAG_COLS} FROM crm_stitky ORDER BY nazev ASC`);
    return r.rows;
  } catch {
    return [];
  }
}

export async function createTag(nazev: string, barva: string, createdBy: string | null): Promise<TagRow> {
  if (!dbReady()) throw new Error('db_unavailable');
  // Idempotentní na název: existující štítek se vrátí (nezaloží duplicitu).
  const row = await queryOne<TagRow>(
    `INSERT INTO crm_stitky (nazev, barva, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (nazev) DO UPDATE SET nazev = EXCLUDED.nazev
     RETURNING ${TAG_COLS}`,
    [nazev, barva, createdBy],
  );
  return row!;
}

export async function deleteTag(id: string): Promise<boolean> {
  if (!dbReady()) throw new Error('db_unavailable');
  // zakazka_stitky se odpojí kaskádně (ON DELETE CASCADE).
  const r = await query('DELETE FROM crm_stitky WHERE id = $1::bigint', [id]);
  return (r.rowCount ?? 0) > 0;
}

/** Štítky konkrétní zakázky. */
export async function getTenderTags(tenderId: string): Promise<TagRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<TagRow>(
      `SELECT s.id::text, s.nazev, s.barva, s.created_by, s.created_at
       FROM zakazka_stitky zs JOIN crm_stitky s ON s.id = zs.stitek_id
       WHERE zs.tender_id = $1 ORDER BY s.nazev ASC`,
      [tenderId],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/** Mapa tender_id → štítky[] pro obohacení seznamu zakázek (chips na řádcích). */
export async function getAllTenderTags(): Promise<Map<string, TagRow[]>> {
  const map = new Map<string, TagRow[]>();
  if (!dbReady()) return map;
  try {
    const r = await query<TagRow & { tender_id: string }>(
      `SELECT zs.tender_id, s.id::text, s.nazev, s.barva, s.created_by, s.created_at
       FROM zakazka_stitky zs JOIN crm_stitky s ON s.id = zs.stitek_id
       ORDER BY s.nazev ASC`,
    );
    for (const row of r.rows) {
      const { tender_id, ...tag } = row;
      const arr = map.get(tender_id) ?? [];
      arr.push(tag as TagRow);
      map.set(tender_id, arr);
    }
  } catch {
    // degrade silently
  }
  return map;
}

export async function attachTag(tenderId: string, stitekId: string): Promise<void> {
  if (!dbReady()) throw new Error('db_unavailable');
  await query(
    `INSERT INTO zakazka_stitky (tender_id, stitek_id) VALUES ($1, $2::bigint)
     ON CONFLICT (tender_id, stitek_id) DO NOTHING`,
    [tenderId, stitekId],
  );
}

export async function detachTag(tenderId: string, stitekId: string): Promise<boolean> {
  if (!dbReady()) throw new Error('db_unavailable');
  const r = await query('DELETE FROM zakazka_stitky WHERE tender_id = $1 AND stitek_id = $2::bigint', [tenderId, stitekId]);
  return (r.rowCount ?? 0) > 0;
}
