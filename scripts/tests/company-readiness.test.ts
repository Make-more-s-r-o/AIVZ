import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  DOC_SLOTS,
  computeCompanyReadiness,
  type DocSlotEntry,
} from '../src/lib/doc-slots.js';
import { getCompanyReadiness } from '../src/lib/company-store.js';

const NOW = new Date('2026-07-12T12:00:00.000Z');
const REQUIRED = ['vypis_or', 'rejstrik_trestu', 'potvrzeni_fu', 'potvrzeni_ossz'] as const;

function entry(slot: DocSlotEntry['slot'], platnost_do?: string): DocSlotEntry {
  return { slot, filename: `${slot}.pdf`, uploadedAt: NOW.toISOString(), platnost_do };
}

test('metadata standardní sady jsou úplná a právě čtyři sloty jsou běžně požadované', () => {
  assert.deepEqual(DOC_SLOTS.filter(slot => slot.bezne_pozadovan).map(slot => slot.type), REQUIRED);
  for (const slot of DOC_SLOTS) {
    assert.equal(typeof slot.popis, 'string');
    assert.ok(slot.popis.length > 20);
    assert.ok(slot.typicka_platnost_dnu === null || slot.typicka_platnost_dnu > 0);
  }
  assert.equal(DOC_SLOTS.find(slot => slot.type === 'profesni_opravneni')?.bezne_pozadovan, false);
});

test('připravenost 0/4 pro prázdný manifest', () => {
  const result = computeCompanyReadiness([], NOW);
  assert.equal(result.pripraveno, 0);
  assert.equal(result.celkem, 4);
  assert.deepEqual(result.chybi.map(item => item.slot), REQUIRED);
});

test('připravenost 4/4 pro platnou standardní sadu', () => {
  const result = computeCompanyReadiness(REQUIRED.map(slot => entry(slot, '2026-10-31')), NOW);
  assert.equal(result.pripraveno, 4);
  assert.equal(result.celkem, 4);
  assert.deepEqual(result.chybi, []);
  assert.deepEqual(result.expirovane, []);
  assert.deepEqual(result.bez_platnosti, []);
});

test('expirovaný doklad se nezapočítá', () => {
  const result = computeCompanyReadiness([
    entry('vypis_or', '2026-07-11'),
    ...REQUIRED.slice(1).map(slot => entry(slot, '2026-10-31')),
  ], NOW);
  assert.equal(result.pripraveno, 3);
  assert.deepEqual(result.expirovane.map(item => item.slot), ['vypis_or']);
});

test('doklad bez platnosti se nezapočítá jako platný', () => {
  const result = computeCompanyReadiness([entry('vypis_or')], NOW);
  assert.equal(result.pripraveno, 0);
  assert.deepEqual(result.bez_platnosti.map(item => item.slot), ['vypis_or']);
});

test('readiness neexistující firmy skončí graceful bez výjimky', async () => {
  assert.equal(await getCompanyReadiness('__firma_ktera_neexistuje__'), null);
});
