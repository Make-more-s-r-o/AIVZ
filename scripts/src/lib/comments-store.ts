/**
 * CRM store (M8) — týmové komentáře k zakázce + @mention. Modelováno dle crm-store/notif-store:
 * čtení degradují bez DB (getPool() === null → []/null), zápisy vyhazují 'db_unavailable'
 * (endpoint přeloží na 503). Soft-delete přes deleted_at (živý = deleted_at IS NULL).
 * mentions = pole user id (sub); validace na reálné uživatele se dělá v endpointu, ne tady.
 */
import { query, queryOne, getPool } from './db.js';

export interface CommentRow {
  id: string;
  tender_id: string;
  text: string;
  mentions: string[];
  author_id: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
}

function dbReady(): boolean {
  return getPool() !== null;
}

// COALESCE(mentions, '[]') pro jistotu; node-pg vrací jsonb už jako JS pole.
const COMMENT_COLS = `id::text, tender_id, text,
  COALESCE(mentions, '[]'::jsonb) AS mentions,
  author_id, author_name, created_at, updated_at`;

export async function getComments(tenderId: string): Promise<CommentRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<CommentRow>(
      `SELECT ${COMMENT_COLS} FROM crm_komentare
       WHERE tender_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC, id ASC`,
      [tenderId],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/** Jeden živý komentář (pro ověření vlastnictví před smazáním). */
export async function getComment(id: string): Promise<CommentRow | null> {
  if (!dbReady()) return null;
  try {
    return await queryOne<CommentRow>(
      `SELECT ${COMMENT_COLS} FROM crm_komentare WHERE id = $1::bigint AND deleted_at IS NULL`,
      [id],
    );
  } catch {
    return null;
  }
}

export interface CreateCommentInput {
  tender_id: string;
  text: string;
  mentions?: string[];
  author_id?: string | null;
  author_name?: string | null;
}

export async function createComment(input: CreateCommentInput): Promise<CommentRow> {
  if (!dbReady()) throw new Error('db_unavailable');
  const mentions = Array.isArray(input.mentions) ? input.mentions : [];
  const row = await queryOne<CommentRow>(
    `INSERT INTO crm_komentare (tender_id, text, mentions, author_id, author_name)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     RETURNING ${COMMENT_COLS}`,
    [input.tender_id, input.text, JSON.stringify(mentions), input.author_id ?? null, input.author_name ?? null],
  );
  return row!;
}

/**
 * Soft-delete komentáře (deleted_at = NOW()). Vlastnictví (autor/admin) hlídá endpoint.
 * Idempotentní: 2. mazání téhož řádku vrátí false (už není živý).
 */
export async function softDeleteComment(id: string): Promise<boolean> {
  if (!dbReady()) throw new Error('db_unavailable');
  const r = await query(
    `UPDATE crm_komentare SET deleted_at = NOW(), updated_at = NOW()
     WHERE id = $1::bigint AND deleted_at IS NULL`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}
