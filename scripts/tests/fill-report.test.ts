import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDocumentFillReport, buildFillReport, calculateMissRate } from '../src/lib/fill-report.js';
import { computeSubmitGate } from '../src/lib/submit-gate.js';

test('výpočet fill miss-rate je čistý a bezpečný pro nulový počet slotů', () => {
  assert.equal(calculateMissRate(2, 8), 0.25);
  assert.equal(calculateMissRate(0, 0), 0);
  const doc = buildDocumentFillReport('test.docx', [
    { original: 'IČO', hodnota: '123', vyplneno: true },
    { original: 'Telefon', hodnota: '', vyplneno: false },
  ]);
  assert.deepEqual([doc.slotu_celkem, doc.vyplneno, doc.nevyplneno, doc.miss_rate], [2, 1, 1, 0.5]);
});

async function minimalOutput(report?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vz-fill-report-'));
  await writeFile(join(dir, 'product-match.json'), JSON.stringify({ kandidati: [{ cena_bez_dph: 100 }], vybrany_index: 0 }));
  await writeFile(join(dir, 'field-validation.json'), JSON.stringify([{ overall: 'pass' }]));
  if (report) await writeFile(join(dir, 'fill-report.json'), JSON.stringify(report));
  return dir;
}

test('nevyplněný povinný slot blokuje submit-gate', async () => {
  const report = buildFillReport([buildDocumentFillReport('nabidka.docx', [{ klic: 'ico', original: 'IČO dodavatele', vyplneno: false }])]);
  const gate = await computeSubmitGate(await minimalOutput(report));
  assert.equal(gate.ready, false);
  assert.match(gate.problems.join(' '), /povinná pole.*ico/i);
});

test('nevyplněný volitelný slot je warning', async () => {
  const report = buildFillReport([buildDocumentFillReport('nabidka.docx', [{ klic: 'telefon', original: 'Kontaktní telefon', vyplneno: false }])]);
  const gate = await computeSubmitGate(await minimalOutput(report));
  assert.match(gate.warnings.join(' '), /volitelná pole.*telefon/i);
  assert.doesNotMatch(gate.problems.join(' '), /telefon/i);
});

test('starý output bez fill-report zůstává zpětně kompatibilní', async () => {
  const gate = await computeSubmitGate(await minimalOutput());
  assert.equal(gate.problems.some((problem) => /fill-report/i.test(problem)), false);
});
