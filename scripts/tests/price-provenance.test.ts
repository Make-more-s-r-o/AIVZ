import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  PriceOverrideSchema,
  PriceProvenanceReadSchema,
  PriceProvenanceSchema,
  ProductMatchSchema,
  getPriceProvenanceGateReasons,
  isConcreteProductUrl,
} from '../src/lib/types.js';

function provenance(overrides: Record<string, unknown> = {}) {
  return {
    verze: 1,
    typ: 'overeny_eshop',
    stav: 'dolozena',
    url: 'https://shop.example.cz/produkt/tiskarna-123',
    zjisteno_at: '2026-07-11T12:00:00.000Z',
    cena_v_okamziku: {
      bez_dph: 1_000,
      s_dph: 1_210,
      mena: 'CZK',
      sazba_dph: 21,
      baleni_ks: 1,
    },
    zjistil: { typ: 'web_agent', id: 'verifier-1', model: 'web-model', run_id: 'run-1' },
    dodavatel: 'Example shop',
    kandidat_fingerprint: 'example|tiskarna-123',
    ...overrides,
  };
}

test('doložený e-shop odmítne explicitní tvary vyhledávacích URL', () => {
  const searchUrls = [
    'https://www.alza.cz/search?q=Cokoli',
    'https://shop.example.cz/catalog/hledat/notebook',
    'https://shop.example.cz/catalog/hledani',
    'https://shop.example.cz/vyhledavani.htm?term=vrta%C4%8Dka',
    'https://shop.example.cz/produkty?query=vrta%C4%8Dka',
    'https://shop.example.cz/produkty?search=vrta%C4%8Dka',
    'https://shop.example.cz/produkty?dotaz=vrta%C4%8Dka',
    'https://shop.example.cz/produkty?keyword=vrta%C4%8Dka',
    'https://www.heureka.cz/?h[fraze]=Cokoli',
  ];

  for (const url of searchUrls) {
    assert.equal(isConcreteProductUrl(url), false, url);
    assert.equal(PriceProvenanceSchema.safeParse(provenance({ url })).success, false, url);
  }
});

test('konkrétní produktová URL smí doložit cenu z e-shopu', () => {
  const parsed = PriceProvenanceSchema.parse(provenance());
  assert.equal(isConcreteProductUrl(parsed.url), true);
  assert.deepEqual(getPriceProvenanceGateReasons(parsed, '2026-07-12T00:00:00.000Z'), []);
});

test('modelový odhad a historická vítězná cena jsou vždy jen informační', () => {
  for (const typ of ['odhad_modelu', 'historicka_vitezna_cena'] as const) {
    assert.equal(PriceProvenanceSchema.safeParse(provenance({ typ, stav: 'dolozena', url: null })).success, false);
    assert.equal(PriceProvenanceSchema.safeParse(provenance({ typ, stav: 'informacni', url: null })).success, true);
  }
});

test('lidský doložený vstup vyžaduje URL nebo doklad_ref', () => {
  assert.equal(PriceProvenanceSchema.safeParse(provenance({
    typ: 'lidsky_vstup',
    url: null,
    zjistil: { typ: 'uzivatel', id: 'operator-1' },
  })).success, false);
  assert.equal(PriceProvenanceSchema.safeParse(provenance({
    typ: 'lidsky_vstup',
    url: null,
    doklad_ref: 'faktura-2026-001',
    zjistil: { typ: 'uzivatel', id: 'operator-1' },
  })).success, true);
});

test('READ je tolerantní, WRITE přísné a historický ProductMatch bez provenance se načte', () => {
  assert.equal(PriceProvenanceReadSchema.safeParse({ url: 'historický volný text' }).success, true);
  assert.equal(PriceProvenanceSchema.safeParse({ url: 'historický volný text' }).success, false);

  const legacy = ProductMatchSchema.safeParse({
    tenderId: 'legacy',
    matchedAt: '2025-01-01T00:00:00.000Z',
    kandidati: [{
      vyrobce: 'Acme', model: 'A', popis: '', parametry: {}, shoda_s_pozadavky: [],
      cena_bez_dph: 100, cena_s_dph: 121, dodavatele: ['Acme'], dostupnost: 'neznámá',
      zdroj_ceny: 'Odhad z podobných produktů',
    }],
    vybrany_index: 0,
    cenova_uprava: {
      nakupni_cena_bez_dph: 100,
      nakupni_cena_s_dph: 121,
      marze_procent: 10,
      nabidkova_cena_bez_dph: 110,
      nabidkova_cena_s_dph: 133.1,
      potvrzeno: true,
    },
  });
  assert.equal(legacy.success, true);
});

test('WRITE override při potvrzení vyžaduje způsobilý snapshot a zmrazí ho', () => {
  const baseOverride = {
    nakupni_cena_bez_dph: 1_000,
    nakupni_cena_s_dph: 1_210,
    marze_procent: 10,
    nabidkova_cena_bez_dph: 1_100,
    nabidkova_cena_s_dph: 1_331,
    potvrzeno: true,
    zkontrolovano_at: '2026-07-11T13:00:00.000Z',
    zkontrolovano_kym: 'operator-1',
  };
  assert.equal(PriceOverrideSchema.safeParse(baseOverride).success, false);

  const parsed = PriceOverrideSchema.parse({ ...baseOverride, price_provenance: provenance() });
  assert.equal(Object.isFrozen(parsed.price_provenance), true);
  assert.equal(Object.isFrozen(parsed.price_provenance?.cena_v_okamziku), true);
  assert.equal(Object.isFrozen(parsed.price_provenance?.zjistil), true);
});

test('propadlá platnost vrací konkrétní důvod brány', () => {
  const parsed = PriceProvenanceSchema.parse(provenance({
    platnost_do: '2026-07-12T00:00:00.000Z',
  }));
  assert.deepEqual(
    getPriceProvenanceGateReasons(parsed, '2026-07-13T00:00:00.000Z').map((reason) => reason.code),
    ['propadla_platnost'],
  );
});
