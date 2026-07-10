/**
 * Deterministické testy validátoru nabídky (bez sítě, bez AI, bez DOCX).
 *
 * Spuštění (z adresáře scripts/):
 *   npx tsx tests/validate-deterministic.test.ts
 */
import { strict as assert } from 'node:assert';

import type { ProductMatch } from '../src/lib/types.js';
import {
  computeExpectedPriceTotals,
  containsHardPlaceholder,
  runDeterministicValidation,
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
