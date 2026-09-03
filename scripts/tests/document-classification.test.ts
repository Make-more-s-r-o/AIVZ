import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {
  classifyDocumentFilename,
  isSoupisFilename,
} from '../src/lib/document-parser.js';
import { extractCastIdFromFilename, parseSoupis } from '../src/parse-soupis.js';

const temporaryDirectories: string[] = [];
test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const NEN_DOCUMENT_FILENAMES = [
  'Zadávací_dokumentace podpis.pdf',
  'Výzva_k_podání_nabídek profil podpis.pdf',
  'Priloha 1 - Kryci list (1).docx',
  'Příloha 2a Technická specifikace Šicí dílna.pdf',
  'Příloha 2b Technická specifikace Kovodílna.pdf',
  'Příloha 2c Technická specifikace Truhlářská dílna.pdf',
  'Příloha 3a Výkaz výměr šicí dílna.xlsx',
  'Příloha 3b Výkaz výměr kovodílna.xlsx',
  'Příloha 3c Výkaz výměr truhlářská dílna.xlsx',
  'Příloha 4a Návrh kupní smlouvy Šicí dílna.docx',
  'Příloha 4b Návrh kupní smlouvy Kovodílna.docx',
  'Příloha 4c Návrh kupní smlouvy truhlářská dílna.docx',
  'Priloha 5 - Cestne prohlaseni_zakladni zpusobilost (1).doc',
  'Priloha 6 - Cestne prohlaseni_odpovedne plneni (1).docx',
  'Priloha 7 - Cestne prohlaseni_neexistence stretu (1).docx',
  'Priloha 8 - Seznam poddavatelu (1).docx',
  'Příloha 9 Čestné prohlášení technické parametry.docx',
  'Šifrovací N006-26-V00027380 Sdílna Litoměřice - technické vybavení.cer',
];

test('V4: N006/26/V00027380 classifies exactly the three 3a/3b/3c cost schedules', () => {
  const soupisy = NEN_DOCUMENT_FILENAMES.filter(isSoupisFilename);
  assert.deepEqual(soupisy, [
    'Příloha 3a Výkaz výměr šicí dílna.xlsx',
    'Příloha 3b Výkaz výměr kovodílna.xlsx',
    'Příloha 3c Výkaz výměr truhlářská dílna.xlsx',
  ]);
});

test('V4: shared classifier covers supported cost-list names and keeps cover sheets as templates', () => {
  for (const filename of [
    'Soupis položek.xlsx',
    'Výkaz_výměr.xlsx',
    'Položkový-rozpočet.xlsx',
    'Kalkulace nabídkové ceny.xlsx',
    'Cenová nabídka.xlsx',
  ]) {
    assert.equal(classifyDocumentFilename(filename).isSoupis, true, filename);
  }

  assert.deepEqual(
    classifyDocumentFilename('Krycí list – kalkulace nabídkové ceny.docx'),
    { isTemplate: true, isSoupis: false },
  );
  assert.equal(isSoupisFilename('Příloha 2a Technická specifikace Šicí dílna.pdf'), false);
});

test('V5: annex letters produce stable part IDs independent of discovery order', () => {
  const filenames = NEN_DOCUMENT_FILENAMES.filter(isSoupisFilename);
  const idsInDiscoveryOrder = filenames.map(extractCastIdFromFilename);
  const idsInReverseOrder = [...filenames].reverse().map(extractCastIdFromFilename).reverse();

  assert.deepEqual(idsInDiscoveryOrder, ['A', 'B', 'C']);
  assert.deepEqual(idsInReverseOrder, ['A', 'B', 'C']);
});

test('V5: named-part markers have word boundaries and eligibility is not a false Los match', () => {
  assert.equal(extractCastIdFromFilename('Část A - soupis.xlsx'), 'A');
  assert.equal(extractCastIdFromFilename('Cast_2-soupis.xlsx'), '2');
  assert.equal(extractCastIdFromFilename('Part B price.xlsx'), 'B');
  assert.equal(extractCastIdFromFilename('Los 3 - položky.xlsx'), '3');
  assert.equal(
    extractCastIdFromFilename('Priloha 5 - Cestne prohlaseni_zakladni zpusobilost (1).doc'),
    undefined,
  );
  assert.equal(extractCastIdFromFilename('/tmp/Cast Z/bez-identifikatoru.xlsx'), undefined);
});

test('V4/V5: Zařízení header parses a NEN-style schedule and preserves its filename part ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vz-document-classification-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'Příloha 3b Výkaz výměr kovodílna.xlsx');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('List1');
  sheet.addRow(['Krycí list - kovodílna']);
  sheet.addRow(['Zařízení', 'měrná jednotka', 'Počet', 'cena za mj bez DPH']);
  sheet.addRow(['Pásová bruska', 'ks', 2]);
  sheet.addRow(['Celkem']);
  await workbook.xlsx.writeFile(filePath);

  const result = await parseSoupis(filePath);
  assert.equal(result.cast_id, 'B');
  assert.deepEqual(result.polozky, [{
    cislo: 1,
    nazev: 'Pásová bruska',
    specifikace: '',
    mnozstvi: 2,
    jednotka: 'ks',
    kategorie: undefined,
    umisteni: undefined,
  }]);
});
