import { strict as assert } from 'node:assert';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateEvalMetrics, calculateMetricsDelta, type EvalItem, type GoldenItem } from '../src/lib/eval-metrics.js';

const golden: GoldenItem[] = [
  { id: 'T:0', nazev_polozky: 'A', specifikace: '', mnozstvi: 1, jednotka: 'ks', realna_cena_bez_dph: 200, zdroj_url_domena: 'shop.test', kategorie: 'produkt' },
  { id: 'T:1', nazev_polozky: 'B', specifikace: '', mnozstvi: 1, jednotka: 'ks', realna_cena_bez_dph: 100, zdroj_url_domena: 'shop.test', kategorie: 'produkt' },
];

test('eval počítá identifikaci, hit-rate, MAPE a drahý směr pod trhem', () => {
  const items: EvalItem[] = [
    { id: 'T:0', vybrany_index: 0, kandidati: [{ vyrobce: 'Acme', model: 'X', katalogove_cislo: 'AX', cena_bez_dph: 100 }], overeni_ceny: { overeno_at: '2026-07-11T10:00:00.000Z', stav: 'nalezeno', zdroje: [{ url: 'https://shop.test/a', cena_bez_dph: 200 }] } },
    { id: 'T:1', vybrany_index: 0, kandidati: [{ vyrobce: 'Acme', model: 'Y', cena_bez_dph: 150 }], overeni_ceny: { overeno_at: '2026-07-11T10:00:00.000Z', stav: 'orientacni', zdroje: [{ url: 'https://shop.test/b', cena_bez_dph: 100, orientacni: true }] } },
  ];
  const result = calculateEvalMetrics(items, golden);
  assert.equal(result.identifikace_pct, 100);
  assert.equal(result.katalogove_cislo_pct, 50);
  assert.equal(result.hit_rate_pct, 50);
  assert.equal(result.pokryti_verify_pct, 100);
  assert.equal(result.mape_pct, 50);
  assert.equal(result.podil_pod_trhem_pct, 50);
  assert.equal(result.median_relativni_chyby_pct, 50);
  assert.equal(result.p90_relativni_chyby_pct, 50);
  assert.deepEqual([result.podceneno, result.nadceneno], [1, 1]);
});

test('eval bezpečně řeší nulové ceny, chybějící realitu a prázdné kandidáty', () => {
  const result = calculateEvalMetrics([{ id: 'T:0', kandidati: [] }, { id: 'T:2' }], [{ ...golden[0], realna_cena_bez_dph: 0 }]);
  assert.equal(result.identifikace_pct, null);
  assert.equal(result.genericky_kandidat_pct, null);
  assert.equal(result.hit_rate_pct, null);
  assert.equal(result.pokryti_verify_pct, 0);
  assert.equal(result.mape_pct, null);
  assert.equal(result.podil_pod_trhem_pct, null);
  assert.equal(result.cenovych_porovnani, 0);
});

test('verify hit-rate používá jen ověřené položky a pokrytí počítá zvlášť', () => {
  const result = calculateEvalMetrics([
    { id: 'T:0', kandidati: [], overeni_ceny: { overeno_at: '2026-07-11T10:00:00.000Z', stav: 'nalezeno', zdroj_url: 'https://shop.test/a' } },
    { id: 'T:1', kandidati: [], overeni_ceny: { overeno_at: '2026-07-11T10:00:00.000Z', stav: 'nenalezeno' } },
    { id: 'T:2', kandidati: [] },
    { id: 'T:3', kandidati: [], overeni_ceny: { stav: 'nalezeno', zdroj_url: 'https://shop.test/legacy-without-timestamp' } },
  ], []);
  assert.equal(result.hit_rate_pct, 50);
  assert.equal(result.pokryti_verify_pct, 50);
});

test('delta hit-rate se počítá mezi reporty stejné verze', () => {
  const current = calculateEvalMetrics([
    { id: 'T:0', overeni_ceny: { overeno_at: '2026-07-11T10:00:00.000Z', stav: 'nalezeno', zdroj_url: 'https://shop.test/a' } },
    { id: 'T:1' },
  ], []);
  const delta = calculateMetricsDelta(current, { hit_rate_pct: 25 }, 2, 2);
  assert.equal(delta.hit_rate_pct, 75);
  assert.equal(delta.pokryti_verify_pct, undefined);
  assert.equal(calculateMetricsDelta(current, { hit_rate_pct: 25, pokryti_verify_pct: 10 }, 2, 2).pokryti_verify_pct, 40);
});

test('delta hit-rate se při rozdílné nebo chybějící verzi vynechá, ostatní metriky zůstanou', () => {
  const current = calculateEvalMetrics([
    { id: 'T:0', overeni_ceny: { overeno_at: '2026-07-11T10:00:00.000Z', stav: 'nalezeno', zdroj_url: 'https://shop.test/a' } },
    { id: 'T:1' },
  ], []);
  const previous = { hit_rate_pct: 25, pokryti_verify_pct: 10 };
  assert.equal(calculateMetricsDelta(current, previous, 2, 1).hit_rate_pct, undefined);
  assert.equal(calculateMetricsDelta(current, previous, 2, undefined).hit_rate_pct, undefined);
  assert.equal(calculateMetricsDelta(current, previous, 2, 1).pokryti_verify_pct, 40);
});

test('generický kandidát zahrnuje placeholder i zadna_shoda', () => {
  const result = calculateEvalMetrics([{ id: 'T:0', kandidati: [
    { vyrobce: 'Neuvedený', model: 'N/A' },
    { vyrobce: 'Acme', model: 'X', zadna_shoda: true },
  ] }], []);
  assert.equal(result.genericky_kandidat_pct, 100);
});

test('offline eval projde bez AI klíče', async () => {
  // The repository intentionally does not version `output/`; relying on a developer's
  // n-485400-naradi result made this test fail in a clean worktree. Build an isolated
  // offline input and remove only the artifacts produced by this test.
  const scriptsDir = new URL('../', import.meta.url).pathname;
  const repositoryRoot = new URL('../../', import.meta.url).pathname;
  const outputRoot = join(repositoryRoot, 'output');
  const reportsDir = join(outputRoot, 'eval');
  const tenderId = `eval-offline-test-${process.pid}`;
  const tenderDir = join(outputRoot, tenderId);
  const outputRootExisted = existsSync(outputRoot);
  const reportsDirExisted = existsSync(reportsDir);
  const reportsBefore = new Set(reportsDirExisted ? await readdir(reportsDir) : []);
  await mkdir(tenderDir, { recursive: true });
  await writeFile(join(tenderDir, 'product-match.json'), JSON.stringify({
    polozky_match: [{
      polozka_index: 0,
      vybrany_index: 0,
      kandidati: [{ vyrobce: 'Offline', model: 'Fixture', cena_bez_dph: 100 }],
    }],
  }), 'utf8');

  let result: { code: number | null; output: string };
  try {
    result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/eval-match.ts', `--tenders=${tenderId}`], {
        cwd: scriptsDir, env: { ...process.env, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', reject); child.on('exit', (code) => resolve({ code, output }));
    });
  } finally {
    await rm(tenderDir, { recursive: true, force: true });
    if (existsSync(reportsDir)) {
      const reportsAfter = await readdir(reportsDir);
      for (const report of reportsAfter.filter((name) => !reportsBefore.has(name))) {
        const reportPath = join(reportsDir, report);
        try {
          const parsed = JSON.parse(await readFile(reportPath, 'utf8'));
          if (Array.isArray(parsed.tenders) && parsed.tenders.includes(tenderId)) await rm(reportPath);
        } catch {
          // Unknown concurrent artifacts are not ours to remove.
        }
      }
    }
    if (!reportsDirExisted) await rmdir(reportsDir).catch(() => {});
    if (!outputRootExisted) await rmdir(outputRoot).catch(() => {});
  }
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Identifikace výrobce/);
  assert.match(result.output, /Pokrytí verify/);
});
