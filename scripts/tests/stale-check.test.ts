import { strict as assert } from 'node:assert';
import test from 'node:test';

import { isStale } from '../src/lib/stale-check.js';

test('isStale: cena změněna PO vygenerování dokumentů → stale', () => {
  const docsGeneratedAt = Date.parse('2026-07-01T10:00:00.000Z');
  const pricesUpdatedAt = '2026-07-01T12:00:00.000Z';
  assert.equal(isStale(docsGeneratedAt, pricesUpdatedAt), true);
});

test('isStale: cena změněna PŘED vygenerováním dokumentů → není stale', () => {
  const docsGeneratedAt = Date.parse('2026-07-01T12:00:00.000Z');
  const pricesUpdatedAt = '2026-07-01T10:00:00.000Z';
  assert.equal(isStale(docsGeneratedAt, pricesUpdatedAt), false);
});

test('isStale: žádný timestamp změny ceny → není stale', () => {
  const docsGeneratedAt = Date.parse('2026-07-01T12:00:00.000Z');
  assert.equal(isStale(docsGeneratedAt, null), false);
  assert.equal(isStale(docsGeneratedAt, undefined), false);
});

test('isStale: dokumenty ještě nevygenerované (null mtime) → není stale', () => {
  assert.equal(isStale(null, '2026-07-01T10:00:00.000Z'), false);
  assert.equal(isStale(undefined, '2026-07-01T10:00:00.000Z'), false);
});

test('isStale: nevalidní ISO string ceny → není stale (žádná falešná pozitiva)', () => {
  const docsGeneratedAt = Date.parse('2026-07-01T10:00:00.000Z');
  assert.equal(isStale(docsGeneratedAt, 'not-a-date'), false);
});

test('isStale: stejný okamžik (hraniční případ) → není stale (musí být PO, ne rovno)', () => {
  const iso = '2026-07-01T10:00:00.000Z';
  assert.equal(isStale(Date.parse(iso), iso), false);
});
