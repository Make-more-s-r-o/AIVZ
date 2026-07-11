import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ProductMatchSchema } from '../src/lib/types.js';

const base = {
  tenderId: 'T-schema',
  matchedAt: '2026-07-11T10:00:00.000Z',
  polozky_match: [],
};

test('ProductMatchSchema přijímá staré overeni_ceny bez pole zdroje', () => {
  const parsed = ProductMatchSchema.safeParse({
    ...base,
    overeni_ceny: {
      stav: 'nalezeno',
      web_cena_bez_dph: 1_000,
      web_cena_s_dph: 1_210,
      mena: 'CZK',
      zdroj_url: 'https://legacy.cz/model',
      dodavatel: 'Legacy',
      overeno_at: '2026-07-11T10:00:00.000Z',
    },
  });

  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.overeni_ceny?.zdroje, undefined);
  if (parsed.success) assert.equal(parsed.data.overeni_ceny?.realita, undefined);
});

test('ProductMatchSchema přijímá a zachová nové multi-source overeni_ceny', () => {
  const parsed = ProductMatchSchema.safeParse({
    ...base,
    overeni_ceny: {
      stav: 'ekvivalent',
      shoda_typ: 'ekvivalent',
      web_cena_bez_dph: 900,
      web_cena_s_dph: 1_089,
      mena: 'CZK',
      zdroj_url: 'https://shop-a.cz/model',
      overeno_at: '2026-07-11T10:00:00.000Z',
      zdroje: [
        {
          url: 'https://shop-a.cz/model',
          dodavatel: 'Shop A',
          nazev_produktu: 'Skutečně nalezený produkt A',
          cena_bez_dph: 900,
          cena_s_dph: 1_089,
          dostupnost: 'skladem',
          poznamka: null,
        },
        {
          url: 'https://shop-b.cz/model',
          dodavatel: null,
          cena_bez_dph: null,
          cena_s_dph: 1_100,
          dostupnost: null,
          poznamka: null,
        },
      ],
      realita: {
        nejlevnejsi_bez_dph: 900,
        rozdil_procent: 12.5,
        pod_trhem: true,
      },
    },
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.overeni_ceny?.zdroje?.length, 2);
    assert.equal(parsed.data.overeni_ceny?.stav, 'ekvivalent');
    assert.equal(parsed.data.overeni_ceny?.zdroje?.[0]?.nazev_produktu, 'Skutečně nalezený produkt A');
    assert.equal(parsed.data.overeni_ceny?.realita?.pod_trhem, true);
  }
});

test('ProductMatchSchema zachová orientační zdroj a vyvráceného kandidáta', () => {
  const parsed = ProductMatchSchema.safeParse({
    ...base,
    tenderId: 'T-orientacni',
    overeni_ceny: {
      stav: 'orientacni',
      shoda_typ: 'ekvivalent',
      kandidat_neexistuje: true,
      overeno_at: '2026-07-11T10:00:00.000Z',
      zdroje: [{
        url: 'https://shop.cz/produkt', dodavatel: 'Shop', nazev_produktu: 'Možný ekvivalent',
        cena_bez_dph: 100, cena_s_dph: 121, cena_baleni_s_dph: 121, baleni_ks: 1,
        mena: 'CZK', dostupnost: 'skladem', poznamka: null,
        splnuje_specifikaci: false, shoda_parametru: [], orientacni: true,
      }],
    },
  });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.overeni_ceny?.stav, 'orientacni');
    assert.equal(parsed.data.overeni_ceny?.kandidat_neexistuje, true);
    assert.equal(parsed.data.overeni_ceny?.zdroje?.[0]?.orientacni, true);
  }
});
