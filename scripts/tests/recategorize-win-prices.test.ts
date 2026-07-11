import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  planRecategorization,
  formatDistribution,
  type RecategorizeRow,
} from '../src/recategorize-win-prices.js';

test('planRecategorization: nezmění řádky, kde nová kategorie odpovídá uložené', () => {
  const rows: RecategorizeRow[] = [
    { id: 1, predmet: 'Server pro datové centrum', komodita_kategorie: 'it_av' },
  ];
  const plan = planRecategorization(rows);
  assert.deepEqual(plan.toUpdate, []);
  assert.deepEqual(plan.distributionBefore, { it_av: 1 });
  assert.deepEqual(plan.distributionAfter, { it_av: 1 });
});

test('planRecategorization: přeřadí řádek z ostatni do specifičtější kategorie', () => {
  const rows: RecategorizeRow[] = [
    { id: 1, predmet: 'Elektrická vrtačka příklepová', komodita_kategorie: 'ostatni' },
    { id: 2, predmet: 'Rentgenový přístroj', komodita_kategorie: 'ostatni' },
    { id: 3, predmet: 'Umělecké dílo - socha', komodita_kategorie: 'ostatni' },
  ];
  const plan = planRecategorization(rows);

  assert.deepEqual(
    plan.toUpdate.sort((a, b) => a.id - b.id),
    [
      { id: 1, from: 'ostatni', to: 'naradi_dilna' },
      { id: 2, from: 'ostatni', to: 'zdravotnicke' },
    ],
  );
  assert.deepEqual(plan.distributionBefore, { ostatni: 3 });
  assert.deepEqual(plan.distributionAfter, { naradi_dilna: 1, zdravotnicke: 1, ostatni: 1 });
});

test('planRecategorization: idempotence — druhý běh nad výstupem prvního nic nemění', () => {
  const rows: RecategorizeRow[] = [
    { id: 1, predmet: 'Kancelářský nábytek - skříně a stoly', komodita_kategorie: 'ostatni' },
  ];
  const firstPlan = planRecategorization(rows);
  assert.equal(firstPlan.toUpdate.length, 1);

  const afterFirstRun: RecategorizeRow[] = rows.map((r) => {
    const update = firstPlan.toUpdate.find((u) => u.id === r.id);
    return update ? { ...r, komodita_kategorie: update.to } : r;
  });
  const secondPlan = planRecategorization(afterFirstRun);
  assert.deepEqual(secondPlan.toUpdate, []);
});

test('planRecategorization: prázdný vstup vrátí prázdný plán', () => {
  const plan = planRecategorization([]);
  assert.deepEqual(plan, { toUpdate: [], distributionBefore: {}, distributionAfter: {} });
});

test('formatDistribution: řadí sestupně dle počtu', () => {
  const formatted = formatDistribution({ ostatni: 3, it_av: 10, kancelar: 5 });
  assert.equal(formatted, 'it_av=10, kancelar=5, ostatni=3');
});

test('formatDistribution: prázdné rozložení má čitelný fallback', () => {
  assert.equal(formatDistribution({}), '(prázdné, n=0)');
});
