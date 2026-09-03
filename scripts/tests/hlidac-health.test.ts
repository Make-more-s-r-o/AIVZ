import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { Request, Response } from 'express';

import {
  fetchNewTenders,
  type HlidacFetchResult,
} from '../src/lib/monitoring/hlidac-client.js';
import { createMonitoringHlidacHandler } from '../src/lib/monitoring/hlidac-route.js';
import {
  collectMonitoringInputs,
  DEFAULT_MAX_PAGES_PER_QUERY,
  DEFAULT_MAX_QUERIES_PER_SYNC,
  DEFAULT_MONITORING_QUERY_DELAY_MS,
} from '../src/lib/monitoring/monitoring-sync.js';

function rawTender(id: string): Record<string, unknown> {
  return {
    Id: id,
    NazevZakazky: `Zakázka ${id}`,
    Zadavatel: { Jmeno: 'Město' },
    OdhadovanaHodnotaBezDPH: 1000,
    LhutaDoruceni: '2026-10-01T10:00:00Z',
    StavVZ: 'zadavani',
    CPV: ['30200000'],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Hlídač načte další stranu, použije číslo strany a deduplikuje ID', async () => {
  const urls: string[] = [];
  const waits: number[] = [];
  const result = await fetchNewTenders(' servery ', {
    token: 'fixture-token',
    maxPages: 5,
    pageDelayMs: 17,
    sleep: async (ms) => { waits.push(ms); },
    fetchFn: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      const page = Number(url.searchParams.get('strana'));
      return page === 1
        ? jsonResponse({ Results: [rawTender('A'), rawTender('B')], Total: 3, PageSize: 2 })
        : jsonResponse({ Results: [rawTender('B'), rawTender('C')], Total: 3, PageSize: 2 });
    }) as typeof fetch,
  });

  assert.deepEqual(result.items.map((item) => item.id), ['A', 'B', 'C']);
  assert.equal(result.health, 'ok');
  assert.equal(result.requests, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, false);
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get('strana')), ['1', '2']);
  assert.equal(new URL(urls[0]).searchParams.get('dotaz'), 'servery');
  assert.deepEqual(waits, [17]);
});

test('Hlídač označí plnou poslední povolenou stranu s dalšími výsledky jako partial', async () => {
  const result = await fetchNewTenders('notebooky', {
    token: 'fixture-token',
    maxPages: 2,
    pageDelayMs: 0,
    sleep: async () => {},
    fetchFn: (async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get('strana'));
      return jsonResponse({
        Results: [rawTender(`${page}-A`), rawTender(`${page}-B`)],
        Total: 10,
        PageSize: 2,
      });
    }) as typeof fetch,
  });

  assert.equal(result.health, 'partial');
  assert.equal(result.truncated, true);
  assert.equal(result.requests, 2);
  assert.equal(result.items.length, 4);
  assert.match(result.warning ?? '', /limitu 2 stran/);
});

test('Hlídač po chybě další strany zachová data a vrátí partial', async () => {
  let calls = 0;
  const result = await fetchNewTenders('', {
    token: 'fixture-token',
    maxPages: 3,
    pageDelayMs: 0,
    sleep: async () => {},
    fetchFn: (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ Results: [rawTender('A')], HasMore: true });
      throw new Error('ECONNRESET fixture');
    }) as typeof fetch,
  });

  assert.equal(result.health, 'partial');
  assert.equal(result.truncated, true);
  assert.equal(result.requests, 2);
  assert.equal(result.pages, 1);
  assert.deepEqual(result.items.map((item) => item.id), ['A']);
});

test('chyba první strany Hlídače je error, nikoli prázdný úspěšný výsledek', async () => {
  const result = await fetchNewTenders('', {
    token: 'fixture-token',
    fetchFn: (async () => jsonResponse({ error: 'maintenance' }, 503)) as typeof fetch,
  });

  assert.equal(result.health, 'error');
  assert.deepEqual(result.items, []);
  assert.equal(result.requests, 1);
  assert.equal(result.pages, 0);
  assert.equal(result.truncated, false);
});

test('chybějící token má vlastní health a neprovede request', async () => {
  let calls = 0;
  const result = await fetchNewTenders('', {
    token: null,
    fetchFn: (async () => {
      calls += 1;
      return jsonResponse({ Results: [] });
    }) as typeof fetch,
  });

  assert.equal(result.health, 'missing_token');
  assert.equal(result.requests, 0);
  assert.equal(calls, 0);
});

test('legitimní prázdná odpověď Hlídače je ok, ne error', async () => {
  const result = await fetchNewTenders('bez výsledků', {
    token: 'fixture-token',
    fetchFn: (async () => jsonResponse({ Results: [], Total: 0, PageSize: 25 })) as typeof fetch,
  });

  assert.deepEqual(result, {
    items: [], health: 'ok', requests: 1, pages: 1,
    total: 0, truncated: false,
  });
});

test('route zachová strukturovaný SourceHealth místo samotného pole', async () => {
  const fixture: HlidacFetchResult = {
    items: [], health: 'error', requests: 1, pages: 0,
    total: null, truncated: false, warning: 'fixture error',
  };
  let receivedQuery = '';
  let payload: unknown;
  const handler = createMonitoringHlidacHandler(async (query) => {
    receivedQuery = query;
    return fixture;
  });
  await handler(
    { query: { q: 'router query' } } as unknown as Request,
    { json: (value: unknown) => { payload = value; } } as unknown as Response,
  );

  assert.equal(receivedQuery, 'router query');
  assert.deepEqual(payload, fixture);
});

test('sync omezuje dotazy, dodržuje prodlevu a zveřejní request budget i health', async () => {
  const queries = Array.from({ length: 16 }, (_, index) => `dotaz-${index + 1}`);
  const calls: Array<{ query: string; maxPages: number | undefined }> = [];
  const waits: number[] = [];
  const result = await collectMonitoringInputs('hlidac', queries, true, {
    fetchNen: async () => ({ items: [], ok: true }),
    fetchHlidac: async (query, options) => {
      calls.push({ query, maxPages: options?.maxPages });
      return {
        items: [], health: 'ok', requests: 1, pages: 1,
        total: 0, truncated: false,
      };
    },
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.equal(DEFAULT_MAX_QUERIES_PER_SYNC, 14);
  assert.equal(DEFAULT_MAX_PAGES_PER_QUERY, 3);
  assert.equal(DEFAULT_MONITORING_QUERY_DELAY_MS, 500);
  assert.equal(calls.length, 14);
  assert.ok(calls.every((call) => call.maxPages === 3));
  assert.deepEqual(waits, Array(13).fill(500));
  assert.deepEqual(result.queries, { requested: 16, processed: 14, dropped: 2, deduplicated: 0 });
  assert.deepEqual(result.requests, { nen: 0, hlidac: 14, total: 14 });
  assert.deepEqual(result.health, { hlidac: 'partial' });
  assert.deepEqual(result.limits, {
    maxQueries: 14,
    maxPagesPerQuery: 3,
    maxRequestsPerSource: 42,
    maxRequestsTotal: 42,
  });
  assert.match(result.varovani ?? '', /2 bylo odříznuto/);
});

test('sync agreguje chyby zdrojů a přesné počty requestů', async () => {
  const passedLimits: number[] = [];
  const result = await collectMonitoringInputs('both', 'servery', true, {
    fetchNen: async (_query, options) => {
      passedLimits.push(options?.maxPages ?? -1);
      return { items: [], ok: false, health: 'error', requests: 2 };
    },
    fetchHlidac: async (_query, options) => {
      passedLimits.push(options?.maxPages ?? -1);
      return {
        items: [], health: 'error', requests: 1, pages: 0,
        total: null, truncated: false, warning: 'Hlídač fixture chyba.',
      };
    },
  });

  assert.deepEqual(passedLimits, [3, 3]);
  assert.deepEqual(result.health, { nen: 'error', hlidac: 'error' });
  assert.deepEqual(result.requests, { nen: 2, hlidac: 1, total: 3 });
  assert.equal(result.limits.maxRequestsPerSource, 42);
  assert.equal(result.limits.maxRequestsTotal, 84);
});
