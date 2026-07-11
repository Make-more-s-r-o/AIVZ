import { strict as assert } from 'node:assert';
import test from 'node:test';

import { PriceOverrideSchema } from '../src/lib/types.js';
import { clearPriceForProductChange, validateBulkPriceWrites, validatePriceWrite } from '../src/lib/price-review.js';

const price = {
  nakupni_cena_bez_dph: 100,
  nakupni_cena_s_dph: 121,
  marze_procent: 10,
  nabidkova_cena_bez_dph: 110,
  nabidkova_cena_s_dph: 133.1,
  potvrzeno: true,
};

test('PriceOverrideSchema odmítne potvrzení bez úplné lidské auditní stopy', () => {
  assert.equal(PriceOverrideSchema.safeParse(price).success, false);
});

test('bulk bez attestace položku přeskočí', () => {
  const result = validateBulkPriceWrites([
    { itemIndex: 3, attestace: false, cenova_uprava: price },
  ], { sub: 'server-user' }, '2026-07-11T12:00:00.000Z');
  assert.deepEqual(result.validated, []);
  assert.deepEqual(result.preskoceno, [3]);
});

test('server ignoruje klientskou identitu a zapíše identitu z JWT', () => {
  const result = validatePriceWrite({
    ...price,
    zkontrolovano_at: '2000-01-01T00:00:00.000Z',
    zkontrolovano_kym: 'podvržený klient',
  }, { sub: 'jwt-sub', name: 'Serverový uživatel' }, '2026-07-11T12:00:00.000Z');
  assert.equal(result.zkontrolovano_kym, 'Serverový uživatel');
  assert.equal(result.zkontrolovano_at, '2026-07-11T12:00:00.000Z');
});

test('změna kandidáta smaže cenu i auditní stopu', () => {
  const target: { cenova_uprava?: unknown } = {
    cenova_uprava: validatePriceWrite(price, { sub: 'tester' }, '2026-07-11T12:00:00.000Z'),
  };
  assert.equal(clearPriceForProductChange(target), true);
  assert.equal(target.cenova_uprava, undefined);
});
