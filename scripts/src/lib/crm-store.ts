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
    const row = await queryOne<{ status: StageKey; assignee: string | null }>(
      'SELECT status, assignee FROM crm_tender_status WHERE tender_id = $1',
      [tenderId],
    );
    return row ? { status: row.status, assignee: row.assignee } : null;
  } catch {
    return null;
  }
}

export async function getAllStatuses(): Promise<Map<string, TenderStatus>> {
  const map = new Map<string, TenderStatus>();
  if (!dbReady()) return map;
  try {
    const r = await query<{ tender_id: string; status: StageKey; assignee: string | null }>(
      'SELECT tender_id, status, assignee FROM crm_tender_status',
    );
    for (const row of r.rows) map.set(row.tender_id, { status: row.status, assignee: row.assignee });
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
