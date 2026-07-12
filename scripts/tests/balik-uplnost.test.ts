import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBalikChecklist, createBalikPotvrzeni, pozadavekFingerprint,
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

  const hash = createHash('sha256').update('test').digest('hex');
  const confirmation = createBalikPotvrzeni({ sub: 'server-user' }, 'obecna_priloha.pdf', hash, requirement, new Date('2026-07-12T10:00:00Z'));
  const allowedDir = await fixture(
    { kvalifikace: [], pozadovane_dokumenty: [requirement] }, ['obecna_priloha.pdf'], { [item.klic]: confirmation },
  );
  const allowed = await computeSubmitGate(allowedDir);
  assert.equal(allowed.ready, true, allowed.problems.join(' | '));
});

test('H5: stará analýza bez pole blokuje bez auditovaného převzetí celé zakázky', async () => {
  const dir = await fixture({ kvalifikace: [] });
  const result = await computeSubmitGate(dir);
  assert.equal(result.ready, false);
  assert.ok(result.problems.some((x) => x.includes('Analýza je z předchozí verze')));
  await writeFile(join(dir, 'balik-potvrzeni.json'), JSON.stringify({ __cela_zakazka__: {
    prevzato: true, duvod: 'Ručně ověřena celá zadávací dokumentace', kdo: 'Operátor', at: '2026-07-12T10:00:00Z',
  }}));
  assert.equal((await computeSubmitGate(dir)).ready, true);
});

test('auditní identita pochází ze serverového principalu, ne z klientského těla', () => {
  const clientBody = { klic: 'jine:priloha', potvrdil: 'podvržený klient', at: '2000-01-01T00:00:00Z' };
  const req = { nazev: 'Příloha', povinny: true };
  const confirmation = createBalikPotvrzeni({ name: 'Serverový uživatel', sub: 'jwt-sub' }, 'prilohy/a.pdf', 'a'.repeat(64), req, new Date('2026-07-12T10:00:00Z'));
  assert.equal(confirmation.potvrdil, 'Serverový uživatel');
  assert.notEqual(confirmation.potvrdil, clientBody.potvrdil);
  assert.equal(confirmation.at, '2026-07-12T10:00:00.000Z');
});

test('H1: firemní manifest bez fyzické kopie v přílohách nepokrývá ZIP', () => {
  const [item] = buildBalikChecklist({ pozadovaneDokumenty: [{ nazev: 'Návrh smlouvy', typ: 'smlouva', povinny: true }],
    vygenerovaneSoubory: [], prilohyZakazky: [], firemniDoklady: ['navrh_smlouvy.pdf'] });
  assert.equal(item.status, 'chybi'); assert.match(item.poznamka ?? '', /Nastavení firmy/);
});

test('H2: jeden soubor automaticky pokryje jen jeden požadavek', () => {
  const items = buildBalikChecklist({ pozadovaneDokumenty: [
    { nazev: 'Návrh smlouvy A', typ: 'smlouva', povinny: true }, { nazev: 'Návrh smlouvy B', typ: 'smlouva', povinny: true }],
    vygenerovaneSoubory: ['navrh_smlouvy.docx'], prilohyZakazky: [], firemniDoklady: [] });
  assert.deepEqual(items.map((x) => x.status), ['pokryto', 'nejiste']);
});

test('H3: potvrzení po změně obsahu souboru propadne', async () => {
  const requirement = { nazev: 'Příloha č. 9', typ: 'jine' as const, povinny: true };
  const [item] = buildBalikChecklist({ pozadovaneDokumenty: [requirement], vygenerovaneSoubory: ['obecna_priloha.pdf'], prilohyZakazky: [], firemniDoklady: [] });
  const confirmation = createBalikPotvrzeni({ sub: 'operator' }, item.soubor!, createHash('sha256').update('puvodni').digest('hex'), requirement);
  const dir = await fixture({ kvalifikace: [], pozadovane_dokumenty: [requirement] }, ['obecna_priloha.pdf'], { [item.klic]: confirmation });
  const result = await computeSubmitGate(dir);
  assert.equal(result.ready, false); assert.ok(result.problems.some((x) => x.includes('Potvrzení propadlo')));
});

test('H4: čísla se porovnávají jako celé tokeny (Příloha 1 není Příloha 11)', () => {
  const [item] = buildBalikChecklist({ pozadovaneDokumenty: [{ nazev: 'Příloha č. 1', povinny: true }],
    vygenerovaneSoubory: [], prilohyZakazky: ['Priloha c 11.pdf'], firemniDoklady: [] });
  assert.notEqual(item.status, 'pokryto');
});

test('M1: zamítnutí platí jen pro nezměněný fingerprint požadavku', async () => {
  const requirement = { nazev: 'AI výmysl', povinny: true };
  const klic = 'jine:ai vymysl';
  const rejection = { zamitnuto: true, duvod: 'V zadávací dokumentaci není', kdo: 'Operátor', at: '2026-07-12T10:00:00Z', pozadavek_fingerprint: pozadavekFingerprint(requirement) };
  const dir = await fixture({ kvalifikace: [], pozadovane_dokumenty: [requirement] }, [], { [klic]: rejection });
  assert.equal((await computeSubmitGate(dir)).ready, true);
  await writeFile(join(dir, 'analysis.json'), JSON.stringify({ kvalifikace: [], pozadovane_dokumenty: [{ ...requirement, nazev: 'Jiný požadavek' }] }));
  assert.equal((await computeSubmitGate(dir)).ready, false);
});
