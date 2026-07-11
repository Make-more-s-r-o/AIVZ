import { strict as assert } from 'node:assert';
import test from 'node:test';

import { compareAiVsMarket, realCostForQuantity } from '../src/lib/price-reality.js';
import type { WebPriceSource } from '../src/lib/types.js';

function source(options: {
  net?: number | null;
  gross?: number | null;
  pack?: number | null;
  availability?: WebPriceSource['dostupnost'];
  tax?: number | null;
  supplier?: string;
  orientacni?: boolean;
} = {}): WebPriceSource {
  return {
    url: `https://shop.cz/${options.supplier ?? 'produkt'}`,
    dodavatel: options.supplier ?? 'Test shop',
    cena_bez_dph: options.net ?? null,
    cena_s_dph: options.gross ?? null,
    cena_baleni_s_dph: options.gross ?? null,
    baleni_ks: options.pack ?? null,
    mena: 'CZK',
    ...(options.tax !== undefined ? { sazba_dph: options.tax } : {}),
    dostupnost: options.availability ?? 'skladem',
    poznamka: null,
    ...(options.orientacni ? { orientacni: true } : {}),
  };
}

test('compareAiVsMarket: prázdné zdroje nemají tržní cenu', () => {
  assert.deepEqual(compareAiVsMarket(100, []), {
    nejlevnejsi_bez_dph: null,
    rozdil_procent: null,
    pod_trhem: false,
  });
});

test('C2: realCostForQuantity kupuje celá balení a přepočte náklad na požadované množství', () => {
  const packed = source({ net: 1_000, gross: 1_210, pack: 10 });
  assert.equal(realCostForQuantity(packed, 10), 1_000);
  assert.equal(realCostForQuantity(packed, 11), 2_000);
  assert.equal(compareAiVsMarket(100, [packed], 11).nejlevnejsi_bez_dph, 181.82);
});

test('C2: nejasné balení se do ochrany nezapočítá a nese vysvětlení', () => {
  const reality = compareAiVsMarket(100, [source({ net: 120, gross: 145.2, pack: null })]);
  assert.equal(reality.nejlevnejsi_bez_dph, null);
  assert.match(reality.poznamka ?? '', /nejasným počtem kusů v balení/);
});

test('H2: přímé porovnání nemá pětiprocentní toleranci', () => {
  const reality = compareAiVsMarket(100, [source({ net: 100.01, gross: 121.0121, pack: 1 })]);
  assert.equal(reality.pod_trhem, true);
  assert.equal(reality.rozdil_procent, 0);
});

test('H4: guard ignoruje nedostupné i zdroje na dotaz a vybere použitelný skladový zdroj', () => {
  const reality = compareAiVsMarket(80, [
    source({ net: 50, gross: 60.5, pack: 1, availability: 'není skladem', supplier: 'Vyprodáno' }),
    source({ net: 60, gross: 72.6, pack: 1, availability: 'na dotaz', supplier: 'Na dotaz' }),
    source({ net: 100, gross: 121, pack: 1, availability: 'skladem', supplier: 'Skladem' }),
  ]);
  assert.equal(reality.nejlevnejsi_bez_dph, 100);
  assert.equal(reality.nejlevnejsi_dodavatel, 'Skladem');
  assert.match(reality.poznamka ?? '', /vyloučeny/);
});

test('H4: bez použitelného zdroje zůstane guard neaktivní s poznámkou', () => {
  const reality = compareAiVsMarket(100, [source({ net: 120, gross: 145.2, pack: 1, availability: 'není skladem' })]);
  assert.equal(reality.nejlevnejsi_bez_dph, null);
  assert.equal(reality.pod_trhem, false);
  assert.match(reality.poznamka ?? '', /Žádný použitelný zdroj/);
});

test('orientační zdroj se nikdy nezapočítá do ochrany proti ztrátě', () => {
  const orientational = source({ net: 500, gross: 605, pack: 1, orientacni: true });
  const reality = compareAiVsMarket(100, [orientational]);

  assert.equal(realCostForQuantity(orientational, 1), null);
  assert.equal(reality.nejlevnejsi_bez_dph, null);
  assert.equal(reality.pod_trhem, false);
  assert.match(reality.poznamka ?? '', /Orientační zdroje.*vyloučeny/);
});

test('M1: gross-only s typickou sazbou dopočte čistou cenu, nejasná sazba použije hrubou cenu', () => {
  const typical = compareAiVsMarket(null, [source({ gross: 121, pack: 1 })]);
  assert.equal(typical.nejlevnejsi_bez_dph, 100);

  const unclear = compareAiVsMarket(null, [source({ gross: 121, pack: 1, tax: null })]);
  assert.equal(unclear.nejlevnejsi_bez_dph, 121);
  assert.match(unclear.poznamka ?? '', /konzervativní horní odhad/);
});
