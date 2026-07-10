import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { Request, Response } from 'express';

import { createWinPriceBandHandler, createWinPriceStatsHandler } from '../src/lib/winprice-api.js';
import type { PriceBand, SimilarWin } from '../src/lib/winprice-query.js';

function responseFixture(): Response & { body?: unknown; statusCode: number } {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return response as Response & { body?: unknown; statusCode: number };
}

test('GET band bez DATABASE_URL vrátí graceful prázdný kontrakt', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const handler = createWinPriceBandHandler();
    const response = responseFixture();
    await handler({ query: { q: 'server' } } as unknown as Request, response, () => undefined);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { n: 0 });
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

test('GET band koercuje NUMERIC hodnoty a omezí vzorky na pět', async () => {
  const band = {
    pocet: '6', min: '100', p25: '125', median: '150', p75: '175', max: '200', prumer: '150',
  } as unknown as PriceBand;
  const wins = Array.from({ length: 6 }, (_, index) => ({
    predmet: `Server ${index}`,
    cena_bez_dph: String(100 + index),
    dodavatel_nazev: 'Dodavatel',
    datum: '2026-01-01',
    url: 'https://example.test/smlouva',
  })) as unknown as SimilarWin[];
  const handler = createWinPriceBandHandler({
    priceBandForSubject: async () => band,
    findSimilarWins: async () => wins,
    getWinPriceStats: async () => ({ count: 0, last_date: null }),
  });
  const response = responseFixture();
  await handler({ query: { q: 'server' } } as unknown as Request, response, () => undefined);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    n: 6,
    median_bez_dph: 150,
    p25: 125,
    p75: 175,
    min: 100,
    max: 200,
    samples: Array.from({ length: 5 }, (_, index) => ({
      predmet: `Server ${index}`,
      cena_bez_dph: 100 + index,
      dodavatel_nazev: 'Dodavatel',
      datum: '2026-01-01',
      url: 'https://example.test/smlouva',
    })),
  });
});

test('GET stats vrací počet jako number a poslední datum', async () => {
  const handler = createWinPriceStatsHandler({
    getWinPriceStats: async () => ({ count: '42' as unknown as number, last_date: '2026-07-09' }),
  });
  const response = responseFixture();
  await handler({ query: {} } as unknown as Request, response, () => undefined);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { count: 42, last_date: '2026-07-09' });
});
