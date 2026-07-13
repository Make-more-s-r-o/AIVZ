// Unit testy čisté agregace AI nákladů (computeCostsAggregate) — bez FS/DB.
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { computeCostsAggregate, type CostsAggregateTenderInput } from '../src/lib/cost-tracker.js';
import type { CostEntry } from '../src/lib/cost-tracker.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

function entry(daysAgo: number, costCZK: number, overrides: Partial<CostEntry> = {}): CostEntry {
  const ts = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    timestamp: ts, step: 'analyze', model: 'claude-sonnet', inputTokens: 100, outputTokens: 100, costCZK,
    ...overrides,
  };
}

function tender(
  tenderId: string,
  entries: CostEntry[],
  name: string | null = null,
  hasGeneratedOffer = false,
): CostsAggregateTenderInput {
  return { tenderId, name, entries, hasGeneratedOffer };
}

test('prázdný vstup → nuly a 14 nulových dní', () => {
  const s = computeCostsAggregate([], NOW);
  assert.equal(s.dnes_czk, 0);
  assert.equal(s.tyden_czk, 0);
  assert.equal(s.mesic_czk, 0);
  assert.equal(s.celkem_czk, 0);
  assert.equal(s.kc_na_cn, null);
  assert.deepEqual(s.top_zakazky, []);
  assert.equal(s.po_dnech.length, 14);
  assert.ok(s.po_dnech.every((d) => d.czk === 0));
  // Poslední den v řadě je dnešek.
  assert.equal(s.po_dnech[13].den, '2026-07-11');
  // První den v řadě je 13 dní zpět.
  assert.equal(s.po_dnech[0].den, '2026-06-28');
});

test('rolling okna dnes/týden/měsíc se počítají nezávisle přes hranice', () => {
  const t = tender('T1', [
    entry(0, 10),   // dnes i týden i měsíc
    entry(3, 20),   // jen týden + měsíc
    entry(10, 30),  // jen měsíc (mimo 7denní okno)
    entry(40, 40),  // jen celkem (mimo 30denní okno)
  ]);
  const s = computeCostsAggregate([t], NOW);
  assert.equal(s.dnes_czk, 10);
  assert.equal(s.tyden_czk, 30);   // 10 + 20
  assert.equal(s.mesic_czk, 60);   // 10 + 20 + 30
  assert.equal(s.celkem_czk, 100); // vše
});

test('vadné záznamy (NaN, chybějící pole, nevalidní timestamp) se tiše přeskočí', () => {
  const bad = [
    entry(0, 10),
    { ...entry(0, NaN) },
    { timestamp: NOW.toISOString(), step: 'x', model: 'm', inputTokens: 1, outputTokens: 1 } as unknown as CostEntry, // chybí costCZK
    { ...entry(0, 5), timestamp: 'not-a-date' },
    null as unknown as CostEntry,
    undefined as unknown as CostEntry,
  ];
  const s = computeCostsAggregate([tender('T1', bad)], NOW);
  assert.equal(s.celkem_czk, 10);
  assert.equal(s.dnes_czk, 10);
});

test('top_zakazky: seřazeno sestupně, max 10, agregace přes více záznamů jedné zakázky', () => {
  const tenders = Array.from({ length: 12 }, (_, i) =>
    tender(`T${i}`, [entry(0, (i + 1) * 100)], i === 0 ? 'Zakázka nula' : null));
  const s = computeCostsAggregate(tenders, NOW);
  assert.equal(s.top_zakazky.length, 10);
  // Nejdražší (T11 = 1200) první.
  assert.equal(s.top_zakazky[0].tender_id, 'T11');
  assert.equal(s.top_zakazky[0].celkem_czk, 1200);
  // Sestupně seřazeno.
  for (let i = 1; i < s.top_zakazky.length; i++) {
    assert.ok(s.top_zakazky[i - 1].celkem_czk >= s.top_zakazky[i].celkem_czk);
  }
});

test('top_zakazky: název se propaguje, zakázka bez nákladů (0) se do žebříčku nedostane', () => {
  const s = computeCostsAggregate([
    tender('T-named', [entry(0, 50)], 'Pěkný název'),
    tender('T-zero', [entry(0, 0)], 'Nulová'),
  ], NOW);
  assert.deepEqual(s.top_zakazky, [{ tender_id: 'T-named', nazev: 'Pěkný název', celkem_czk: 50 }]);
});

test('náklady jedné zakázky napříč více cost-logy (více entries) se sečtou do jednoho top řádku', () => {
  const s = computeCostsAggregate([
    tender('T1', [entry(0, 10), entry(1, 20), entry(2, 5)], 'Jedna zakázka'),
  ], NOW);
  assert.equal(s.top_zakazky.length, 1);
  assert.equal(s.top_zakazky[0].celkem_czk, 35);
});

test('po_dnech: záznam mimo posledních 14 dní se do řady nepropíše', () => {
  const s = computeCostsAggregate([tender('T1', [entry(20, 999)])], NOW);
  assert.ok(s.po_dnech.every((d) => d.czk === 0));
  assert.equal(s.celkem_czk, 999); // ale do celkem se počítá
});

test('zaokrouhlení na 2 desetinná místa', () => {
  const s = computeCostsAggregate([tender('T1', [entry(0, 10.005), entry(0, 0.001)])], NOW);
  assert.equal(s.dnes_czk, 10.01);
});

test('Kč/CN: celkové náklady se dělí počtem zakázek s kanonickou vygenerovanou CN', () => {
  const s = computeCostsAggregate([
    tender('T1', [entry(0, 100)], null, true),
    tender('T2', [entry(0, 50)], null, true),
    tender('T3', [entry(0, 25)]), // rozpracovaná zakázka: náklady ano, hotová CN ne
  ], NOW);
  assert.equal(s.celkem_czk, 175);
  assert.equal(s.kc_na_cn, 87.5);
});

test('Kč/CN: bez vygenerované CN je null a výsledek se zaokrouhlí na haléře', () => {
  assert.equal(computeCostsAggregate([tender('T1', [entry(0, 10)])], NOW).kc_na_cn, null);
  assert.equal(computeCostsAggregate([
    tender('T1', [entry(0, 10)], null, true),
    tender('T2', [], null, true),
    tender('T3', [], null, true),
  ], NOW).kc_na_cn, 3.33);
});
