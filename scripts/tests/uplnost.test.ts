import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';

import {
  ANALYZE_MIN_TEXT_ENV,
  DEFAULT_ANALYZE_MIN_TEXT_CHARACTERS,
  RadkovySberacLogu,
  UPLNOST_DIRECTORY,
  UplnostError,
  aplikujUplnostNaStavy,
  analyzovatelnyPocetZnaku,
  analyzeMinimumCharacters,
  formatUplnostError,
  nactiUplnostZakazky,
  ocekavanyPocetPoMultipartDavce,
  pocetUplnosti,
  stavKrokuProKlienta,
  stavPoKontroleUplnosti,
  ulozUplnostKroku,
  vytvorUplnostAnalyzy,
  vytvorUplnostKroku,
  vytvorSloucenouUplnostIngestu,
  zaznamenejVysledekPipelineKroku,
  zpravaUplnostiZLogu,
} from '../src/lib/uplnost.js';
import { downloadNenAttachments } from '../src/lib/monitoring/zd-download.js';
import type { NenAttachment } from '../src/lib/monitoring/nen-client.js';
import {
  classifyExtractedDocument,
  createSingleSheetSoupisSnapshot,
  findSoupisDataSheetNames,
  inspectSoupisWorkbook,
} from '../src/lib/document-parser.js';
import { parseSoupis } from '../src/parse-soupis.js';
import {
  CONVERTED_DOC_DIRNAME,
  discoverInputFiles,
  listSourceAttachmentNames,
} from '../src/lib/input-discovery.js';

const SCRIPT_DIR = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const EXTRACT_SCRIPT = join(SCRIPT_DIR, 'src', 'extract-tender.ts');
const ANALYZE_SCRIPT = join(SCRIPT_DIR, 'src', 'analyze-tender.ts');
const SERVE_API_SOURCE = join(SCRIPT_DIR, 'src', 'serve-api.ts');
const roots: string[] = [];

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function fixtureRoot(tenderId = 'test-tender'): Promise<{
  root: string; tenderId: string; inputDir: string; outputDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'vz-uplnost-'));
  roots.push(root);
  const inputDir = join(root, 'input', tenderId);
  const outputDir = join(root, 'output', tenderId);
  await mkdir(inputDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  return { root, tenderId, inputDir, outputDir };
}

function runScript(
  script: string,
  root: string,
  tenderId: string,
  env: Record<string, string> = {},
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, `--tender-id=${tenderId}`], {
      cwd: SCRIPT_DIR,
      env: { ...process.env, VZ_ROOT_DIR: root, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function fetchFixtures(responses: Record<string, Buffer | number>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const response = responses[String(input)];
    if (typeof response === 'number') return new Response('error', { status: response });
    return new Response(response ?? 'missing', { status: response ? 200 : 404 });
  }) as typeof fetch;
}

function fieldValidationFixture(documents: readonly string[]): unknown[] {
  return documents.map((document) => ({
    document,
    mode: 'fill',
    checks: [],
    overall: 'pass',
    confidence: 100,
  }));
}

function validationReportFixture(tenderId: string): unknown {
  return {
    tenderId,
    validatedAt: '2026-09-03T10:00:00.000Z',
    overall_score: 10,
    ready_to_submit: true,
    checks: [],
    kriticke_problemy: [],
    doporuceni: [],
  };
}

function matchedCandidate(model: string, cena_bez_dph = 100): unknown {
  return {
    vyrobce: 'Acme',
    model,
    popis: model,
    parametry: {},
    shoda_s_pozadavky: [],
    cena_bez_dph,
    cena_s_dph: cena_bez_dph * 1.21,
    cena_spolehlivost: 'stredni',
    dodavatele: [],
    dostupnost: 'skladem',
  };
}

function pricedMatchedItem(
  polozka_index: number,
  polozka_nazev: string,
  cena_bez_dph: number,
  cast_id?: string,
): unknown {
  return {
    polozka_index,
    polozka_nazev,
    ...(cast_id ? { cast_id } : {}),
    vybrany_index: 0,
    kandidati: [matchedCandidate(polozka_nazev, cena_bez_dph)],
    oduvodneni_vyberu: 'Nejlepší dostupná shoda.',
  };
}

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test('kontrakt: deficit je castecne a zachová celý seznam chybějících položek', () => {
  const report = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 3, dostano: 1 }],
    chybi: ['zadávací dokumentace.pdf', 'návrh smlouvy.docx'],
  });
  assert.equal(report.stav, 'castecne');
  assert.deepEqual(report.chybi, ['zadávací dokumentace.pdf', 'návrh smlouvy.docx']);
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 3);
  assert.equal(pocetUplnosti(report, 'dostano', 'dokumenty'), 1);
});

test('kontrakt: všechny očekávané výstupy jsou uplne', () => {
  const report = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 2 }],
    chybi: [],
  });
  assert.equal(report.stav, 'uplne');
  assert.deepEqual(report.chybi, []);
});

test('kontrakt bez metrik/kroků ani kontrakt cizí zakázky nejsou důkaz úplnosti', async () => {
  const empty = vytvorUplnostKroku({ krok: 'extract', metriky: [] });
  assert.equal(empty.stav, 'selhalo');
  assert.ok(empty.chybi.some((item) => item.includes('žádnou metriku')));

  const fixture = await fixtureRoot();
  await mkdir(join(fixture.outputDir, UPLNOST_DIRECTORY), { recursive: true });
  await writeFile(join(fixture.outputDir, UPLNOST_DIRECTORY, 'uplnost.json'), JSON.stringify({
    verze: 1,
    tenderId: fixture.tenderId,
    aktualizovano: '2026-09-03T10:00:00.000Z',
    kroky: {
      extract: {
        krok: 'extract', stav: 'uplne', ocekavano: [], dostano: [], chybi: [],
        vedomeIgnorovano: [], zprava: 'hotovo', naprava: '',
        aktualizovano: '2026-09-03T10:00:00.000Z',
      },
    },
  }));
  await assert.rejects(nactiUplnostZakazky(fixture.outputDir), /neplatný formát/);

  await writeFile(join(fixture.outputDir, UPLNOST_DIRECTORY, 'uplnost.json'), JSON.stringify({
    verze: 1,
    tenderId: fixture.tenderId,
    aktualizovano: '2026-09-03T10:00:00.000Z',
    kroky: {},
  }));
  await assert.rejects(nactiUplnostZakazky(fixture.outputDir), /neplatný formát/);

  const complete = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 1, dostano: 1 }],
  });
  await writeFile(join(fixture.outputDir, UPLNOST_DIRECTORY, 'uplnost.json'), JSON.stringify({
    verze: 1,
    tenderId: 'cizi-tender',
    aktualizovano: complete.aktualizovano,
    kroky: { extract: complete },
  }));
  await assert.rejects(nactiUplnostZakazky(fixture.outputDir), /neplatný formát/);
});

test('castecne se nepropíše jako zelený artefakt ani při exit code 0', () => {
  const partial = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['zadani.pdf'],
  });
  assert.equal(stavPoKontroleUplnosti('done', partial), 'error');
  assert.equal(stavKrokuProKlienta('done', partial), 'error');

  const complete = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 2 }],
    chybi: [],
  });
  assert.equal(stavPoKontroleUplnosti('done', complete), 'done');
  assert.equal(stavKrokuProKlienta('done', complete), 'done');
});

test('novější upstream report zneplatní zelené stavy starých downstream artefaktů', () => {
  const ingest = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['smlouva.pdf'],
  });
  const report = {
    verze: 1 as const,
    tenderId: 'test',
    aktualizovano: ingest.aktualizovano,
    kroky: { ingest },
  };
  assert.deepEqual(aplikujUplnostNaStavy({
    extract: 'done', analyze: 'done', match: 'done', generate: 'done', validate: 'done',
  }, report), {
    extract: 'error', analyze: 'error', match: 'error', generate: 'error', validate: 'error',
  });
  assert.deepEqual(aplikujUplnostNaStavy({
    extract: 'pending', analyze: 'pending', match: 'pending', generate: 'pending', validate: 'pending',
  }, report), {
    extract: 'pending', analyze: 'pending', match: 'pending', generate: 'pending', validate: 'pending',
  });
  assert.deepEqual(aplikujUplnostNaStavy({ extract: 'done' }, null), { extract: 'done' });

  const laterAnalyze = vytvorUplnostAnalyzy(1_000, 1_000, true);
  const reportWithLaterSuccess = {
    ...report,
    aktualizovano: laterAnalyze.aktualizovano,
    kroky: { ingest, analyze: laterAnalyze },
  };
  assert.deepEqual(aplikujUplnostNaStavy({
    extract: 'done', analyze: 'done', match: 'done', generate: 'done', validate: 'done',
  }, reportWithLaterSuccess), {
    extract: 'error', analyze: 'error', match: 'error', generate: 'error', validate: 'error',
  });
});

test('ingest: očekávání vychází z nalezených minus ignorovaných, ne ze stažených', async () => {
  const { inputDir, outputDir, tenderId } = await fixtureRoot();
  const attachments: NenAttachment[] = [
    { nazev: 'zadávací-dokumentace.pdf', url: 'https://nen.nipez.cz/file?id=ok' },
    { nazev: 'šifrovací-certifikát.cer', url: 'https://nen.nipez.cz/file?id=ignored' },
    { nazev: 'návrh-smlouvy.docx', url: 'https://nen.nipez.cz/file?id=failed' },
  ];
  let fetchCalls = 0;
  const baseFetch = fetchFixtures({
    'https://nen.nipez.cz/file?id=ok': Buffer.from('PDF'),
    'https://nen.nipez.cz/file?id=failed': 503,
  });
  const result = await downloadNenAttachments(attachments, inputDir, {
    fetchFn: (async (...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return baseFetch(...args);
    }) as typeof fetch,
    uplnost: { outputDir, tenderId },
  });

  assert.equal(fetchCalls, 2, 'certifikát se vědomě ignoruje bez síťového požadavku');
  assert.equal(result.pocet_nalezenych, 3);
  assert.equal(result.pocet_ignorovanych, 1);
  assert.equal(pocetUplnosti(result.uplnost, 'ocekavano', 'dokumenty'), 2);
  assert.equal(pocetUplnosti(result.uplnost, 'dostano', 'dokumenty'), 1);
  assert.equal(result.uplnost.stav, 'castecne');
  assert.deepEqual(result.uplnost.chybi, ['návrh-smlouvy.docx']);
  assert.deepEqual(result.uplnost.vedomeIgnorovano, ['šifrovací-certifikát.cer']);
  assert.deepEqual((await nactiUplnostZakazky(outputDir))?.kroky.ingest, result.uplnost);
});

test('ingest: dokument plus vědomě ignorovaný .cer je uplne', async () => {
  const { inputDir, outputDir, tenderId } = await fixtureRoot();
  const result = await downloadNenAttachments([
    { nazev: 'výzva.pdf', url: 'https://nen.nipez.cz/file?id=document' },
    { nazev: 'certifikát.cer', url: 'https://nen.nipez.cz/file?id=certificate' },
  ], inputDir, {
    fetchFn: fetchFixtures({ 'https://nen.nipez.cz/file?id=document': Buffer.from('PDF') }),
    uplnost: { outputDir, tenderId },
  });
  assert.equal(result.uplnost.stav, 'uplne');
  assert.equal(pocetUplnosti(result.uplnost, 'ocekavano', 'dokumenty'), 1);
  assert.equal(pocetUplnosti(result.uplnost, 'dostano', 'dokumenty'), 1);
  assert.deepEqual(result.uplnost.chybi, []);
  assert.deepEqual((await nactiUplnostZakazky(outputDir))?.kroky.ingest, result.uplnost);
});

test('ingest neodečte nalezený podporovaný dokument jen kvůli chybnému MIME', async () => {
  const { inputDir, outputDir, tenderId } = await fixtureRoot();
  const result = await downloadNenAttachments([
    { nazev: 'ostatni.pdf', url: 'https://nen.nipez.cz/file?id=ok' },
    { nazev: 'zadávací-dokumentace.pdf', url: 'https://nen.nipez.cz/file?id=wrong-type' },
    { nazev: 'smlouva.docx', url: 'https://nen.nipez.cz/file?id=wrong-name' },
    { nazev: 'Dokument', url: 'https://nen.nipez.cz/file?id=wrong-disposition-type' },
  ], inputDir, {
    fetchFn: (async (input: string | URL | Request) => {
      if (String(input).endsWith('wrong-type')) {
        return new Response(Buffer.from('PNG'), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      if (String(input).endsWith('wrong-name')) {
        return new Response(Buffer.from('SIGNATURE'), {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="podpis.p7s"' },
        });
      }
      if (String(input).endsWith('wrong-disposition-type')) {
        return new Response(Buffer.from('PNG'), {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-disposition': 'attachment; filename="zadani.pdf"',
          },
        });
      }
      return new Response(Buffer.from('PDF'), { status: 200 });
    }) as typeof fetch,
    uplnost: { outputDir, tenderId },
  });

  assert.equal(result.pocet_stazenych, 1);
  assert.equal(result.pocet_ignorovanych, 0);
  assert.equal(pocetUplnosti(result.uplnost, 'ocekavano', 'dokumenty'), 4);
  assert.equal(pocetUplnosti(result.uplnost, 'dostano', 'dokumenty'), 1);
  assert.equal(result.uplnost.stav, 'castecne');
  assert.deepEqual(result.uplnost.chybi, [
    'zadávací-dokumentace.pdf',
    'smlouva.docx',
    'Dokument',
  ]);
});

test('doplňovací ingest nesníží původní očekávání 18 dokumentů na velikost nové dávky', () => {
  const missing = Array.from({ length: 8 }, (_value, index) => `chybi-${index + 11}.pdf`);
  const previous = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 18, dostano: 10 }],
    chybi: missing,
  });
  const actual = [
    ...Array.from({ length: 10 }, (_value, index) => `puvodni-${index + 1}.pdf`),
    'chybi-11.pdf',
  ];
  const merged = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: actual,
    ocekavanoVDavce: 1,
    predchozi: previous,
    noveVyreseno: ['chybi-11.pdf'],
  });
  assert.equal(pocetUplnosti(merged, 'ocekavano', 'dokumenty'), 18);
  assert.equal(pocetUplnosti(merged, 'dostano', 'dokumenty'), 11);
  assert.equal(merged.stav, 'castecne');
  assert.deepEqual(merged.chybi, missing.slice(1));

  const healed = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: [...actual, ...missing.slice(1)],
    ocekavanoVDavce: 7,
    predchozi: merged,
    noveVyreseno: missing.slice(1),
  });
  assert.equal(healed.stav, 'uplne');
  assert.equal(pocetUplnosti(healed, 'ocekavano', 'dokumenty'), 18);
  assert.deepEqual(healed.chybi, []);
});

test('multipart kolize názvů zachová aditivní záměr i po retry', () => {
  const originalNames = Array.from({ length: 10 }, (_value, index) => `puvodni-${index + 1}.pdf`);
  const previous = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 10, dostano: 10 }],
  });
  const minimumAfterCollision = ocekavanyPocetPoMultipartDavce(
    originalNames,
    ['novy.pdf', 'novy.pdf'],
  );
  assert.equal(minimumAfterCollision, 12);
  const collided = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: [...originalNames, 'novy.pdf'],
    ocekavanoVDavce: 2,
    minimalniOcekavano: minimumAfterCollision,
    predchozi: previous,
    noveVyreseno: ['novy.pdf', 'novy.pdf'],
    noveChybi: ['novy.pdf (duplicitní název byl přepsán)'],
  });
  assert.equal(collided.stav, 'castecne');
  assert.equal(pocetUplnosti(collided, 'ocekavano', 'dokumenty'), 12);

  const retried = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: [...originalNames, 'novy.pdf'],
    ocekavanoVDavce: 1,
    minimalniOcekavano: ocekavanyPocetPoMultipartDavce(
      [...originalNames, 'novy.pdf'],
      ['novy.pdf'],
    ),
    predchozi: collided,
    noveVyreseno: ['novy.pdf'],
  });
  assert.equal(retried.stav, 'castecne');
  assert.equal(pocetUplnosti(retried, 'ocekavano', 'dokumenty'), 12);
  assert.equal(pocetUplnosti(retried, 'dostano', 'dokumenty'), 11);

  const sameNameTwice = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 3, dostano: 1 }],
    chybi: ['stejny.pdf', 'stejny.pdf'],
  });
  const onlyOneResolved = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: ['puvodni.pdf', 'stejny.pdf', 'jiny.pdf'],
    ocekavanoVDavce: 2,
    predchozi: sameNameTwice,
    noveVyreseno: ['stejny.pdf', 'jiny.pdf'],
  });
  assert.equal(onlyOneResolved.stav, 'castecne');
  assert.deepEqual(onlyOneResolved.chybi, ['stejny.pdf']);
});

test('URL retry páruje původní URL, ale neznámý přerušený multipart zůstane fail-closed', () => {
  const url = 'https://example.test/download/zadani.pdf?token=1';
  const interruptedUrl = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 1, dostano: 0 }],
    chybi: [`stahování URL nebylo dokončeno: ${url}`],
    selhalo: true,
  });
  const retriedUrl = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: ['zadani.pdf'],
    ocekavanoVDavce: 1,
    predchozi: interruptedUrl,
    noveVyreseno: ['zadani.pdf', url],
  });
  assert.equal(retriedUrl.stav, 'uplne');
  assert.deepEqual(retriedUrl.chybi, []);

  const manuallyCompletedUrl = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: ['zadani.pdf'],
    ocekavanoVDavce: 1,
    predchozi: interruptedUrl,
    noveVyreseno: ['zadani.pdf'],
  });
  assert.equal(manuallyCompletedUrl.stav, 'uplne');
  assert.deepEqual(manuallyCompletedUrl.chybi, []);

  const interruptedMultipart = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 1, dostano: 0 }],
    chybi: ['příjem nové dávky dokumentů nebyl dokončen'],
    selhalo: true,
  });
  const unknownIntent = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: ['jeden-soubor.pdf'],
    ocekavanoVDavce: 1,
    predchozi: interruptedMultipart,
    noveVyreseno: ['jeden-soubor.pdf'],
  });
  assert.equal(unknownIntent.stav, 'castecne');
  assert.deepEqual(unknownIntent.chybi, ['příjem nové dávky dokumentů nebyl dokončen']);
});

test('URL retry rozliší dvě opaque URL se stejnou cestou podle query', () => {
  const first = 'https://example.test/download?id=1';
  const second = 'https://example.test/download?id=2';
  const previous = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 0 }],
    chybi: [`${first}: HTTP 503`, `${second}: HTTP 503`],
    selhalo: true,
  });
  const retried = vytvorSloucenouUplnostIngestu({
    skutecneDokumenty: ['zadani.pdf'],
    ocekavanoVDavce: 1,
    predchozi: previous,
    noveVyreseno: ['zadani.pdf', second],
  });

  assert.equal(retried.stav, 'castecne');
  assert.deepEqual(retried.chybi, [`${first}: HTTP 503`]);
});

test('ingest: prázdná nebo pouze ignorovaná sada není zelená', async () => {
  const empty = await fixtureRoot();
  const emptyResult = await downloadNenAttachments([], empty.inputDir);
  assert.equal(emptyResult.uplnost.stav, 'selhalo');
  assert.ok(emptyResult.uplnost.chybi.length > 0);

  const ignored = await fixtureRoot();
  const ignoredResult = await downloadNenAttachments([
    { nazev: 'certifikát.cer', url: 'https://nen.nipez.cz/file?id=certificate' },
  ], ignored.inputDir);
  assert.equal(ignoredResult.uplnost.stav, 'selhalo');
  assert.deepEqual(ignoredResult.uplnost.vedomeIgnorovano, ['certifikát.cer']);
});

test('extract nad nulou dokumentů skončí nenulově a zapíše srozumitelný stav', async () => {
  const fixture = await fixtureRoot();
  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /UPLNOST_ERROR/);
  assert.match(result.stderr, /Nahrajte nebo znovu stáhněte/);
  const report = await nactiUplnostZakazky(fixture.outputDir);
  assert.equal(report?.kroky.extract?.stav, 'selhalo');
  assert.equal(pocetUplnosti(report?.kroky.extract, 'dostano', 'dokumenty'), 0);
});

test('extract odmítne lokálních 1/2, které zdědil z neúplného ingestu', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  await workbook.xlsx.writeFile(join(fixture.inputDir, 'zadani.xlsx'));
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['smlouva.pdf'],
  }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = await nactiUplnostZakazky(fixture.outputDir);
  assert.equal(report?.kroky.extract?.stav, 'castecne');
  assert.deepEqual(report?.kroky.extract?.chybi, ['smlouva.pdf']);
});

test('obsah ZIPu početně nezamaskuje jinou chybějící zdrojovou přílohu', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const zip = new PizZip();
  zip.file('a.xlsx', xlsx);
  zip.file('b.xlsx', xlsx);
  await writeFile(join(fixture.inputDir, 'balik.zip'), zip.generate({ type: 'nodebuffer' }));
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['smlouva.pdf'],
  }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'castecne');
  assert.equal(pocetUplnosti(report, 'dostano', 'dokumenty'), 2);
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 3);
  assert.deepEqual(report?.chybi, ['smlouva.pdf']);
});

test('soubor uvnitř ZIPu neuzdraví stejně pojmenovanou chybějící source přílohu', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const zip = new PizZip();
  zip.file('a.xlsx', xlsx);
  zip.file('b.xlsx', xlsx);
  await writeFile(join(fixture.inputDir, 'balik.zip'), zip.generate({ type: 'nodebuffer' }));
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['a.xlsx'],
  }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'castecne');
  assert.equal(pocetUplnosti(report, 'dostano', 'dokumenty'), 2);
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 3);
  assert.deepEqual(report?.chybi, ['a.xlsx']);
});

test('jeden ZIP multisetově neuzdraví dvě stejně pojmenované chybějící přílohy', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  const zip = new PizZip();
  zip.file('a.xlsx', xlsx);
  zip.file('b.xlsx', xlsx);
  await writeFile(join(fixture.inputDir, 'balik.zip'), zip.generate({ type: 'nodebuffer' }));
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 0 }],
    chybi: ['balik.zip', 'balik.zip'],
    selhalo: true,
  }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'castecne');
  assert.equal(pocetUplnosti(report, 'dostano', 'dokumenty'), 2);
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 4);
  assert.deepEqual(report?.chybi, ['balik.zip', 'balik.zip']);
});

test('ruční změna inputu bez nového ingest kontraktu starý deficit neuzdraví', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  await workbook.xlsx.writeFile(join(fixture.inputDir, 'puvodni.xlsx'));
  const zip = new PizZip();
  zip.file('doplnene.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  await writeFile(join(fixture.inputDir, 'chybi.zip'), zip.generate({ type: 'nodebuffer' }));
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['chybi.zip'],
  }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'castecne');
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 3);
  assert.equal(pocetUplnosti(report, 'dostano', 'dokumenty'), 2);
  assert.deepEqual(report?.chybi, ['chybi.zip']);
});

test('varování o poškozeném vnořeném ZIPu nedovolí zelenou extrakci', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  const zip = new PizZip();
  zip.file('validni.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  zip.file('poskozeny.zip', Buffer.from('toto není ZIP'));
  await writeFile(join(fixture.inputDir, 'balik.zip'), zip.generate({ type: 'nodebuffer' }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'castecne');
  assert.ok(report?.chybi.some((item) => item.includes('Nelze otevřít ZIP')));
});

test('ZIP nezamaskuje nepodporovaný ani prázdný povinný dokument', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  const zip = new PizZip();
  zip.file('zadani.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  zip.file('povinna-priloha.rtf', Buffer.from('{\\rtf1 povinná příloha}'));
  zip.file('prazdna-smlouva.pdf', Buffer.alloc(0));
  await writeFile(join(fixture.inputDir, 'balik.zip'), zip.generate({ type: 'nodebuffer' }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'castecne');
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 3);
  assert.ok(report?.chybi.some((item) => item.includes('povinna-priloha.rtf')));
  assert.ok(report?.chybi.some((item) => item.includes('prazdna-smlouva.pdf')));
});

test('parserem vrácený prázdný běžný dokument se nepočítá jako přijatý', async () => {
  const fixture = await fixtureRoot();
  const good = new ExcelJS.Workbook();
  good.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  const blank = new ExcelJS.Workbook();
  const blankSheet = blank.addWorksheet('Prázdný list');
  for (let row = 1; row <= 600; row += 1) blankSheet.getRow(row).values = ['', '', ''];
  await Promise.all([
    good.xlsx.writeFile(join(fixture.inputDir, 'zadani.xlsx')),
    blank.xlsx.writeFile(join(fixture.inputDir, 'prazdna-priloha.xlsx')),
  ]);

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'castecne');
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 2);
  assert.equal(pocetUplnosti(report, 'dostano', 'dokumenty'), 1);
  assert.ok(report?.chybi.includes('prazdna-priloha.xlsx'));
});

test('pracovní DOC konverze není další zdrojová příloha', async () => {
  const fixture = await fixtureRoot();
  await mkdir(join(fixture.inputDir, CONVERTED_DOC_DIRNAME), { recursive: true });
  await Promise.all([
    writeFile(join(fixture.inputDir, 'smlouva.doc'), 'source'),
    writeFile(join(fixture.inputDir, CONVERTED_DOC_DIRNAME, 'smlouva.docx'), 'derived'),
  ]);
  assert.deepEqual(await listSourceAttachmentNames(fixture.inputDir), ['smlouva.doc']);
  assert.deepEqual((await discoverInputFiles(fixture.inputDir)).files.map((file) => file.name), ['smlouva.doc']);
});

test('ZIP s technickými metadaty, podpisem, certifikátem a obrázkem zůstane úplný', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  const zip = new PizZip();
  zip.file('zadani.xlsx', Buffer.from(await workbook.xlsx.writeBuffer()));
  zip.file('_metadata.json', Buffer.from('{}'));
  zip.file('certifikat.cer', Buffer.from('CERT'));
  zip.file('podpis.p7s', Buffer.from('SIGNATURE'));
  zip.file('obrazek.png', Buffer.from('PNG'));
  await writeFile(join(fixture.inputDir, 'balik.zip'), zip.generate({ type: 'nodebuffer' }));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'uplne');
  assert.equal(pocetUplnosti(report, 'ocekavano', 'dokumenty'), 1);
  assert.deepEqual(new Set(report?.vedomeIgnorovano), new Set([
    '_metadata.json', 'certifikat.cer', 'podpis.p7s', 'obrazek.png',
  ]));
});

test('extract s kompletní sadou zůstane uplne a vytvoří stejný artefakt', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('ZD').addRow(['zadávací dokumentace']);
  await workbook.xlsx.writeFile(join(fixture.inputDir, 'zadani.xlsx'));

  const result = await runScript(EXTRACT_SCRIPT, fixture.root, fixture.tenderId);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const extracted = JSON.parse(await readFile(join(fixture.outputDir, 'extracted-text.json'), 'utf-8'));
  assert.equal(extracted.documents.length, 1);
  assert.deepEqual(extracted.documents[0], {
    filename: 'zadani.xlsx',
    type: 'xlsx',
    text: '=== List: ZD ===\nzadávací dokumentace',
    isTemplate: false,
    isSoupis: false,
  });
  assert.equal(extracted.totalCharacters, extracted.documents[0].text.length);
  const report = (await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract;
  assert.equal(report?.stav, 'uplne');
  assert.equal(pocetUplnosti(report, 'dostano', 'extracted_text_json'), 1);
});

test('discovery nezahodí stejně pojmenované dokumenty ani při shodném obsahu', async () => {
  const fixture = await fixtureRoot();
  await Promise.all([
    mkdir(join(fixture.inputDir, 'A'), { recursive: true }),
    mkdir(join(fixture.inputDir, 'B'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(fixture.inputDir, 'A', 'zadani.pdf'), 'AAAA'),
    writeFile(join(fixture.inputDir, 'B', 'zadani.pdf'), 'BBBB'),
  ]);
  const discovery = await discoverInputFiles(fixture.inputDir);
  assert.equal(discovery.files.length, 2);
  assert.deepEqual(discovery.files.map((file) => file.name), [
    'A / zadani.pdf',
    'B / zadani.pdf',
  ]);

  await writeFile(join(fixture.inputDir, 'B', 'zadani.pdf'), 'AAAA');
  const identical = await discoverInputFiles(fixture.inputDir);
  assert.equal(identical.files.length, 2);
  assert.deepEqual(identical.files.map((file) => file.name), [
    'A / zadani.pdf',
    'B / zadani.pdf',
  ]);
});

test('analyze práh má bezpečný default a nejde vypnout nulou ani neplatnou hodnotou', () => {
  assert.equal(DEFAULT_ANALYZE_MIN_TEXT_CHARACTERS, 1_000);
  assert.equal(analyzeMinimumCharacters({}), DEFAULT_ANALYZE_MIN_TEXT_CHARACTERS);
  assert.equal(analyzeMinimumCharacters({ [ANALYZE_MIN_TEXT_ENV]: '250' }), 250);
  for (const invalid of ['0', '-1', '1.5', 'NaN']) {
    assert.equal(analyzeMinimumCharacters({ [ANALYZE_MIN_TEXT_ENV]: invalid }), DEFAULT_ANALYZE_MIN_TEXT_CHARACTERS);
  }
});

test('analyze měří jen skutečné AI tělo, ne whitespace, šablony, Excel soupisy ani hlavičky listů', () => {
  assert.equal(analyzovatelnyPocetZnaku([
    { text: '   \n\t', isTemplate: false, isSoupis: false },
    { text: 'x'.repeat(5_000), isTemplate: true, isSoupis: false },
    { text: 'y'.repeat(5_000), type: 'xlsx', isTemplate: false, isSoupis: true },
  ]), 0);
  assert.equal(analyzovatelnyPocetZnaku([{ text: 'abc   def' }]), 7);
  assert.equal(analyzovatelnyPocetZnaku([
    { text: 'z'.repeat(1_200), type: 'pdf', isTemplate: false, isSoupis: true },
  ]), 1_200, 'neexcelový soupis jde do AI a musí se započítat');
  assert.equal(analyzovatelnyPocetZnaku([
    { text: Array.from({ length: 100 }, (_value, index) => `=== List: List${index} ===`).join('\n') },
  ]), 0, 'názvy prázdných excelových listů nejsou obsah');
  assert.equal(analyzovatelnyPocetZnaku([
    { text: Array.from({ length: 600 }, () => ' |  | ').join('\n'), type: 'xlsx' },
  ]), 0, 'oddělovače fyzicky prázdných excelových řádků nejsou obsah');
});

test('více datových listů soupisu je rozpoznáno před jednosheetovým parserem', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Pokyny').addRows(Array.from(
    { length: 10 },
    (_value, index) => [`Pokyn číslo ${index + 1}`],
  ));
  for (const name of ['Část A', 'Část B']) {
    const sheet = workbook.addWorksheet(name);
    // Stejně jako parseSoupis: jedna buňka může zároveň znamenat název i popis.
    sheet.addRow(['Popis položky']);
    sheet.addRow([`Položka ${name}`]);
  }
  const path = join(fixture.inputDir, 'soupis.xlsx');
  await workbook.xlsx.writeFile(path);

  assert.deepEqual(await findSoupisDataSheetNames(path), ['Část A', 'Část B']);
  const analyzeSource = await readFile(ANALYZE_SCRIPT, 'utf-8');
  assert.match(analyzeSource, /inspectSoupisWorkbook\(filePath\)/);
  assert.match(analyzeSource, /parser umí bezpečně zpracovat jen jeden/);
});

test('inspektor neztratí druhý datový list s hlavičkou až za řádkem 50', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet('Část A');
  first.addRow(['P.č.', 'Položka', 'Množství']);
  first.addRow([1, 'Notebook A', 1]);

  const second = workbook.addWorksheet('Část B');
  second.addRows(Array.from(
    { length: 50 },
    (_value, index) => [`Pokyn číslo ${index + 1}`],
  ));
  second.addRow(['P.č.', 'Položka', 'Množství']);
  second.addRow([1, 'Notebook B', 1]);
  const path = join(fixture.inputDir, 'soupis.xlsx');
  await workbook.xlsx.writeFile(path);

  assert.deepEqual(await findSoupisDataSheetNames(path), ['Část A', 'Část B']);
});

test('jediný datový list se parsuje i za delším listem pokynů', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Pokyny').addRows(Array.from(
    { length: 10 },
    (_value, index) => [`Pokyn číslo ${index + 1}`],
  ));
  const items = workbook.addWorksheet('Položky');
  items.addRow(['P.č.', 'Položka', 'Množství']);
  items.addRow([1, 'Notebook', 1]);
  const path = join(fixture.inputDir, 'soupis.xlsx');
  await workbook.xlsx.writeFile(path);

  const snapshot = await createSingleSheetSoupisSnapshot(path, 'Položky');
  try {
    const parsed = await parseSoupis(snapshot.path);
    assert.deepEqual(parsed.polozky.map((item) => item.nazev), ['Notebook']);
  } finally {
    await snapshot.cleanup();
  }
});

test('parserem nepodporovaně číslované řádky soupisu se nesmějí tiše ztratit', async () => {
  const fixture = await fixtureRoot();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Položky');
  sheet.addRow(['P.č.', 'Položka', 'Množství']);
  sheet.addRow([1, 'Notebook', 1]);
  sheet.addRow(['1.1', 'Dokovací stanice', 1]);
  sheet.addRow(['2.1', 'Monitor', 2]);
  sheet.addRow(['A-2', 'Tiskárna', 1]);
  sheet.addRow(['B1', 'Skener', 1]);
  sheet.addRow(['', 'Myš bez čísla', 1]);
  sheet.addRow([2, 'Klávesnice', 2]);
  const path = join(fixture.inputDir, 'soupis.xlsx');
  await workbook.xlsx.writeFile(path);

  const inspection = await inspectSoupisWorkbook(path);
  assert.deepEqual(inspection.dataSheetNames, ['Položky']);
  assert.deepEqual(inspection.unsupportedNumberedRows, [
    'Položky: 1.1 Dokovací stanice',
    'Položky: 2.1 Monitor',
    'Položky: A-2 Tiskárna',
    'Položky: B1 Skener',
    'Položky: [bez čísla] Myš bez čísla',
  ]);
});

test('analyze kontrakt rozlišuje dostatečný vstup od skutečně vzniklého analysis.json', () => {
  const preflight = vytvorUplnostAnalyzy(1_000, 1_000, false);
  assert.equal(preflight.stav, 'castecne');
  assert.equal(pocetUplnosti(preflight, 'dostano', 'analysis_json'), 0);
  assert.deepEqual(preflight.chybi, ['analysis.json (výstup analýzy dosud nevznikl)']);

  const final = vytvorUplnostAnalyzy(1_000, 1_000, true);
  assert.equal(final.stav, 'uplne');
  assert.equal(pocetUplnosti(final, 'dostano', 'analysis_json'), 1);
  assert.deepEqual(final.chybi, []);

  const incompleteSoupis = vytvorUplnostAnalyzy(1_000, 1_000, true, {
    ocekavano: 2,
    zpracovano: 1,
    chybi: ['soupis-cast-2.xlsx'],
  });
  assert.equal(incompleteSoupis.stav, 'castecne');
  assert.equal(pocetUplnosti(incompleteSoupis, 'dostano', 'soupisy_polozek'), 1);
  assert.deepEqual(incompleteSoupis.chybi, ['soupis-cast-2.xlsx']);
});

async function writeExtractedFixture(outputDir: string, tenderId: string, text: string): Promise<void> {
  await writeFile(join(outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [{ filename: 'zadani.pdf', type: 'pdf', text, isTemplate: false, isSoupis: false }],
    totalCharacters: text.length,
  }), 'utf-8');
}

test('analyze nad prázdným textem skončí nenulově ještě před AI voláním', async () => {
  const fixture = await fixtureRoot();
  await writeExtractedFixture(fixture.outputDir, fixture.tenderId, '   \n\t');
  const result = await runScript(ANALYZE_SCRIPT, fixture.root, fixture.tenderId, {
    [ANALYZE_MIN_TEXT_ENV]: '100',
  });
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /použitelný text má 0 znaků/);
  assert.equal((await nactiUplnostZakazky(fixture.outputDir))?.kroky.analyze?.stav, 'selhalo');
});

test('analyze nad podprahovým textem skončí nenulově a jako castecne', async () => {
  const fixture = await fixtureRoot();
  await writeExtractedFixture(fixture.outputDir, fixture.tenderId, 'x'.repeat(99));
  const result = await runScript(ANALYZE_SCRIPT, fixture.root, fixture.tenderId, {
    [ANALYZE_MIN_TEXT_ENV]: '100',
  });
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /99 znaků, bezpečné minimum je 100/);
  assert.equal((await nactiUplnostZakazky(fixture.outputDir))?.kroky.analyze?.stav, 'castecne');

  const rerun = await runScript(ANALYZE_SCRIPT, fixture.root, fixture.tenderId, {
    [ANALYZE_MIN_TEXT_ENV]: '100',
  });
  assert.notEqual(rerun.code, 0, `${rerun.stdout}\n${rerun.stderr}`);
  assert.match(rerun.stderr, /99 znaků, bezpečné minimum je 100/);
  assert.doesNotMatch(rerun.stderr, /extrakce není potvrzena jako úplná/);
});

test('artefakt jiné zakázky ani neúplný verify záznam nemohou být zelené', async () => {
  const fixture = await fixtureRoot();
  await writeExtractedFixture(fixture.outputDir, 'cizi-tender', 'x'.repeat(2_000));
  const analyze = await runScript(ANALYZE_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(analyze.code, 0, `${analyze.stdout}\n${analyze.stderr}`);
  assert.match(analyze.stderr, /patří zakázce cizi-tender/);

  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    polozky: [{ nazev: 'Notebook' }],
  }));
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: 'cizi-tender',
    polozky_match: [{
      polozka_index: 0,
      polozka_nazev: 'Notebook',
      vybrany_index: 0,
      kandidati: [{ vyrobce: 'Acme', model: 'Book' }],
      oduvodneni_vyberu: 'Odpovídá notebooku.',
    }],
  }));
  const foreignMatch = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'match', true,
  );
  assert.equal(foreignMatch.stav, 'selhalo');
  assert.ok(foreignMatch.chybi.some((item) => item.includes('product-match.json nepatří')));

  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [{
      polozka_nazev: 'Notebook',
      kandidati: [matchedCandidate('Book')],
      overeni_ceny: { stav: 'nalezeno', overeno_at: '2026-09-03T10:00:00.000Z' },
    }],
  }));
  const incompleteVerify = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'verify-prices', true,
  );
  assert.equal(incompleteVerify.stav, 'selhalo');
  assert.ok(incompleteVerify.chybi.some((item) => item.includes('polozka_index')));
});

test('analyze odmítne starý artefakt, když nový ingest zneplatnil extract', async () => {
  const fixture = await fixtureRoot();
  await writeExtractedFixture(fixture.outputDir, fixture.tenderId, 'x'.repeat(2_000));
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['nová příloha.pdf'],
  }));
  const result = await runScript(ANALYZE_SCRIPT, fixture.root, fixture.tenderId);
  assert.notEqual(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /extrakce není potvrzena jako úplná/);
  assert.equal((await nactiUplnostZakazky(fixture.outputDir))?.kroky.analyze?.stav, 'selhalo');
});

test('uživatelská chyba úplnosti ignoruje ocas stack trace a uvede co chybí i nápravu', () => {
  const kontrola = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['zadani.pdf'],
    zprava: 'Získán jen jeden ze dvou dokumentů.',
    naprava: 'Nahrajte zadani.pdf a spusťte krok znovu.',
  });
  const logs = [
    formatUplnostError(new UplnostError(kontrola)),
    'at irrelevant (/srv/app.js:1:1)',
    'at irrelevant (/srv/app.js:2:2)',
    'at irrelevant (/srv/app.js:3:3)',
  ];
  const message = zpravaUplnostiZLogu(logs);
  assert.match(message ?? '', /Chybí: zadani\.pdf/);
  assert.match(message ?? '', /Nahrajte zadani\.pdf/);
  assert.doesNotMatch(message ?? '', /irrelevant|app\.js/);
});

test('strukturovaná chyba přežije rozdělení UTF-8 markeru po jednotlivých bytech streamu', () => {
  const kontrola = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['zadávací dokumentace.pdf'],
    zprava: 'Stažen jen jeden dokument.',
    naprava: 'Doplňte chybějící přílohu.',
  });
  const bytes = Buffer.from(`${formatUplnostError(new UplnostError(kontrola))}\nstack tail`);
  const collector = new RadkovySberacLogu();
  const lines: string[] = [];
  for (const byte of bytes) lines.push(...collector.pridej(Buffer.from([byte])));
  lines.push(...collector.dokoncit());

  const message = zpravaUplnostiZLogu(lines);
  assert.match(message ?? '', /zadávací dokumentace\.pdf/);
  assert.match(message ?? '', /Doplňte chybějící přílohu/);
  assert.doesNotMatch(message ?? '', /stack tail/);
});

test('zbývající kroky zapisují očekáváno vs dostáno a partial blokuje zelený stav', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    polozky: [{ nazev: 'Notebook' }, { nazev: 'Monitor' }],
  }));
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [{
      polozka_index: 0,
      polozka_nazev: 'Notebook',
      kandidati: [matchedCandidate('Book')],
      vybrany_index: 0,
      oduvodneni_vyberu: 'Nejlepší dostupná shoda.',
    }],
  }));
  const match = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'match', true,
  );
  assert.equal(match.stav, 'castecne');
  assert.deepEqual(match.chybi, ['Monitor']);
  assert.equal(pocetUplnosti(match, 'ocekavano', 'polozky'), 2);
  assert.equal(pocetUplnosti(match, 'dostano', 'polozky'), 1);

  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [
      {
        polozka_index: 0, polozka_nazev: 'Notebook', vybrany_index: 0,
        kandidati: [matchedCandidate('Book')],
        oduvodneni_vyberu: 'Odpovídá notebooku.',
        overeni_ceny: { stav: 'nalezeno', overeno_at: '2026-09-03T10:00:00.000Z' },
      },
      {
        polozka_index: 1, polozka_nazev: 'Monitor', vybrany_index: 0,
        kandidati: [matchedCandidate('Screen')],
        oduvodneni_vyberu: 'Odpovídá monitoru.',
        overeni_ceny: { stav: 'chyba', overeno_at: '2026-09-03T10:00:00.000Z' },
      },
    ],
  }));
  const verify = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'verify-prices', true,
  );
  assert.equal(verify.stav, 'castecne');
  assert.deepEqual(verify.chybi, ['Monitor']);
  assert.equal(pocetUplnosti(verify, 'ocekavano', 'overene_polozky'), 2);
  assert.equal(pocetUplnosti(verify, 'dostano', 'overene_polozky'), 1);
  const persisted = await nactiUplnostZakazky(fixture.outputDir);
  assert.deepEqual(persisted?.kroky.match, match);
  assert.deepEqual(persisted?.kroky['verify-prices'], verify);
});

test('match nepočítá prázdný záznam ani kandidáta bez věcného výsledku', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    polozky: [{ nazev: 'Notebook' }],
  }));
  for (const polozky_match of [
    [{}],
    [{
      polozka_index: 0,
      polozka_nazev: 'Notebook',
      kandidati: [matchedCandidate('')],
      vybrany_index: 0,
      oduvodneni_vyberu: 'Bez výsledku.',
    }],
  ]) {
    await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match,
    }));
    const match = await zaznamenejVysledekPipelineKroku(
      fixture.outputDir, fixture.tenderId, 'match', true,
    );
    assert.equal(match.stav, 'selhalo');
    assert.ok(match.chybi.length > 0);
    if (polozky_match[0]?.polozka_nazev === 'Notebook') {
      assert.ok(match.chybi.some((item) => item.includes('Notebook')));
      assert.equal(pocetUplnosti(match, 'dostano', 'polozky'), 0);
    }
  }
});

test('match kontrakt zrcadlí fallback producenta na předmět zakázky', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    zakazka: { predmet: 'Dodávka pracovních stanic' },
    casti: [{ id: 'A' }, { id: 'B' }],
    polozky: [{ nazev: 'Položka pouze části A', cast_id: 'A' }],
  }));
  await writeFile(join(fixture.outputDir, 'parts-selection.json'), JSON.stringify({ selected_parts: ['B'] }));
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    selected_parts_snapshot: ['B'],
    polozky_match: [pricedMatchedItem(0, 'Dodávka pracovních stanic', 100)],
  }));

  const match = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'match', true,
  );
  assert.equal(match.stav, 'uplne');
  assert.equal(pocetUplnosti(match, 'ocekavano', 'polozky'), 1);
  assert.equal(pocetUplnosti(match, 'dostano', 'polozky'), 1);
});

test('vadná služba bez legacy analýzy není ve verifieru vědomě ignorovaná', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [{
      polozka_index: 0,
      polozka_nazev: 'Montáž',
      typ: 'sluzba',
      kandidati: [],
      vybrany_index: 0,
      oduvodneni_vyberu: '',
    }],
  }));

  const verify = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'verify-prices', true,
  );
  assert.equal(verify.stav, 'selhalo');
  assert.equal(pocetUplnosti(verify, 'ocekavano', 'overene_polozky'), 1);
  assert.equal(pocetUplnosti(verify, 'dostano', 'overene_polozky'), 0);
  assert.deepEqual(verify.chybi, ['Montáž']);
  assert.deepEqual(verify.vedomeIgnorovano, []);
});

test('match zachová původní indexy a verifier odliší službu od chybějícího výsledku', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    casti: [{ id: 'a' }, { id: 'b' }],
    polozky: [
      { nazev: 'A', cast_id: 'a' },
      { nazev: 'B', cast_id: 'a' },
      { nazev: 'C', cast_id: 'b' },
    ],
  }));
  await writeFile(join(fixture.outputDir, 'parts-selection.json'), JSON.stringify({ selected_parts: ['b'] }));
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    selected_parts_snapshot: ['b'],
    polozky_match: [{
      polozka_index: 2,
      polozka_nazev: 'C',
      cast_id: 'b',
      vybrany_index: 0,
      kandidati: [matchedCandidate('C')],
      oduvodneni_vyberu: 'Odpovídá položce C.',
      overeni_ceny: { stav: 'nalezeno', overeno_at: '2026-09-03T10:00:00.000Z' },
    }],
  }));
  const match = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'match', true,
  );
  assert.equal(match.stav, 'uplne');
  assert.equal(pocetUplnosti(match, 'ocekavano', 'polozky'), 1);

  const legacyWithoutSnapshot = {
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [
      pricedMatchedItem(0, 'A', 100, 'a'),
      pricedMatchedItem(2, 'C', 100, 'b'),
    ],
  };
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify(legacyWithoutSnapshot));
  const legacyMatch = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'match', true,
  );
  assert.equal(legacyMatch.stav, 'uplne');

  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    ...legacyWithoutSnapshot,
    polozky_match: [
      pricedMatchedItem(0, 'A', 100, 'a'),
      {
        ...(pricedMatchedItem(2, 'C', 100, 'b') as Record<string, unknown>),
        overeni_ceny: { stav: 'nalezeno', overeno_at: '2026-09-03T10:00:00.000Z' },
      },
    ],
  }));
  const legacyVerify = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'verify-prices', true,
  );
  assert.equal(legacyVerify.stav, 'uplne');
  assert.equal(pocetUplnosti(legacyVerify, 'ocekavano', 'overene_polozky'), 1);
  assert.equal(pocetUplnosti(legacyVerify, 'dostano', 'overene_polozky'), 1);

  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    selected_parts_snapshot: ['b'],
    polozky_match: [{
      polozka_index: 2,
      polozka_nazev: 'C',
      cast_id: 'a',
      vybrany_index: 0,
      kandidati: [matchedCandidate('C')],
      oduvodneni_vyberu: 'Chybně přiřazená část.',
    }],
  }));
  const wrongPart = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'match', true,
  );
  assert.equal(wrongPart.stav, 'selhalo');
  assert.deepEqual(wrongPart.chybi, ['C', 'C: neodpovídá část b']);

  await unlink(join(fixture.outputDir, 'parts-selection.json'));
  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    polozky: [
      { nazev: 'Montáž' },
      { nazev: 'Neurčené zboží' },
      { nazev: 'C' },
      { nazev: 'Prázdné ověření' },
    ],
  }));

  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [
    {
      polozka_index: 0, polozka_nazev: 'Montáž', typ: 'sluzba',
      kandidati: [matchedCandidate('Montáž')], vybrany_index: 0,
      oduvodneni_vyberu: 'Služba se cenově neověřuje.',
    },
    {
      polozka_index: 1, polozka_nazev: 'Neurčené zboží', vybrany_index: 0,
      kandidati: [matchedCandidate('')], oduvodneni_vyberu: 'Model nebyl určen.',
    },
    {
      polozka_index: 2, polozka_nazev: 'C', vybrany_index: 0,
      kandidati: [matchedCandidate('C')],
      oduvodneni_vyberu: 'Odpovídá C.',
      overeni_ceny: { stav: 'nalezeno', overeno_at: '2026-09-03T10:00:00.000Z' },
    },
    {
      polozka_index: 3, polozka_nazev: 'Prázdné ověření', vybrany_index: 0,
      kandidati: [matchedCandidate('D')],
      oduvodneni_vyberu: 'Odpovídá D.',
    },
  ] }));
  const verify = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'verify-prices', true,
  );
  assert.equal(verify.stav, 'castecne');
  assert.deepEqual(verify.chybi, [
    'Neurčené zboží',
    'Prázdné ověření',
    'matching: Neurčené zboží',
    'matching: Neurčené zboží: neúplný záznam matchingu',
  ]);
  assert.deepEqual(verify.vedomeIgnorovano, ['Montáž']);
  assert.equal(pocetUplnosti(verify, 'ocekavano', 'overene_polozky'), 3);
  assert.equal(pocetUplnosti(verify, 'dostano', 'overene_polozky'), 1);

  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [{
    polozka_index: 2,
    polozka_nazev: 'C',
    vybrany_index: 0,
    kandidati: [matchedCandidate('C')],
    oduvodneni_vyberu: 'Odpovídá C.',
    overeni_ceny: {
      stav: 'nalezeno', overeno_at: '2026-09-03T10:00:00.000Z',
      kandidat_fingerprint: 'JINY|PRODUKT|0',
    },
  }] }));
  const staleFingerprint = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'verify-prices', true,
  );
  // Odpovídající match C vznikl (matching 1/4), ale jeho cenové ověření je
  // zastaralé. Explicitní kontrakt proto rozliší dílčí výsledek jako castecne.
  assert.equal(staleFingerprint.stav, 'castecne');
  assert.deepEqual(staleFingerprint.chybi, [
    'C',
    'matching: Montáž',
    'matching: Neurčené zboží',
    'matching: Prázdné ověření',
  ]);

  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [{
    polozka_index: 2,
    polozka_nazev: 'C',
    vybrany_index: 0,
    kandidati: [matchedCandidate('C')],
    oduvodneni_vyberu: 'Odpovídá C.',
    overeni_ceny: {
      stav: 'nalezeno', overeno_at: '2026-09-03T10:00:00.000Z',
      posledni_chyba: {
        zprava: 'Poslední pokus skončil timeoutem.', at: '2026-09-03T10:05:00.000Z',
      },
    },
  }] }));
  const latestAttemptFailed = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'verify-prices', true,
  );
  assert.equal(latestAttemptFailed.stav, 'castecne');
  assert.deepEqual(latestAttemptFailed.chybi, [
    'C',
    'matching: Montáž',
    'matching: Neurčené zboží',
    'matching: Prázdné ověření',
  ]);
});

test('match kontrakt odmítne prázdný nebo neznámý výběr částí', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    casti: [{ id: 'A' }, { id: 'B' }],
    polozky: [{ nazev: 'Položka A', cast_id: 'A' }, { nazev: 'Položka B', cast_id: 'B' }],
  }));

  for (const selected_parts_snapshot of [[], ['C']]) {
    await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      selected_parts_snapshot,
      polozky_match: [],
    }));
    const match = await zaznamenejVysledekPipelineKroku(
      fixture.outputDir, fixture.tenderId, 'match', true,
    );
    assert.equal(match.stav, 'selhalo');
    assert.ok(match.chybi.some((item) => item.includes('výběr existujících částí')));
  }

  await writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    casti: [{ id: 'A' }, { id: 'B' }],
    polozky: [{ nazev: 'Položka A', cast_id: 'A' }, { nazev: 'Osiřelá položka', cast_id: 'C' }],
  }));
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    selected_parts_snapshot: ['A', 'B'],
    polozky_match: [pricedMatchedItem(0, 'Položka A', 100, 'A')],
  }));
  const orphan = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'match', true,
  );
  assert.equal(orphan.stav, 'selhalo');
  assert.ok(orphan.chybi.some((item) => item.includes('neznámým cast_id C')));
});

test('generate bez volitelných šablon a validate s kompletní povinnou sadou jsou uplne', async () => {
  const fixture = await fixtureRoot();
  await writeExtractedFixture(fixture.outputDir, fixture.tenderId, 'dostatečný text');
  const generated = ['technicky_navrh.docx', 'cenova_nabidka.docx'];
  await Promise.all(generated.map((filename) => writeFile(join(fixture.outputDir, filename), 'doc')));
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [pricedMatchedItem(0, 'Položka A', 100)],
  }));
  await writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
    'technicky_navrh.docx': { source: 'programmatic' },
    'cenova_nabidka.docx': { source: 'programmatic' },
  }));
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'uplne');
  assert.equal(pocetUplnosti(generate, 'ocekavano', 'sablony'), 0);

  await writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
    fieldValidationFixture(generated),
  ));
  await writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
    validationReportFixture(fixture.tenderId),
  ));
  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(validate.stav, 'uplne');

  const persisted = await nactiUplnostZakazky(fixture.outputDir);
  assert.equal(persisted?.kroky.generate?.stav, 'uplne');
  assert.equal(persisted?.kroky.validate?.stav, 'uplne');
});

test('generate a validate zůstanou neúplné, když chybí povinný výstup', async () => {
  const fixture = await fixtureRoot();
  await writeExtractedFixture(fixture.outputDir, fixture.tenderId, 'dostatečný text');
  await writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc');
  await writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
    'technicky_navrh.docx': { source: 'programmatic' },
    'cenova_nabidka.docx': { source: 'programmatic' },
  }));
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.deepEqual(generate.chybi, ['cenova_nabidka.docx']);
  assert.equal(pocetUplnosti(generate, 'dostano', 'zakladni_dokumenty'), 1);

  // I syntakticky platný field-result nesmí tvrdit, že validoval fyzicky chybějící soubor.
  await writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
    fieldValidationFixture(['technicky_navrh.docx', 'cenova_nabidka.docx']),
  ));
  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(validate.stav, 'castecne');
  assert.deepEqual(validate.chybi, ['cenova_nabidka.docx', 'validation-report.json']);
  assert.equal(pocetUplnosti(validate, 'dostano', 'validovane_dokumenty'), 1);
  assert.equal(pocetUplnosti(validate, 'dostano', 'validation_report'), 0);
});

test('validate očekává oba povinné dokumenty i při prázdném generation-meta', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [],
    totalCharacters: 0,
  }));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'generation-meta.json'), '{}'),
    writeFile(join(fixture.outputDir, 'field-validation.json'), '[]'),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);

  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(validate.stav, 'castecne');
  assert.equal(pocetUplnosti(validate, 'ocekavano', 'validovane_dokumenty'), 2);
  assert.equal(pocetUplnosti(validate, 'dostano', 'validovane_dokumenty'), 0);
  assert.deepEqual(validate.chybi, ['technicky_navrh.docx', 'cenova_nabidka.docx']);
});

test('validate odvodí povinné šablony ze vstupu, ne z neúplných generation metadata', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [{
      filename: 'cast-a/Navrh smlouvy.docx', type: 'docx', text: 'šablona', isTemplate: true, isSoupis: false,
    }],
    totalCharacters: 7,
  }));
  const base = ['technicky_navrh.docx', 'cenova_nabidka.docx'];
  await Promise.all(base.map((filename) => writeFile(join(fixture.outputDir, filename), 'doc')));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
      fieldValidationFixture(base),
    )),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);

  const missing = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(missing.stav, 'castecne');
  assert.equal(pocetUplnosti(missing, 'ocekavano', 'validovane_sablony'), 1);
  assert.equal(pocetUplnosti(missing, 'dostano', 'validovane_sablony'), 0);
  assert.ok(missing.chybi.includes('cast-a/Navrh smlouvy.docx'));

  await Promise.all([
    writeFile(join(fixture.outputDir, 'navrh_smlouvy.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
      'navrh_smlouvy.docx': { template_source: 'Navrh smlouvy.docx' },
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify([
      ...fieldValidationFixture(base),
      ...fieldValidationFixture(['navrh_smlouvy.docx']),
    ])),
  ]);
  const complete = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(complete.stav, 'uplne');
  assert.equal(pocetUplnosti(complete, 'dostano', 'validovane_sablony'), 1);
});

test('Excel šablona je úplná v generate a ve validate je vědomě mimo DOCX validator', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [{
      filename: 'Form.xlsx', type: 'xlsx', text: '[DOPLNIT]', isTemplate: true, isSoupis: false,
    }],
    totalCharacters: 9,
  }));
  const base = ['technicky_navrh.docx', 'cenova_nabidka.docx'];
  await Promise.all(base.map((filename) => writeFile(join(fixture.outputDir, filename), 'document')));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
      fieldValidationFixture(base),
    )),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);

  const missingValidate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(missingValidate.stav, 'castecne');
  assert.equal(pocetUplnosti(missingValidate, 'ocekavano', 'pripravene_excel_sablony'), 1);
  assert.equal(pocetUplnosti(missingValidate, 'dostano', 'pripravene_excel_sablony'), 0);
  assert.ok(missingValidate.chybi.includes('Form.xlsx'));
  assert.deepEqual(missingValidate.vedomeIgnorovano, []);

  await Promise.all([
    writeFile(join(fixture.outputDir, 'form.xlsx'), 'document'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
      'form.xlsx': { source: 'excel-ai', template_source: 'Form.xlsx' },
    })),
  ]);

  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(generate.stav, 'uplne');
  assert.equal(validate.stav, 'uplne');
  assert.equal(pocetUplnosti(validate, 'ocekavano', 'validovane_sablony'), 0);
  assert.equal(pocetUplnosti(validate, 'dostano', 'pripravene_excel_sablony'), 1);
  assert.deepEqual(validate.vedomeIgnorovano, ['Form.xlsx']);
});

test('neplatný field-validation ani nečitelný validation-report nejsou zelené', async () => {
  const fixture = await fixtureRoot();
  await writeExtractedFixture(fixture.outputDir, fixture.tenderId, 'dostatečný text');
  const base = ['technicky_navrh.docx', 'cenova_nabidka.docx'];
  await Promise.all(base.map((filename) => writeFile(join(fixture.outputDir, filename), 'doc')));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
      base.map((document) => ({ document })),
    )),
    writeFile(join(fixture.outputDir, 'validation-report.json'), 'not json'),
  ]);

  const invalid = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.notEqual(invalid.stav, 'uplne');
  assert.equal(pocetUplnosti(invalid, 'dostano', 'validovane_dokumenty'), 0);
  assert.equal(pocetUplnosti(invalid, 'dostano', 'validation_report'), 0);

  await Promise.all([
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
      fieldValidationFixture(base),
    )),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture('cizi-tender'),
    )),
  ]);
  const foreignReport = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.notEqual(foreignReport.stav, 'uplne');
  assert.equal(pocetUplnosti(foreignReport, 'dostano', 'validovane_dokumenty'), 2);
  assert.equal(pocetUplnosti(foreignReport, 'dostano', 'validation_report'), 0);

  await writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify({
    ...validationReportFixture(fixture.tenderId) as Record<string, unknown>,
    validatedAt: '2099-01-01T00:00:00.000Z',
  }));
  const staleFieldValidation = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.notEqual(staleFieldValidation.stav, 'uplne');
  assert.equal(pocetUplnosti(staleFieldValidation, 'dostano', 'validovane_dokumenty'), 0);
  assert.equal(pocetUplnosti(staleFieldValidation, 'dostano', 'validation_report'), 1);

  await Promise.all([
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);
  const complete = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(complete.stav, 'uplne');
});

test('šablona nesmí jedním souborem přepsat a současně splnit povinný base dokument', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [{
      filename: 'technicky_navrh.docx', type: 'docx', text: '[DOPLNIT]', isTemplate: true, isSoupis: false,
    }],
    totalCharacters: 9,
  }));
  const base = ['technicky_navrh.docx', 'cenova_nabidka.docx'];
  await Promise.all(base.map((filename) => writeFile(join(fixture.outputDir, filename), 'doc')));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'ai-fill', template_source: 'technicky_navrh.docx' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
      fieldValidationFixture(base),
    )),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);

  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.notEqual(generate.stav, 'uplne');
  assert.notEqual(validate.stav, 'uplne');
  assert.ok(generate.chybi.includes('technicky_navrh.docx'));
  assert.ok(validate.chybi.includes('technicky_navrh.docx'));
});

test('generate i validate vyžadují vyplněný a úplně namapovaný cenový soupis', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [
      { filename: 'zadani.pdf', type: 'pdf', text: 'zadání', isTemplate: false, isSoupis: false },
      { filename: 'soupis.xlsx', type: 'xlsx', text: 'položky', isTemplate: false, isSoupis: true },
    ],
    totalCharacters: 13,
  }));
  const generated = ['technicky_navrh.docx', 'cenova_nabidka.docx'];
  await Promise.all(generated.map((filename) => writeFile(join(fixture.outputDir, filename), 'doc')));
  await writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    matchedAt: '2026-09-03T10:00:00.000Z',
    polozky_match: [pricedMatchedItem(0, 'Položka A', 100)],
  }));
  await writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
    'technicky_navrh.docx': { source: 'programmatic' },
    'cenova_nabidka.docx': { source: 'programmatic' },
  }));

  const missingGenerate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(missingGenerate.stav, 'castecne');
  assert.equal(pocetUplnosti(missingGenerate, 'ocekavano', 'vyplnene_soupisy'), 1);
  assert.equal(pocetUplnosti(missingGenerate, 'dostano', 'vyplnene_soupisy'), 0);
  assert.ok(missingGenerate.chybi.some((item) => item.includes('soupis_filled_soupis.xlsx')));

  await writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
    fieldValidationFixture(generated),
  ));
  await writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
    validationReportFixture(fixture.tenderId),
  ));
  const missingValidate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(missingValidate.stav, 'castecne');
  assert.equal(pocetUplnosti(missingValidate, 'ocekavano', 'validovane_soupisy'), 1);
  assert.equal(pocetUplnosti(missingValidate, 'dostano', 'validovane_soupisy'), 0);

  await Promise.all([
    writeFile(join(fixture.outputDir, 'soupis_filled_soupis.xlsx'), 'xlsx'),
    writeFile(join(fixture.outputDir, 'soupis_mapping_soupis.json'), JSON.stringify({
      totalRows: 1,
      filledRows: 1,
      skippedRows: 0,
      mappings: [{ matchedItem: 'Položka A', priceBezDph: 100 }],
    })),
  ]);
  const completeGenerate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(completeGenerate.stav, 'uplne');
  assert.equal(pocetUplnosti(completeGenerate, 'dostano', 'vyplnene_soupisy'), 1);
  const completeValidate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(completeValidate.stav, 'uplne');
  assert.equal(pocetUplnosti(completeValidate, 'dostano', 'validovane_soupisy'), 1);
});

test('jeden vyplněný řádek soupisu nepokryje dvě naceněné položky', async () => {
  const fixture = await fixtureRoot();
  await Promise.all([
    writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      extractedAt: '2026-09-03T10:00:00.000Z',
      documents: [{
        filename: 'soupis.xlsx', type: 'xlsx', text: 'položky', isTemplate: false, isSoupis: true,
      }],
      totalCharacters: 7,
    })),
    writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match: [
        pricedMatchedItem(0, 'Položka A', 100),
        pricedMatchedItem(1, 'Položka B', 200),
      ],
    })),
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'soupis_filled_soupis.xlsx'), 'xlsx'),
    writeFile(join(fixture.outputDir, 'soupis_mapping_soupis.json'), JSON.stringify({
      totalRows: 1,
      filledRows: 1,
      skippedRows: 0,
      mappings: [{ matchedItem: 'Položka A', priceBezDph: 100 }],
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify([
      ...fieldValidationFixture(['technicky_navrh.docx', 'cenova_nabidka.docx']),
    ])),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);

  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.equal(validate.stav, 'castecne');
  assert.equal(pocetUplnosti(generate, 'dostano', 'vyplnene_soupisy'), 0);
  assert.equal(pocetUplnosti(validate, 'dostano', 'validovane_soupisy'), 0);
});

test('jedna naceněná položka nesmí opakovaně pokrýt dva řádky soupisu', async () => {
  const fixture = await fixtureRoot();
  await Promise.all([
    writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      extractedAt: '2026-09-03T10:00:00.000Z',
      documents: [{
        filename: 'soupis.xlsx', type: 'xlsx', text: 'položky', isTemplate: false, isSoupis: true,
      }],
      totalCharacters: 7,
    })),
    writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match: [pricedMatchedItem(0, 'Položka A', 100)],
    })),
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'soupis_filled_soupis.xlsx'), 'xlsx'),
    writeFile(join(fixture.outputDir, 'soupis_mapping_soupis.json'), JSON.stringify({
      totalRows: 2,
      filledRows: 2,
      skippedRows: 0,
      mappings: [
        { matchedItem: 'Položka A', priceBezDph: 100 },
        { matchedItem: 'Položka A', priceBezDph: 100 },
      ],
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
      fieldValidationFixture(['technicky_navrh.docx', 'cenova_nabidka.docx']),
    )),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.equal(validate.stav, 'castecne');
  assert.equal(pocetUplnosti(generate, 'dostano', 'vyplnene_soupisy'), 0);
  assert.equal(pocetUplnosti(validate, 'dostano', 'validovane_soupisy'), 0);
});

test('stejnojmenné položky soupisu musí sedět i multisetem cen', async () => {
  const fixture = await fixtureRoot();
  await Promise.all([
    writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      extractedAt: '2026-09-03T10:00:00.000Z',
      documents: [{
        filename: 'soupis.xlsx', type: 'xlsx', text: 'položky', isTemplate: false, isSoupis: true,
      }],
      totalCharacters: 7,
    })),
    writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match: [
        pricedMatchedItem(0, 'Notebook', 100),
        pricedMatchedItem(1, 'Notebook', 200),
      ],
    })),
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'soupis_filled_soupis.xlsx'), 'xlsx'),
    writeFile(join(fixture.outputDir, 'soupis_mapping_soupis.json'), JSON.stringify({
      totalRows: 2,
      filledRows: 2,
      skippedRows: 0,
      mappings: [
        { matchedItem: 'Notebook', priceBezDph: 100 },
        { matchedItem: 'Notebook', priceBezDph: 100 },
      ],
    })),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.equal(pocetUplnosti(generate, 'dostano', 'vyplnene_soupisy'), 0);
});

test('neexcelový soupis je povinně chybějící, ne tiché nula z nuly', async () => {
  const fixture = await fixtureRoot();
  await Promise.all([
    writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      extractedAt: '2026-09-03T10:00:00.000Z',
      documents: [{
        filename: 'soupis.pdf', type: 'pdf', text: 'položky', isTemplate: false, isSoupis: true,
      }],
      totalCharacters: 7,
    })),
    writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match: [pricedMatchedItem(0, 'Položka A', 100)],
    })),
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'field-validation.json'), JSON.stringify(
      fieldValidationFixture(['technicky_navrh.docx', 'cenova_nabidka.docx']),
    )),
    writeFile(join(fixture.outputDir, 'validation-report.json'), JSON.stringify(
      validationReportFixture(fixture.tenderId),
    )),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  const validate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'validate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.equal(validate.stav, 'castecne');
  assert.equal(pocetUplnosti(generate, 'ocekavano', 'vyplnene_soupisy'), 1);
  assert.equal(pocetUplnosti(generate, 'dostano', 'vyplnene_soupisy'), 0);
  assert.equal(pocetUplnosti(validate, 'dostano', 'validovane_soupisy'), 0);
  assert.ok(generate.chybi.some((item) => item.includes('nepodporovaný formát')));
});

test('soupis neznámé části se neztratí filtrem vybraných částí', async () => {
  const fixture = await fixtureRoot();
  await Promise.all([
    writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      extractedAt: '2026-09-03T10:00:00.000Z',
      documents: [{
        filename: 'Cast-C-soupis.xlsx', type: 'xlsx', text: 'položky', isTemplate: false, isSoupis: true,
      }],
      totalCharacters: 7,
    })),
    writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      casti: [{ id: 'A' }, { id: 'B' }],
      polozky: [{ nazev: 'Položka A', cast_id: 'A' }],
    })),
    writeFile(join(fixture.outputDir, 'parts-selection.json'), JSON.stringify({ selected_parts: ['A', 'B'] })),
    writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match: [pricedMatchedItem(0, 'Položka A', 100, 'A')],
    })),
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'selhalo');
  assert.ok(generate.chybi.some((item) => item.includes('neznámou část zakázky')));
});

test('soupis části nelze vyplnit položkami s explicitně cizím cast_id', async () => {
  const fixture = await fixtureRoot();
  await Promise.all([
    writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      extractedAt: '2026-09-03T10:00:00.000Z',
      documents: [{
        filename: 'Cast-B-soupis.xlsx', type: 'xlsx', text: 'položky', isTemplate: false, isSoupis: true,
      }],
      totalCharacters: 7,
    })),
    writeFile(join(fixture.outputDir, 'analysis.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      casti: [{ id: 'A' }, { id: 'B' }],
      polozky: [
        { nazev: 'Položka A', cast_id: 'A' },
        { nazev: 'Položka B', cast_id: 'B' },
      ],
    })),
    writeFile(join(fixture.outputDir, 'parts-selection.json'), JSON.stringify({ selected_parts: ['A', 'B'] })),
    writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match: [pricedMatchedItem(0, 'Položka A', 100, 'A')],
    })),
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
    writeFile(join(fixture.outputDir, 'soupis_filled_cast-b-soupis.xlsx'), 'xlsx'),
    writeFile(join(fixture.outputDir, 'soupis_mapping_cast-b-soupis.json'), JSON.stringify({
      totalRows: 1,
      filledRows: 1,
      skippedRows: 0,
      mappings: [{ matchedItem: 'Položka A', priceBezDph: 100 }],
    })),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.equal(pocetUplnosti(generate, 'dostano', 'vyplnene_soupisy'), 0);
});

test('jeden sanitizovaný soubor nesplní dva kolidující cenové soupisy', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [
      { filename: 'A / soupis.xlsx', type: 'xlsx', text: 'A', isTemplate: false, isSoupis: true },
      { filename: 'A___soupis.xlsx', type: 'xlsx', text: 'B', isTemplate: false, isSoupis: true },
    ],
    totalCharacters: 2,
  }));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), '{}'),
    writeFile(join(fixture.outputDir, 'product-match.json'), JSON.stringify({
      tenderId: fixture.tenderId,
      matchedAt: '2026-09-03T10:00:00.000Z',
      polozky_match: [pricedMatchedItem(0, 'Položka A', 100)],
    })),
    writeFile(join(fixture.outputDir, 'soupis_filled_a_soupis.xlsx'), 'xlsx'),
    writeFile(join(fixture.outputDir, 'soupis_mapping_a_soupis.json'), JSON.stringify({
      totalRows: 1,
      filledRows: 1,
      skippedRows: 0,
      mappings: [{ matchedItem: 'Položka A', priceBezDph: 100 }],
    })),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.equal(pocetUplnosti(generate, 'ocekavano', 'vyplnene_soupisy'), 2);
  assert.equal(pocetUplnosti(generate, 'dostano', 'vyplnene_soupisy'), 1);
});

test('dvě vnořené stejně pojmenované šablony se párují jako multiset', async () => {
  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [
      { filename: 'A / Form.docx', type: 'docx', text: '[DOPLNIT]', isTemplate: true, isSoupis: false },
      { filename: 'B / Form.docx', type: 'docx', text: '[DOPLNIT]', isTemplate: true, isSoupis: false },
    ],
    totalCharacters: 18,
  }));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'form.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'form_2.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
      'form.docx': { template_source: 'Form.docx' },
      'form_2.docx': { template_source: 'Form.docx' },
    })),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'uplne');
  assert.equal(pocetUplnosti(generate, 'ocekavano', 'sablony'), 2);
  assert.equal(pocetUplnosti(generate, 'dostano', 'sablony'), 2);
});

test('kupní smlouva i obsahový placeholder jsou povinné šablony pro generate', async () => {
  const named = classifyExtractedDocument('Navrh_kupni_smlouvy.docx', 'text smlouvy');
  const content = classifyExtractedDocument('Priloha-7.docx', 'Název dodavatele: [DOPLNIT]');
  assert.equal(named.isTemplate, true);
  assert.equal(content.isTemplate, true);
  assert.equal(classifyExtractedDocument('Navrh-kupni-smlouvy.docx', 'text smlouvy').isTemplate, false,
    'klasifikace musí přesně odpovídat normalizaci generátoru');
  assert.equal(classifyExtractedDocument('Navrh_kupni_smlouvy.pdf', '[DOPLNIT]').isTemplate, false,
    'needukovatelný PDF soubor generátor jako šablonu neumí vyplnit');

  const fixture = await fixtureRoot();
  await writeFile(join(fixture.outputDir, 'extracted-text.json'), JSON.stringify({
    tenderId: fixture.tenderId,
    extractedAt: '2026-09-03T10:00:00.000Z',
    documents: [
      { filename: 'zadani.pdf', type: 'pdf', text: 'zadání', isTemplate: false, isSoupis: false },
      { filename: 'Navrh_kupni_smlouvy.docx', type: 'docx', text: 'text smlouvy', ...named },
    ],
    totalCharacters: 18,
  }));
  await Promise.all([
    writeFile(join(fixture.outputDir, 'technicky_navrh.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'cenova_nabidka.docx'), 'doc'),
    writeFile(join(fixture.outputDir, 'generation-meta.json'), JSON.stringify({
      'technicky_navrh.docx': { source: 'programmatic' },
      'cenova_nabidka.docx': { source: 'programmatic' },
    })),
  ]);
  const generate = await zaznamenejVysledekPipelineKroku(
    fixture.outputDir, fixture.tenderId, 'generate', true,
  );
  assert.equal(generate.stav, 'castecne');
  assert.equal(pocetUplnosti(generate, 'ocekavano', 'sablony'), 1);
  assert.deepEqual(generate.chybi, ['Navrh_kupni_smlouvy.docx']);
});

test('kontrakt v .pipeline přežije cleanup starých generovaných souborů', async () => {
  const fixture = await fixtureRoot();
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 1, dostano: 1 }],
  }));
  await writeFile(join(fixture.outputDir, 'stary-vystup.docx'), 'old');
  const keepFiles = new Set([
    'analysis.json', 'extracted-text.json', 'product-match.json', 'parts-selection.json',
    'cenova_uprava.json', 'cost-log.json', 'tender-meta.json', 'prilohy',
  ]);
  for (const file of await readdir(fixture.outputDir)) {
    if (!keepFiles.has(file)) await unlink(join(fixture.outputDir, file)).catch(() => {});
  }

  assert.equal((await nactiUplnostZakazky(fixture.outputDir))?.kroky.extract?.stav, 'uplne');
  assert.ok((await readdir(fixture.outputDir)).includes(UPLNOST_DIRECTORY));
});

test('souběžné zápisy se neztratí a nový upstream zneplatní starý downstream', async () => {
  const fixture = await fixtureRoot();
  const ingest = vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 1, dostano: 1 }],
  });
  const extract = vytvorUplnostKroku({
    krok: 'extract',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 1, dostano: 1 }],
  });
  const analyze = vytvorUplnostAnalyzy(1_000, 1_000, true);
  await Promise.all([
    ulozUplnostKroku(fixture.outputDir, fixture.tenderId, ingest),
    ulozUplnostKroku(fixture.outputDir, fixture.tenderId, extract),
    ulozUplnostKroku(fixture.outputDir, fixture.tenderId, analyze),
  ]);
  assert.deepEqual(Object.keys((await nactiUplnostZakazky(fixture.outputDir))?.kroky ?? {}), [
    'ingest', 'extract', 'analyze',
  ]);

  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{ nazev: 'dokumenty', jednotka: 'dokumenty', ocekavano: 2, dostano: 1 }],
    chybi: ['novy.pdf'],
  }));
  assert.deepEqual(Object.keys((await nactiUplnostZakazky(fixture.outputDir))?.kroky ?? {}), ['ingest']);
});

test('změna výběru částí může zopakováním analyze zneplatnit match a downstream', async () => {
  const fixture = await fixtureRoot();
  const analyze = vytvorUplnostAnalyzy(1_000, 1_000, true);
  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, analyze);
  for (const krok of ['match', 'verify-prices', 'generate', 'validate'] as const) {
    await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
      krok,
      metriky: [{ nazev: 'vystup', jednotka: 'vystupy', ocekavano: 1, dostano: 1 }],
    }));
  }

  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, analyze);
  const report = await nactiUplnostZakazky(fixture.outputDir);
  assert.deepEqual(Object.keys(report?.kroky ?? {}), ['analyze']);
  assert.deepEqual(aplikujUplnostNaStavy({
    extract: 'done', analyze: 'done', match: 'done', generate: 'done', validate: 'done',
  }, report), {
    extract: 'done', analyze: 'done', match: 'error', generate: 'error', validate: 'error',
  });

  await ulozUplnostKroku(fixture.outputDir, fixture.tenderId, vytvorUplnostKroku({
    krok: 'generate',
    metriky: [{ nazev: 'vystup', jednotka: 'vystupy', ocekavano: 1, dostano: 1 }],
  }));
  const reportWithSkippedSteps = await nactiUplnostZakazky(fixture.outputDir);
  assert.deepEqual(Object.keys(reportWithSkippedSteps?.kroky ?? {}), ['analyze', 'generate']);
  assert.deepEqual(aplikujUplnostNaStavy({
    extract: 'done', analyze: 'done', match: 'done', generate: 'done', validate: 'done',
  }, reportWithSkippedSteps), {
    extract: 'done', analyze: 'done', match: 'error', generate: 'error', validate: 'error',
  });
});

test('reader odmítne vnitřně rozporné zelené počty', async () => {
  const fixture = await fixtureRoot();
  await mkdir(join(fixture.outputDir, UPLNOST_DIRECTORY), { recursive: true });
  await writeFile(join(fixture.outputDir, UPLNOST_DIRECTORY, 'uplnost.json'), JSON.stringify({
    verze: 1,
    tenderId: fixture.tenderId,
    aktualizovano: '2026-09-03T10:00:00.000Z',
    kroky: {
      ingest: {
        krok: 'ingest', stav: 'uplne',
        ocekavano: [{ nazev: 'dokumenty', jednotka: 'dokumenty', pocet: 18 }],
        dostano: [{ nazev: 'dokumenty', jednotka: 'dokumenty', pocet: 10 }],
        chybi: [], vedomeIgnorovano: [], zprava: 'vše OK', naprava: '',
        aktualizovano: '2026-09-03T10:00:00.000Z',
      },
    },
  }));
  await assert.rejects(() => nactiUplnostZakazky(fixture.outputDir), /neplatný formát/);
});

test('reader odmítne castecne bez seznamu konkrétních chyb', async () => {
  const fixture = await fixtureRoot();
  await mkdir(join(fixture.outputDir, UPLNOST_DIRECTORY), { recursive: true });
  await writeFile(join(fixture.outputDir, UPLNOST_DIRECTORY, 'uplnost.json'), JSON.stringify({
    verze: 1,
    tenderId: fixture.tenderId,
    aktualizovano: '2026-09-03T10:00:00.000Z',
    kroky: {
      ingest: {
        krok: 'ingest', stav: 'castecne',
        ocekavano: [{ nazev: 'dokumenty', jednotka: 'dokumenty', pocet: 2 }],
        dostano: [{ nazev: 'dokumenty', jednotka: 'dokumenty', pocet: 1 }],
        chybi: [], vedomeIgnorovano: [], zprava: 'jen část', naprava: 'doplňte',
        aktualizovano: '2026-09-03T10:00:00.000Z',
      },
    },
  }));
  await assert.rejects(() => nactiUplnostZakazky(fixture.outputDir), /neplatný formát/);
});

test('serve API skutečně používá kontrakt pro job chybu i veřejný stav', async () => {
  const source = await readFile(SERVE_API_SOURCE, 'utf-8');
  const jobPreflight = source.indexOf('nový výsledek kroku ${job.step} dosud nevznikl');
  const childSpawn = source.indexOf('const child = spawn(', jobPreflight);
  assert.ok(jobPreflight >= 0 && childSpawn > jobPreflight,
    'fail-closed report musí být uložen před spuštěním child procesu');
  assert.match(source, /await ulozUplnostKroku\([\s\S]{0,700}nový výsledek kroku/);
  assert.match(source, /if \(draining \|\| job\.status !== 'running' \|\| !runningJobs\.has\(job\.id\)\)/);
  assert.match(source, /parent\.failedStep = job\.step as PipelineStep/);
  assert.match(source, /new RadkovySberacLogu\(\)/);
  assert.match(source, /zpravaUplnostiZLogu\(job\.logs\)/);
  assert.match(source, /stavPoKontroleUplnosti\(finalStatus, kontrola\)/);
  assert.match(source, /aplikujUplnostNaStavy\(steps, uplnost\)/);
  assert.match(source, /uplnost:\s*uplnost\?\.kroky\s*\?\?\s*null/);
  assert.match(source, /\.\.\.report/);
  assert.match(source, /skutecneDokumenty:\s*sourceNamesAfter/);
  assert.match(source, /minimalniOcekavano:\s*sourceNamesBefore\.length \+ expectedUrlDocuments/);
  assert.match(source, /noveIgnorovano:\s*ignored/);
  assert.match(source, /recordMultipartIngest\(req\.params\.id, files, previous \?\? undefined, sourceNamesBefore \?\? \[\]\)/);
  assert.match(source, /assignTenderId, reserveTenderIngest, uploadTenderDocuments/);
  assert.match(source, /noveChybi:\s*\['příjem nové dávky dokumentů nebyl dokončen'\]/);
  assert.match(source, /if \(typeof ensurePreflight === 'function'\) await ensurePreflight\(\)/);
  assert.doesNotMatch(source, /fileFilter:[\s\S]{0,500}Promise\.resolve\(ensurePreflight\(\)\)/);
  assert.match(source, /findTenderExecutionConflict\(tenderId\)/);
  assert.doesNotMatch(source, /res\.once\('close', release\)/);
  assert.match(source, /const analyzeReport = report\?\.kroky\.analyze/);
  assert.match(source, /nový matching pro aktuální výběr částí/);
  assert.match(source, /ocekavanyPocetPoMultipartDavce/);
  assert.match(source, /selected_parts\.length === 0 \|\| unknownParts\.length > 0/);
  assert.match(source, /const listingFetch: typeof fetch/);
  assert.match(source, /if \(zdSourceListingIncomplete\) \{/);
  assert.match(source, /další přílohy z nedokončeného seznamu NEN/);
  assert.match(source, /Změna vybraného produktu zneplatnila předchozí ověření ceny/);
  assert.match(source, /id, 'verify-prices', true/);
  assert.match(source, /if \(reservedTenderId\) activeIngests\.delete\(reservedTenderId\)/);
  assert.match(source, /ai:\s*\{ budget: aiBudget, vectorMatcher \}/);
  assert.match(source, /dailyAiLimitBlock\(governance, todayCzk\)/);
  assert.match(source, /OPENAI_API_KEY není nastaven; vektorový tier matcheru není dostupný/);
  assert.match(source, /async function commitTenderUploadFiles\(req: express\.Request\)/);
  assert.match(source, /await commitTenderUploadFiles\(req\)/);
  assert.match(source, /await rename\(file\.path, finalPath\)/);
  assert.match(source, /await rename\(backupPath, finalPath\)/);
});
