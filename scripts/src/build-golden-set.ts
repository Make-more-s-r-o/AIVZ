import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { GoldenItem } from './lib/eval-metrics.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const DEFAULT_TENDERS = ['nakup-drobneho-naradi-podzim', 'n-485400-naradi', 'vypocetni-servery-pro-zo-pardubice', 'kancelarsky-material', 'varyte-vybaveni'];

function domain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function selectedSource(verification: any): { price: number; domain: string } | null {
  if (!['nalezeno', 'ekvivalent'].includes(verification?.stav)) return null;
  const sources = (verification.zdroje ?? [])
    .filter((source: any) => source?.orientacni !== true && Number(source?.cena_bez_dph) > 0 && domain(source?.url))
    .sort((a: any, b: any) => a.cena_bez_dph - b.cena_bez_dph);
  if (sources[0]) return { price: sources[0].cena_bez_dph, domain: domain(sources[0].url)! };
  const legacyDomain = domain(verification.zdroj_url);
  return legacyDomain && Number(verification.web_cena_bez_dph) > 0
    ? { price: verification.web_cena_bez_dph, domain: legacyDomain }
    : null;
}

export async function buildGoldenSet(tenders: string[]): Promise<GoldenItem[]> {
  const result: GoldenItem[] = [];
  for (const tender of tenders) {
    const output = join(ROOT, 'output', basename(tender));
    let analysis: any;
    let match: any;
    try {
      [analysis, match] = await Promise.all([
        readFile(join(output, 'analysis.json'), 'utf8').then(JSON.parse),
        readFile(join(output, 'product-match.json'), 'utf8').then(JSON.parse),
      ]);
    } catch {
      console.warn(`Přeskakuji ${basename(tender)}: chybí analysis.json nebo product-match.json.`);
      continue;
    }
    for (const item of match.polozky_match ?? []) {
      const source = selectedSource(item.overeni_ceny);
      if (!source) continue;
      const original = analysis.polozky?.[item.polozka_index] ?? {};
      const candidate = item.kandidati?.[item.vybrany_index ?? 0] ?? {};
      result.push({
        id: `${basename(tender)}:${item.polozka_index}`,
        nazev_polozky: String(original.nazev ?? item.polozka_nazev ?? ''),
        specifikace: String(original.specifikace ?? ''),
        mnozstvi: Number(original.mnozstvi ?? item.mnozstvi ?? 1),
        jednotka: String(original.jednotka ?? item.jednotka ?? 'ks'),
        ...(candidate.vyrobce ? { ocekavany_vyrobce: candidate.vyrobce } : {}),
        ...(candidate.model ? { ocekavany_model: candidate.model } : {}),
        ...(candidate.katalogove_cislo ? { ocekavane_katalogove_cislo: candidate.katalogove_cislo } : {}),
        realna_cena_bez_dph: source.price,
        zdroj_url_domena: source.domain,
        kategorie: String(item.typ ?? original.cast_id ?? 'produkt'),
      });
    }
  }
  return result;
}

async function main(): Promise<void> {
  const tendersArg = process.argv.find((arg) => arg.startsWith('--tenders='));
  const tenders = tendersArg ? tendersArg.slice('--tenders='.length).split(',').filter(Boolean) : DEFAULT_TENDERS;
  const golden = await buildGoldenSet(tenders);
  const directory = join(ROOT, 'scripts/tests/fixtures/golden-set');
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'golden-set.json');
  await writeFile(target, JSON.stringify(golden, null, 2) + '\n', 'utf8');
  console.log(`Zapsáno ${golden.length} anonymizovaných položek do ${target}.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch((error) => { console.error(error); process.exitCode = 1; });
