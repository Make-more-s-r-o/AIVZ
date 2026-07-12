/** CLI Outcome Watcher — vytváří výhradně návrhy, nikdy crm_vysledky. */
import { config } from 'dotenv';
import { runMigrations } from './lib/db-migrate.js';
import { closePool } from './lib/db.js';
import { findNenOutcome } from './lib/outcome-watcher.js';
import { listWatchableTenders, saveOutcomeCandidate } from './lib/outcome-kandidati-store.js';
config({ path: new URL('../../.env', import.meta.url).pathname });

export async function watchOutcomes(): Promise<{ zkontrolovano: number; nalezeno: number }> {
  const tenders = await listWatchableTenders();
  let nalezeno = 0;
  for (const tender of tenders) {
    const candidate = await findNenOutcome(tender);
    if (candidate && await saveOutcomeCandidate(candidate)) nalezeno += 1;
  }
  return { zkontrolovano: tenders.length, nalezeno };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().then(watchOutcomes).then((r) => console.log(`Outcome watcher: zkontrolováno ${r.zkontrolovano}, nových návrhů ${r.nalezeno}.`)).catch((e) => { console.error(`Outcome watcher selhal: ${String(e)}`); process.exitCode = 1; }).finally(closePool);
}
