// Unit testy čistého výpočtu win-rate statistik (computeOutcomeStats) — bez DB.
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { computeOutcomeStats, type OutcomeStatsRow } from '../src/lib/outcomes-store.js';

function row(vysledek: OutcomeStatsRow['vysledek'], nase: number | null = null, vitezna: number | null = null): OutcomeStatsRow {
  return { vysledek, nase_cena_bez_dph: nase, vitezna_cena_bez_dph: vitezna };
}

test('prázdný vstup → nuly a null metriky', () => {
  const s = computeOutcomeStats([]);
  assert.deepEqual(s, {
    celkem: 0, vyhry: 0, prohry: 0, zrusene: 0,
    win_rate_procent: null, prumerna_odchylka_od_viteze_procent: null,
  });
});

test('win-rate počítá jen rozhodnuté (výhry + prohry), zrušené se nepočítají', () => {
  const s = computeOutcomeStats([
    row('vyhra', 100000, 100000),
    row('prohra', 120000, 100000),
    row('prohra'),
    row('zruseno'),
  ]);
  assert.equal(s.celkem, 4);
  assert.equal(s.vyhry, 1);
  assert.equal(s.prohry, 2);
  assert.equal(s.zrusene, 1);
  // 1 / (1 + 2) = 33.33 % — zrušená zakázka win-rate neředí.
  assert.equal(s.win_rate_procent, 33.33);
});

test('jen zrušené → win_rate_procent null (žádné dělení nulou)', () => {
  const s = computeOutcomeStats([row('zruseno'), row('zruseno')]);
  assert.equal(s.win_rate_procent, null);
  assert.equal(s.zrusene, 2);
});

test('odchylka od vítěze: průměr přes prohry s oběma cenami', () => {
  const s = computeOutcomeStats([
    row('prohra', 110000, 100000), // +10 %
    row('prohra', 120000, 100000), // +20 %
  ]);
  assert.equal(s.prumerna_odchylka_od_viteze_procent, 15);
});

test('odchylka ignoruje výhry, prohry bez cen a nulovou vítěznou cenu', () => {
  const s = computeOutcomeStats([
    row('vyhra', 500000, 400000),   // výhra se do odchylky nepočítá
    row('prohra', 110000, 100000),  // jediný validní řádek: +10 %
    row('prohra', null, 100000),    // chybí naše cena
    row('prohra', 110000, null),    // chybí vítězná cena
    row('prohra', 110000, 0),       // vítězná 0 → dělení nulou se přeskočí
  ]);
  assert.equal(s.prumerna_odchylka_od_viteze_procent, 10);
});

test('odchylka umí být i záporná (podali jsme levněji, ale prohráli — např. na kvalitě)', () => {
  const s = computeOutcomeStats([row('prohra', 90000, 100000)]);
  assert.equal(s.prumerna_odchylka_od_viteze_procent, -10);
});

test('100% win-rate a zaokrouhlení na 2 desetinná místa', () => {
  const vsechnyVyhry = computeOutcomeStats([row('vyhra'), row('vyhra')]);
  assert.equal(vsechnyVyhry.win_rate_procent, 100);

  const tretiny = computeOutcomeStats([
    row('vyhra'), row('vyhra'), row('prohra'),
  ]);
  assert.equal(tretiny.win_rate_procent, 66.67);
});
