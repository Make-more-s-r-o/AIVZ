/** Append-only PostgreSQL úložiště feature vektorů skóre. */
import { getPool, queryOne } from './db.js';
import type { ScoreFeatureVector } from './go-no-go.js';

export type ScoreSnapshotContext = 'prevzeti' | 'match' | 'finalize' | 'api';

export interface ScoreSnapshotInput {
  tender_id: string;
  typ: 'gonogo' | 'bid';
  skore: number | null;
  doporuceni: string | null;
  features: ScoreFeatureVector;
  kontext: ScoreSnapshotContext;
}

export interface StoredScoreSnapshot extends ScoreSnapshotInput {
  id: string;
  created_at: string;
}

interface StoreDeps {
  hasDb: () => boolean;
  insert: (sql: string, params?: unknown[]) => Promise<StoredScoreSnapshot | null>;
}

const defaultDeps: StoreDeps = {
  hasDb: () => getPool() !== null,
  insert: queryOne,
};

/** Jediná zapisovací operace store je INSERT; žádný řádek se později nemění. */
export async function insertScoreSnapshot(
  snapshot: ScoreSnapshotInput,
  deps: StoreDeps = defaultDeps,
): Promise<StoredScoreSnapshot | null> {
  if (!deps.hasDb()) return null;
  return deps.insert(
    `INSERT INTO crm_score_snapshots
       (tender_id, typ, skore, doporuceni, features, kontext)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id::text, tender_id, typ, skore, doporuceni, features, kontext, created_at`,
    [snapshot.tender_id, snapshot.typ, snapshot.skore, snapshot.doporuceni,
      JSON.stringify(snapshot.features), snapshot.kontext],
  );
}

/** Best-effort zápis: výpadek DB nikdy nesmí shodit hlavní obchodní operaci. */
export async function persistScoreSnapshotBestEffort(
  snapshot: ScoreSnapshotInput,
  warn: (message: string, error: unknown) => void = (message, error) => console.warn(message, error),
  insert: (value: ScoreSnapshotInput) => Promise<unknown> = insertScoreSnapshot,
): Promise<boolean> {
  try {
    await insert(snapshot);
    return true;
  } catch (error) {
    warn(`Uložení ${snapshot.typ} feature vektoru pro ${snapshot.tender_id} selhalo`, error);
    return false;
  }
}
