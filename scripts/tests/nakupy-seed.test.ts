import { strict as assert } from 'node:assert';
import test from 'node:test';

import { closePool } from '../src/lib/db.js';
import { buildNakupySeedItems, buildNakupySeedPlan } from '../src/lib/nakupy-seed.js';
import { listNakupy, NAKUP_SEED_OWNED_FIELDS, setObjednano, upsertNakupy } from '../src/lib/nakupy-store.js';
import { PriceOverrideSchema, type ProductMatch, type TenderAnalysis } from '../src/lib/types.js';
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
        zkontrolovano_at: '2026-07-11T10:00:00.000Z',
        zkontrolovano_kym: 'tester',
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

test('H2: opakovaný seed vrací opravená seedová pole a operátorská pole nevlastní', () => {
  const existing = [{ polozka_index: 0, objednano: true }];
  const items = buildNakupySeedItems(matchWith(), [], existing);
  assert.equal(items[0]?.nakupni_cena_bez_dph, 10_000);
  assert.deepEqual(NAKUP_SEED_OWNED_FIELDS, [
    'polozka_nazev', 'mnozstvi', 'jednotka', 'nakupni_cena_bez_dph', 'dodavatel', 'url',
  ]);
  assert.equal(NAKUP_SEED_OWNED_FIELDS.includes('objednano' as never), false);
  assert.equal(NAKUP_SEED_OWNED_FIELDS.includes('objednano_at' as never), false);
  assert.equal(NAKUP_SEED_OWNED_FIELDS.includes('poznamka' as never), false);
  assert.deepEqual(existing, [{ polozka_index: 0, objednano: true }]);
});

test('H2: nepotvrzenou položku seed neaktualizuje a započítá ji do response info', () => {
  const match = matchWith();
  match.polozky_match![0]!.cenova_uprava!.potvrzeno = false;
  const plan = buildNakupySeedPlan(match, []);
  assert.deepEqual(plan.items, []);
  assert.equal(plan.vynechane_nepotvrzene, 1);
});

test('M1: operátorem uložený zdroj má přednost a projde schématem cenové úpravy', () => {
  const match = matchWith({
    stav: 'nalezeno',
    overeno_at: '2026-07-11T10:00:00.000Z',
    zdroje: [
      { url: 'https://nejlevnejsi.cz/model', dodavatel: 'Automat', cena_bez_dph: 500, cena_s_dph: 605, dostupnost: null, poznamka: null },
    ],
  });
  match.polozky_match![0]!.cenova_uprava!.zdroj_nakupu = {
    url: 'https://operator.cz/model', dodavatel: 'Volba operátora',
  };
  const parsed = PriceOverrideSchema.parse(match.polozky_match![0]!.cenova_uprava);
  const item = buildNakupySeedPlan(match, []).items[0];

  assert.equal(parsed.zdroj_nakupu?.url, 'https://operator.cz/model');
  assert.deepEqual({ url: item?.url, dodavatel: item?.dodavatel }, {
    url: 'https://operator.cz/model', dodavatel: 'Volba operátora',
  });
});

test('M2: nejlevnější zdroj se vybírá po normalizaci na cenu s DPH', () => {
  const items = buildNakupySeedItems(matchWith({
    stav: 'nalezeno',
    overeno_at: '2026-07-11T10:00:00.000Z',
    zdroje: [
      { url: 'https://bez-dph.cz/model', dodavatel: 'Bez DPH', cena_bez_dph: 100, cena_s_dph: null, dostupnost: null, poznamka: null },
      { url: 'https://s-dph.cz/model', dodavatel: 'S DPH', cena_bez_dph: null, cena_s_dph: 115, dostupnost: null, poznamka: null },
    ],
  }), []);
  assert.equal(items[0]?.url, 'https://s-dph.cz/model');
});

test('M4: legacy single-product se seeduje na index 0 s názvem kandidáta a daty z analýzy', () => {
  const multi = matchWith();
  const override = multi.polozky_match![0]!.cenova_uprava!;
  const legacy = {
    tenderId: 'T-legacy',
    matchedAt: '2026-07-11T10:00:00.000Z',
    kandidati: [{
      vyrobce: 'Acme', model: 'Laser 500', popis: 'Laser', parametry: {}, shoda_s_pozadavky: [],
      cena_bez_dph: 10_000, cena_s_dph: 12_100, cena_spolehlivost: 'vysoka',
      dodavatele: [], dostupnost: 'skladem',
    }],
    vybrany_index: 0,
    cenova_uprava: override,
  } as ProductMatch;
  const analysis = {
    zakazka: { nazev: 'Zakázka', predmet: 'Předmět' },
    polozky: [{ nazev: 'Laser dle ZD', mnozstvi: 3, jednotka: 'ks', specifikace: '' }],
  } as TenderAnalysis;
  const plan = buildNakupySeedPlan(legacy, [], analysis);

  assert.equal(plan.items[0]?.polozka_index, 0);
  assert.equal(plan.items[0]?.polozka_nazev, 'Acme Laser 500');
  assert.equal(plan.items[0]?.mnozstvi, 3);
  assert.equal(plan.items[0]?.jednotka, 'ks');
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
