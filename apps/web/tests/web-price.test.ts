import { strict as assert } from 'node:assert';
import test from 'node:test';

import { applyWebSource, buildDraftFromWeb, webPriceGross, withPriceDraft } from '../src/lib/web-price.js';
import { nakupySeedAction } from '../src/lib/nakupy-ui.js';

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
  assert.deepEqual(draft.zdroj_nakupu, { url: 'https://shop.cz/model', dodavatel: 'Shop' });
});

test('zobrazená cena s DPH se dopočítá z ceny bez DPH', () => {
  assert.equal(webPriceGross({ cena_bez_dph: 2_000, cena_s_dph: null }), 2_420);
});

test('C2: webový draft počítá celé balení pro požadované množství', () => {
  const draft = buildDraftFromWeb({
    url: 'https://shop.cz/baleni',
    dodavatel: 'Shop',
    cena_bez_dph: 1_000,
    cena_s_dph: 1_210,
    cena_baleni_s_dph: 1_210,
    baleni_ks: 10,
    mena: 'CZK',
    sazba_dph: 21,
    dostupnost: 'skladem',
    poznamka: null,
  }, 0, 11);
  assert.equal(draft.nakupni_cena_bez_dph, 181.82);
});

test('M1: webový draft s nejasnou DPH použije hrubou cenu konzervativně', () => {
  const draft = buildDraftFromWeb({
    url: 'https://shop.cz/nejasna-dph',
    dodavatel: 'Shop',
    cena_bez_dph: null,
    cena_s_dph: 121,
    cena_baleni_s_dph: 121,
    baleni_ks: 1,
    mena: 'CZK',
    sazba_dph: null,
    dostupnost: 'skladem',
    poznamka: null,
  }, 0);
  assert.equal(draft.nakupni_cena_bez_dph, 121);
});

test('H1: aplikovaný řádkový zdroj se propíše do rodičovské mapy pro hromadné potvrzení', () => {
  const original = new Map();
  let parentDrafts = original;
  const draft = applyWebSource({
    url: 'https://vybrany.cz/model',
    dodavatel: 'Vybraný obchod',
    cena_bez_dph: 750,
    cena_s_dph: 907.5,
  }, 10, (applied) => { parentDrafts = withPriceDraft(parentDrafts, 4, applied); });

  assert.equal(original.size, 0);
  assert.strictEqual(parentDrafts.get(4), draft);
  assert.equal(parentDrafts.get(4)?.nakupni_cena_bez_dph, 750);
});

test('M3: nad neprázdným nákupním seznamem zůstává sekundární akce Doplnit seznam', () => {
  assert.deepEqual(nakupySeedAction(3), { label: 'Doplnit seznam', variant: 'secondary' });
  assert.deepEqual(nakupySeedAction(0), { label: 'Sestavit nákupní seznam', variant: 'primary' });
});
