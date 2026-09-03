import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type JsonObject = Record<string, unknown>;

export type UrlCategory = 'produktova_stranka' | 'vyhledavani' | 'neznamy';

export interface ProvenanceMeasurement {
  zakazek: number;
  polozek: number;
  kandidatu: number;
  sKatalogovymCislem: number;
  sDodavateli: number;
  sUrl: number;
  produktovaStranka: number;
  jenVyhledavani: number;
  bezOdkazu: number;
  sDoklademOvereniCeny: number;
  dolozenych: number;
  podilDolozenych: string;
  odkazyPodleKategorie: Record<UrlCategory, number>;
  hostitele: Record<string, number>;
  cenaSpolehlivost: Record<string, number>;
  topZdrojeCeny: Array<{ hodnota: string; pocet: number }>;
}

const HTTP_URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

const SEARCH_PATH_PATTERNS = [
  /(?:^|\/)search(?:\/|$)/i, // Běžná anglická cesta vyhledávání.
  /(?:^|\/)hledat(?:\/|$)/i, // Český infinitiv používaný e-shopy.
  /(?:^|\/)hledani(?:\/|$)/i, // Česká cesta bez diakritiky.
  /(?:^|\/)vyhledavani(?:\/|$)/i, // Delší česká varianta bez diakritiky.
];

const SEARCH_QUERY_PARAMETERS = new Set([
  'q', // Krátký obecný vyhledávací dotaz.
  'query', // Anglický název vyhledávacího dotazu.
  'search', // Parametr pojmenovaný přímo podle vyhledávání.
  'dotaz', // Český název dotazu.
  'keyword', // Vyhledávání podle klíčového slova.
  'h[fraze]', // Heureka sem ukládá hledanou frázi; nejde o identifikátor produktu.
]);

const PRODUCT_PATH_PATTERNS = [
  /(?:^|\/)produkt(?:\/|$)/i, // Česká produktová cesta `/produkt/`.
  /(?:^|\/)products?(?:\/|$)/i, // Anglické produktové cesty `/product/` a `/products/`.
  /(?:^|\/)p(?:\/|$)/i, // Krátká produktová cesta `/p/`.
  /(?:^|\/)dp(?:\/|$)/i, // Produktová cesta `/dp/`.
  /(?:^|\/)zbozi(?:\/|$)/i, // Česká produktová cesta `/zbozi/`.
  /(?:^|\/)\d{3,}(?:\/|$)/i, // Samostatné číselné ID v cestě.
];

const KNOWN_PRODUCT_PATHS = [
  { hostname: 'mayku.me', pathname: /^\/multiplier\/?$/i }, // Mayku používá pro produkt Multiplier jednoslovný permalink.
];

const NEUVEDENO = '(neuvedeno)';
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL('../../../output/', import.meta.url));

function asObject(value: unknown): JsonObject | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function hasNonEmptyValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonEmptyValue);
  return false;
}

export function containsHttpUrl(value: unknown): boolean {
  return collectHttpUrls(value).length > 0;
}

function collectHttpUrls(value: unknown): string[] {
  if (typeof value === 'string') return value.match(HTTP_URL_PATTERN) ?? [];
  if (Array.isArray(value)) return value.flatMap(collectHttpUrls);

  const object = asObject(value);
  return object ? Object.values(object).flatMap(collectHttpUrls) : [];
}

function parseHttpUrl(rawUrl: string): URL | undefined {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function classifyUrl(rawUrl: string): UrlCategory {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return 'neznamy';

  const pathname = parsed.pathname;
  const queryParameters = [...parsed.searchParams.keys()].map((key) => key.toLowerCase());

  // Vyhledávání má přednost: ani produktově vypadající cesta s hledacím parametrem není doklad.
  if (
    SEARCH_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
    || queryParameters.some((key) => SEARCH_QUERY_PARAMETERS.has(key))
  ) {
    return 'vyhledavani';
  }

  if (
    PRODUCT_PATH_PATTERNS.some((pattern) => pattern.test(pathname))
    || KNOWN_PRODUCT_PATHS.some(({ hostname, pathname: pattern }) => (
      parsed.hostname.toLowerCase() === hostname && pattern.test(pathname)
    ))
  ) {
    return 'produktova_stranka';
  }

  return 'neznamy';
}

function hasVerificationSourceUrl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasVerificationSourceUrl);

  const object = asObject(value);
  if (!object) return false;

  return Object.entries(object).some(([key, nestedValue]) => {
    if (key === 'zdroj_url' || key === 'url') {
      return collectHttpUrls(nestedValue).some((rawUrl) => (
        parseHttpUrl(rawUrl) !== undefined && classifyUrl(rawUrl) !== 'vyhledavani'
      ));
    }
    return hasVerificationSourceUrl(nestedValue);
  });
}

function selectedCandidateIndex(item: JsonObject, candidateCount: number): number | undefined {
  const selected = item.vybrany_index;
  if (typeof selected === 'number' && Number.isInteger(selected) && selected >= 0 && selected < candidateCount) {
    return selected;
  }

  // U položky s jediným kandidátem je vazba jednoznačná i u starších dat bez indexu.
  return candidateCount === 1 ? 0 : undefined;
}

function itemsFromProductMatch(value: unknown): JsonObject[] {
  const productMatch = asObject(value);
  if (!productMatch) return [];

  if (Array.isArray(productMatch.polozky_match)) {
    return productMatch.polozky_match.flatMap((item) => {
      const object = asObject(item);
      return object ? [object] : [];
    });
  }

  // Legacy product-match ukládal kandidáty přímo v kořeni a reprezentuje jednu položku.
  return Array.isArray(productMatch.kandidati) ? [productMatch] : [];
}

async function findProductMatchFiles(outputDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Adresář output nelze přečíst (${outputDir}): ${message}`);
  }

  const files: string[] = [];
  for (const entry of entries) {
    const candidate = join(outputDir, entry.name, 'product-match.json');
    try {
      if ((await stat(candidate)).isFile()) files.push(candidate);
    } catch (error) {
      const code = asObject(error)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }

  files.sort();
  if (files.length === 0) {
    throw new Error(`Adresář output je prázdný nebo neobsahuje */product-match.json (${outputDir}).`);
  }
  return files;
}

function increment(counts: Map<string, number>, rawValue: unknown): void {
  const value = typeof rawValue === 'string' && rawValue.trim() ? rawValue.trim() : NEUVEDENO;
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort(([leftValue, leftCount], [rightValue, rightCount]) => {
    return rightCount - leftCount || leftValue.localeCompare(rightValue, 'cs');
  });
}

function formatPercentage(numerator: number, denominator: number): string {
  if (denominator === 0) return '0 %';
  const rounded = (Math.round((numerator / denominator) * 10_000) / 100).toFixed(2);
  return `${rounded.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')} %`;
}

export async function measureProvenance(outputDir: string = DEFAULT_OUTPUT_DIR): Promise<ProvenanceMeasurement> {
  const files = await findProductMatchFiles(outputDir);
  const reliabilityCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const hostCounts = new Map<string, number>();
  const odkazyPodleKategorie: Record<UrlCategory, number> = {
    produktova_stranka: 0,
    vyhledavani: 0,
    neznamy: 0,
  };

  let polozek = 0;
  let kandidatu = 0;
  let sKatalogovymCislem = 0;
  let sDodavateli = 0;
  let sUrl = 0;
  let produktovaStranka = 0;
  let jenVyhledavani = 0;
  let bezOdkazu = 0;
  let sDoklademOvereniCeny = 0;
  let dolozenych = 0;

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Soubor ${file} nelze načíst jako JSON: ${message}`);
    }

    const items = itemsFromProductMatch(parsed);
    polozek += items.length;

    for (const item of items) {
      const candidates = Array.isArray(item.kandidati) ? item.kandidati : [];
      const documentedIndex = hasVerificationSourceUrl(item.overeni_ceny)
        ? selectedCandidateIndex(item, candidates.length)
        : undefined;

      for (const [index, candidate] of candidates.entries()) {
        kandidatu += 1;
        const object = asObject(candidate);
        const candidateUrls = collectHttpUrls(candidate);
        const urlCategories = candidateUrls.map(classifyUrl);
        const candidateHasUrl = candidateUrls.length > 0;
        const candidateHasProductPage = urlCategories.includes('produktova_stranka');
        const candidateHasOnlySearch = candidateHasUrl
          && urlCategories.every((category) => category === 'vyhledavani');
        const candidateHasDocument = documentedIndex === index;

        for (const [urlIndex, rawUrl] of candidateUrls.entries()) {
          const category = urlCategories[urlIndex] ?? 'neznamy';
          odkazyPodleKategorie[category] += 1;
          const parsedUrl = parseHttpUrl(rawUrl);
          if (parsedUrl) increment(hostCounts, parsedUrl.hostname.toLowerCase());
        }

        if (object && hasNonEmptyValue(object.katalogove_cislo)) sKatalogovymCislem += 1;
        if (object && hasNonEmptyValue(object.dodavatele)) sDodavateli += 1;
        if (candidateHasUrl) sUrl += 1;
        if (candidateHasProductPage) produktovaStranka += 1;
        if (candidateHasOnlySearch) jenVyhledavani += 1;
        if (!candidateHasUrl) bezOdkazu += 1;
        if (candidateHasDocument) sDoklademOvereniCeny += 1;
        if (candidateHasProductPage || candidateHasDocument) dolozenych += 1;

        increment(reliabilityCounts, object?.cena_spolehlivost);
        increment(sourceCounts, object?.zdroj_ceny);
      }
    }
  }

  if (kandidatu === 0) {
    throw new Error(`Nalezené product-match.json neobsahují žádné cenové kandidáty (${outputDir}).`);
  }

  return {
    zakazek: files.length,
    polozek,
    kandidatu,
    sKatalogovymCislem,
    sDodavateli,
    sUrl,
    produktovaStranka,
    jenVyhledavani,
    bezOdkazu,
    sDoklademOvereniCeny,
    dolozenych,
    podilDolozenych: formatPercentage(dolozenych, kandidatu),
    odkazyPodleKategorie,
    hostitele: Object.fromEntries(sortedCounts(hostCounts)),
    cenaSpolehlivost: Object.fromEntries(sortedCounts(reliabilityCounts)),
    topZdrojeCeny: sortedCounts(sourceCounts)
      .filter(([value]) => value !== NEUVEDENO)
      .slice(0, 10)
      .map(([hodnota, pocet]) => ({ hodnota, pocet })),
  };
}

function printMeasurement(measurement: ProvenanceMeasurement): void {
  const rows: Array<[string, string]> = [
    ['Zakázky', String(measurement.zakazek)],
    ['Položky', String(measurement.polozek)],
    ['Cenoví kandidáti', String(measurement.kandidatu)],
    ['Zdánlivě doložené ceny (jen vyhledávací odkazy)', String(measurement.jenVyhledavani)],
    ['Kandidáti s produktovou stránkou', String(measurement.produktovaStranka)],
    ['Kandidáti bez odkazu', String(measurement.bezOdkazu)],
    ['S katalogovým číslem', String(measurement.sKatalogovymCislem)],
    ['S dodavateli', String(measurement.sDodavateli)],
    ['S URL ve struktuře kandidáta', String(measurement.sUrl)],
    ['S dokladem v overeni_ceny', String(measurement.sDoklademOvereniCeny)],
    ['Skutečně doložené ceny', `${measurement.dolozenych} (${measurement.podilDolozenych})`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length), 'Metrika'.length);

  console.log('Měření provenience cen');
  console.log(`${'Metrika'.padEnd(width)} | Hodnota`);
  console.log(`${'-'.repeat(width)}-+----------------`);
  for (const [label, value] of rows) console.log(`${label.padEnd(width)} | ${value}`);

  console.log('\nRozpad cena_spolehlivost');
  for (const [value, count] of Object.entries(measurement.cenaSpolehlivost)) {
    console.log(`  ${value}: ${count}`);
  }

  console.log('\nTop hodnoty zdroj_ceny');
  for (const [index, source] of measurement.topZdrojeCeny.entries()) {
    console.log(`  ${index + 1}. ${source.hodnota}: ${source.pocet}`);
  }

  console.log('\nHostitelé odkazů kandidátů');
  for (const [hostname, count] of Object.entries(measurement.hostitele)) {
    console.log(`  ${hostname}: ${count}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      'output-dir': { type: 'string' },
    },
    strict: true,
  });
  const outputDir = values['output-dir'] ? resolve(values['output-dir']) : DEFAULT_OUTPUT_DIR;
  const measurement = await measureProvenance(outputDir);

  if (values.json) console.log(JSON.stringify(measurement, null, 2));
  else printMeasurement(measurement);
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Chyba měření provenience: ${message}`);
    process.exitCode = 1;
  });
}
