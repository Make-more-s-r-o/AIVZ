import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { Request, Response } from 'express';

import { candidateFingerprint } from '../src/lib/candidate-fingerprint.js';
import { createApplyMarketPricesHandler } from '../src/lib/market-price-api.js';
import { applyMarketPrices } from '../src/lib/market-price-application.js';
import type { PolozkaMatch, ProductCandidate, ProductMatch, WebPriceSource } from '../src/lib/types.js';

function candidate(model: string, price = 50): ProductCandidate {
  return {
    vyrobce: 'Výrobce', model, popis: model, parametry: {}, shoda_s_pozadavky: [],
    cena_bez_dph: price, cena_s_dph: price * 1.21, cena_spolehlivost: 'stredni',
    dodavatele: [], dostupnost: 'skladem',
  };
}

function source(options: { supplier: string; net: number; pack: number; orientacni?: boolean }): WebPriceSource {
  return {
    url: `https://shop.test/${options.supplier}`, dodavatel: options.supplier,
    cena_bez_dph: options.net, cena_s_dph: options.net * 1.21,
    cena_baleni_s_dph: options.net * 1.21, baleni_ks: options.pack,
    mena: 'CZK', sazba_dph: 21, dostupnost: 'skladem', poznamka: null,
    ...(options.orientacni ? { orientacni: true } : {}),
  };
}

function item(index: number, options: {
  quantity?: number;
  state?: 'nalezeno' | 'orientacni';
  sources?: WebPriceSource[];
  fingerprint?: string;
  existingMargin?: number;
} = {}): PolozkaMatch {
  const selected = candidate(`Model-${index}`);
  return {
    polozka_nazev: `Položka ${index}`, polozka_index: index, mnozstvi: options.quantity ?? 1,
    typ: 'produkt', kandidati: [selected], vybrany_index: 0, oduvodneni_vyberu: 'test',
    ...(options.existingMargin !== undefined ? {
      cenova_uprava: {
        nakupni_cena_bez_dph: 50, nakupni_cena_s_dph: 60.5,
        marze_procent: options.existingMargin, nabidkova_cena_bez_dph: 60,
        nabidkova_cena_s_dph: 72.6, potvrzeno: true, poznamka: 'původní poznámka',
        zkontrolovano_at: '2026-07-11T10:00:00.000Z', zkontrolovano_kym: 'tester',
      },
    } : {}),
    overeni_ceny: {
      stav: options.state ?? 'nalezeno', overeno_at: '2026-07-11T10:00:00.000Z',
      kandidat_fingerprint: options.fingerprint ?? candidateFingerprint(selected, 0),
      zdroje: options.sources ?? [],
    },
  };
}

function match(items: PolozkaMatch[]): ProductMatch {
  return { tenderId: 'pilot', matchedAt: '2026-07-11T10:00:00.000Z', polozky_match: items };
}

function responseFixture(): Response & { body?: any; statusCode: number } {
  const response = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return response as Response & { body?: any; statusCode: number };
}

test('výběr zdroje zohlední celá balení a zachová stávající marži', () => {
  const productMatch = match([item(0, {
    quantity: 11,
    existingMargin: 20,
    sources: [
      source({ supplier: 'Levné balení', net: 1_000, pack: 10 }),
      source({ supplier: 'Dražší kusy', net: 190, pack: 1 }),
    ],
  })]);

  const result = applyMarketPrices(productMatch, 15);
  const price = productMatch.polozky_match?.[0]?.cenova_uprava;

  assert.equal(result.upraveno, 1);
  assert.equal(price?.nakupni_cena_bez_dph, 181.82);
  assert.equal(price?.marze_procent, 20);
  assert.equal(price?.nabidkova_cena_bez_dph, 218.18);
  assert.equal(price?.zdroj_nakupu?.dodavatel, 'Levné balení');
  assert.equal(price?.potvrzeno, false);
  assert.equal(price?.zkontrolovano_at, undefined);
  assert.deepEqual(result.zrusena_potvrzeni, [0]);
  assert.equal(price?.poznamka, 'původní poznámka; cena z ověřeného zdroje (Levné balení)');
});

test('způsobilost odmítne orientační zdroj a změněný fingerprint, default marži použije jen bez stávající', () => {
  const stale = item(2, { sources: [source({ supplier: 'Stale', net: 80, pack: 1 })], fingerprint: 'jiný|kandidát|0' });
  const withoutSource = item(3);
  delete withoutSource.overeni_ceny;
  const productMatch = match([
    item(0, { sources: [source({ supplier: 'Ověřený', net: 100, pack: 1 })] }),
    item(1, { state: 'orientacni', sources: [source({ supplier: 'Orientační', net: 10, pack: 1, orientacni: true })] }),
    stale,
    withoutSource,
  ]);

  const result = applyMarketPrices(productMatch, 15);

  assert.equal(result.upraveno, 1);
  assert.equal(result.preskoceno, 3);
  assert.deepEqual(result.duvody_preskoceni, { orientacni: 1, bez_zdroje: 1, zmeneny_kandidat: 1 });
  assert.equal(productMatch.polozky_match?.[0]?.cenova_uprava?.marze_procent, 15);
  assert.equal(productMatch.polozky_match?.[1]?.cenova_uprava, undefined);
  assert.equal(productMatch.polozky_match?.[2]?.cenova_uprava, undefined);
});

test('POST handler uloží návrhy nepotvrzené a v odpovědi vysvětlí přeskočení orientačních', async () => {
  let stored = match([
    item(0, { existingMargin: 12, sources: [source({ supplier: 'BAUHAUS', net: 100, pack: 1 })] }),
    item(1, { state: 'orientacni', sources: [source({ supplier: 'Možný zdroj', net: 50, pack: 1, orientacni: true })] }),
  ]);
  const handler = createApplyMarketPricesHandler({
    loadProductMatch: async () => structuredClone(stored),
    saveProductMatch: async (_id, value) => { stored = value; },
    resolveDefaultMargin: async () => 10,
    now: () => '2026-07-11T12:00:00.000Z',
  });
  const response = responseFixture();

  await handler(
    { params: { id: 'pilot' }, body: {} } as unknown as Request,
    response,
    () => undefined,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.upraveno, 1);
  assert.equal(response.body.preskoceno, 1);
  assert.equal(response.body.duvody_preskoceni.orientacni, 1);
  assert.equal(stored.polozky_match?.[0]?.cenova_uprava?.potvrzeno, false);
  assert.equal(stored.polozky_match?.[1]?.cenova_uprava, undefined);
});
