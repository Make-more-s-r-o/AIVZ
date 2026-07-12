/** CLI pro bezpečné doplnění identity historických webových nálezů. */
import { config } from 'dotenv';
import { closePool, getPool, query } from './lib/db.js';
import { backfillFindingsIdentity, loadBackfillMetadata } from './lib/backfill-findings-identity.js';

config({ path: new URL('../../.env', import.meta.url).pathname });
const ROOT = new URL('../../', import.meta.url).pathname;

function limitArg(): number | undefined {
  const raw = process.argv.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('--limit musí být nezáporné celé číslo');
  return parsed;
}

async function main(): Promise<void> {
  if (getPool() === null) throw new Error('Chybí DATABASE_URL; backfill nelze spustit.');
  const dryRun = process.argv.includes('--dry-run');
  const metadata = await loadBackfillMetadata(`${ROOT}output`);
  const summary = await backfillFindingsIdentity({ query, metadata, dryRun, limit: limitArg() });
  console.log(`${dryRun ? 'DRY-RUN: ' : ''}Prošlo řádků: ${summary.rowsScanned}, doplněno: ${summary.rowsChanged}.`);
  console.log(`Řádky s identitou před/po: ${summary.identityBefore}/${summary.identityAfter}.`);
}

main().catch((error) => {
  console.error(`Backfill selhal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}).finally(closePool);
