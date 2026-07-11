import { strict as assert } from 'node:assert';
import test from 'node:test';

import { deriveCenaBezDph } from '../src/lib/winprice-query.js';

test('cena bez DPH má přednost, když existuje', () => {
  assert.equal(deriveCenaBezDph(1000, 2000, 'CZK'), 1000);
});

test('jen cena s DPH (CZK) → dopočet /1.21 na haléře', () => {
  assert.equal(deriveCenaBezDph(null, 121000, 'CZK'), 100000);
  assert.equal(deriveCenaBezDph(null, 1000, 'CZK'), 826.45);
});

test('nulová cena bez DPH se bere jako chybějící → dopočet', () => {
  assert.equal(deriveCenaBezDph(0, 121, 'CZK'), 100);
});

test('cizí měna se nedopočítává', () => {
  assert.equal(deriveCenaBezDph(null, 121000, 'EUR'), null);
});

test('obě ceny chybí → null', () => {
  assert.equal(deriveCenaBezDph(null, null, 'CZK'), null);
});

test('záporná/nulová cena s DPH se nedopočítává', () => {
  assert.equal(deriveCenaBezDph(null, 0, 'CZK'), null);
  assert.equal(deriveCenaBezDph(null, -5, 'CZK'), null);
});
