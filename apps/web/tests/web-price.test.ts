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
