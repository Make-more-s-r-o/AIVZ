import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { QueryResult, QueryResultRow } from 'pg';
import { normalizeFindingItemName } from './web-findings-store.js';

export interface BackfillRow {
  id: number;
  tender_id: string;
  polozka_index: number;
  katalogove_cislo: string | null;
  vyrobce: string | null;
  model: string | null;
  nazev_polozky: string | null;
  polozka_nazev: string;
}

export interface BackfillMetadata {
  katalogove_cislo: string | null;
  vyrobce: string | null;
  model: string | null;
  nazev_polozky: string | null;
}

export interface BackfillSummary {
  rowsScanned: number;
  rowsChanged: number;
  identityBefore: number;
  identityAfter: number;
  dryRun: boolean;
}

type Query = <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function selectedMetadata(document: unknown): Map<number, BackfillMetadata> {
  const data = document as Record<string, any>;
  const result = new Map<number, BackfillMetadata>();
  const add = (index: number, item: Record<string, any>, candidate: Record<string, any> | undefined): void => {
    const name = nonEmpty(item.polozka_nazev);
    result.set(index, {
      katalogove_cislo: nonEmpty(candidate?.katalogove_cislo),
      vyrobce: nonEmpty(candidate?.vyrobce),
      model: nonEmpty(candidate?.model),
      nazev_polozky: name ? normalizeFindingItemName(name) || null : null,
    });
  };
  if (Array.isArray(data.polozky_match)) {
    for (const item of data.polozky_match) {
      if (!Number.isInteger(item?.polozka_index) || !Array.isArray(item?.kandidati)) continue;
      add(item.polozka_index, item, item.kandidati[item.vybrany_index]);
    }
  } else if (Array.isArray(data.kandidati)) {
    add(-1, data, data.kandidati[data.vybrany_index ?? 0]);
  }
  return result;
}

/** Načte pouze product-match soubory; poškozený nebo neúplný soubor bezpečně přeskočí. */
export async function loadBackfillMetadata(outputDir: string): Promise<Map<string, Map<number, BackfillMetadata>>> {
  const result = new Map<string, Map<number, BackfillMetadata>>();
  let entries;
  try { entries = await readdir(outputDir, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const document = JSON.parse(await readFile(join(outputDir, entry.name, 'product-match.json'), 'utf8'));
      result.set(entry.name, selectedMetadata(document));
    } catch {
      // Chybějící nebo poškozený historický soubor nesmí zastavit ostatní zakázky.
    }
  }
  return result;
}

function hasIdentity(row: Pick<BackfillRow, 'katalogove_cislo' | 'vyrobce' | 'model'>): boolean {
  return Boolean(row.katalogove_cislo || (row.vyrobce && row.model));
}

/** Backfill mění výhradně čtyři identifikační sloupce a jen přes COALESCE(NULL, hodnota). */
export async function backfillFindingsIdentity(options: {
  query: Query;
  metadata: Map<string, Map<number, BackfillMetadata>>;
  dryRun?: boolean;
  limit?: number;
}): Promise<BackfillSummary> {
  const count = await options.query<{ identity_count: string }>(
    `SELECT COUNT(*) FILTER (WHERE katalogove_cislo IS NOT NULL OR (vyrobce IS NOT NULL AND model IS NOT NULL))::text AS identity_count
     FROM warehouse_web_findings`,
  );
  const identityBefore = Number(count.rows[0]?.identity_count ?? 0);
  const rows = await options.query<BackfillRow>(
    `SELECT id, tender_id, polozka_index, katalogove_cislo, vyrobce, model, nazev_polozky, polozka_nazev
     FROM warehouse_web_findings
     WHERE katalogove_cislo IS NULL OR vyrobce IS NULL OR model IS NULL OR nazev_polozky IS NULL
     ORDER BY id`,
  );
  let changed = 0;
  let gainedIdentity = 0;
  const limit = options.limit === undefined ? Infinity : Math.max(0, options.limit);
  for (const row of rows.rows) {
    if (changed >= limit) break;
    const fileMetadata = options.metadata.get(row.tender_id)?.get(row.polozka_index);
    const metadata: BackfillMetadata = fileMetadata ?? {
      katalogove_cislo: null, vyrobce: null, model: null,
      nazev_polozky: normalizeFindingItemName(row.polozka_nazev) || null,
    };
    const willChange = (!row.katalogove_cislo && metadata.katalogove_cislo)
      || (!row.vyrobce && metadata.vyrobce) || (!row.model && metadata.model)
      || (!row.nazev_polozky && metadata.nazev_polozky);
    if (!willChange) continue;
    changed++;
    const after = {
      katalogove_cislo: row.katalogove_cislo ?? metadata.katalogove_cislo,
      vyrobce: row.vyrobce ?? metadata.vyrobce,
      model: row.model ?? metadata.model,
    };
    if (!hasIdentity(row) && hasIdentity(after)) gainedIdentity++;
    if (!options.dryRun) {
      await options.query(
        `UPDATE warehouse_web_findings SET
           katalogove_cislo = COALESCE(katalogove_cislo, $2),
           vyrobce = COALESCE(vyrobce, $3),
           model = COALESCE(model, $4),
           nazev_polozky = COALESCE(nazev_polozky, $5)
         WHERE id = $1`,
        [row.id, metadata.katalogove_cislo, metadata.vyrobce, metadata.model, metadata.nazev_polozky],
      );
    }
  }
  return {
    rowsScanned: rows.rows.length,
    rowsChanged: changed,
    identityBefore,
    identityAfter: identityBefore + gainedIdentity,
    dryRun: options.dryRun === true,
  };
}
