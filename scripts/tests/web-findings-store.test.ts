import { strict as assert } from 'node:assert';
import test from 'node:test';

import { closePool } from '../src/lib/db.js';
import { listFindings, upsertFindings } from '../src/lib/web-findings-store.js';

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
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await closePool();
  }
});

