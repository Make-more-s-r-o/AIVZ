/**
 * CRM store (M7) — in-app notifikace (zvonek). Modelováno dle crm-store logActivity:
 * notify() je BEST-EFFORT (nikdy nevyhazuje, neblokuje primární akci) a přeskakuje
 * self-notifikaci (příjemce === actor). Čtení degradují bez DB. Dedup přes partial-unique index.
 */
import { query, getPool } from './db.js';

export interface NotifRow {
  id: string;
  user_id: string;
  typ: string;
  text: string;
  url: string | null;
  tender_id: string | null;
  entity_typ: string | null;
  entity_id: string | null;
  actor_id: string | null;
  precteno: boolean;
  created_at: string;
}

function dbReady(): boolean {
  return getPool() !== null;
}

const NOTIF_COLS = `id::text, user_id, typ, text, url, tender_id, entity_typ, entity_id, actor_id, precteno, created_at`;

export interface NotifyInput {
  user_id: string;                 // příjemce
  typ: string;
  text: string;
  url?: string | null;
  tender_id?: string | null;
  entity_typ?: string | null;
  entity_id?: string | null;
  actor_id?: string | null;        // kdo akci vyvolal (self-notif se přeskočí)
  dedup_key?: string | null;
}

/** Best-effort založení notifikace (nikdy nevyhazuje, neblokuje). Skip self-notif. */
export async function notify(input: NotifyInput): Promise<void> {
  if (!dbReady()) return;
  if (!input.user_id) return;
  if (input.actor_id && input.actor_id === input.user_id) return; // neupozorňuj sám sebe
  try {
    await query(
      `INSERT INTO crm_notifikace (user_id, typ, text, url, tender_id, entity_typ, entity_id, actor_id, dedup_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, dedup_key) WHERE precteno = FALSE AND dedup_key IS NOT NULL DO NOTHING`,
      [
        input.user_id, input.typ, input.text, input.url ?? null, input.tender_id ?? null,
        input.entity_typ ?? null, input.entity_id ?? null, input.actor_id ?? null, input.dedup_key ?? null,
      ],
    );
  } catch {
    // notifikace jsou best-effort — nikdy neblokovat primární akci
  }
}

export async function getNotifications(userId: string, opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<NotifRow[]> {
  if (!dbReady() || !userId) return [];
  try {
    const where = opts.unreadOnly ? 'WHERE user_id = $1 AND precteno = FALSE' : 'WHERE user_id = $1';
    const r = await query<NotifRow>(
      `SELECT ${NOTIF_COLS} FROM crm_notifikace ${where} ORDER BY created_at DESC LIMIT $2`,
      [userId, opts.limit ?? 30],
    );
    return r.rows;
  } catch {
    return [];
  }
}

export async function getUnreadCount(userId: string): Promise<number> {
  if (!dbReady() || !userId) return 0;
  try {
    const r = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM crm_notifikace WHERE user_id = $1 AND precteno = FALSE',
      [userId],
    );
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** Označit přečtené. Bez ids → všechny uživatelovy. Vrací počet dotčených. */
export async function markRead(userId: string, ids?: string[]): Promise<number> {
  if (!dbReady() || !userId) throw new Error('db_unavailable');
  if (ids && ids.length > 0) {
    // Max 18 číslic — vejde se do bigintu (jinak ::bigint cast hodí 22003 → 500).
    const numeric = ids.filter((x) => /^\d{1,18}$/.test(x));
    if (numeric.length === 0) return 0;
    const r = await query(
      `UPDATE crm_notifikace SET precteno = TRUE, read_at = NOW()
       WHERE user_id = $1 AND precteno = FALSE AND id = ANY($2::bigint[])`,
      [userId, numeric],
    );
    return r.rowCount ?? 0;
  }
  const r = await query(
    'UPDATE crm_notifikace SET precteno = TRUE, read_at = NOW() WHERE user_id = $1 AND precteno = FALSE',
    [userId],
  );
  return r.rowCount ?? 0;
}
