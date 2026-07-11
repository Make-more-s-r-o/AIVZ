/**
 * CLI: re-kategorizace existujících záznamů ve win_prices podle aktuální keyword
 * heuristiky (categorizeCommodity v lib/winprice-store.ts).
 *
 * Historicky skončila naprostá většina řádků v kategorii 'ostatni', protože dřívější
 * keyword mapa byla úzká — go/no-go skóre i cenová pásma tak měly v ostatních
 * kategoriích příliš tenká data. Tento CLI po rozšíření keyword mapy přepočítá
 * kategorii u existujících záznamů a zapíše jen ty, kde se liší od uložené hodnoty
 * (idempotentní běh — opakované spuštění beze změny predmet/heuristiky nic nemění).
 *
 * NEVOLÁ žádné AI API — čistě keyword heuristika, žádná migrace (sloupec
 * komodita_kategorie je TEXT bez CHECK constraintu).
 *
 * Použití:
 *   npx tsx src/recategorize-win-prices.ts --dry-run              # jen report, bez zápisu
 *   npx tsx src/recategorize-win-prices.ts --dry-run --limit=1000  # report nad výřezem dat
 *   npx tsx src/recategorize-win-prices.ts                         # zapíše změny do DB
 *   npx tsx src/recategorize-win-prices.ts --limit=5000             # zapíše jen prvních N řádků (dle id)
 */
import { config } from 'dotenv';
import { closePool, query } from './lib/db.js';
import { categorizeCommodity, type KomoditaKategorie } from './lib/winprice-store.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

export interface RecategorizeRow {
  id: number;
  predmet: string;
  komodita_kategorie: string;
}

export interface RecategorizePlanItem {
  id: number;
  from: string;
  to: KomoditaKategorie;
}

export interface RecategorizePlan {
  toUpdate: RecategorizePlanItem[];
  distributionBefore: Record<string, number>;
  distributionAfter: Record<string, number>;
}

/**
 * Čistá funkce (bez DB, testovatelná bez Postgresu) — pro každý řádek spočítá novou
 * kategorii dle aktuální heuristiky a vrátí jen řádky, kde se liší od uložené hodnoty,
 * plus rozložení kategorií před/po (pro report).
 */
export function planRecategorization(rows: RecategorizeRow[]): RecategorizePlan {
  const distributionBefore: Record<string, number> = {};
  const distributionAfter: Record<string, number> = {};
  const toUpdate: RecategorizePlanItem[] = [];

  for (const row of rows) {
    const from = row.komodita_kategorie;
    distributionBefore[from] = (distributionBefore[from] ?? 0) + 1;

    const to = categorizeCommodity(row.predmet);
    distributionAfter[to] = (distributionAfter[to] ?? 0) + 1;

    if (to !== from) {
      toUpdate.push({ id: row.id, from, to });
    }
  }

  return { toUpdate, distributionBefore, distributionAfter };
}

/** Formátuje rozložení kategorií pro výpis (sestupně dle počtu). */
export function formatDistribution(dist: Record<string, number>): string {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  return Object.entries(dist)
    .sort(([, a], [, b]) => b - a)
    .map(([kat, pocet]) => `${kat}=${pocet}`)
    .join(', ') || `(prázdné, n=${total})`;
}

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
function getArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/**
 * Zapíše nové kategorie do DB po dávkách přes `UPDATE … FROM (VALUES …)`, aby se
 * i velký počet změn vešel do limitu parametrů jednoho dotazu.
 */
async function applyUpdates(items: RecategorizePlanItem[]): Promise<number> {
  if (items.length === 0) return 0;
  const CHUNK = 500; // 2 parametry na řádek → 1000 parametrů/dávka, bezpečně pod limitem 65535
  let affected = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const rows: string[] = [];
    chunk.forEach((item, idx) => {
      rows.push(`($${idx * 2 + 1}::bigint, $${idx * 2 + 2}::text)`);
      values.push(item.id, item.to);
    });
    const sql = `
      UPDATE win_prices AS w
      SET komodita_kategorie = v.kat
      FROM (VALUES ${rows.join(',')}) AS v(id, kat)
      WHERE w.id = v.id
    `;
    const res = await query(sql, values);
    affected += res.rowCount ?? 0;
  }
  return affected;
}

async function loadRows(limit?: number): Promise<RecategorizeRow[]> {
  const sql = `SELECT id, predmet, komodita_kategorie FROM win_prices ORDER BY id${limit ? ' LIMIT $1' : ''}`;
  const { rows } = await query<{ id: number; predmet: string; komodita_kategorie: string }>(
    sql,
    limit ? [limit] : [],
  );
  return rows;
}

async function main(): Promise<void> {
  const dryRun = hasFlag('dry-run');
  const limitArg = getArg('limit');
  const limit = limitArg ? Number(limitArg) : undefined;
  if (limitArg && (!Number.isFinite(limit) || (limit as number) <= 0)) {
    console.error(`Neplatný --limit: ${limitArg}`);
    process.exit(1);
    return;
  }

  console.log(
    `\nWin-price re-kategorizace — ${dryRun ? 'DRY RUN (bez zápisu)' : 'ZÁPIS do DB'}` +
      `${limit ? `, limit=${limit}` : ''}`,
  );

  const rows = await loadRows(limit);
  console.log(`Načteno ${rows.length} záznamů.`);

  const plan = planRecategorization(rows);

  console.log(`\nRozložení PŘED: ${formatDistribution(plan.distributionBefore)}`);
  console.log(`Rozložení PO:   ${formatDistribution(plan.distributionAfter)}`);
  console.log(`\nKe změně: ${plan.toUpdate.length} z ${rows.length} záznamů.`);

  if (dryRun) {
    console.log('\nDry-run — žádný zápis do DB.');
    await closePool();
    return;
  }

  const affected = await applyUpdates(plan.toUpdate);
  console.log(`\nHotovo. Aktualizováno ${affected} záznamů.`);
  await closePool();
}

// Spustí se jen při přímém běhu (`npx tsx src/recategorize-win-prices.ts`), ne při importu
// pure funkcí (planRecategorization, formatDistribution) z testů.
const isMainModule = process.argv[1] !== undefined
  && import.meta.url === new URL(process.argv[1], 'file://').href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
