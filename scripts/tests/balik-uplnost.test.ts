import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBalikChecklist, createBalikPotvrzeni,
} from '../src/lib/balik-uplnost.js';
import { computeSubmitGate } from '../src/lib/submit-gate.js';

const dirs: string[] = [];

async function fixture(analysis: unknown, generated: string[] = [], confirmations?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vz-balik-'));
  dirs.push(dir);
  await writeFile(join(dir, 'analysis.json'), JSON.stringify(analysis), 'utf-8');
  await writeFile(join(dir, 'field-validation.json'), JSON.stringify([{ overall: 'pass' }]), 'utf-8');
  for (const filename of generated) await writeFile(join(dir, filename), 'test', 'utf-8');
  if (confirmations) await writeFile(join(dir, 'balik-potvrzeni.json'), JSON.stringify(confirmations), 'utf-8');
  return dir;
}

test.after(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); });

test('typ má při párování přednost před názvem', () => {
  const [item] = buildBalikChecklist({
    pozadovaneDokumenty: [{ nazev: 'Krycí list', typ: 'smlouva', povinny: true }],
    vygenerovaneSoubory: ['kryci_list.pdf', 'navrh_smlouvy.docx'],
    prilohyZakazky: [], firemniDoklady: [],
  });
  assert.equal(item.status, 'pokryto');
  assert.equal(item.soubor, 'navrh_smlouvy.docx');
});

test('název se páruje bez diakritiky a interpunkce', () => {
  const [item] = buildBalikChecklist({
    pozadovaneDokumenty: [{ nazev: 'Příloha č. 7 – Čestné prohlášení!', povinny: true }],
    vygenerovaneSoubory: [], prilohyZakazky: ['Priloha c 7 cestne prohlaseni.pdf'], firemniDoklady: [],
  });
  assert.equal(item.status, 'pokryto');
});

test('povinný chybějící dokument blokuje submit-gate', async () => {
  const dir = await fixture({ kvalifikace: [], pozadovane_dokumenty: [
    { nazev: 'Návrh smlouvy', typ: 'smlouva', povinny: true },
  ] });
  const result = await computeSubmitGate(dir);
  assert.equal(result.ready, false);
  assert.ok(result.problems.some((problem) => problem.includes('Chybí povinný dokument')));
});

test('nejisté párování bez potvrzení blokuje a po auditovaném potvrzení projde', async () => {
  const requirement = { nazev: 'Příloha č. 9', typ: 'jine' as const, povinny: true };
  const [item] = buildBalikChecklist({
    pozadovaneDokumenty: [requirement], vygenerovaneSoubory: ['obecna_priloha.pdf'], prilohyZakazky: [], firemniDoklady: [],
  });
  const blockedDir = await fixture({ kvalifikace: [], pozadovane_dokumenty: [requirement] }, ['obecna_priloha.pdf']);
  const blocked = await computeSubmitGate(blockedDir);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.problems.some((problem) => problem.includes('potvrďte ručně')));

  const confirmation = createBalikPotvrzeni({ sub: 'server-user' }, new Date('2026-07-12T10:00:00Z'));
  const allowedDir = await fixture(
    { kvalifikace: [], pozadovane_dokumenty: [requirement] }, ['obecna_priloha.pdf'], { [item.klic]: confirmation },
  );
  const allowed = await computeSubmitGate(allowedDir);
  assert.equal(allowed.ready, true, allowed.problems.join(' | '));
});

test('stará analýza bez pole pouze varuje', async () => {
  const dir = await fixture({ kvalifikace: [] });
  const result = await computeSubmitGate(dir);
  assert.equal(result.ready, true);
  assert.ok(result.warnings.includes('Úplnost balíku nelze ověřit — analýza je z předchozí verze.'));
});

test('auditní identita pochází ze serverového principalu, ne z klientského těla', () => {
  const clientBody = { klic: 'jine:priloha', potvrdil: 'podvržený klient', at: '2000-01-01T00:00:00Z' };
  const confirmation = createBalikPotvrzeni({ name: 'Serverový uživatel', sub: 'jwt-sub' }, new Date('2026-07-12T10:00:00Z'));
  assert.equal(confirmation.potvrdil, 'Serverový uživatel');
  assert.notEqual(confirmation.potvrdil, clientBody.potvrdil);
  assert.equal(confirmation.at, '2026-07-12T10:00:00.000Z');
});
