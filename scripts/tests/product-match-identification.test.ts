import { strict as assert } from 'node:assert';
import test from 'node:test';

import { ProductCandidateSchema } from '../src/lib/types.js';
import { PRODUCT_MATCH_SYSTEM, buildProductMatchUserMessage } from '../src/prompts/product-match.js';

const legacyCandidate = {
  vyrobce: 'Acme', model: 'X1', popis: 'Starý kandidát', parametry: {},
  shoda_s_pozadavky: [], cena_bez_dph: 100, cena_s_dph: 121,
  cena_spolehlivost: 'stredni', dodavatele: [], dostupnost: 'skladem',
};

test('starý product-match bez identifikace_jistota a katalogového čísla zůstává kompatibilní', () => {
  const parsed = ProductCandidateSchema.parse(legacyCandidate);
  assert.equal(parsed.identifikace_jistota, undefined);
  assert.equal(parsed.katalogove_cislo, undefined);
});

test('nový kontrakt přijímá identifikace_jistota a prompt vyžaduje bezpečnou identifikaci', () => {
  assert.equal(ProductCandidateSchema.parse({ ...legacyCandidate, identifikace_jistota: 'vysoka' }).identifikace_jistota, 'vysoka');
  const message = buildProductMatchUserMessage([{ nazev: 'Disk', specifikace: '150 mm', technicke_pozadavky: [] }], 'Test', 'Test');
  for (const field of ['"vyrobce"', '"model"', '"katalogove_cislo"', '"identifikace_jistota"']) assert.match(message, new RegExp(field));
  assert.match(PRODUCT_MATCH_SYSTEM, /NIKDY ho nevymýšlej/);
  assert.match(PRODUCT_MATCH_SYSTEM, /NIKDY nekombinuj model s parametry/);
  assert.match(PRODUCT_MATCH_SYSTEM, /U komoditního zboží/);
});
