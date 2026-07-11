import { strict as assert } from 'node:assert';
import test from 'node:test';

import { compareAiVsMarket } from '../src/lib/price-reality.js';
import type { WebPriceSource } from '../src/lib/types.js';

function source(cenaBezDph: number | null, cenaSdph: number | null): WebPriceSource {
  return {
    url: 'https://shop.cz/produkt',
    dodavatel: 'Test shop',
    cena_bez_dph: cenaBezDph,
    cena_s_dph: cenaSdph,
    dostupnost: 'skladem',
    poznamka: null,
  };
}

test('compareAiVsMarket: prázdné a bezcenové zdroje nemají tržní cenu', () => {
  assert.deepEqual(compareAiVsMarket(100, []), {
    nejlevnejsi_bez_dph: null,
    rozdil_procent: null,
    pod_trhem: false,
  });
  assert.deepEqual(compareAiVsMarket(100, [source(null, null)]), {
    nejlevnejsi_bez_dph: null,
    rozdil_procent: null,
    pod_trhem: false,
  });
});

test('compareAiVsMarket: vybere nejlevnější cenu a chybějící cenu bez DPH dopočítá', () => {
  assert.deepEqual(compareAiVsMarket(80, [source(null, 121), source(110, 133.1)]), {
    nejlevnejsi_bez_dph: 100,
    rozdil_procent: 25,
    pod_trhem: true,
  });
});

test('compareAiVsMarket: bez validního AI odhadu zachová trh, ale nevytvoří flag', () => {
  assert.deepEqual(compareAiVsMarket(null, [source(100, 121)]), {
    nejlevnejsi_bez_dph: 100,
    rozdil_procent: null,
    pod_trhem: false,
  });
});

test('compareAiVsMarket: přesně 5 % není pod trhem, až vyšší rozdíl ano', () => {
  const boundary = compareAiVsMarket(100, [source(105, 127.05)]);
  assert.equal(boundary.rozdil_procent, 5);
  assert.equal(boundary.pod_trhem, false);

  const above = compareAiVsMarket(100, [source(105.01, 127.0621)]);
  assert.equal(above.pod_trhem, true);
});
