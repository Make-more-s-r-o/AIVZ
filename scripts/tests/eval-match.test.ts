import { strict as assert } from 'node:assert';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { calculateEvalMetrics, type EvalItem, type GoldenItem } from '../src/lib/eval-metrics.js';

const golden: GoldenItem[] = [
  { id: 'T:0', nazev_polozky: 'A', specifikace: '', mnozstvi: 1, jednotka: 'ks', realna_cena_bez_dph: 200, zdroj_url_domena: 'shop.test', kategorie: 'produkt' },
  { id: 'T:1', nazev_polozky: 'B', specifikace: '', mnozstvi: 1, jednotka: 'ks', realna_cena_bez_dph: 100, zdroj_url_domena: 'shop.test', kategorie: 'produkt' },
];

test('eval počítá identifikaci, hit-rate, MAPE a drahý směr pod trhem', () => {
  const items: EvalItem[] = [
    { id: 'T:0', vybrany_index: 0, kandidati: [{ vyrobce: 'Acme', model: 'X', katalogove_cislo: 'AX', cena_bez_dph: 100 }], overeni_ceny: { stav: 'nalezeno', zdroje: [{ url: 'https://shop.test/a', cena_bez_dph: 200 }] } },
    { id: 'T:1', vybrany_index: 0, kandidati: [{ vyrobce: 'Acme', model: 'Y', cena_bez_dph: 150 }], overeni_ceny: { stav: 'orientacni', zdroje: [{ url: 'https://shop.test/b', cena_bez_dph: 100, orientacni: true }] } },
  ];
  const result = calculateEvalMetrics(items, golden);
  assert.equal(result.identifikace_pct, 100);
  assert.equal(result.katalogove_cislo_pct, 50);
  assert.equal(result.hit_rate_pct, 50);
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
  assert.equal(result.hit_rate_pct, 0);
  assert.equal(result.mape_pct, null);
  assert.equal(result.podil_pod_trhem_pct, null);
  assert.equal(result.cenovych_porovnani, 0);
});

test('generický kandidát zahrnuje placeholder i zadna_shoda', () => {
  const result = calculateEvalMetrics([{ id: 'T:0', kandidati: [
    { vyrobce: 'Neuvedený', model: 'N/A' },
    { vyrobce: 'Acme', model: 'X', zadna_shoda: true },
  ] }], []);
  assert.equal(result.genericky_kandidat_pct, 100);
});

test('offline eval projde bez AI klíče', async () => {
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/eval-match.ts', '--tenders=n-485400-naradi'], {
      cwd: new URL('../', import.meta.url).pathname, env: { ...process.env, ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject); child.on('exit', (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Identifikace výrobce/);
});
