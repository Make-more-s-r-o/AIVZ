import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  DOMAIN_CATEGORY_VALUES,
  DOMAIN_REGISTRY,
  DOMAIN_REGISTRY_VERSION,
  buildDomainClassificationPrompt,
  categorizeCommodity as registryCategorizeCommodity,
  categorizeTender,
  domainMatches,
  normalizeCpvCodes,
  normalizeDomainCategories,
  resolveDomainCategory,
} from '../src/lib/monitoring/domain-registry.js';
import {
  KOMODITA_KATEGORIE_VALUES,
  categorizeCommodity,
} from '../src/lib/winprice-store.js';

const EXPECTED_CATEGORIES = [
  'it_av',
  'naradi_dilna',
  'zdravotnicke',
  'vozidla',
  'stavebni_prace',
  'potraviny',
  'energie',
  'nabytek',
  'kancelar',
  'sluzby',
  'ostatni',
];

test('registr v1 je jediným zdrojem přesně 11 veřejných kategorií', () => {
  assert.equal(DOMAIN_REGISTRY_VERSION, 1);
  assert.equal(DOMAIN_REGISTRY.version, DOMAIN_REGISTRY_VERSION);
  assert.deepEqual(DOMAIN_CATEGORY_VALUES, EXPECTED_CATEGORIES);
  assert.deepEqual(DOMAIN_REGISTRY.domains.map((domain) => domain.category), EXPECTED_CATEGORIES);
  assert.equal(new Set(DOMAIN_REGISTRY.domains.map((domain) => domain.category)).size, 11);

  // Sabotáž 5: win-price nesmí zavést kopii/odlišnou taxonomii.
  assert.strictEqual(KOMODITA_KATEGORIE_VALUES, DOMAIN_CATEGORY_VALUES);
  assert.strictEqual(categorizeCommodity, registryCategorizeCommodity);

  for (const domain of DOMAIN_REGISTRY.domains) {
    assert.ok(Array.isArray(domain.aliases));
    assert.ok(Array.isArray(domain.keywords));
    assert.ok(Array.isArray(domain.cpvPrefixes));
    assert.equal(typeof domain.weights.title, 'number');
    assert.equal(typeof domain.weights.cpv, 'number');
    for (const alias of domain.aliases) {
      assert.equal(resolveDomainCategory(alias), domain.category);
    }
  }
});

test('legacy aliasy se kanonizují bez vytváření dalších sektorů', () => {
  assert.equal(resolveDomainCategory('IT'), 'it_av');
  assert.equal(resolveDomainCategory('AV'), 'it_av');
  assert.equal(resolveDomainCategory('IT/AV'), 'it_av');
  assert.equal(resolveDomainCategory('kancelarsky'), 'kancelar');
  assert.deepEqual(normalizeDomainCategories(['IT', 'AV', 'it_av']), ['it_av']);
  assert.equal(domainMatches('AV', ['it_av']), true);
  assert.equal(domainMatches('kancelarsky', ['kancelar']), true);
  assert.equal(domainMatches('nabytek', ['IT', 'AV']), false);
});

test('CPV normalizátor přijímá kód s kontrolní číslicí, objekty a deduplikuje', () => {
  assert.deepEqual(
    normalizeCpvCodes(['44510000-8', { Kod: '44510000', nested: { cpv: 'CPV 44510000-8' } }]),
    ['44510000'],
  );
});

test('přesný CPV 44510000 má přednost a zařadí zakázku do dílenského oboru', () => {
  assert.equal(categorizeTender('Obecná dodávka', ['44510000-8']), 'naradi_dilna');
  assert.equal(categorizeTender('Dodávka notebooků', [{ kod: '44510000' }]), 'naradi_dilna');
  // Osmimístné pravidlo je exact, nikoli vymyšlený širší prefix.
  assert.equal(categorizeTender('Obecná dodávka', ['44519999']), 'ostatni');
});

test('zakázka bez CPV se stále kategorizuje podle názvu a 3D tisk patří do dílny', () => {
  assert.equal(categorizeTender('Dodávka serverů a notebooků'), 'it_av');
  assert.equal(categorizeTender('Dílenské vybavení pro odborný výcvik', []), 'naradi_dilna');
  assert.equal(categorizeTender('3D tiskárna pro výuku technických předmětů', null), 'naradi_dilna');
});

test('registr neobsahuje odhadnuté CPV prefixy pro nábytek ani zobecnění kódu nářadí', () => {
  const nabytek = DOMAIN_REGISTRY.domains.find((domain) => domain.category === 'nabytek');
  assert.deepEqual(nabytek?.cpvPrefixes, []);
  assert.deepEqual(
    DOMAIN_REGISTRY.domains.flatMap((domain) => domain.cpvPrefixes.map((prefix) => [domain.category, prefix])),
    [['naradi_dilna', '44510000']],
  );
});

test('prompt sektorového matcheru vzniká z kanonických kategorií registru', () => {
  const prompt = buildDomainClassificationPrompt();
  for (const category of DOMAIN_CATEGORY_VALUES) {
    assert.match(prompt, new RegExp(`- ${category}:`));
  }
  assert.match(prompt, /registru v1/);
  assert.match(prompt, /"sektor":"it_av"/);
});
