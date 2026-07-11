/**
 * Deterministické testy validátoru nabídky (bez sítě, bez AI, bez DOCX).
 *
 * Spuštění (z adresáře scripts/):
 *   npx tsx tests/validate-deterministic.test.ts
 */
import { strict as assert } from 'node:assert';

import type { ProductMatch, TenderAnalysis } from '../src/lib/types.js';
import {
  computeExpectedPriceTotals,
  containsHardPlaceholder,
  runDeterministicValidation,
  runSpecComplianceChecks,
  textContainsAmount,
  type GeneratedDocumentText,
} from '../src/lib/validation-deterministic.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

function doc(filename: string, text: string): GeneratedDocumentText {
  return { filename, path: `/tmp/${filename}`, text };
}

const company = {
  nazev: 'Make more s.r.o.',
  ico: '07023987',
  dic: 'CZ07023987',
};

const productMatch = {
  tenderId: 'fixture',
  matchedAt: new Date().toISOString(),
  polozky_match: [
    {
      polozka_nazev: 'Projektor',
      polozka_index: 0,
      mnozstvi: 2,
      vybrany_index: 0,
      kandidati: [{ cena_bez_dph: 100 }],
    },
    {
      polozka_nazev: 'Držák',
      polozka_index: 1,
      mnozstvi: 3,
      vybrany_index: 0,
      kandidati: [{ cena_bez_dph: 50 }],
    },
  ],
} as unknown as ProductMatch;

// --- Fixtury pro spec-compliance kontrolu ---
const technicalRequirements = [
  { parametr: 'Rozlišení', pozadovana_hodnota: 'Full HD', jednotka: null, povinny: true },
  { parametr: 'Barva krytu', pozadovana_hodnota: 'černá', jednotka: null, povinny: false },
] as unknown as TenderAnalysis['technicke_pozadavky'];

function candidate(overrides: Record<string, unknown> = {}): any {
  return {
    vyrobce: 'TestCorp',
    model: 'X1',
    popis: '',
    parametry: {},
    shoda_s_pozadavky: [],
    cena_bez_dph: 1000,
    cena_s_dph: 1210,
    dodavatele: [],
    dostupnost: 'skladem',
    ...overrides,
  };
}

function polozka(overrides: Record<string, unknown> = {}): any {
  return {
    polozka_nazev: 'Projektor',
    polozka_index: 0,
    vybrany_index: 0,
    typ: 'produkt',
    oduvodneni_vyberu: '',
    kandidati: [candidate()],
    ...overrides,
  };
}

function specMatch(items: any[]): ProductMatch {
  return {
    tenderId: 'fixture',
    matchedAt: new Date().toISOString(),
    polozky_match: items,
  } as unknown as ProductMatch;
}

async function run(): Promise<void> {
  await test('DPH přepočet používá cenu bez DPH a sazbu 21 %', () => {
    const totals = computeExpectedPriceTotals(productMatch);
    assert.equal(totals.bezDph, 350);
    assert.equal(totals.dph, 73.5);
    assert.equal(totals.sDph, 423.5);
  });

  await test('částky se hledají s českými mezerami, čárkami a tolerancí', () => {
    assert.equal(textContainsAmount('Celkem bez DPH: 1 234,00 Kč', 1234), true);
    assert.equal(textContainsAmount('Celkem s DPH: 1.493,14 Kč', 1493.14), true);
    assert.equal(textContainsAmount('Celkem s DPH: 421,60 Kč', 423.5), true);
    assert.equal(textContainsAmount('Celkem s DPH: 420,00 Kč', 423.5), false);
  });

  await test('DPH kontrola projde na fixture cenové nabídce', () => {
    const checks = runDeterministicValidation({
      company,
      productMatch,
      documents: [
        doc('kryci_list.docx', 'KRYCÍ LIST\nUchazeč: Make more s.r.o.\nIČO: 070 239 87\nDIČ: CZ 07023987'),
        doc('cenova_nabidka.docx', 'CENOVÁ NABÍDKA\nCelková nabídková cena bez DPH: 350,00 Kč\nCelková nabídková cena s DPH: 423,50 Kč'),
      ],
    });
    const priceCheck = checks.find((check) => check.kontrola.includes('DPH'));
    assert.equal(priceCheck?.status, 'pass');
    assert.equal(priceCheck?.zdroj, 'deterministic');
  });

  await test('placeholder detekce najde tvrdé placeholdery', () => {
    assert.equal(containsHardPlaceholder('Text: doplní účastník'), 'doplní účastník');
    assert.equal(containsHardPlaceholder('Text: [účastník vyplní]'), '[účastník vyplní]');
    assert.equal(containsHardPlaceholder('Text: {{datum}}'), '{{');
    assert.equal(containsHardPlaceholder('Text bez placeholderu'), null);
  });

  await test('IČO/DIČ/název firmy se matchují v krycím listu', () => {
    const checks = runDeterministicValidation({
      company,
      productMatch,
      documents: [
        doc('kryci_list.docx', 'KRYCÍ LIST\nDodavatel Make more s.r.o.\nIČO 070 239 87\nDIČ CZ 07023987'),
        doc('cenova_nabidka.docx', 'CENOVÁ NABÍDKA\nCena bez DPH 350,00 Kč\nCena s DPH 423,50 Kč'),
      ],
    });
    const identityCheck = checks.find((check) => check.kontrola.includes('Identita'));
    assert.equal(identityCheck?.status, 'pass');
  });

  // --- Shoda se specifikací (spec-compliance) ---

  await test('spec: nesplněný povinný požadavek → fail', () => {
    const checks = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({
          kandidati: [candidate({
            shoda_s_pozadavky: [
              { pozadavek: 'Rozlišení Full HD', splneno: false, hodnota: 'HD 720p', komentar: 'jen 720p' },
            ],
          })],
        }),
      ]),
    });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'fail');
    assert.equal(checks[0].kategorie, 'shoda_specifikace');
    assert.equal(checks[0].zdroj, 'deterministic');
    assert.ok(checks[0].detail.includes('HD 720p'));
    assert.ok(checks[0].detail.includes('jen 720p'));
  });

  await test('spec: nesplněný NEpovinný požadavek → žádný nález', () => {
    const checks = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({
          kandidati: [candidate({
            shoda_s_pozadavky: [
              { pozadavek: 'Barva krytu bílá', splneno: false, hodnota: 'černá' },
            ],
          })],
        }),
      ]),
    });
    assert.equal(checks.length, 0);
  });

  await test('spec: vše splněno → žádný nález', () => {
    const checks = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({
          kandidati: [candidate({
            shoda_s_pozadavky: [
              { pozadavek: 'Rozlišení Full HD', splneno: true, hodnota: 'Full HD' },
            ],
          })],
        }),
      ]),
    });
    assert.equal(checks.length, 0);
  });

  await test('spec: prázdné shoda_s_pozadavky u produktu → warning', () => {
    const checks = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({ kandidati: [candidate({ shoda_s_pozadavky: [] })] }),
      ]),
    });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'warning');
    assert.equal(checks[0].kategorie, 'shoda_specifikace');
  });

  await test('spec: položka typu sluzba se přeskočí', () => {
    const checks = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({
          typ: 'sluzba',
          kandidati: [candidate({
            shoda_s_pozadavky: [
              { pozadavek: 'Rozlišení Full HD', splneno: false, hodnota: 'HD' },
            ],
          })],
        }),
      ]),
    });
    assert.equal(checks.length, 0);
  });

  await test('spec: nenapárovaný požadavek se bere konzervativně jako povinný → fail', () => {
    const checks = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({
          kandidati: [candidate({
            shoda_s_pozadavky: [
              { pozadavek: 'Hmotnost do 2 kg', splneno: false, hodnota: '3 kg' },
            ],
          })],
        }),
      ]),
    });
    assert.equal(checks.length, 1);
    assert.equal(checks[0].status, 'fail');
  });

  await test('spec: párování jmen ignoruje diakritiku a velikost písmen', () => {
    // Požadavek „ROZLISENI" (bez diakritiky, verzálky) se musí napárovat na parametr
    // „Rozlišení" (povinny=false) → nepovinný → žádný fail. Bez normalizace by zůstal
    // nenapárovaný → konzervativně povinný → fail.
    const reqs = [
      { parametr: 'Rozlišení', pozadovana_hodnota: 'Full HD', jednotka: null, povinny: false },
    ] as unknown as TenderAnalysis['technicke_pozadavky'];
    const checks = runSpecComplianceChecks({
      technicalRequirements: reqs,
      productMatch: specMatch([
        polozka({
          kandidati: [candidate({
            shoda_s_pozadavky: [
              { pozadavek: 'ROZLISENI', splneno: false, hodnota: 'HD' },
            ],
          })],
        }),
      ]),
    });
    assert.equal(checks.length, 0);
  });

  await test('spec: zástupný kandidát (zadna_shoda) i nulová cena se přeskočí', () => {
    const zadnaShoda = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({
          kandidati: [candidate({
            zadna_shoda: true,
            shoda_s_pozadavky: [{ pozadavek: 'Rozlišení Full HD', splneno: false, hodnota: '-' }],
          })],
        }),
      ]),
    });
    assert.equal(zadnaShoda.length, 0);

    const nulovaCena = runSpecComplianceChecks({
      technicalRequirements,
      productMatch: specMatch([
        polozka({
          kandidati: [candidate({
            cena_bez_dph: 0,
            shoda_s_pozadavky: [{ pozadavek: 'Rozlišení Full HD', splneno: false, hodnota: '-' }],
          })],
        }),
      ]),
    });
    assert.equal(nulovaCena.length, 0);
  });

  await test('spec: filtr vybraných částí vynechá položky nevybraných částí', () => {
    const checks = runSpecComplianceChecks({
      technicalRequirements,
      selectedPartIds: new Set(['A']),
      productMatch: specMatch([
        polozka({
          cast_id: 'B',
          kandidati: [candidate({
            shoda_s_pozadavky: [{ pozadavek: 'Rozlišení Full HD', splneno: false, hodnota: 'HD' }],
          })],
        }),
      ]),
    });
    assert.equal(checks.length, 0);
  });
}

run()
  .catch((err) => {
    failed++;
    console.error('✗ neočekávaná chyba v test harness');
    console.error(err);
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
