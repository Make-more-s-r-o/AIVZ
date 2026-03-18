/**
 * PostgreSQL connection pool pro cenový sklad.
 * Vrací null pokud DATABASE_URL není nastavena (graceful degradation).
 */
import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool | null {
  if (pool) return pool;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('DB: DATABASE_URL not set — warehouse features disabled');
    return null;
  }

  pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err) => {
    console.error('DB: unexpected pool error', err);
  });

  return pool;
}

/** Query helper s typováním */
export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const p = getPool();
  if (!p) throw new Error('Database not available');
  return p.query<T>(text, params);
}

/** Single row helper */
export async function queryOne<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

/** Zjistí, zda je DB dostupná */
export async function isDbAvailable(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await p.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Graceful shutdown */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('DB: pool closed');
  }
}
