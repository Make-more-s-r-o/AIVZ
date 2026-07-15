/**
 * CRM store (M2) — perzistovaný stav zakázky + log aktivit ve sdíleném Postgresu
 * (vz_warehouse). Modelováno dle warehouse-store.ts nad db.ts.
 * Graceful degradace: bez DB (getPool() === null) vrací prázdno / vyhazuje 'db_unavailable'
 * u zápisů (endpoint to přeloží na 503).
 */
import { query, queryOne, getPool } from './db.js';
import type { StageKey } from './stage-machine.js';

export interface TenderStatus {
  status: StageKey;
  assignee: string | null;
  archived: boolean;
  deleted: boolean;
}

export interface ActivityEntry {
  id: string;
  tender_id: string;
  type: string;
  actor_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
}

function dbReady(): boolean {
  return getPool() !== null;
}

export async function getStatus(tenderId: string): Promise<TenderStatus | null> {
  if (!dbReady()) return null;
  try {
    const row = await queryOne<{ status: StageKey; assignee: string | null; archived_at: string | null; deleted_at: string | null }>(
      'SELECT status, assignee, archived_at, deleted_at FROM crm_tender_status WHERE tender_id = $1',
      [tenderId],
    );
    return row
      ? { status: row.status, assignee: row.assignee, archived: row.archived_at != null, deleted: row.deleted_at != null }
      : null;
  } catch {
    return null;
  }
}

export async function getAllStatuses(): Promise<Map<string, TenderStatus>> {
  const map = new Map<string, TenderStatus>();
  if (!dbReady()) return map;
  try {
    const r = await query<{ tender_id: string; status: StageKey; assignee: string | null; archived_at: string | null; deleted_at: string | null }>(
      'SELECT tender_id, status, assignee, archived_at, deleted_at FROM crm_tender_status',
    );
    for (const row of r.rows) map.set(row.tender_id, {
      status: row.status,
      assignee: row.assignee,
      archived: row.archived_at != null,
      deleted: row.deleted_at != null,
    });
  } catch {
    // degrade silently
  }
  return map;
}

export async function setStatus(tenderId: string, status: StageKey): Promise<void> {
  if (!dbReady()) throw new Error('db_unavailable');
  await query(
    `INSERT INTO crm_tender_status (tender_id, status) VALUES ($1, $2)
     ON CONFLICT (tender_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
    [tenderId, status],
  );
}

export async function setAssignee(
  tenderId: string,
  assignee: string | null,
  fallbackStatus: StageKey,
): Promise<void> {
  if (!dbReady()) throw new Error('db_unavailable');
  await query(
    `INSERT INTO crm_tender_status (tender_id, status, assignee) VALUES ($1, $2, $3)
     ON CONFLICT (tender_id) DO UPDATE SET assignee = EXCLUDED.assignee, updated_at = NOW()`,
    [tenderId, fallbackStatus, assignee],
  );
}

/** Archivace / odarchivace zakázky (příznak ortogonální ke stavu). Upsertuje řádek. */
export async function setArchived(
  tenderId: string,
  archived: boolean,
  actorId: string | null,
  fallbackStatus: StageKey,
): Promise<void> {
  if (!dbReady()) throw new Error('db_unavailable');
  await query(
    `INSERT INTO crm_tender_status (tender_id, status, archived_at, archived_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tender_id) DO UPDATE SET archived_at = $3, archived_by = $4, updated_at = NOW()`,
    [tenderId, fallbackStatus, archived ? new Date().toISOString() : null, archived ? actorId : null],
  );
}

/** Soft-delete / obnova zakázky (přesun do Koše, vratné). Upsertuje řádek. */
export async function setDeleted(
  tenderId: string,
  deleted: boolean,
  actorId: string | null,
  fallbackStatus: StageKey,
): Promise<void> {
  if (!dbReady()) throw new Error('db_unavailable');
  await query(
    `INSERT INTO crm_tender_status (tender_id, status, deleted_at, deleted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tender_id) DO UPDATE SET deleted_at = $3, deleted_by = $4, updated_at = NOW()`,
    [tenderId, fallbackStatus, deleted ? new Date().toISOString() : null, deleted ? actorId : null],
  );
}

/**
 * Trvalý úklid VŠECH DB dat navázaných na zakázku (tender_id) v jedné transakci.
 * Zakázka není DB entita → žádné FK CASCADE, mažeme ručně napříč tabulkami.
 * POZOR: při přidání nové tabulky s `tender_id` ji doplnit i sem (viz CLAUDE.md).
 * monitoring_zakazky se nemaže, jen odpojí (zachovat historii monitoringu).
 */
export async function purgeTenderData(tenderId: string): Promise<void> {
  if (!dbReady()) throw new Error('db_unavailable');
  const pool = getPool();
  if (!pool) throw new Error('db_unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = [
      'crm_activity', 'crm_tasks', 'crm_terminy', 'crm_notifikace', 'crm_komentare',
      'zakazka_stitky', 'crm_vysledky', 'crm_nakupy', 'tender_product_matches',
      'warehouse_web_findings', 'bid_snapshots', 'crm_score_snapshots', 'outcome_kandidati',
    ];
    for (const t of tables) {
      await client.query(`DELETE FROM ${t} WHERE tender_id = $1`, [tenderId]);
    }
    // Monitoring: zachovat záznam, jen odpojit vazbu na smazanou zakázku.
    await client.query('UPDATE monitoring_zakazky SET tender_id = NULL WHERE tender_id = $1', [tenderId]);
    // Nakonec status řádek samotný.
    await client.query('DELETE FROM crm_tender_status WHERE tender_id = $1', [tenderId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function logActivity(
  tenderId: string,
  type: string,
  actorId: string | null,
  payload: Record<string, unknown> | null,
): Promise<void> {
  if (!dbReady()) return;
  try {
    await query(
      'INSERT INTO crm_activity (tender_id, type, actor_id, payload) VALUES ($1, $2, $3, $4)',
      [tenderId, type, actorId, payload ? JSON.stringify(payload) : null],
    );
  } catch {
    // logging is best-effort — never block the primary action
  }
}

export async function getActivity(tenderId: string, limit = 50): Promise<ActivityEntry[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<ActivityEntry>(
      `SELECT id::text, tender_id, type, actor_id, payload, created_at
       FROM crm_activity WHERE tender_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenderId, limit],
    );
    return r.rows;
  } catch {
    return [];
  }
}

export async function getRecentActivity(limit = 20): Promise<ActivityEntry[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<ActivityEntry>(
      `SELECT id::text, tender_id, type, actor_id, payload, created_at
       FROM crm_activity ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  } catch {
    return [];
  }
}

// --- Úkoly + checklisty (M3) ---

export interface TaskRow {
  id: string;
  tender_id: string;
  title: string;
  assignee: string | null;
  due_date: string | null; // 'YYYY-MM-DD' | null
  stav: string;
  priorita: string;
  je_checklist: boolean;
  seed_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

// due_date přes to_char, jinak node-pg parsuje DATE na JS Date v lokální půlnoci a
// JSON.stringify ji posune o TZ offset → off-by-one v prohlížeči. Ostatní timestamptz sloupce
// serializují korektně samy.
const TASK_COLS = `id::text, tender_id, title, assignee,
  to_char(due_date, 'YYYY-MM-DD') AS due_date,
  stav, priorita, je_checklist, seed_key, created_by,
  created_at, updated_at, completed_at`;

export async function getTask(id: string): Promise<TaskRow | null> {
  if (!dbReady()) return null;
  try {
    return await queryOne<TaskRow>(`SELECT ${TASK_COLS} FROM crm_tasks WHERE id = $1::bigint`, [id]);
  } catch {
    return null;
  }
}

export async function getTasks(tenderId: string): Promise<TaskRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<TaskRow>(
      `SELECT ${TASK_COLS} FROM crm_tasks WHERE tender_id = $1 ORDER BY created_at ASC, id ASC`,
      [tenderId],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/** Nedokončené úkoly přiřazené uživateli napříč zakázkami (dashboard „Moje úkoly"). */
export async function getMyTasks(assignee: string, limit = 100): Promise<TaskRow[]> {
  if (!dbReady()) return [];
  try {
    const r = await query<TaskRow>(
      `SELECT ${TASK_COLS} FROM crm_tasks
       WHERE assignee = $1 AND stav <> 'hotovo'
       ORDER BY (due_date IS NULL), due_date ASC, created_at ASC
       LIMIT $2`,
      [assignee, limit],
    );
    return r.rows;
  } catch {
    return [];
  }
}

/** Počty úkolů na zakázku pro kanban chip „Úkoly {done}/{total}". */
export async function getTaskCounts(): Promise<Map<string, { done: number; total: number }>> {
  const map = new Map<string, { done: number; total: number }>();
  if (!dbReady()) return map;
  try {
    const r = await query<{ tender_id: string; total: number; done: number }>(
      `SELECT tender_id, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE stav = 'hotovo')::int AS done
       FROM crm_tasks GROUP BY tender_id`,
    );
    for (const row of r.rows) map.set(row.tender_id, { done: row.done, total: row.total });
  } catch {
    // degrade silently
  }
  return map;
}

export interface CreateTaskInput {
  tender_id: string;
  title: string;
  assignee?: string | null;
  due_date?: string | null;
  stav?: string;
  priorita?: string;
  je_checklist?: boolean;
  created_by?: string | null;
}

export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  if (!dbReady()) throw new Error('db_unavailable');
  const row = await queryOne<TaskRow>(
    `INSERT INTO crm_tasks (tender_id, title, assignee, due_date, stav, priorita, je_checklist, created_by)
     VALUES ($1, $2, $3, $4, COALESCE($5,'k_vyrizeni'), COALESCE($6,'stredni'), COALESCE($7,FALSE), $8)
     RETURNING ${TASK_COLS}`,
    [
      input.tender_id, input.title, input.assignee ?? null, input.due_date ?? null,
      input.stav ?? null, input.priorita ?? null, input.je_checklist ?? null, input.created_by ?? null,
    ],
  );
  return row!;
}

// Whitelist sloupců pro partial update — názvy sloupců pocházejí VÝHRADNĚ odsud, nikdy z requestu.
const UPDATABLE = ['title', 'assignee', 'due_date', 'stav', 'priorita'] as const;

export async function updateTask(id: string, patch: Record<string, unknown>): Promise<TaskRow | null> {
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
  // completed_at bookkeeping při změně stav (idempotentní: první čas dokončení se drží).
  if ('stav' in patch && patch.stav !== undefined) {
    sets.push(`completed_at = CASE WHEN $${i} = 'hotovo' THEN COALESCE(completed_at, NOW()) ELSE NULL END`);
    params.push(patch.stav);
    i++;
  }
  if (sets.length === 0) return getTask(id);
  sets.push('updated_at = NOW()');
  params.push(id);
  return await queryOne<TaskRow>(
    `UPDATE crm_tasks SET ${sets.join(', ')} WHERE id = $${i}::bigint RETURNING ${TASK_COLS}`,
    params,
  );
}

export async function deleteTask(id: string): Promise<boolean> {
  if (!dbReady()) throw new Error('db_unavailable');
  const r = await query('DELETE FROM crm_tasks WHERE id = $1::bigint', [id]);
  return (r.rowCount ?? 0) > 0;
}

export interface SeedItem {
  title: string;
  seed_key: string;
  priorita?: string;
}

/**
 * Idempotentní seed checklistu. Vloží jen nové položky (dle content-hash seed_key);
 * existující (i uživatelem upravené) zůstanou nedotčené díky ON CONFLICT DO NOTHING.
 * Vrací počet skutečně vložených řádků.
 */
export async function seedChecklist(tenderId: string, items: SeedItem[]): Promise<number> {
  if (!dbReady()) throw new Error('db_unavailable');
  if (items.length === 0) return 0;
  const rows: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const it of items) {
    rows.push(`($${i++}, $${i++}, TRUE, 'k_vyrizeni', COALESCE($${i++},'stredni'), $${i++})`);
    params.push(tenderId, it.title, it.priorita ?? null, it.seed_key);
  }
  const r = await query(
    `INSERT INTO crm_tasks (tender_id, title, je_checklist, stav, priorita, seed_key)
     VALUES ${rows.join(', ')}
     ON CONFLICT (tender_id, seed_key) WHERE seed_key IS NOT NULL DO NOTHING`,
    params,
  );
  return r.rowCount ?? 0;
}
