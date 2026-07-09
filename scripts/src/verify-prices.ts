/**
 * CLI: ověření reálných cen web-searchem pro danou zakázku.
 *
 * Načte output/<id>/product-match.json, přes web search dohledá aktuální ceny
 * v českých e-shopech a MERGE `overeni_ceny` do jednotlivých položek (ostatní
 * pole nedotčená), pak atomicky (tmp + rename) zapíše soubor zpět.
 *
 * NIKDY nesahá na `cenova_uprava` — tu potvrzuje uživatel v UI (money-path).
 *
 * Použití:
 *   npx tsx src/verify-prices.ts --tender-id=<id> [--limit=N] [--only-index=i]
 */
import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { verifyAllPrices, type OvereniCeny } from './lib/price-verifier.js';
import type { ProductMatch, PolozkaMatch } from './lib/types.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

function getArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

function parseIntArg(name: string): number | undefined {
  const v = getArg(name);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

async function main(): Promise<void> {
  const tenderId = getArg('tender-id');
  if (!tenderId) {
    console.error('Chybí --tender-id=<id>');
    console.error('Použití: npx tsx src/verify-prices.ts --tender-id=<id> [--limit=N] [--only-index=i]');
    process.exit(1);
  }
  const limit = parseIntArg('limit');
  const onlyIndex = parseIntArg('only-index');

  const matchPath = join(ROOT, 'output', tenderId, 'product-match.json');
  let matchData: ProductMatch;
  try {
    matchData = JSON.parse(await readFile(matchPath, 'utf-8')) as ProductMatch;
  } catch (err) {
    console.error(`Nelze načíst ${matchPath}: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  console.log(`\nOvěřování cen web-searchem — zakázka ${tenderId}`);
  if (limit !== undefined) console.log(`  limit: ${limit}`);
  if (onlyIndex !== undefined) console.log(`  jen položka index: ${onlyIndex}`);

  const { results, summary } = await verifyAllPrices(matchData, {
    tenderId,
    limit,
    onlyIndex,
    onProgress: (m) => console.log('  ' + m),
  });

  // MERGE overeni_ceny do položek (ostatní pole nedotčená).
  //
  // POZOR na lost-update: web search běží MINUTY a `matchData` je snapshot z počátku běhu.
  // Mezitím může operátor v UI potvrdit ceny (`cenova_uprava`) — jednotlivě i hromadně přes
  // bulk endpoint — což zapisuje do stejného souboru. Kdybychom zapsali zpět starý snapshot,
  // tato potvrzení (money-path!) by tiše zmizela. Proto těsně před zápisem soubor znovu
  // načteme (čerstvá kopie) a mergujeme overeni_ceny jen do ní. Okno mezi tímto re-readem
  // a rename je milisekundy (místo minut), takže souběžná potvrzení zůstanou zachována.
  const byIndex = new Map<number, OvereniCeny>(results.map((r) => [r.polozka_index, r.overeni_ceny]));

  let fresh: ProductMatch;
  try {
    fresh = JSON.parse(await readFile(matchPath, 'utf-8')) as ProductMatch;
  } catch {
    // Kdyby čerstvé načtení selhalo, radši nepřepisuj soubor stale snapshotem —
    // overeni_ceny se dá klidně dohledat znovu, ale ztracená cenova_uprava ne.
    fresh = matchData;
  }

  if (Array.isArray(fresh.polozky_match)) {
    for (const item of fresh.polozky_match as (PolozkaMatch & { overeni_ceny?: OvereniCeny })[]) {
      const ov = byIndex.get(item.polozka_index);
      if (ov) item.overeni_ceny = ov;
    }
  } else {
    const rootOv = byIndex.get(-1);
    if (rootOv) (fresh as ProductMatch & { overeni_ceny?: OvereniCeny }).overeni_ceny = rootOv;
  }

  // Atomický zápis (tmp + rename) — nikdy nezanechá poškozený soubor
  const tmpPath = `${matchPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(fresh, null, 2), 'utf-8');
  await rename(tmpPath, matchPath);

  // Souhrn
  console.log('\n--- Souhrn ---');
  console.log(`  Ověřeno položek: ${summary.total}`);
  console.log(`  Nalezeno: ${summary.nalezeno}  |  Nenalezeno: ${summary.nenalezeno}  |  Chyba: ${summary.chyba}`);
  if (summary.prekracuje_strop > 0) console.log(`  Překračuje cenový strop: ${summary.prekracuje_strop}`);
  console.log(`  Web searchů: ${summary.searches}`);
  console.log(
    `  Tokeny: ${summary.inputTokens} in / ${summary.outputTokens} out  |  Náklad: ${summary.costCZK.toFixed(2)} CZK`,
  );
  console.log(`\nZapsáno do: ${matchPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
