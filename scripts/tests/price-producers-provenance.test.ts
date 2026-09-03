import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { attachModelPriceProvenance } from '../src/match-product.js';
import { applyPricePrefill } from '../src/lib/price-prefill.js';
import { warehouseMatchToCandidate, type WarehouseMatch } from '../src/lib/warehouse-matcher.js';
import { PRODUCT_MATCH_SYSTEM, buildServicePricingMessage } from '../src/prompts/product-match.js';
import { PriceProvenanceSchema, type PriceProvenance } from '../src/lib/types.js';

const ESTIMATED_AT = '2026-09-03T08:30:00.000Z';

test('sabotáž 2: match-product označí odhad jako informační modelovou cenu a zahodí falešné citace', () => {
  const candidate = {
    vyrobce: 'Acme',
    model: 'Model X',
    cena_bez_dph: 1_000,
    cena_s_dph: 1_210,
    zdroj_ceny: 'Ověřeno u konkrétního obchodu',
    reference_urls: ['https://www.alza.cz/search?q=Model+X'],
  };

  const provenance = attachModelPriceProvenance(
    candidate,
    2,
    'claude-sonnet-4-6',
    ESTIMATED_AT,
    'tender-model-price',
  );

  assert.equal(provenance.typ, 'odhad_modelu');
  assert.equal(provenance.stav, 'informacni');
  assert.equal(provenance.url, null);
  assert.equal(provenance.zjisteno_at, ESTIMATED_AT);
  assert.deepEqual(provenance.zjistil, {
    typ: 'model', id: 'match-product', model: 'claude-sonnet-4-6', run_id: 'tender-model-price',
  });
  assert.equal(provenance.kandidat_fingerprint, 'Acme|Model X|2');
  assert.equal('reference_urls' in candidate, false);
  assert.match(String(candidate.zdroj_ceny), /Modelový odhad.*bez ověření/);
  PriceProvenanceSchema.parse(provenance);
});

test('modelový prompt výslovně zakazuje tvrdit ověření ceny i vyrábět odkazy', () => {
  assert.match(PRODUCT_MATCH_SYSTEM, /NIKDY netvrď, že jsi cenu, dostupnost nebo konkrétního dodavatele ověřil/);
  assert.match(PRODUCT_MATCH_SYSTEM, /NIKDY nevymýšlej ani nevracej pole reference_urls/);
  const servicePrompt = buildServicePricingMessage([
    { nazev: 'Instalace', specifikace: 'Instalace zařízení' },
  ], 'Testovací zakázka');
  assert.match(servicePrompt, /pouze o modelový odhad bez ověření/);
  assert.match(servicePrompt, /NIKDY netvrď, že cena byla ověřena/);
});

test('informační modelová cena nevytvoří potvrditelný cenový draft', () => {
  const candidate = {
    vyrobce: 'Acme', model: 'Model X', popis: 'Reálný model', katalogove_cislo: 'X-1',
    cena_bez_dph: 1_000, cena_s_dph: 1_210, cena_spolehlivost: 'stredni',
  };
  attachModelPriceProvenance(candidate, 0, 'claude-sonnet-4-6', ESTIMATED_AT, 'tender-prefill');
  const item = { polozka_nazev: 'Položka', typ: 'produkt', kandidati: [candidate], vybrany_index: 0 };

  applyPricePrefill([item], 10);

  assert.equal(item.cenova_uprava, undefined);
});

function warehouseMatch(overrides: Partial<WarehouseMatch> = {}): WarehouseMatch {
  return {
    product_id: '2d931510-d99f-494a-8c67-87feb05e1594',
    manufacturer: 'Warehouse Acme',
    model: 'W-1',
    ean: null,
    part_number: 'W-1',
    description: 'Skladový produkt',
    parameters_normalized: {},
    category_slug: 'test',
    price_bez_dph: 2_000,
    price_s_dph: 2_420,
    price_source: 'Import dodavatele',
    price_source_url: 'https://shop.example.cz/produkty/w-1',
    price_fetched_at: '2026-09-02T12:00:00.000Z',
    match_tier: 'exact',
    match_score: 1,
    ...overrides,
  };
}

test('sabotáž 4: sklad čte source_url a fetched_at a jen s oběma vytvoří doloženou provenienci', async () => {
  const candidate = warehouseMatchToCandidate(warehouseMatch(), 1, ESTIMATED_AT);
  const provenance = candidate.price_provenance as PriceProvenance;
  assert.equal(provenance.typ, 'cenovy_sklad');
  assert.equal(provenance.stav, 'dolozena');
  assert.equal(provenance.url, 'https://shop.example.cz/produkty/w-1');
  assert.equal(provenance.zjisteno_at, '2026-09-02T12:00:00.000Z');
  assert.equal(provenance.kandidat_fingerprint, 'Warehouse Acme|W-1|1');
  PriceProvenanceSchema.parse(provenance);

  for (const incomplete of [
    warehouseMatch({ price_source_url: null }),
    warehouseMatch({ price_fetched_at: null }),
  ]) {
    const informational = warehouseMatchToCandidate(incomplete, 0, ESTIMATED_AT).price_provenance as PriceProvenance;
    assert.equal(informational.typ, 'cenovy_sklad');
    assert.equal(informational.stav, 'informacni');
  }

  // Pojistka proti regresi přímo v SQL všech tří tierů: nestačí mít pole jen v převodníku.
  const source = await readFile(new URL('../src/lib/warehouse-matcher.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/bp\.source_url as price_source_url/g) ?? []).length, 3);
});

test('doložený skladový kandidát vytvoří draft s nezávislým snapshotem provenience', () => {
  const candidate = warehouseMatchToCandidate(warehouseMatch(), 0, ESTIMATED_AT);
  const original = candidate.price_provenance as PriceProvenance;
  const item = { polozka_nazev: 'Skladová položka', typ: 'produkt', kandidati: [candidate], vybrany_index: 0 };

  applyPricePrefill([item], 10);

  const draft = item.cenova_uprava as { price_provenance?: PriceProvenance } | undefined;
  assert.ok(draft);
  assert.deepEqual(draft.price_provenance, original);
  assert.notStrictEqual(draft.price_provenance, original);
});
