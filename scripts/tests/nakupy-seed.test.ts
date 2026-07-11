import { strict as assert } from 'node:assert';
import test from 'node:test';

import { closePool } from '../src/lib/db.js';
import { buildNakupySeedItems } from '../src/lib/nakupy-seed.js';
import { listNakupy, setObjednano, upsertNakupy } from '../src/lib/nakupy-store.js';
import type { ProductMatch } from '../src/lib/types.js';
import type { WebFindingRow } from '../src/lib/web-findings-store.js';

function matchWith(overeni_ceny?: NonNullable<ProductMatch['polozky_match']>[number]['overeni_ceny']): ProductMatch {
  return {
    tenderId: 'T-1',
    matchedAt: '2026-07-11T10:00:00.000Z',
    polozky_match: [{
      polozka_index: 0,
      polozka_nazev: 'Notebook',
      mnozstvi: 2,
      jednotka: 'ks',
      typ: 'produkt',
      kandidati: [],
      vybrany_index: 0,
      oduvodneni_vyberu: 'test',
      cenova_uprava: {
        nakupni_cena_bez_dph: 10_000,
        nakupni_cena_s_dph: 12_100,
        marze_procent: 10,
        nabidkova_cena_bez_dph: 11_000,
        nabidkova_cena_s_dph: 13_310,
        potvrzeno: true,
      },
      overeni_ceny,
    }],
  };
}

function finding(overrides: Partial<WebFindingRow> = {}): WebFindingRow {
  return {
    id: 1,
    tender_id: 'T-1',
    polozka_index: 0,
    polozka_nazev: 'Notebook',
    produkt: null,
    dodavatel: 'Finding shop',
    url: 'https://finding.cz/notebook',
    cena_bez_dph: 8_000,
    cena_s_dph: 9_680,
    dostupnost: null,
    zdroj: 'web_verify',
    found_at: '2026-07-11T10:00:00.000Z',
    ...overrides,
  };
}

test('seed vybírá nejlevnější zdroje[] před legacy ověřením a findings', () => {
  const items = buildNakupySeedItems(matchWith({
    stav: 'nalezeno',
    overeno_at: '2026-07-11T10:00:00.000Z',
    zdroj_url: 'https://legacy.cz/notebook',
    dodavatel: 'Legacy',
    zdroje: [
      { url: 'https://drahy.cz/notebook', dodavatel: 'Drahý', cena_bez_dph: 9_000, cena_s_dph: 10_890, dostupnost: null, poznamka: null },
      { url: 'https://levny.cz/notebook', dodavatel: 'Levný', cena_bez_dph: 8_500, cena_s_dph: 10_285, dostupnost: null, poznamka: null },
    ],
  }), [finding()]);

  assert.equal(items[0]?.url, 'https://levny.cz/notebook');
  assert.equal(items[0]?.dodavatel, 'Levný');
  assert.equal(items[0]?.nakupni_cena_bez_dph, 10_000);
});

test('seed používá postupně legacy ověření, findings a nakonec null', () => {
  const legacy = buildNakupySeedItems(matchWith({
    stav: 'nalezeno', overeno_at: '2026-07-11T10:00:00.000Z',
    zdroj_url: 'https://legacy.cz/notebook', dodavatel: 'Legacy',
  }), [finding()]);
  assert.deepEqual({ dodavatel: legacy[0]?.dodavatel, url: legacy[0]?.url }, {
    dodavatel: 'Legacy', url: 'https://legacy.cz/notebook',
  });

  const fromFinding = buildNakupySeedItems(matchWith(), [finding()]);
  assert.equal(fromFinding[0]?.url, 'https://finding.cz/notebook');

  const empty = buildNakupySeedItems(matchWith(), []);
  assert.deepEqual({ dodavatel: empty[0]?.dodavatel, url: empty[0]?.url }, { dodavatel: null, url: null });
});

test('opakovaný seed existující objednanou položku vynechá a nemění', () => {
  const existing = [{ polozka_index: 0, objednano: true }];
  assert.deepEqual(buildNakupySeedItems(matchWith(), [], existing), []);
  assert.deepEqual(existing, [{ polozka_index: 0, objednano: true }]);
});

test('nákupní store bez DATABASE_URL degraduje graceful', async () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  await closePool();
  try {
    assert.deepEqual(await listNakupy('T-1'), []);
    await assert.rejects(upsertNakupy('T-1', [{
      polozka_index: 0, polozka_nazev: 'Notebook', mnozstvi: 1, jednotka: 'ks',
      nakupni_cena_bez_dph: 1_000, dodavatel: null, url: null,
    }]), /db_unavailable/);
    await assert.rejects(setObjednano('T-1', 0, true), /db_unavailable/);
  } finally {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await closePool();
  }
});
