import { strict as assert } from 'node:assert';
import test from 'node:test';

import { findUnconfirmedPrices } from '../src/lib/price-confirmation.js';
import type { ProductMatch } from '../src/lib/types.js';

function match(items: Array<{ name: string; part?: string; confirmed: boolean }>): ProductMatch {
  return {
    tenderId: 't', matchedAt: '2026-07-11T00:00:00.000Z',
    polozky_match: items.map((item, index) => ({
      polozka_nazev: item.name, polozka_index: index, mnozstvi: 1, typ: 'produkt',
      cast_id: item.part, kandidati: [], vybrany_index: 0, oduvodneni_vyberu: '',
      cenova_uprava: item.confirmed ? {
        nakupni_cena_bez_dph: 100, nakupni_cena_s_dph: 121, marze_procent: 10,
        nabidkova_cena_bez_dph: 110, nabidkova_cena_s_dph: 133.1, potvrzeno: true,
      } : undefined,
    })),
  } as ProductMatch;
}

test('money-gate vrátí všechny nepotvrzené ceny', () => {
  assert.deepEqual(findUnconfirmedPrices(match([
    { name: 'A', confirmed: true }, { name: 'B', confirmed: false },
  ])), { count: 1, names: ['B'] });
});

test('money-gate ignoruje nepodávanou část', () => {
  const result = findUnconfirmedPrices(match([
    { name: 'A', part: 'A', confirmed: true },
    { name: 'B', part: 'B', confirmed: false },
  ]), new Set(['A']));
  assert.deepEqual(result, { count: 0, names: [] });
});
