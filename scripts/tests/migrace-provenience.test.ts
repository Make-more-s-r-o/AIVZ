import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { candidateFingerprint } from '../src/lib/candidate-fingerprint.js';
import {
  migratePriceProvenance,
  migrateProductMatchDocument,
  migrationApplies,
} from '../src/tools/migrace-provenience.js';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    vyrobce: 'Acme',
    model: 'Model 1',
    popis: 'Test',
    parametry: {},
    shoda_s_pozadavky: [],
    cena_bez_dph: 1_000,
    cena_s_dph: 1_210,
    cena_spolehlivost: 'nizka',
    dodavatele: ['Dodavatel Bez Dokladu'],
    dostupnost: 'neznámá',
    zdroj_ceny: 'Odhad z internetového trhu, bez ověření.',
    reference_urls: ['https://www.alza.cz/search?q=Model+1'],
    ...overrides,
  };
}

function rootMatch(overrides: Record<string, unknown> = {}) {
  return {
    tenderId: 'legacy-1',
    matchedAt: '2026-07-11T10:00:00.000Z',
    kandidati: [candidate()],
    vybrany_index: 0,
    oduvodneni_vyberu: 'test',
    ...overrides,
  };
}

test('migrace je bez explicitního apply dry-run a soubor byte-for-byte nezmění', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'vz-provenance-migration-'));
  const tenderDir = join(outputDir, 'legacy-1');
  const path = join(tenderDir, 'product-match.json');
  await mkdir(tenderDir);
  const before = `${JSON.stringify(rootMatch(), null, 2)}\n`;
  await writeFile(path, before, 'utf8');
  try {
    const report = await migratePriceProvenance({ outputDir });

    assert.equal(report.dryRun, true);
    assert.equal(report.prevedeno, 1);
    assert.equal(report.zustavaInformacni, 1);
    assert.equal(report.prevedenoNaOvereny, 0);
    assert.equal(report.vyrobenychUrl, 0);
    assert.equal(await readFile(path, 'utf8'), before);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('apply převede legacy odhad na informační provenienci a nikdy nevyrobí URL z dodavatele', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'vz-provenance-migration-'));
  const tenderDir = join(outputDir, 'legacy-1');
  const path = join(tenderDir, 'product-match.json');
  await mkdir(tenderDir);
  await writeFile(path, JSON.stringify(rootMatch()), 'utf8');
  try {
    const report = await migratePriceProvenance({ outputDir, apply: true });
    const stored = JSON.parse(await readFile(path, 'utf8'));
    const provenance = stored.kandidati[0].price_provenance;

    assert.equal(report.dryRun, false);
    assert.equal(report.prevedeno, 1);
    assert.equal(report.zustavaInformacni, 1);
    assert.equal(report.prevedenoNaOvereny, 0);
    assert.equal(report.chyba, 0);
    assert.equal(report.vyrobenychUrl, 0);
    assert.equal(provenance.typ, 'odhad_modelu');
    assert.equal(provenance.stav, 'informacni');
    assert.equal(provenance.url, null);
    assert.equal(provenance.dodavatel, undefined);
    assert.equal(provenance.zjisteno_at, '2026-07-11T10:00:00.000Z');
    assert.equal(provenance.poznamka, 'Odhad z internetového trhu, bez ověření.');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('platný existující zdroj s cenou, časem a shodným fingerprintem se převede na ověřený e-shop', () => {
  const selected = candidate();
  const fingerprint = candidateFingerprint(selected, 0);
  const result = migrateProductMatchDocument(rootMatch({
    kandidati: [selected],
    overeni_ceny: {
      stav: 'nalezeno',
      overeno_at: '2026-07-12T09:30:00.000Z',
      kandidat_fingerprint: fingerprint,
      zdroje: [{
        url: 'https://shop.example.cz/produkty/model-1',
        dodavatel: 'Doložený obchod',
        cena_bez_dph: 1_100,
        cena_s_dph: 1_331,
        mena: 'CZK',
        sazba_dph: 21,
        baleni_ks: 1,
      }],
    },
  }));
  const migrated = result.document as any;
  const provenance = migrated.kandidati[0].price_provenance;

  assert.equal(result.report.prevedenoNaOvereny, 1);
  assert.equal(result.report.zustavaInformacni, 0);
  assert.equal(provenance.typ, 'overeny_eshop');
  assert.equal(provenance.stav, 'dolozena');
  assert.equal(provenance.url, 'https://shop.example.cz/produkty/model-1');
  assert.equal(provenance.cena_v_okamziku.bez_dph, 1_100);
  assert.equal(provenance.kandidat_fingerprint, fingerprint);
});

test('neshodný fingerprint ani vyhledávací URL se na doklad nepovýší', () => {
  const selected = candidate();
  const cases = [
    { fingerprint: 'jiny|kandidat|0', url: 'https://shop.example.cz/produkty/model-1' },
    { fingerprint: candidateFingerprint(selected, 0), url: 'https://www.alza.cz/search?q=Model+1' },
  ];

  for (const verificationCase of cases) {
    const result = migrateProductMatchDocument(rootMatch({
      kandidati: [selected],
      overeni_ceny: {
        stav: 'nalezeno',
        overeno_at: '2026-07-12T09:30:00.000Z',
        kandidat_fingerprint: verificationCase.fingerprint,
        zdroje: [{
          url: verificationCase.url,
          dodavatel: 'Obchod',
          cena_bez_dph: 1_100,
          cena_s_dph: 1_331,
          mena: 'CZK',
        }],
      },
    }));
    const migrated = result.document as any;

    assert.equal(result.report.prevedenoNaOvereny, 0);
    assert.equal(result.report.zustavaInformacni, 1);
    assert.equal(migrated.kandidati[0].price_provenance.typ, 'odhad_modelu');
    assert.equal(migrated.kandidati[0].price_provenance.url, null);
  }
});

test('ostrý režim vyžaduje přesný explicitní přepínač --apply', () => {
  assert.equal(migrationApplies([]), false);
  assert.equal(migrationApplies(['--dry-run']), false);
  assert.equal(migrationApplies(['--apply=false']), false);
  assert.equal(migrationApplies(['--apply']), true);
});
