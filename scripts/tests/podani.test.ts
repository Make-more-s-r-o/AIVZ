import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  sha256Hex,
  computeContentHash,
  buildManifest,
  celkovaCenaZMatch,
  evidenceInputSchema,
  buildEvidence,
  evidenceMatchesSubmission,
  finalizeEvidenceConflict,
  decideSubmissionRecord,
  persistEvidenceAfterStatus,
  type ManifestFileEntry,
  type SubmissionManifest,
} from '../src/lib/podani.js';
import { canTransition } from '../src/lib/stage-machine.js';

function file(name: string, content: string): ManifestFileEntry {
  return { name, sha256: sha256Hex(content), size: Buffer.byteLength(content) };
}

// --- Determinismus manifestu ---

test('computeContentHash: stejné soubory → stejný hash bez ohledu na pořadí', () => {
  const a = [file('kryci_list.docx', 'AAA'), file('cenova_nabidka.docx', 'BBB')];
  const b = [file('cenova_nabidka.docx', 'BBB'), file('kryci_list.docx', 'AAA')];
  assert.equal(computeContentHash(a), computeContentHash(b));
});

test('computeContentHash: změna obsahu jednoho souboru → jiný hash', () => {
  const a = [file('kryci_list.docx', 'AAA')];
  const b = [file('kryci_list.docx', 'ZZZ')];
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

test('buildManifest: content_hash nezávisí na čase vytvoření', () => {
  const files = [file('a.docx', 'X'), file('b.pdf', 'Y')];
  const m1 = buildManifest({ files, celkovaCena: 1000, vybraneCasti: null, previous: null, createdAt: '2026-01-01T00:00:00.000Z' });
  const m2 = buildManifest({ files, celkovaCena: 1000, vybraneCasti: null, previous: null, createdAt: '2026-07-11T12:34:56.000Z' });
  assert.equal(m1.manifest.content_hash, m2.manifest.content_hash);
});

// --- Immutabilita a verzování ---

test('buildManifest: nezměněné soubory → recyklace existujícího balíku (reused)', () => {
  const files = [file('a.docx', 'X')];
  const first = buildManifest({ files, celkovaCena: null, vybraneCasti: null, previous: null, createdAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.reused, false);
  assert.equal(first.manifest.version, 1);
  assert.equal(first.manifest.zip_filename, 'podani-v1.zip');

  const second = buildManifest({
    files, celkovaCena: null, vybraneCasti: null,
    previous: first.manifest, createdAt: '2026-02-02T00:00:00.000Z',
  });
  assert.equal(second.reused, true);
  assert.equal(second.manifest.version, 1);
  assert.equal(second.manifest.zip_filename, 'podani-v1.zip');
  // Recyklovaný manifest je identický (immutable), nezmění se ani čas.
  assert.equal(second.manifest.created_at, '2026-01-01T00:00:00.000Z');
});

test('buildManifest: změněné soubory → nová verze v2 a nový ZIP', () => {
  const first = buildManifest({
    files: [file('a.docx', 'X')], celkovaCena: null, vybraneCasti: null,
    previous: null, createdAt: '2026-01-01T00:00:00.000Z',
  });
  const changed = buildManifest({
    files: [file('a.docx', 'CHANGED')], celkovaCena: null, vybraneCasti: null,
    previous: first.manifest, createdAt: '2026-02-02T00:00:00.000Z',
  });
  assert.equal(changed.reused, false);
  assert.equal(changed.manifest.version, 2);
  assert.equal(changed.manifest.zip_filename, 'podani-v2.zip');
  assert.notEqual(changed.manifest.content_hash, first.manifest.content_hash);
});

test('buildManifest: files jsou seřazené podle jména', () => {
  const { manifest } = buildManifest({
    files: [file('z.pdf', '1'), file('a.docx', '2'), file('m.xlsx', '3')],
    celkovaCena: null, vybraneCasti: null, previous: null, createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(manifest.files.map((f) => f.name), ['a.docx', 'm.xlsx', 'z.pdf']);
});

// --- Celková cena z product-match ---

test('celkovaCenaZMatch: sečte cenu * množství přes položky', () => {
  const pm = {
    polozky_match: [
      { cenova_uprava: { nabidkova_cena_s_dph: 1210 }, mnozstvi: 2 },
      { cenova_uprava: { nabidkova_cena_s_dph: 500 }, mnozstvi: 1 },
    ],
  };
  assert.equal(celkovaCenaZMatch(pm, null), 2920);
});

test('celkovaCenaZMatch: respektuje výběr částí', () => {
  const pm = {
    polozky_match: [
      { cast_id: 'A', cenova_uprava: { nabidkova_cena_s_dph: 1000 }, mnozstvi: 1 },
      { cast_id: 'B', cenova_uprava: { nabidkova_cena_s_dph: 9999 }, mnozstvi: 1 },
    ],
  };
  assert.equal(celkovaCenaZMatch(pm, ['A']), 1000);
});

test('celkovaCenaZMatch: bez cen → null', () => {
  assert.equal(celkovaCenaZMatch({ polozky_match: [{ mnozstvi: 1 }] }, null), null);
  assert.equal(celkovaCenaZMatch(null, null), null);
});

// --- Validace evidence ---

test('evidenceInputSchema: přijme validní vstup', () => {
  const parsed = evidenceInputSchema.safeParse({
    portal: 'NEN',
    cas_podani: '2026-07-11T10:00:00.000Z',
    evidencni_cislo: 'Z2026-001',
  });
  assert.equal(parsed.success, true);
});

test('evidenceInputSchema: prázdný portál je chyba', () => {
  const parsed = evidenceInputSchema.safeParse({ portal: '  ', cas_podani: '2026-07-11T10:00:00.000Z' });
  assert.equal(parsed.success, false);
});

test('evidenceInputSchema: nevalidní čas je chyba', () => {
  const parsed = evidenceInputSchema.safeParse({ portal: 'NEN', cas_podani: '11. 7. 2026' });
  assert.equal(parsed.success, false);
});

test('buildEvidence: přidá server timestamp a vazbu na balík', () => {
  const manifest: SubmissionManifest = {
    version: 3, content_hash: 'abc123', created_at: '2026-01-01T00:00:00.000Z',
    zip_filename: 'podani-v3.zip', files: [], celkova_cena_s_dph: null, vybrane_casti: null,
  };
  const ev = buildEvidence(
    { portal: 'NEN', cas_podani: '2026-07-11T10:00:00.000Z' },
    manifest,
    '2026-07-11T10:05:00.000Z',
  );
  assert.equal(ev.manifest_version, 3);
  assert.equal(ev.manifest_content_hash, 'abc123');
  assert.equal(ev.zaznamenano, '2026-07-11T10:05:00.000Z');
});

test('evidenceMatchesSubmission: stejné klíčové údaje jsou idempotentní', () => {
  const manifest: SubmissionManifest = {
    version: 1, content_hash: 'hash', created_at: '2026-01-01T00:00:00.000Z',
    zip_filename: 'podani-v1.zip', files: [], celkova_cena_s_dph: null, vybrane_casti: null,
  };
  const input = { portal: 'NEN', cas_podani: '2026-07-11T10:00:00.000Z', evidencni_cislo: 'E-1' };
  const existing = buildEvidence(input, manifest, '2026-07-11T10:05:00.000Z');
  assert.equal(evidenceMatchesSubmission(existing as unknown as Record<string, unknown>, input, manifest), true);
  assert.equal(evidenceMatchesSubmission(existing as unknown as Record<string, unknown>, { ...input, evidencni_cislo: 'E-2' }, manifest), false);
});

test('finalizeEvidenceConflict: existující evidence blokuje re-finalizaci', () => {
  assert.match(finalizeEvidenceConflict(true) ?? '', /už byla podána/);
  assert.equal(finalizeEvidenceConflict(false), null);
});

test('decideSubmissionRecord: podání je one-way a idempotentní jen se stejnou evidencí', () => {
  assert.equal(decideSubmissionRecord('pripravena', false), 'create');
  assert.equal(decideSubmissionRecord('odeslana', true), 'idempotent');
  assert.equal(decideSubmissionRecord('odeslana', false), 'different_evidence');
  assert.equal(decideSubmissionRecord('vyhodnocena', true), 'illegal_stage');
  assert.equal(decideSubmissionRecord('vyhrano', true), 'illegal_stage');
});

test('persistEvidenceAfterStatus: DB předchází souboru', async () => {
  const calls: string[] = [];
  const result = await persistEvidenceAfterStatus({
    setSubmitted: async () => { calls.push('db:odeslana'); },
    writeEvidence: async () => { calls.push('fs:evidence'); },
    restorePrepared: async () => { calls.push('db:pripravena'); },
  });
  assert.deepEqual(calls, ['db:odeslana', 'fs:evidence']);
  assert.equal(result.ok, true);
});

test('persistEvidenceAfterStatus: chyba souboru spustí kompenzaci', async () => {
  const calls: string[] = [];
  const result = await persistEvidenceAfterStatus({
    setSubmitted: async () => { calls.push('db:odeslana'); },
    writeEvidence: async () => { calls.push('fs:evidence'); throw new Error('disk'); },
    restorePrepared: async () => { calls.push('db:pripravena'); },
  });
  assert.deepEqual(calls, ['db:odeslana', 'fs:evidence', 'db:pripravena']);
  assert.equal(result.ok, false);
  assert.match(String(result.writeError), /disk/);
});

// --- Stavové přechody submission cockpitu ---

const doneAll = { extract: true, analyze: true, match: true, generate: true, validate: true };

test('stavy: finalize cesta ocenena→pripravena je povolená', () => {
  assert.equal(canTransition('ocenena', 'pripravena', doneAll).ok, true);
});

test('stavy: pripravena→odeslana je povolená (podání)', () => {
  assert.equal(canTransition('pripravena', 'odeslana', doneAll).ok, true);
});

test('stavy: odeslana bez dokončené validace je zakázaná', () => {
  const noValidate = { ...doneAll, validate: false };
  assert.equal(canTransition('pripravena', 'odeslana', noValidate).ok, false);
});
