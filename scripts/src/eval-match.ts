import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { basename, join } from 'node:path';
import { calculateEvalMetrics, calculateMetricsDelta, METRICS_VERSION, type EvalItem, type EvalMetrics, type GoldenItem } from './lib/eval-metrics.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const FIXTURES = join(ROOT, 'scripts/tests/fixtures/golden-set');
const REPORTS = join(ROOT, 'output/eval');
const DEFAULT_TENDERS = ['nakup-drobneho-naradi-podzim', 'n-485400-naradi', 'vypocetni-servery-pro-zo-pardubice', 'kancelarsky-material', 'varyte-vybaveni'];

interface EvalReport {
  metrics_version: number;
  generated_at: string;
  mode: 'offline' | 'live';
  tenders: string[];
  golden_items: number;
  metrics: EvalMetrics;
  delta_vs_previous: Partial<Record<keyof EvalMetrics, number>> | null;
}

async function loadGolden(): Promise<GoldenItem[]> {
  const files = (await readdir(FIXTURES)).filter((file) => file.endsWith('.json'));
  const chunks = await Promise.all(files.map((file) => readFile(join(FIXTURES, file), 'utf8').then(JSON.parse)));
  return chunks.flat() as GoldenItem[];
}

async function loadTenderItems(tender: string): Promise<EvalItem[]> {
  const path = join(ROOT, 'output', basename(tender), 'product-match.json');
  if (!existsSync(path)) return [];
  const match = JSON.parse(await readFile(path, 'utf8'));
  if (match.polozky_match) {
    return match.polozky_match.map((item: any) => ({ ...item, id: `${basename(tender)}:${item.polozka_index}` }));
  }
  return [{ ...match, id: `${basename(tender)}:-1` }];
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: join(ROOT, 'scripts'), stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} skončil s kódem ${code}`)));
  });
}

async function confirmLive(count: number): Promise<void> {
  const estimate = Math.max(1, Math.ceil(count / 10)) * 0.25;
  console.log(`Odhad nákladu matchingu: přibližně ${estimate.toFixed(2)}–${(estimate * 4).toFixed(2)} Kč pro ${count} položek (verify cenu dále zvýší).`);
  if (process.argv.includes('--yes')) return;
  if (!process.stdin.isTTY) throw new Error('Live režim vyžaduje interaktivní potvrzení nebo explicitní --yes.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Pokračovat v placeném AI běhu? [ano/NE] ');
  rl.close();
  if (!/^a(no)?$/i.test(answer.trim())) throw new Error('Live běh zrušen.');
}

async function runLive(golden: GoldenItem[]): Promise<string[]> {
  if (golden.length === 0) throw new Error('Zlatý set je prázdný; live běh nemá nad čím spustit matching.');
  await confirmLive(golden.length);
  const id = `eval-live-${Date.now()}`;
  const output = join(ROOT, 'output', id);
  await mkdir(output, { recursive: true });
  const analysis = {
    zakazka: { nazev: 'Anonymizovaný eval', predmet: 'Regresní měření matchingu', zadavatel: 'ANONYMIZOVÁNO' },
    kvalifikace: [], hodnotici_kriteria: [], terminy: {}, casti: [], technicke_pozadavky: [], rizika: [], doporuceni: [],
    polozky: golden.map((item) => ({ nazev: item.nazev_polozky, specifikace: item.specifikace, mnozstvi: item.mnozstvi, jednotka: item.jednotka })),
  };
  await writeFile(join(output, 'analysis.json'), JSON.stringify(analysis, null, 2), 'utf8');
  await run(process.execPath, ['--import', 'tsx', 'src/match-product.ts', `--tender-id=${id}`]);
  if (process.argv.includes('--verify')) await run(process.execPath, ['--import', 'tsx', 'src/verify-prices.ts', `--tender-id=${id}`]);
  // ID položek přemapujeme na stabilní ID zlatého setu až při načtení reportu.
  const match = JSON.parse(await readFile(join(output, 'product-match.json'), 'utf8'));
  match.polozky_match = (match.polozky_match ?? []).map((item: any, index: number) => ({ ...item, eval_golden_id: golden[index]?.id }));
  await writeFile(join(output, 'product-match.json'), JSON.stringify(match, null, 2), 'utf8');
  return [id];
}

function printMetrics(metrics: EvalMetrics): void {
  const display = (value: number | null) => value === null ? 'N/A' : `${value.toFixed(2)} %`;
  console.table([
    { metrika: 'Identifikace výrobce + model', hodnota: display(metrics.identifikace_pct) },
    { metrika: 'Katalogové číslo', hodnota: display(metrics.katalogove_cislo_pct) },
    { metrika: 'Generický kandidát', hodnota: display(metrics.genericky_kandidat_pct) },
    { metrika: 'Verify hit-rate', hodnota: display(metrics.hit_rate_pct) },
    { metrika: 'Pokrytí verify', hodnota: display(metrics.pokryti_verify_pct) },
    { metrika: 'MAPE ceny', hodnota: display(metrics.mape_pct) },
    { metrika: 'Podíl pod trhem', hodnota: display(metrics.podil_pod_trhem_pct) },
    { metrika: 'Medián relativní chyby', hodnota: display(metrics.median_relativni_chyby_pct) },
    { metrika: 'P90 relativní chyby', hodnota: display(metrics.p90_relativni_chyby_pct) },
  ]);
  console.log(`Směr ceny: ${metrics.podceneno}× podceněno, ${metrics.nadceneno}× nadceněno, ${metrics.shoda_ceny}× shoda.`);
}

async function previousReport(): Promise<EvalReport | null> {
  if (!existsSync(REPORTS)) return null;
  const files = (await readdir(REPORTS)).filter((file) => file.endsWith('.json')).sort();
  if (!files.length) return null;
  return JSON.parse(await readFile(join(REPORTS, files.at(-1)!), 'utf8')) as EvalReport;
}

async function main(): Promise<void> {
  // Důležitá vlastnost offline režimu: tento modul pouze čte JSON; AI moduly se ani neimportují.
  const live = process.argv.includes('--live');
  const golden = await loadGolden();
  let tenders: string[];
  let items: EvalItem[];
  if (live) {
    tenders = await runLive(golden);
    const raw = await loadTenderItems(tenders[0]);
    items = raw.map((item: any, index) => ({ ...item, id: golden[index]?.id ?? item.id }));
  } else {
    const arg = process.argv.find((value) => value.startsWith('--tenders='));
    tenders = arg ? arg.slice('--tenders='.length).split(',').filter(Boolean) : DEFAULT_TENDERS;
    items = (await Promise.all(tenders.map(loadTenderItems))).flat();
    tenders = tenders.filter((tender) => existsSync(join(ROOT, 'output', basename(tender), 'product-match.json')));
  }
  if (!items.length) throw new Error('Nebyl nalezen žádný aktuální product-match.json pro vyhodnocení.');
  const metrics = calculateEvalMetrics(items, golden);
  const previous = await previousReport();
  const delta: EvalReport['delta_vs_previous'] = previous ? {} : null;
  if (delta) Object.assign(delta, calculateMetricsDelta(metrics, previous!.metrics, METRICS_VERSION, previous!.metrics_version));
  const generated = new Date().toISOString();
  const report: EvalReport = { metrics_version: METRICS_VERSION, generated_at: generated, mode: live ? 'live' : 'offline', tenders, golden_items: golden.length, metrics, delta_vs_previous: delta };
  printMetrics(metrics);
  if (previous) {
    console.log('Delta proti předchozímu reportu:', delta);
    if (previous.metrics_version !== METRICS_VERSION) console.log('hit-rate: nová definice metriky, delta nedostupná');
  }
  else console.log('Předchozí report není k dispozici.');
  if (!golden.length) console.warn('Zlatý set je prázdný: cenové metriky jsou N/A, protože lokální data neobsahují ověřené reálné ceny.');
  await mkdir(REPORTS, { recursive: true });
  const target = join(REPORTS, generated.replace(/[:.]/g, '-') + '.json');
  await writeFile(target, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`JSON report: ${target}`);
}

main().catch((error) => { console.error(`Eval selhal: ${(error as Error).message}`); process.exitCode = 1; });
