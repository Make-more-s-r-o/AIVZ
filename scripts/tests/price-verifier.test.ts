import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mergePriceVerifications, parseWebPriceResponse } from '../src/lib/price-verifier.js';
import type { ProductMatch } from '../src/lib/types.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

test('parser seřadí, sanitizuje a omezí multi-source odpověď a naplní legacy pole', async () => {
  const response = await readFile(new URL('price-verifier-multi-response.txt', FIXTURES), 'utf-8');
  const parsed = parseWebPriceResponse(response, { cena_max_s_dph: 1_000 }, '2026-07-11T10:00:00.000Z');

  assert.equal(parsed.stav, 'nalezeno');
  assert.deepEqual(parsed.zdroje?.map((source) => source.dodavatel), ['Shop B', 'Shop C', 'Shop A']);
  assert.equal(parsed.zdroje?.length, 3);
  assert.equal(parsed.zdroj_url, 'https://shop-b.cz/model-x');
  assert.equal(parsed.dodavatel, 'Shop B');
  assert.equal(parsed.web_cena_s_dph, 968);
  assert.equal(parsed.web_cena_bez_dph, 800);
  assert.equal(parsed.prekracuje_strop, false);
  assert.equal(parsed.poznamka, 'akční cena | cena bez DPH dopočtena z ceny s DPH (DPH 21 %)');
});

test('parser zachová kompatibilitu se starou single-source odpovědí', async () => {
  const response = await readFile(new URL('price-verifier-legacy-response.txt', FIXTURES), 'utf-8');
  const parsed = parseWebPriceResponse(response, {}, '2026-07-11T10:00:00.000Z');

  assert.equal(parsed.stav, 'nalezeno');
  assert.equal(parsed.web_cena_bez_dph, 2_000);
  assert.equal(parsed.web_cena_s_dph, 2_420);
  assert.equal(parsed.zdroje?.[0]?.url, 'https://legacy-shop.cz/model-y');
  assert.equal(parsed.dodavatel, 'Legacy Shop');
  assert.equal(parsed.shoda_typ, 'presny');
  assert.equal(parsed.realita?.rozdil_procent, null);
});

test('parser zachová shoda_typ, názvy produktů a realitu multi-source ekvivalentu', async () => {
  const response = await readFile(new URL('price-verifier-equivalent-response.txt', FIXTURES), 'utf-8');
  const parsed = parseWebPriceResponse(
    response,
    { ai_cena_bez_dph: 20 },
    '2026-07-11T10:00:00.000Z',
  );

  assert.equal(parsed.stav, 'ekvivalent');
  assert.equal(parsed.shoda_typ, 'ekvivalent');
  assert.deepEqual(parsed.zdroje?.map((source) => source.nazev_produktu), [
    'Brusné plátno arch 230 × 280 mm P120',
    'Brusné plátno 230x280 zrnitost 120',
  ]);
  assert.equal(parsed.realita?.nejlevnejsi_bez_dph, 30);
  assert.equal(parsed.realita?.rozdil_procent, 50);
  assert.equal(parsed.realita?.pod_trhem, true);
});

test('M5: top-level legacy pole pocházejí výhradně z nejlevnějšího validního zdroje', () => {
  const parsed = parseWebPriceResponse(JSON.stringify({
    nalezeno: true,
    cena_bez_dph: 9_999,
    cena_s_dph: 12_098.79,
    zdroj_url: 'https://legacy.cz/jiny-produkt',
    dodavatel: 'Legacy obchod',
    dostupnost: 'na dotaz',
    zdroje: [{
      url: 'https://nejlevnejsi.cz/model',
      dodavatel: 'Nejlevnější obchod',
      cena_bez_dph: null,
      cena_s_dph: 1_210,
      dostupnost: 'skladem',
      poznamka: null,
    }],
  }), {}, '2026-07-11T10:00:00.000Z');

  assert.equal(parsed.web_cena_s_dph, 1_210);
  assert.equal(parsed.web_cena_bez_dph, 1_000);
  assert.equal(parsed.zdroj_url, 'https://nejlevnejsi.cz/model');
  assert.equal(parsed.dodavatel, 'Nejlevnější obchod');
  assert.equal(parsed.dostupnost, 'skladem');
});

test('merge multi-source výsledku mění pouze overeni_ceny správné položky', () => {
  const match = {
    tenderId: 'T-1',
    matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: [
      {
        polozka_index: 7,
        polozka_nazev: 'Notebook',
        typ: 'produkt',
        kandidati: [],
        vybrany_index: 0,
        oduvodneni_vyberu: 'test',
        cenova_uprava: {
          nakupni_cena_bez_dph: 900,
          nakupni_cena_s_dph: 1089,
          marze_procent: 10,
          nabidkova_cena_bez_dph: 990,
          nabidkova_cena_s_dph: 1197.9,
          potvrzeno: true,
        },
      },
    ],
  } as ProductMatch;
  const originalOverride = match.polozky_match?.[0]?.cenova_uprava;
  const overeni = parseWebPriceResponse(
    '{"nalezeno":true,"mena":"CZK","zdroje":[{"url":"https://shop.cz/x","dodavatel":"Shop","cena_bez_dph":800,"cena_s_dph":968,"dostupnost":"skladem","poznamka":null}]}',
    {},
    '2026-07-11T10:00:00.000Z',
  );

  mergePriceVerifications(match, [{ polozka_index: 7, polozka_nazev: 'Notebook', overeni_ceny: overeni }]);

  assert.equal(match.polozky_match?.[0]?.overeni_ceny?.zdroje?.[0]?.url, 'https://shop.cz/x');
  assert.strictEqual(match.polozky_match?.[0]?.cenova_uprava, originalOverride);
  assert.equal(match.polozky_match?.[0]?.cenova_uprava?.potvrzeno, true);
});
