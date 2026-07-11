/**
 * Jednotkový test resolveru výchozí marže pro GET /api/tenders/:id/pricing-defaults.
 * Bez sítě, bez FS — závislosti se injektují (vzor winprice-band-endpoint.test.ts).
 *
 * Spuštění z adresáře scripts/:
 *   npx tsx tests/pricing-defaults.test.ts
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  resolvePricingDefaults,
  type PricingDefaultsDeps,
} from '../src/lib/pricing-defaults.js';
import { resolveDefaultMarzeProcent, type CompanyData } from '../src/lib/company-store.js';

/** Minimální validní CompanyData fixture — testy řeší jen default_marze_procent. */
function companyFixture(id: string, marze?: number): CompanyData {
  return {
    id,
    nazev: `Firma ${id}`,
    ico: '12345678',
    dic: 'CZ12345678',
    sidlo: 'Praha',
    jednajici_osoba: 'Jan Novák',
    default_marze_procent: marze,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

test('firma přiřazená zakázce má přednost před default firmou', async () => {
  const consulted: string[] = [];
  const deps: PricingDefaultsDeps = {
    getTenderCompanyId: async () => 'abc',
    getCompany: async (id) => {
      consulted.push(id);
      return id === 'abc' ? companyFixture('abc', 15) : companyFixture('default', 99);
    },
    readLegacyCompany: async () => {
      throw new Error('legacy se nesmí číst, když existuje firma zakázky');
    },
  };
  assert.deepEqual(await resolvePricingDefaults('n-485400', deps), { default_marze_procent: 15 });
  assert.deepEqual(consulted, ['abc']);
});

test('zakázka bez firmy spadne na default firmu; explicitní 0 % zůstává platná', async () => {
  const deps: PricingDefaultsDeps = {
    getTenderCompanyId: async () => null,
    getCompany: async (id) => (id === 'default' ? companyFixture('default', 0) : null),
    readLegacyCompany: async () => null,
  };
  // Poznámka: getCompany prochází withCompanyDefaults, takže reálně nikdy nevrátí
  // undefined marži — 0 tady znamená vědomé nastavení operátora, ne díru v datech.
  assert.deepEqual(await resolvePricingDefaults('n-485400', deps), { default_marze_procent: 0 });
});

test('bez firem se čte legacy config/company.json', async () => {
  const deps: PricingDefaultsDeps = {
    getTenderCompanyId: async () => null,
    getCompany: async () => null,
    readLegacyCompany: async () => ({ default_marze_procent: 12 }),
  };
  assert.deepEqual(await resolvePricingDefaults('n-485400', deps), { default_marze_procent: 12 });
});

test('chybějící legacy soubor (reject) → fallback 10 %', async () => {
  const deps: PricingDefaultsDeps = {
    getTenderCompanyId: async () => null,
    getCompany: async () => null,
    readLegacyCompany: async () => {
      throw new Error('ENOENT');
    },
  };
  assert.deepEqual(await resolvePricingDefaults('n-485400', deps), { default_marze_procent: 10 });
});

test('výjimka kdekoli v resolve řetězci → fallback 10 %, nikdy 5xx', async () => {
  const deps: PricingDefaultsDeps = {
    getTenderCompanyId: async () => {
      throw new Error('disk error');
    },
    getCompany: async () => null,
    readLegacyCompany: async () => null,
  };
  assert.deepEqual(await resolvePricingDefaults('n-485400', deps), { default_marze_procent: 10 });
});

test('nevalidní marže z legacy configu se normalizuje na 10 %', async () => {
  const deps = (marze: unknown): PricingDefaultsDeps => ({
    getTenderCompanyId: async () => null,
    getCompany: async () => null,
    readLegacyCompany: async () => ({ default_marze_procent: marze as number }),
  });
  assert.deepEqual(await resolvePricingDefaults('t', deps(150)), { default_marze_procent: 10 });
  assert.deepEqual(await resolvePricingDefaults('t', deps(-5)), { default_marze_procent: 10 });
  assert.deepEqual(await resolvePricingDefaults('t', deps('nesmysl')), { default_marze_procent: 10 });
  // Číselný string projde (staré ruční configy) — stejné chování jako resolveDefaultMarzeProcent.
  assert.deepEqual(await resolvePricingDefaults('t', deps('15')), { default_marze_procent: 15 });
});

test('resolveDefaultMarzeProcent edge cases (rozšíření price-calculator.test.ts)', () => {
  assert.equal(resolveDefaultMarzeProcent(null), 10);
  assert.equal(resolveDefaultMarzeProcent(Number.NaN), 10);
  assert.equal(resolveDefaultMarzeProcent(100), 100);
  assert.equal(resolveDefaultMarzeProcent(101), 10);
  assert.equal(resolveDefaultMarzeProcent(''), 10);
  assert.equal(resolveDefaultMarzeProcent(' 20 '), 20);
});
