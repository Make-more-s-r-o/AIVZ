import { strict as assert } from 'node:assert';
import test from 'node:test';

import { buildDraftFromWeb, webPriceGross } from '../src/lib/web-price.js';

test('webový zdroj dopočítá cenu bez DPH a zachová aktuální marži', () => {
  const draft = buildDraftFromWeb({
    url: 'https://shop.cz/model',
    dodavatel: 'Shop',
    cena_bez_dph: null,
    cena_s_dph: 1_210,
    dostupnost: 'skladem',
    poznamka: null,
  }, 17);

  assert.equal(draft.nakupni_cena_bez_dph, 1_000);
  assert.equal(draft.nakupni_cena_s_dph, 1_210);
  assert.equal(draft.marze_procent, 17);
  assert.equal(draft.nabidkova_cena_bez_dph, 1_170);
  assert.equal(draft.potvrzeno, false);
  assert.equal(draft.poznamka, 'Cena z webu: https://shop.cz/model');
});

test('zobrazená cena s DPH se dopočítá z ceny bez DPH', () => {
  assert.equal(webPriceGross({ cena_bez_dph: 2_000, cena_s_dph: null }), 2_420);
});
