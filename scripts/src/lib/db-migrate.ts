/**
 * Auto-migrace: čte SQL soubory z scripts/migrations/ a aplikuje je v pořadí.
 * Sleduje aplikované migrace v tabulce _migrations.
 */
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { getPool } from './db.js';

const MIGRATIONS_DIR = new URL('../../../migrations', import.meta.url).pathname;

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  if (!pool) {
    console.log('Migrate: skipped (no database)');
    return;
  }

  // Tabulka pro sledování migrací
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Načíst aplikované migrace
  const { rows: applied } = await pool.query<{ name: string }>(
    'SELECT name FROM _migrations ORDER BY name',
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  // Načíst dostupné SQL soubory
  let files: string[];
  try {
    files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.log('Migrate: no migrations directory found');
    return;
  }

  const pending = files.filter((f) => !appliedSet.has(f));
  if (pending.length === 0) {
    console.log(`Migrate: all ${files.length} migrations already applied`);
    return;
  }

  console.log(`Migrate: applying ${pending.length} pending migration(s)...`);

  for (const file of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Migrate: ✓ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Migrate: ✗ ${file}`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log('Migrate: done');
}
