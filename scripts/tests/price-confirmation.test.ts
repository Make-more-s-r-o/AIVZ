import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertPricesConfirmedForGeneration,
  findUnconfirmedPrices,
  validateServerPriceWrite,
} from '../src/lib/price-confirmation.js';
import { candidateFingerprint } from '../src/lib/candidate-fingerprint.js';
import {
  PriceProvenanceSchema,
  type PriceProvenance,
  type ProductCandidate,
  type ProductMatch,
} from '../src/lib/types.js';

function proof(overrides: Partial<PriceProvenance> = {}): PriceProvenance {
  return PriceProvenanceSchema.parse({
    verze: 1,
    typ: 'overeny_eshop',
    stav: 'dolozena',
    url: 'https://shop.example.cz/produkty/bruska-123',
    zjisteno_at: '2026-07-11T00:00:00.000Z',
    cena_v_okamziku: {
      bez_dph: 100,
      s_dph: 121,
      mena: 'CZK',
      sazba_dph: 21,
      baleni_ks: 1,
    },
    zjistil: { typ: 'web_agent', id: 'price-verifier', run_id: 'run-1' },
    dodavatel: 'Example shop',
    kandidat_fingerprint: 'example|bruska-123',
    ...overrides,
  });
}

function match(items: Array<{
  name: string;
  part?: string;
  confirmed: boolean;
  provenance?: PriceProvenance | null;
}>): ProductMatch {
  return {
    tenderId: 't', matchedAt: '2026-07-11T00:00:00.000Z',
    polozky_match: items.map((item, index) => ({
      polozka_nazev: item.name, polozka_index: index, mnozstvi: 1, typ: 'produkt',
      cast_id: item.part, kandidati: [], vybrany_index: 0, oduvodneni_vyberu: '',
      cenova_uprava: item.confirmed ? {
        nakupni_cena_bez_dph: 100, nakupni_cena_s_dph: 121, marze_procent: 10,
        nabidkova_cena_bez_dph: 110, nabidkova_cena_s_dph: 133.1, potvrzeno: true,
        ...(item.provenance === null ? {} : { price_provenance: item.provenance ?? proof() }),
      } : undefined,
    })),
  } as ProductMatch;
}

test('money-gate vrátí všechny nepotvrzené ceny', () => {
  const result = findUnconfirmedPrices(match([
    { name: 'A', confirmed: true }, { name: 'B', confirmed: false },
  ]));
  assert.equal(result.count, 1);
  assert.deepEqual(result.names, ['B']);
  assert.deepEqual(result.issues.map((issue) => issue.name), ['B']);
  assert.match(result.issues[0]!.reasons.join(' '), /nemá potvrzenou cenu/);
});

test('money-gate ignoruje nepodávanou část', () => {
  const result = findUnconfirmedPrices(match([
    { name: 'A', part: 'A', confirmed: true },
    { name: 'B', part: 'B', confirmed: false },
  ]), new Set(['A']));
  assert.deepEqual(result, { count: 0, names: [], issues: [] });
});

test('generate má hard fail nad nepotvrzenou cenou', () => {
  assert.throws(
    () => assertPricesConfirmedForGeneration(match([{ name: 'B', confirmed: false }])),
    /B: nemá potvrzenou cenu/,
  );
});

test('samotné potvrzeno bez dokladu money-gate nesplní', () => {
  const result = findUnconfirmedPrices(match([
    { name: 'Bruska', confirmed: true, provenance: null },
  ]));
  assert.equal(result.count, 1);
  assert.deepEqual(result.names, ['Bruska']);
  assert.match(result.issues[0]!.reasons.join(' '), /chybí doklad/);
  assert.throws(
    () => assertPricesConfirmedForGeneration(match([
      { name: 'Bruska', confirmed: true, provenance: null },
    ])),
    /Bruska: chybí doklad/,
  );
});

test('money-gate vypíše nepovolený typ a propadlou platnost po položkách', () => {
  const informational = proof({ typ: 'odhad_modelu', stav: 'informacni', url: null });
  const expired = proof({ platnost_do: '2026-07-12T00:00:00.000Z' });
  const result = findUnconfirmedPrices(match([
    { name: 'Modelový odhad', confirmed: true, provenance: informational },
    { name: 'Starý doklad', confirmed: true, provenance: expired },
  ]), null, '2026-07-13T00:00:00.000Z');

  assert.equal(result.count, 2);
  assert.match(result.issues[0]!.reasons.join(' '), /nepovolený typ.*odhad_modelu/);
  assert.match(result.issues[1]!.reasons.join(' '), /propadlá platnost/);
  assert.throws(
    () => assertPricesConfirmedForGeneration(match([
      { name: 'Modelový odhad', confirmed: true, provenance: informational },
      { name: 'Starý doklad', confirmed: true, provenance: expired },
    ]), null, '2026-07-13T00:00:00.000Z'),
    /Modelový odhad:.*odhad_modelu.*Starý doklad:.*propadlá platnost/,
  );
});

test('potvrzená doložená cena s produktovou URL projde i v legacy single-product tvaru', () => {
  const multi = match([{ name: 'A', confirmed: true }]);
  assert.equal(findUnconfirmedPrices(multi).count, 0);

  const single = {
    tenderId: 'single',
    matchedAt: '2026-07-11T00:00:00.000Z',
    kandidati: [],
    vybrany_index: 0,
    cenova_uprava: multi.polozky_match![0]!.cenova_uprava,
  } as ProductMatch;
  assert.deepEqual(findUnconfirmedPrices(single), { count: 0, names: [], issues: [] });
  assert.doesNotThrow(() => assertPricesConfirmedForGeneration(single));
});

const serverCandidate: ProductCandidate = {
  vyrobce: 'Acme',
  model: 'Server-1',
  popis: 'Serverový testovací produkt',
  parametry: {},
  shoda_s_pozadavky: [],
  cena_bez_dph: 100,
  cena_s_dph: 121,
  cena_spolehlivost: 'nizka',
  dodavatele: [],
  dostupnost: 'neznámá',
};

function serverPriceBody(overrides: Record<string, unknown> = {}) {
  return {
    nakupni_cena_bez_dph: 100,
    nakupni_cena_s_dph: 121,
    marze_procent: 10,
    nabidkova_cena_bez_dph: 110,
    nabidkova_cena_s_dph: 133.1,
    potvrzeno: true,
    ...overrides,
  };
}

test('sabotáž 6: server nevěří provenienci z requestu', () => {
  assert.throws(
    () => validateServerPriceWrite(
      serverPriceBody({ price_provenance: proof() }),
      { kandidati: [serverCandidate], vybrany_index: 0 },
      { sub: 'jwt-user' },
      '2026-09-03T10:00:00.000Z',
    ),
    /klientská provenience nestačí/,
  );
});

test('server odmítne vyhledávací URL i u lidského potvrzení', () => {
  assert.throws(
    () => validateServerPriceWrite(
      serverPriceBody({
        zdroj_nakupu: { url: 'https://www.alza.cz/search?q=Cokoli', dodavatel: 'Alza' },
      }),
      { kandidati: [serverCandidate], vybrany_index: 0 },
      { sub: 'jwt-user' },
      '2026-09-03T10:00:00.000Z',
    ),
    /konkrétní produktovou stránku/,
  );
});

test('server vytvoří lidský snapshot jen z validované URL nebo doklad_ref', () => {
  const fromUrl = validateServerPriceWrite(
    serverPriceBody({
      zdroj_nakupu: { url: 'https://shop.example.cz/produkt/server-1', dodavatel: 'Example' },
    }),
    { kandidati: [serverCandidate], vybrany_index: 0 },
    { sub: 'jwt-user', name: 'Serverový uživatel' },
    '2026-09-03T10:00:00.000Z',
  );
  assert.equal(fromUrl.price_provenance.typ, 'lidsky_vstup');
  assert.equal(fromUrl.price_provenance.url, 'https://shop.example.cz/produkt/server-1');
  assert.equal(fromUrl.price_provenance.zjistil.id, 'jwt-user');
  assert.equal(fromUrl.zkontrolovano_kym, 'Serverový uživatel');

  const fromDocument = validateServerPriceWrite(
    serverPriceBody({ doklad_ref: 'nabidka-dodavatele-2026-09-03' }),
    { kandidati: [serverCandidate], vybrany_index: 0 },
    { sub: 'jwt-user' },
    '2026-09-03T10:00:00.000Z',
  );
  assert.equal(fromDocument.price_provenance.url, null);
  assert.equal(fromDocument.price_provenance.doklad_ref, 'nabidka-dodavatele-2026-09-03');
});

test('server z uloženého verifier nálezu vytvoří overeny_eshop snapshot', () => {
  const fingerprint = candidateFingerprint(serverCandidate, 0);
  const result = validateServerPriceWrite(
    serverPriceBody({
      zdroj_nakupu: { url: 'https://shop.example.cz/produkt/server-1', dodavatel: 'Example' },
    }),
    {
      kandidati: [serverCandidate],
      vybrany_index: 0,
      mnozstvi: 1,
      overeni_ceny: {
        stav: 'nalezeno',
        overeno_at: '2026-09-03T09:00:00.000Z',
        kandidat_fingerprint: fingerprint,
        zdroje: [{
          url: 'https://shop.example.cz/produkt/server-1',
          dodavatel: 'Example',
          cena_bez_dph: 100,
          cena_s_dph: 121,
          cena_baleni_s_dph: 121,
          baleni_ks: 1,
          mena: 'CZK',
          sazba_dph: 21,
          dostupnost: 'skladem',
          poznamka: null,
        }],
      },
    },
    { sub: 'jwt-user' },
    '2026-09-03T10:00:00.000Z',
  );
  assert.equal(result.price_provenance.typ, 'overeny_eshop');
  assert.equal(result.price_provenance.zjisteno_at, '2026-09-03T09:00:00.000Z');
  assert.equal(result.price_provenance.kandidat_fingerprint, fingerprint);
});

test('všechny tři serverové cenové endpointy používají jediný autoritativní validátor', async () => {
  const source = await readFile(new URL('../src/serve-api.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/validateServerPriceWrite\(/g)?.length, 3);
  assert.doesNotMatch(source, /validatePriceWrite\(/);
});
