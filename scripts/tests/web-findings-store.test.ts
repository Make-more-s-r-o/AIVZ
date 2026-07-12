import { strict as assert } from 'node:assert';
import test from 'node:test';

import { closePool } from '../src/lib/db.js';
import { findCachedSources, listFindings, normalizeFindingItemName, selectCachedSources, upsertFindings, type WebFindingRow } from '../src/lib/web-findings-store.js';

function row(overrides: Partial<WebFindingRow>): WebFindingRow {
  return {
    id: 1, tender_id: 'T', polozka_index: 0, polozka_nazev: 'Židle kancelářská',
    produkt: 'Acme M1', dodavatel: 'Shop', url: 'https://shop.cz/x', cena_bez_dph: 100,
    cena_s_dph: 121, dostupnost: 'skladem', zdroj: 'web_verify',
    found_at: '2026-07-10T00:00:00.000Z', katalogove_cislo: 'CAT-1', vyrobce: 'Acme', model: 'M1',
    ...overrides,
  };
}

test('cache lookup dodržuje prioritu katalog > výrobce+model > normalizovaný název', () => {
  const rows = [
    row({ id: 1, katalogove_cislo: 'JINE', cena_s_dph: 10 }),
    row({ id: 2, katalogove_cislo: 'cat-1', vyrobce: 'Jiný', model: 'X', cena_s_dph: 30 }),
    row({ id: 3, katalogove_cislo: null, vyrobce: 'ÁCME', model: 'm1', cena_s_dph: 20 }),
  ];
  const now = new Date('2026-07-12T00:00:00.000Z');
  assert.deepEqual(selectCachedSources(rows, { katalogove_cislo: 'CAT-1', vyrobce: 'Acme', model: 'M1', nazev_polozky: 'Židle kancelářská' }, 14, now).map((r) => r.id), [2]);
  assert.deepEqual(selectCachedSources(rows, { vyrobce: 'acme', model: 'M1', nazev_polozky: 'Židle kancelářská' }, 14, now).map((r) => r.id), [1, 3]);
  assert.deepEqual(selectCachedSources(rows, { nazev_polozky: 'zidle kancelarska' }, 14, now).map((r) => r.id), [1, 3, 2]);
  assert.ok(selectCachedSources(rows, { nazev_polozky: 'Židle kancelářská 25 ks' }, 14, now).every((r) => r.cache_match === 'nazev'));
});

test('normalizace názvu odstraní pouze koncové množství a zachová modelové číslo', () => {
  assert.equal(normalizeFindingItemName('Monitor Dell P2425H (množství: 12 ks)'), 'monitor dell p2425h');
  assert.equal(normalizeFindingItemName('Monitor Dell P2425H'), 'monitor dell p2425h');
});

test('cache lookup respektuje maximální stáří', () => {
  const result = selectCachedSources([
    row({ id: 1, found_at: '2026-06-01T00:00:00.000Z' }),
    row({ id: 2, found_at: '2026-07-10T00:00:00.000Z' }),
  ], { katalogove_cislo: 'CAT-1' }, 14, new Date('2026-07-12T00:00:00.000Z'));
  assert.deepEqual(result.map((r) => r.id), [2]);
});

test('cache lookup po nenalezeném katalogu kaskádově zkusí model a až potom název', () => {
  const now = new Date('2026-07-12T00:00:00.000Z');
  const modelHit = selectCachedSources([row({ katalogove_cislo: null })], {
    katalogove_cislo: 'CHYBI', vyrobce: 'Acme', model: 'M1', nazev_polozky: 'Židle kancelářská',
  }, 14, now);
  assert.equal(modelHit[0]?.cache_match, 'model');
  const nameHit = selectCachedSources([row({ katalogove_cislo: null, vyrobce: null, model: null })], {
    katalogove_cislo: 'CHYBI', vyrobce: 'Acme', model: 'M1', nazev_polozky: 'Židle kancelářská 10 ks',
  }, 14, now);
  assert.equal(nameHit[0]?.cache_match, 'nazev');
});

test('web findings store bez DATABASE_URL degraduje na prázdné čtení a no-op zápis', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  await closePool();
  try {
    const stored = await upsertFindings([{
      tender_id: 'T-1',
      polozka_index: 0,
      polozka_nazev: 'Notebook',
      produkt: 'Výrobce Model',
      dodavatel: 'Dodavatel',
      url: 'https://shop.cz/model',
      cena_bez_dph: 1_000,
      cena_s_dph: 1_210,
      dostupnost: 'skladem',
    }]);

    assert.equal(stored, 0);
    assert.deepEqual(await listFindings('T-1'), []);
    assert.deepEqual(await findCachedSources({ katalogove_cislo: 'CAT-1' }, 14), []);
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await closePool();
  }
});
