/**
 * Jednotkový test výpočtu nabídkové ceny a DPH bez sítě a AI.
 *
 * Spuštění z adresáře scripts/:
 *   npx tsx tests/price-calculator.test.ts
 */
import { strict as assert } from 'node:assert';

import { resolveDefaultMarzeProcent } from '../src/lib/company-store.js';
import { calculateItemPrice } from '../src/lib/price-calculator.js';
import { PriceOverrideSchema } from '../src/lib/types.js';

const cases = [
  {
    name: '0 % marže zachová nákupní cenu',
    input: [1000, 0] as const,
    expected: {
      nakupni_cena_bez_dph: 1000,
      nakupni_cena_s_dph: 1210,
      marze_procent: 0,
      nabidkova_cena_bez_dph: 1000,
      nabidkova_cena_s_dph: 1210,
    },
  },
  {
    name: '10 % marže: 1000 Kč → 1100 Kč / 1331 Kč s DPH',
    input: [1000, 10] as const,
    expected: {
      nakupni_cena_bez_dph: 1000,
      nakupni_cena_s_dph: 1210,
      marze_procent: 10,
      nabidkova_cena_bez_dph: 1100,
      nabidkova_cena_s_dph: 1331,
    },
  },
  {
    name: '25 % marže dopočítá DPH z nabídkové ceny',
    input: [1000, 25] as const,
    expected: {
      nakupni_cena_bez_dph: 1000,
      nakupni_cena_s_dph: 1210,
      marze_procent: 25,
      nabidkova_cena_bez_dph: 1250,
      nabidkova_cena_s_dph: 1512.5,
    },
  },
  {
    name: 'desetinné částky se zaokrouhlí na dvě desetinná místa',
    input: [999.99, 10] as const,
    expected: {
      nakupni_cena_bez_dph: 999.99,
      nakupni_cena_s_dph: 1209.99,
      marze_procent: 10,
      nabidkova_cena_bez_dph: 1099.99,
      nabidkova_cena_s_dph: 1330.99,
    },
  },
];

for (const testCase of cases) {
  assert.deepEqual(calculateItemPrice(...testCase.input), testCase.expected, testCase.name);
  console.log(`✓ ${testCase.name}`);
}

const schemaResult = PriceOverrideSchema.parse({
  ...calculateItemPrice(1000, 10),
  potvrzeno: false,
});
assert.equal(schemaResult.marze_procent, 10);
assert.equal(schemaResult.nabidkova_cena_bez_dph, 1100);
console.log('✓ cenový návrh projde PriceOverrideSchema se zachovanou marží');

assert.equal(resolveDefaultMarzeProcent(undefined), 10);
assert.equal(resolveDefaultMarzeProcent(0), 0);
assert.equal(resolveDefaultMarzeProcent(25), 25);
console.log('✓ chybějící firemní marže má fallback 10 %, explicitní 0 % zůstává platné');

console.log(`\n${cases.length + 2} passed, 0 failed`);
