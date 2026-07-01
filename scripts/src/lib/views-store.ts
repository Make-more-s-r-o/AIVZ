/**
 * CRM store (M9b) — uložené pohledy (saved views). Vzor crm-store/notif-store:
 * čtení degradují bez DB ([]/null), zápisy vyhazují 'db_unavailable' (endpoint → 503).
 * Vlastnictví (owner/admin u delete) hlídá endpoint, ne store.
 */
import { query, queryOne, getPool } from './db.js';

export interface ViewRow {
  id: string;
  user_id: string;
  nazev: string;
  definice: Record<string, unknown>;
  je_sdileny: boolean;
  created_at: string;
}

function dbReady(): boolean {
  return getPool() !== null;
}

const VIEW_COLS = `id::text, user_id, nazev, COALESCE(definice, '{}'::jsonb) AS definice, je_sdileny, created_at`;

/** Pohledy viditelné uživateli: vlastní + sdílené týmové. */
export async function getViews(userId: string): Promise<ViewRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<ViewRow>(
      `SELECT ${VIEW_COLS} FROM crm_ulozene_pohledy
       WHERE user_id = $1 OR je_sdileny = TRUE
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return r.rows;
  } catch {
    return [];
  }
}

export async function getView(id: string): Promise<ViewRow | null> {
  if (!dbReady()) return null;
  try {
    return await queryOne<ViewRow>(`SELECT ${VIEW_COLS} FROM crm_ulozene_pohledy WHERE id = $1::bigint`, [id]);
  } catch {
    return null;
  }
}

export interface CreateViewInput {
  user_id: string;
  nazev: string;
  definice?: Record<string, unknown>;
  je_sdileny?: boolean;
}

export async function createView(input: CreateViewInput): Promise<ViewRow> {
  if (!dbReady()) throw new Error('db_unavailable');
  const row = await queryOne<ViewRow>(
    `INSERT INTO crm_ulozene_pohledy (user_id, nazev, definice, je_sdileny)
     VALUES ($1, $2, $3::jsonb, COALESCE($4, FALSE))
     RETURNING ${VIEW_COLS}`,
    [input.user_id, input.nazev, JSON.stringify(input.definice ?? {}), input.je_sdileny ?? null],
  );
  return row!;
}

export async function deleteView(id: string): Promise<boolean> {
  if (!dbReady()) throw new Error('db_unavailable');
  const r = await query('DELETE FROM crm_ulozene_pohledy WHERE id = $1::bigint', [id]);
  return (r.rowCount ?? 0) > 0;
}
