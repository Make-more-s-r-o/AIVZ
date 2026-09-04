import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPartDocumentPriceAssignments,
  resolveFormGenerationPolicy,
  scopeDocumentDataToPart,
  type DocumentData,
  type PartDocumentPriceAssignment,
} from '../src/lib/data-resolver.js';
import {
  discoverTemplates,
  templateLimitPerType,
} from '../src/lib/template-engine.js';

async function templateDirectory(
  t: { after: (fn: () => Promise<void> | void) => void },
  filenames: readonly string[],
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'e6b-template-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(filenames.map((filename) => writeFile(join(directory, filename), '')));
  return directory;
}

test('A: formuláře zadavatele mají přednost a vlastní builder je označený fallback', () => {
  for (const type of ['kryci_list', 'cestne_prohlaseni', 'seznam_poddodavatelu']) {
    assert.deepEqual(
      resolveFormGenerationPolicy({ type, origin: 'tender-form' }, 'clean'),
      { mode: 'fill', form_source: 'tender-form' },
      type,
    );
    assert.deepEqual(
      resolveFormGenerationPolicy({ type, origin: 'tender-form' }, 'reconstruct'),
      { mode: 'fill', form_source: 'tender-form' },
      `${type}: reconstruct by vytvořil nový dokument`,
    );
    assert.deepEqual(
      resolveFormGenerationPolicy({ type, origin: 'own-fallback' }, 'fill'),
      { mode: 'clean', form_source: 'own-fallback' },
      `${type}: chybějící formulář musí použít builder`,
    );
  }
  assert.deepEqual(
    resolveFormGenerationPolicy({ type: 'kupni_smlouva', origin: 'tender-form' }, 'reconstruct'),
    { mode: 'reconstruct' },
  );
});

test('B: limit se váže na počet částí a každý ořez hlásí počet i názvy', async (t) => {
  assert.equal(templateLimitPerType(), 4);
  assert.equal(templateLimitPerType(1), 4);
  assert.equal(templateLimitPerType(3), 12);

  const filenames = Array.from(
    { length: 5 },
    (_, index) => `Čestné prohlášení ${index + 1}.docx`,
  );
  const directory = await templateDirectory(t, filenames);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));
  let templates;
  try {
    templates = await discoverTemplates(directory);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(templates.length, 4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Limit 4 šablon typu cestne_prohlaseni/);
  assert.match(warnings[0]!, /zahozeno 1/);
  assert.match(warnings[0]!, /Čestné prohlášení 5\.docx/);

  const divided = await discoverTemplates(directory, { partCount: 3 });
  assert.equal(divided.length, 5, 'dělená zakázka nesmí použít pevný strop čtyři');
});

test('A/C: referenční formuláře se neztratí a objevené smlouvy nesou části A/B/C', async (t) => {
  const filenames = [
    'Priloha 1 - Kryci list (1).docx',
    'Priloha 5 - Cestne prohlaseni zakladni zpusobilost.docx',
    'Priloha 6 - Cestne prohlaseni odpovedne plneni.docx',
    'Priloha 7 - Cestne prohlaseni neexistence stretu.docx',
    'Priloha 8 - Seznam poddavatelu.docx',
    'Příloha 9 Čestné prohlášení technické parametry.docx',
    'Příloha 4a Návrh kupní smlouvy Šicí dílna.docx',
    'Příloha 4b Návrh kupní smlouvy Kovodílna.docx',
    'Příloha 4c Návrh kupní smlouvy truhlářská dílna.docx',
    'Návrh kupní smlouvy bez určení části.docx',
  ];
  const templates = await discoverTemplates(await templateDirectory(t, filenames), { partCount: 3 });

  assert.equal(templates.filter(({ type }) => type === 'kryci_list').length, 1);
  assert.equal(templates.filter(({ type }) => type === 'cestne_prohlaseni').length, 4);
  assert.equal(templates.filter(({ type }) => type === 'seznam_poddodavatelu').length, 1);
  assert.ok(templates.some(({ filename }) => filename.startsWith('Příloha 9')));
  assert.ok(templates.every(({ origin }) => origin === 'tender-form'));

  const contracts = templates
    .filter(({ filename }) => /^Příloha 4[a-c]/.test(filename))
    .sort((left, right) => left.filename.localeCompare(right.filename));
  assert.deepEqual(contracts.map(({ cast_id }) => cast_id), ['A', 'B', 'C']);
  assert.equal(
    templates.find(({ filename }) => filename.startsWith('Návrh kupní smlouvy'))?.cast_id,
    undefined,
  );

  const parts = [
    { id: 'A', nazev: 'Šicí dílna', cena_bez_dph: 200, cena_s_dph: 242, pocet_polozek: 1 },
    { id: 'B', nazev: 'Kovodílna', cena_bez_dph: 300, cena_s_dph: 363, pocet_polozek: 1 },
    { id: 'C', nazev: 'Truhlářská dílna', cena_bez_dph: 400, cena_s_dph: 484, pocet_polozek: 1 },
  ];
  const data = {
    celkova_cena_bez_dph: 900,
    celkova_cena_s_dph: 1089,
    dph_castka: 189,
    casti: parts,
    polozky: [
      { nazev: 'A', cast_id: 'A' },
      { nazev: 'B', cast_id: 'B' },
      { nazev: 'C', cast_id: 'C' },
    ],
  } as unknown as DocumentData;
  const assignments: PartDocumentPriceAssignment[] = contracts.map((contract) => {
    const scoped = scopeDocumentDataToPart(data, contract.cast_id);
    return {
      document: contract.filename,
      cast_id: contract.cast_id!,
      cena_bez_dph: scoped.celkova_cena_bez_dph,
      cena_s_dph: scoped.celkova_cena_s_dph,
    };
  });
  assert.deepEqual(assignments.map(({ cena_bez_dph }) => cena_bez_dph), [200, 300, 400]);
  assert.doesNotThrow(() => assertPartDocumentPriceAssignments(assignments, parts));
});

test('A/C: generátor používá policy, metadata původu a hotové cast_id šablony', async () => {
  const source = await readFile(new URL('../src/generate-bid.ts', import.meta.url), 'utf-8');
  assert.match(source, /resolveFormGenerationPolicy\(template, requestedMode\)/);
  assert.match(source, /form_source: formSource/);
  assert.match(source, /origin: 'own-fallback'/);

  const templateLoop = source.slice(
    source.indexOf('for (const template of templates)'),
    source.indexOf('assertPartDocumentPriceAssignments('),
  );
  assert.match(templateLoop, /template\.cast_id/);
  assert.doesNotMatch(templateLoop, /extractCastIdFromFilename\(template\.filename\)/);
});
