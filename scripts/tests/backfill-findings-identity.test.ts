import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { QueryResultRow } from 'pg';
import { backfillFindingsIdentity, type BackfillMetadata, type BackfillRow } from '../src/lib/backfill-findings-identity.js';

interface StoredRow extends BackfillRow {
  cena_s_dph: number;
  url: string;
  found_at: string;
}

function fixture() {
  const rows: StoredRow[] = [{
    id: 1, tender_id: 'T-1', polozka_index: 0, katalogove_cislo: null,
    vyrobce: 'Původní výrobce', model: null, nazev_polozky: null, polozka_nazev: 'Testovací položka 5 ks',
    cena_s_dph: 1210, url: 'https://shop.cz/x', found_at: '2025-01-02T03:04:05Z',
  }];
  let updates = 0;
  const query = async <T extends QueryResultRow>(sql: string, params: unknown[] = []) => {
    if (sql.includes('COUNT(*) FILTER')) {
      const count = rows.filter((row) => row.katalogove_cislo || (row.vyrobce && row.model)).length;
      return { rows: [{ identity_count: String(count) }] } as any;
    }
    if (sql.startsWith('SELECT id,')) return { rows: rows.map((row) => ({ ...row })) } as any;
    if (sql.includes('UPDATE warehouse_web_findings')) {
      updates++;
      const row = rows.find((candidate) => candidate.id === params[0])!;
      row.katalogove_cislo ??= params[1] as string | null;
      row.vyrobce ??= params[2] as string | null;
      row.model ??= params[3] as string | null;
      row.nazev_polozky ??= params[4] as string | null;
      return { rows: [] } as any;
    }
    throw new Error(`Neočekávané SQL: ${sql}`);
  };
  const metadata = new Map<string, Map<number, BackfillMetadata>>([['T-1', new Map([[0, {
    katalogove_cislo: 'CAT-1', vyrobce: 'Nový výrobce', model: 'M1', nazev_polozky: 'testovaci polozka',
  }]])]]);
  return { rows, query, metadata, get updates() { return updates; } };
}

test('backfill doplní jen NULL identitu a nedotkne se money-path polí', async () => {
  const db = fixture();
  const moneyBefore = { cena_s_dph: db.rows[0]!.cena_s_dph, url: db.rows[0]!.url, found_at: db.rows[0]!.found_at };
  const result = await backfillFindingsIdentity({ query: db.query, metadata: db.metadata });
  assert.equal(result.rowsChanged, 1);
  assert.equal(db.rows[0]!.vyrobce, 'Původní výrobce');
  assert.equal(db.rows[0]!.katalogove_cislo, 'CAT-1');
  assert.equal(db.rows[0]!.model, 'M1');
  assert.deepEqual({ cena_s_dph: db.rows[0]!.cena_s_dph, url: db.rows[0]!.url, found_at: db.rows[0]!.found_at }, moneyBefore);
});

test('backfill je idempotentní', async () => {
  const db = fixture();
  await backfillFindingsIdentity({ query: db.query, metadata: db.metadata });
  const snapshot = structuredClone(db.rows);
  const second = await backfillFindingsIdentity({ query: db.query, metadata: db.metadata });
  assert.equal(second.rowsChanged, 0);
  assert.deepEqual(db.rows, snapshot);
  assert.equal(db.updates, 1);
});

test('dry-run nic nezapíše a správně predikuje souhrn', async () => {
  const db = fixture();
  const before = structuredClone(db.rows);
  const result = await backfillFindingsIdentity({ query: db.query, metadata: db.metadata, dryRun: true });
  assert.equal(result.rowsChanged, 1);
  assert.equal(result.identityBefore, 0);
  assert.equal(result.identityAfter, 1);
  assert.deepEqual(db.rows, before);
  assert.equal(db.updates, 0);
});
