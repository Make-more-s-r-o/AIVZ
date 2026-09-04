import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { extractCastIdFromFilename } from '../parse-soupis.js';
import { candidateFingerprint } from './candidate-fingerprint.js';
import { ProductMatchSchema, ValidationReportSchema } from './types.js';

export const UPLNOST_FILENAME = 'uplnost.json';
export const UPLNOST_DIRECTORY = '.pipeline';
export const UPLNOST_ERROR_MARKER = 'UPLNOST_ERROR ';
export const DEFAULT_ANALYZE_MIN_TEXT_CHARACTERS = 1_000;
export const ANALYZE_MIN_TEXT_ENV = 'ANALYZE_MIN_TEXT_CHARACTERS';

export type UplnostStav = 'uplne' | 'castecne' | 'selhalo';
export type UplnostKrokNazev =
  | 'ingest'
  | 'extract'
  | 'analyze'
  | 'match'
  | 'verify-prices'
  | 'generate'
  | 'validate';

export const UPLNOST_STEP_ORDER: readonly UplnostKrokNazev[] = [
  'ingest', 'extract', 'analyze', 'match', 'verify-prices', 'generate', 'validate',
];

export interface UplnostHodnota {
  nazev: string;
  jednotka: 'dokumenty' | 'znaky' | 'polozky' | 'sablony' | 'soubory' | 'vystupy';
  pocet: number;
}

export interface UplnostMetrika {
  nazev: string;
  jednotka: UplnostHodnota['jednotka'];
  ocekavano: number;
  dostano: number;
}

export interface UplnostKroku {
  krok: UplnostKrokNazev;
  stav: UplnostStav;
  ocekavano: UplnostHodnota[];
  dostano: UplnostHodnota[];
  chybi: string[];
  vedomeIgnorovano: string[];
  zprava: string;
  naprava: string;
  aktualizovano: string;
}

export interface UplnostZakazky {
  verze: 1;
  tenderId: string;
  aktualizovano: string;
  kroky: Partial<Record<UplnostKrokNazev, UplnostKroku>>;
}

export interface VytvorUplnostKrokuInput {
  krok: UplnostKrokNazev;
  metriky: UplnostMetrika[];
  chybi?: readonly string[];
  vedomeIgnorovano?: readonly string[];
  selhalo?: boolean;
  zprava?: string;
  naprava?: string;
  aktualizovano?: string;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function defaultMessage(krok: UplnostKrokNazev, stav: UplnostStav): string {
  if (stav === 'uplne') return `Krok ${krok} vytvořil všechny očekávané výstupy.`;
  if (stav === 'castecne') return `Krok ${krok} vytvořil jen část očekávaných výstupů.`;
  return `Krok ${krok} nevytvořil požadovaný výstup.`;
}

/**
 * Jediné místo, které odvozuje explicitní stav. `uplne` je možné pouze tehdy,
 * když žádná metrika nemá deficit a seznam chybějících položek je prázdný.
 */
export function urciStavUplnosti(
  metriky: readonly UplnostMetrika[],
  chybi: readonly string[],
  vynuceneSelhani = false,
): UplnostStav {
  // Bez jediné dvojice očekáváno/dostáno nemáme žádný důkaz úplnosti.
  if (vynuceneSelhani || metriky.length === 0) return 'selhalo';
  const maDeficit = metriky.some((metrika) =>
    nonNegativeInteger(metrika.dostano) < nonNegativeInteger(metrika.ocekavano));
  if (!maDeficit && chybi.length === 0) return 'uplne';
  const necoVzniklo = metriky.some((metrika) => nonNegativeInteger(metrika.dostano) > 0);
  return necoVzniklo ? 'castecne' : 'selhalo';
}

export function vytvorUplnostKroku(input: VytvorUplnostKrokuInput): UplnostKroku {
  const metriky = input.metriky.map((metrika) => ({
    ...metrika,
    ocekavano: nonNegativeInteger(metrika.ocekavano),
    dostano: nonNegativeInteger(metrika.dostano),
  }));
  const chybi = [...(input.chybi ?? [])];
  if (metriky.length === 0) {
    // I chybný volající musí vyprodukovat čitelný kontrakt s explicitní dvojicí.
    metriky.push({
      nazev: 'kontrakt_kroku', jednotka: 'vystupy', ocekavano: 1, dostano: 0,
    });
    if (chybi.length === 0) {
      chybi.push('kontrakt neobsahuje žádnou metriku očekáváno vs. dostáno');
    }
  }
  for (const metrika of metriky) {
    const deficit = metrika.ocekavano - metrika.dostano;
    if (deficit > 0 && chybi.length === 0) {
      chybi.push(`${metrika.nazev}: chybí ${deficit} ${metrika.jednotka}`);
    }
  }
  const stav = urciStavUplnosti(metriky, chybi, input['selhalo']);
  return {
    krok: input.krok,
    stav,
    ocekavano: metriky.map(({ nazev, jednotka, ocekavano }) => ({ nazev, jednotka, pocet: ocekavano })),
    dostano: metriky.map(({ nazev, jednotka, dostano }) => ({ nazev, jednotka, pocet: dostano })),
    chybi,
    vedomeIgnorovano: [...(input.vedomeIgnorovano ?? [])],
    zprava: input.zprava ?? defaultMessage(input.krok, stav),
    naprava: input.naprava ?? (stav === 'uplne' ? '' : 'Doplňte chybějící vstupy a spusťte krok znovu.'),
    aktualizovano: input.aktualizovano ?? new Date().toISOString(),
  };
}

export function pocetUplnosti(
  krok: UplnostKroku | undefined,
  strana: 'ocekavano' | 'dostano',
  nazev: string,
): number | undefined {
  return krok?.[strana].find((hodnota) => hodnota.nazev === nazev)?.pocet;
}

function isUplnostKroku(value: unknown): value is UplnostKroku {
  if (!value || typeof value !== 'object') return false;
  const krok = value as Partial<UplnostKroku>;
  const validValue = (item: unknown): item is UplnostHodnota => {
    if (!item || typeof item !== 'object') return false;
    const entry = item as Partial<UplnostHodnota>;
    return typeof entry.nazev === 'string' && entry.nazev.length > 0
      && ['dokumenty', 'znaky', 'polozky', 'sablony', 'soubory', 'vystupy'].includes(String(entry.jednotka))
      && Number.isSafeInteger(entry.pocet) && Number(entry.pocet) >= 0;
  };
  if (!(typeof krok.krok === 'string' && UPLNOST_STEP_ORDER.includes(krok.krok as UplnostKrokNazev)
    && (krok.stav === 'uplne' || krok.stav === 'castecne' || krok.stav === 'selhalo')
    && Array.isArray(krok.ocekavano) && krok.ocekavano.every(validValue)
    && Array.isArray(krok.dostano) && krok.dostano.every(validValue)
    && Array.isArray(krok.chybi) && krok.chybi.every((item) => typeof item === 'string')
    && Array.isArray(krok.vedomeIgnorovano) && krok.vedomeIgnorovano.every((item) => typeof item === 'string')
    && typeof krok.zprava === 'string'
    && typeof krok.naprava === 'string'
    && typeof krok.aktualizovano === 'string')) return false;

  const expected = new Map(krok.ocekavano.map((item) => [`${item.nazev}\0${item.jednotka}`, item.pocet]));
  const actual = new Map(krok.dostano.map((item) => [`${item.nazev}\0${item.jednotka}`, item.pocet]));
  if (expected.size === 0 || expected.size !== krok.ocekavano.length || actual.size !== krok.dostano.length
    || expected.size !== actual.size || [...expected.keys()].some((key) => !actual.has(key))) return false;
  const derived = urciStavUplnosti([...expected].map(([key, ocekavano]) => {
    const [nazev, jednotka] = key.split('\0') as [string, UplnostHodnota['jednotka']];
    return { nazev, jednotka, ocekavano, dostano: actual.get(key)! };
  }), krok.chybi);
  // A partial result without an actionable missing list violates the public
  // contract even when the numeric deficit happens to be internally consistent.
  if (krok.stav === 'castecne' && krok.chybi.length === 0) return false;
  // `selhalo` může být vynucené i nad dílčím výstupem; zelená a částečná hodnota
  // však musí přesně odpovídat metrikám, jinak je soubor vnitřně rozporný.
  return krok.stav === 'selhalo' || krok.stav === derived;
}

function isUplnostZakazky(value: unknown): value is UplnostZakazky {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<UplnostZakazky>;
  if (report.verze !== 1 || typeof report.tenderId !== 'string'
    || report.tenderId.length === 0
    || typeof report.aktualizovano !== 'string' || !report.kroky || typeof report.kroky !== 'object'
    || Array.isArray(report.kroky) || Object.keys(report.kroky).length === 0) {
    return false;
  }
  return Object.entries(report.kroky).every(([name, krok]) =>
    UPLNOST_STEP_ORDER.includes(name as UplnostKrokNazev)
      && krok !== undefined && isUplnostKroku(krok) && krok.krok === name);
}

export async function nactiUplnostZakazky(outputDir: string): Promise<UplnostZakazky | null> {
  let raw: string;
  try {
    raw = await readFile(join(outputDir, UPLNOST_DIRECTORY, UPLNOST_FILENAME), 'utf-8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isUplnostZakazky(parsed) || parsed.tenderId !== basename(outputDir)) {
    throw new Error(`Soubor ${UPLNOST_FILENAME} má neplatný formát.`);
  }
  return parsed;
}

const reportWriteQueues = new Map<string, Promise<void>>();

/** Atomický read-modify-write krokového reportu vedle ostatních JSON výstupů zakázky. */
async function ulozUplnostKrokuLocked(
  outputDir: string,
  tenderId: string,
  krok: UplnostKroku,
): Promise<UplnostZakazky> {
  const stateDir = join(outputDir, UPLNOST_DIRECTORY);
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, UPLNOST_FILENAME);
  const lockPath = join(stateDir, '.uplnost.lock');
  const deadline = Date.now() + 10_000;
  let lock: Awaited<ReturnType<typeof open>>;
  for (;;) {
    try {
      lock = await open(lockPath, 'wx');
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 5_000) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`Kontrolu úplnosti nelze uzamknout: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const existing = await nactiUplnostZakazky(outputDir);
    if (existing && existing.tenderId !== tenderId) {
      throw new Error(`Soubor ${UPLNOST_FILENAME} patří jiné zakázce (${existing.tenderId}).`);
    }
    const currentIndex = UPLNOST_STEP_ORDER.indexOf(krok.krok);
    const retainedSteps = Object.fromEntries(Object.entries(existing?.kroky ?? {})
      .filter(([name]) => UPLNOST_STEP_ORDER.indexOf(name as UplnostKrokNazev) <= currentIndex));
    const report: UplnostZakazky = {
      verze: 1,
      tenderId,
      aktualizovano: krok.aktualizovano,
      // Nový výsledek dřívějšího kroku zneplatní všechny jeho starší downstream stavy.
      kroky: { ...retainedSteps, [krok.krok]: krok },
    };
    await writeFile(tempPath, JSON.stringify(report, null, 2), 'utf-8');
    await rename(tempPath, path);
    return report;
  } finally {
    await unlink(tempPath).catch(() => {});
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * Zachová pořadí souběžných zápisů v jednom procesu; lockfile uvnitř implementace
 * totéž vynutí mezi child procesem a API serverem.
 */
export function ulozUplnostKroku(
  outputDir: string,
  tenderId: string,
  krok: UplnostKroku,
): Promise<UplnostZakazky> {
  const key = join(outputDir, UPLNOST_DIRECTORY, UPLNOST_FILENAME);
  const previous = reportWriteQueues.get(key) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(() => ulozUplnostKrokuLocked(outputDir, tenderId, krok));
  const tail = operation.then(() => {}, () => {});
  reportWriteQueues.set(key, tail);
  void tail.finally(() => {
    if (reportWriteQueues.get(key) === tail) reportWriteQueues.delete(key);
  });
  return operation;
}

export function analyzeMinimumCharacters(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ANALYZE_MIN_TEXT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_ANALYZE_MIN_TEXT_CHARACTERS;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ANALYZE_MIN_TEXT_CHARACTERS;
}

export function analyzovatelnyPocetZnaku(
  documents: ReadonlyArray<{
    text?: string;
    type?: string;
    isTemplate?: boolean;
    isSoupis?: boolean;
  }>,
): number {
  return documents
    // Excelové soupisy zpracovává deterministický parser. PDF/DOC(X) soupis je
    // naopak součástí AI vstupu, a proto se jeho skutečný text do prahu počítá.
    .filter((document) => !document.isTemplate
      && !(document.isSoupis && (document.type === 'xls' || document.type === 'xlsx')))
    // Parser Excelu přidává jednu technickou hlavičku pro každý list. Samotné
    // názvy prázdných listů nesmějí z prázdného sešitu vyrobit dostatečný vstup.
    .map((document) => {
      const withoutSheetHeaders = (document.text ?? '').replace(/^=== List: .* ===\s*$/gm, '');
      const meaningfulText = document.type === 'xls' || document.type === 'xlsx'
        ? withoutSheetHeaders.replace(/\|/g, '')
        : withoutSheetHeaders;
      return meaningfulText.replace(/\s+/g, ' ').trim().length;
    })
    .reduce((sum, length) => sum + length, 0);
}

function canonicalAttachmentName(name: string): string {
  let candidate = name.trim();
  const urlPreflightPrefix = 'stahování URL nebylo dokončeno: ';
  if (candidate.startsWith(urlPreflightPrefix)) candidate = candidate.slice(urlPreflightPrefix.length);
  const errorSuffix = candidate.indexOf(': ', candidate.indexOf('://') + 3);
  if (errorSuffix > 0) candidate = candidate.slice(0, errorSuffix);
  try {
    if (/^https?:\/\//i.test(candidate)) {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    }
  } catch {
    // Neplatná URL zůstane prostým zobrazovaným názvem.
  }
  const leaf = candidate.split(/[\\/]/).pop()?.trim() || candidate;
  return leaf
    .replace(/\s+\([^)]*\)\s*$/, '')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Identita chybějícího zdroje pro odstranění opakovaných hlášek mezi retry pokusy.
 * U URL zachováváme host, cestu i query: dvě opaque URL `/download?id=1` a `?id=2`
 * mohou být dva různé dokumenty, přestože jejich zobrazovaný basename je stejný.
 */
function missingAttachmentIdentity(name: string): string {
  let candidate = name.trim();
  const urlPreflightPrefix = 'stahování URL nebylo dokončeno: ';
  if (candidate.startsWith(urlPreflightPrefix)) candidate = candidate.slice(urlPreflightPrefix.length);
  const errorSuffix = candidate.indexOf(': ', candidate.indexOf('://') + 3);
  if (errorSuffix > 0) candidate = candidate.slice(0, errorSuffix);
  try {
    if (/^https?:\/\//i.test(candidate)) {
      const url = new URL(candidate);
      return `url:${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
    }
  } catch {
    // Neplatná URL se deduplikuje stejně jako běžný zobrazovaný název.
  }
  return `name:${canonicalAttachmentName(candidate) || candidate.toLowerCase()}`;
}

function uniqueMissingAttachments(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const uniqueFromEnd = [...items].reverse().filter((item) => {
    const identity = missingAttachmentIdentity(item);
    // Stejně pojmenované dokumenty tvoří multiset (např. dvě části mohou mít
    // `smlouva.pdf`). Deduplikujeme jen opakovanou diagnostiku téže přesné URL.
    if (!identity.startsWith('url:')) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  // Novější retry hláška má obvykle konkrétnější důvod než fail-closed preflight.
  return uniqueFromEnd.reverse();
}

/** Ruční upload smí podle názvu uzdravit URL, jen když URL sama nesla skutečný filename. */
function urlMissingHasFilename(name: string): boolean {
  let candidate = name.trim();
  const prefix = 'stahování URL nebylo dokončeno: ';
  if (candidate.startsWith(prefix)) candidate = candidate.slice(prefix.length);
  const errorSuffix = candidate.indexOf(': ', candidate.indexOf('://') + 3);
  if (errorSuffix > 0) candidate = candidate.slice(0, errorSuffix);
  try {
    const leaf = decodeURIComponent(new URL(candidate).pathname).split('/').pop() ?? '';
    return /\.[a-z0-9]{1,10}$/i.test(leaf);
  } catch {
    return false;
  }
}

export interface SloucenyIngestInput {
  /** Fyzické podporované zdrojové přílohy, které jsou právě v input adresáři. */
  skutecneDokumenty: readonly string[];
  /** Očekávání právě zpracovávané dávky; nikdy nesníží starší očekávání. */
  ocekavanoVDavce: number;
  predchozi?: UplnostKroku;
  /** Dolní mez pro fail-closed preflight nebo URL dávku přidávanou ke stávající sadě. */
  minimalniOcekavano?: number;
  noveVyreseno?: readonly string[];
  noveChybi?: readonly string[];
  noveIgnorovano?: readonly string[];
  probiha?: boolean;
}

/**
 * Dolní mez očekávání po multipart dávce. Jeden upload smí nahradit jeden fyzicky
 * existující soubor stejného jména; každá další položka dávky je nový záměr, i když
 * ji disk storage kvůli kolizi jména přepsal.
 */
export function ocekavanyPocetPoMultipartDavce(
  existujiciNazvy: readonly string[],
  nazvyDavky: readonly string[],
): number {
  const nahraditelne = new Set(existujiciNazvy.map((name) => name.toLocaleLowerCase('cs-CZ')));
  let noveZamery = 0;
  for (const name of nazvyDavky) {
    const key = name.toLocaleLowerCase('cs-CZ');
    if (!nahraditelne.delete(key)) noveZamery += 1;
  }
  return existujiciNazvy.length + noveZamery;
}

/**
 * Sloučí doplňovací ingest se starším kontraktem. Klíčová vlastnost: očekávání
 * 10/18 se po ručním nahrání jednoho souboru nesmí přepsat na zelených 1/1.
 */
export function vytvorSloucenouUplnostIngestu(input: SloucenyIngestInput): UplnostKroku {
  const actualNames = [...input.skutecneDokumenty];
  const actualCount = actualNames.length;
  const previousExpected = pocetUplnosti(input.predchozi, 'ocekavano', 'dokumenty') ?? 0;
  const expectedCount = Math.max(
    previousExpected,
    nonNegativeInteger(input.ocekavanoVDavce),
    nonNegativeInteger(input.minimalniOcekavano ?? 0),
    actualCount,
  );

  const resolved = [...(input.noveVyreseno ?? [])].map((name) => ({
    identity: missingAttachmentIdentity(name),
    canonical: canonicalAttachmentName(name),
  }));
  const previousMissing = uniqueMissingAttachments(input.predchozi?.chybi ?? []).filter((missing) => {
    const key = missingAttachmentIdentity(missing);
    let index = resolved.findIndex((item) => item.identity === key);
    if (index < 0 && key.startsWith('url:') && urlMissingHasFilename(missing)) {
      const canonical = canonicalAttachmentName(missing);
      index = resolved.findIndex((item) => item.identity.startsWith('name:') && item.canonical === canonical);
    }
    if (index < 0) return true;
    resolved.splice(index, 1);
    return false;
  });
  let missing = uniqueMissingAttachments([...previousMissing, ...(input.noveChybi ?? [])]);
  if (!input.probiha && actualCount >= expectedCount && (input.noveChybi?.length ?? 0) === 0) {
    // Čistě početní deficit lze uzavřít počtem. Konkrétně pojmenovaný chybějící
    // dokument ale smí zmizet jen po skutečném spárování v `noveVyreseno`.
    missing = missing.filter((item) => !/^chybí \d+ dokumentů ze zdrojové sady$/i.test(item));
  }
  if (actualCount < expectedCount && missing.length === 0) {
    missing.push(`chybí ${expectedCount - actualCount} dokumentů ze zdrojové sady`);
  }
  if (expectedCount === 0 && missing.length === 0) {
    missing.push('alespoň jeden podporovaný dokument zadávací dokumentace');
  }
  const ignored = [...new Set([
    ...(input.predchozi?.vedomeIgnorovano ?? []),
    ...(input.noveIgnorovano ?? []),
  ])];

  return vytvorUplnostKroku({
    krok: 'ingest',
    metriky: [{
      nazev: 'dokumenty',
      jednotka: 'dokumenty',
      ocekavano: expectedCount,
      dostano: actualCount,
    }],
    chybi: missing,
    vedomeIgnorovano: ignored,
    selhalo: Boolean(input.probiha) || expectedCount === 0 || actualCount === 0,
    zprava: input.probiha
      ? `Stahování ${expectedCount} očekávaných dokumentů nebylo dokončeno.`
      : expectedCount === 0
        ? 'Nebyl nalezen žádný podporovaný dokument zadávací dokumentace.'
        : actualCount < expectedCount || missing.length > 0
          ? `Příjem zadávací dokumentace je neúplný: získáno ${actualCount} z ${expectedCount} očekávaných dokumentů.`
          : undefined,
    naprava: !input.probiha && actualCount >= expectedCount && missing.length === 0
      ? ''
      : 'Doplňte uvedené dokumenty ručně nebo opakujte stažení před spuštěním pipeline.',
  });
}

/**
 * Jednotná konstrukce preflight i finální kontroly analýzy. Díky explicitnímu
 * `analysisVznikla` nemůže dostatečně dlouhý vstup sám o sobě vypadat jako hotová analýza.
 */
export function vytvorUplnostAnalyzy(
  meaningfulCharacters: number,
  minimumCharacters: number,
  analysisVznikla: boolean,
  soupisy: {
    ocekavano: number;
    zpracovano: number;
    chybi?: readonly string[];
  } = { ocekavano: 0, zpracovano: 0 },
): UplnostKroku {
  const inputIncomplete = meaningfulCharacters < minimumCharacters;
  const chybi: string[] = inputIncomplete
    ? [`text zadávací dokumentace: chybí alespoň ${minimumCharacters - meaningfulCharacters} znaků`]
    : analysisVznikla ? [] : ['analysis.json (výstup analýzy dosud nevznikl)'];
  if (soupisy.zpracovano < soupisy.ocekavano) {
    const missingSoupisy = [...(soupisy.chybi ?? [])];
    chybi.push(...(missingSoupisy.length > 0
      ? missingSoupisy
      : [`soupisy položek: chybí ${soupisy.ocekavano - soupisy.zpracovano}`]));
  }
  const metriky: UplnostMetrika[] = [
    {
      nazev: 'analyzovatelny_text',
      jednotka: 'znaky',
      ocekavano: minimumCharacters,
      dostano: meaningfulCharacters,
    },
    {
      nazev: 'analysis_json',
      jednotka: 'vystupy',
      ocekavano: 1,
      dostano: analysisVznikla ? 1 : 0,
    },
  ];
  if (soupisy.ocekavano > 0) {
    metriky.push({
      nazev: 'soupisy_polozek',
      jednotka: 'dokumenty',
      ocekavano: soupisy.ocekavano,
      dostano: soupisy.zpracovano,
    });
  }
  return vytvorUplnostKroku({
    krok: 'analyze',
    metriky,
    chybi,
    selhalo: meaningfulCharacters === 0,
    zprava: inputIncomplete
      ? `Analýzu nelze spustit: použitelný text má ${meaningfulCharacters} znaků, bezpečné minimum je ${minimumCharacters}.`
      : analysisVznikla
        ? soupisy.zpracovano < soupisy.ocekavano
          ? `Analýza nezpracovala ${soupisy.ocekavano - soupisy.zpracovano} očekávaných soupisů položek.`
          : undefined
        : 'Analýza vstupu probíhá; očekávaný výstup analysis.json zatím nevznikl.',
    naprava: inputIncomplete
      ? 'Zkontrolujte stažení a čitelnost zadávací dokumentace (včetně OCR) a spusťte extrakci i analýzu znovu.'
      : analysisVznikla && soupisy.zpracovano >= soupisy.ocekavano
        ? ''
        : 'Zkontrolujte čitelnost soupisů a spusťte analýzu znovu.',
  });
}

export class UplnostError extends Error {
  constructor(public readonly kontrola: UplnostKroku) {
    super(zpravaUplnostiProUzivatele(kontrola));
    this.name = 'UplnostError';
  }
}

export function zpravaUplnostiProUzivatele(kontrola: UplnostKroku): string {
  return [
    kontrola.zprava,
    kontrola.chybi.length > 0 ? `Chybí: ${kontrola.chybi.join(', ')}.` : '',
    kontrola.naprava,
  ].filter(Boolean).join(' ');
}

export function stavPoKontroleUplnosti(
  dosavadni: 'done' | 'error',
  kontrola: UplnostKroku,
): 'done' | 'error' {
  return dosavadni === 'done' && kontrola.stav === 'uplne' ? 'done' : 'error';
}

export function stavKrokuProKlienta(dosavadni: string, kontrola?: UplnostKroku): string {
  return kontrola && kontrola.stav !== 'uplne' ? 'error' : dosavadni;
}

/**
 * Promítne kontrakt do artefaktového API stavu. Jakmile existuje novější upstream
 * report, chybějící (zneplatněný) downstream report už nesmí fallbacknout na starý soubor.
 */
export function aplikujUplnostNaStavy<T extends Record<string, string>>(
  dosavadni: T,
  report: UplnostZakazky | null,
): T {
  if (!report) return { ...dosavadni };
  const recordedIndexes = Object.keys(report.kroky)
    .map((step) => UPLNOST_STEP_ORDER.indexOf(step as UplnostKrokNazev))
    .filter((index) => index >= 0);
  const firstIndex = recordedIndexes.length > 0 ? Math.min(...recordedIndexes) : -1;
  const latestIndex = recordedIndexes.length > 0 ? Math.max(...recordedIndexes) : -1;
  const firstGapIndex = firstIndex >= 0
    ? UPLNOST_STEP_ORDER.findIndex((step, index) =>
      index >= firstIndex && index <= latestIndex && !report.kroky[step])
    : -1;
  const incompleteIndexes = Object.entries(report.kroky)
    .filter(([, kontrola]) => kontrola?.stav !== 'uplne')
    .map(([step]) => UPLNOST_STEP_ORDER.indexOf(step as UplnostKrokNazev))
    .filter((index) => index >= 0);
  const firstIncompleteIndex = incompleteIndexes.length > 0
    ? Math.min(...incompleteIndexes)
    : Number.POSITIVE_INFINITY;
  const result = { ...dosavadni };
  for (const step of Object.keys(result)) {
    const stepIndex = UPLNOST_STEP_ORDER.indexOf(step as UplnostKrokNazev);
    if (stepIndex < 0) continue;
    const kontrola = report.kroky[step as UplnostKrokNazev];
    if ((kontrola && kontrola.stav !== 'uplne')
      // Později ručně spuštěný krok nesmí přikrýt starší explicitně neúplný upstream.
      || (stepIndex > firstIncompleteIndex && result[step as keyof T] === 'done')
      // Ani díra v kontraktu mezi prvním a posledním reportem není doklad úplnosti.
      // Typicky vznikne, když se po změně částí přeskočí match/verify a spustí generate.
      || (firstGapIndex >= 0 && stepIndex >= firstGapIndex && result[step as keyof T] === 'done')
      || (stepIndex > latestIndex && result[step as keyof T] === 'done')) {
      result[step as keyof T] = 'error' as T[keyof T];
    }
  }
  return result;
}

export function formatUplnostError(error: UplnostError): string {
  return `${UPLNOST_ERROR_MARKER}${JSON.stringify({
    krok: error.kontrola.krok,
    stav: error.kontrola.stav,
    chybi: error.kontrola.chybi,
    zprava: error.kontrola.zprava,
    naprava: error.kontrola.naprava,
  })}`;
}

/** Z logu vytáhne jen strukturovanou, uživatelskou větu; nikdy ocas stack trace. */
export function zpravaUplnostiZLogu(logs: readonly string[]): string | null {
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const markerIndex = logs[index].indexOf(UPLNOST_ERROR_MARKER);
    if (markerIndex < 0) continue;
    try {
      const parsed = JSON.parse(logs[index].slice(markerIndex + UPLNOST_ERROR_MARKER.length)) as {
        zprava?: unknown; naprava?: unknown; chybi?: unknown;
      };
      const zprava = typeof parsed.zprava === 'string' ? parsed.zprava : '';
      const naprava = typeof parsed.naprava === 'string' ? parsed.naprava : '';
      const chybi = Array.isArray(parsed.chybi)
        ? parsed.chybi.filter((item): item is string => typeof item === 'string')
        : [];
      const result = [zprava, chybi.length > 0 ? `Chybí: ${chybi.join(', ')}.` : '', naprava]
        .filter(Boolean).join(' ');
      if (result) return result;
    } catch {
      // Poškozený marker nesmí skrýt běžnou procesní chybu; volající použije fallback.
    }
  }
  return null;
}

/**
 * Node stream negarantuje hranice řádků ani UTF-8 znaků. Sběrač drží nedokončený
 * řádek mezi chunky, aby se dlouhý JSON marker úplnosti nikdy nerozpadl.
 */
export class RadkovySberacLogu {
  private readonly decoder = new StringDecoder('utf8');
  private remainder = '';
  private ended = false;

  pridej(chunk: Buffer): string[] {
    if (this.ended) return [];
    const parts = `${this.remainder}${this.decoder.write(chunk)}`.split(/\r?\n/);
    this.remainder = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  dokoncit(): string[] {
    if (this.ended) return [];
    this.ended = true;
    const tail = `${this.remainder}${this.decoder.end()}`;
    this.remainder = '';
    return tail.length > 0 ? [tail] : [];
  }
}

async function jsonFile(outputDir: string, filename: string): Promise<any> {
  return JSON.parse(await readFile(join(outputDir, filename), 'utf-8'));
}

async function exists(outputDir: string, filename: string): Promise<boolean> {
  try {
    const file = await stat(join(outputDir, filename));
    return file.isFile() && file.size > 0;
  } catch {
    return false;
  }
}

async function existsSince(
  outputDir: string,
  filename: string,
  notBefore?: string,
): Promise<boolean> {
  try {
    const file = await stat(join(outputDir, filename));
    if (!file.isFile() || file.size <= 0) return false;
    if (!notBefore) return true;
    const threshold = Date.parse(notBefore);
    return Number.isFinite(threshold) && file.mtimeMs >= threshold;
  } catch {
    return false;
  }
}

function sanitizeGeneratedStem(name: string): string {
  // Musí zůstat shodné se sanitizeFilename() v generate-bid.ts. Generátor zde
  // nelze měnit, kontrakt ale musí umět předem určit jeho očekávaný výstup.
  return name
    .replace(/\.[^.]+$/, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

interface ExpectedSoupisOutput {
  sourceName: string;
  outputName: string;
  mappingName: string;
  expectedItems: Array<{
    name: string;
    priceBezDph: number | null;
  }>;
  supported: boolean;
}

async function optionalJsonFile(outputDir: string, filename: string): Promise<any | null> {
  try {
    return await jsonFile(outputDir, filename);
  } catch {
    return null;
  }
}

async function optionalJsonFileStrict(outputDir: string, filename: string): Promise<any | null> {
  try {
    return await jsonFile(outputDir, filename);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** Null = zakázka nemá více částí; chybějící selection u multi = všechny části. */
function selectedPartsForCompleteness(
  analysis: any,
  rawSelection: unknown,
  source: string,
): Set<string> | null {
  const rawParts: any[] = Array.isArray(analysis?.casti) ? analysis.casti : [];
  const allPartIds = rawParts.map((part: any) => part?.id);
  if (allPartIds.some((id: unknown) => typeof id !== 'string' || id.length === 0)
    || new Set(allPartIds).size !== allPartIds.length) {
    throw new Error('analysis.json neobsahuje unikátní neprázdná ID částí.');
  }
  const knownPartIds = new Set(allPartIds as string[]);
  const orphanItem = (Array.isArray(analysis?.polozky) ? analysis.polozky : [])
    .find((item: any) => typeof item?.cast_id === 'string'
      && item.cast_id.length > 0
      && !knownPartIds.has(item.cast_id));
  if (orphanItem) {
    throw new Error(`analysis.json obsahuje položku s neznámým cast_id ${orphanItem.cast_id}.`);
  }
  if (allPartIds.length <= 1) return null;
  if (rawSelection === null || rawSelection === undefined) return new Set(allPartIds);
  if (!Array.isArray(rawSelection)
    || rawSelection.length === 0
    || !rawSelection.every((id): id is string => typeof id === 'string' && id.length > 0)
    || new Set(rawSelection).size !== rawSelection.length
    || rawSelection.some((id: string) => !allPartIds.includes(id))) {
    throw new Error(`${source} neobsahuje neprázdný unikátní výběr existujících částí.`);
  }
  return new Set(rawSelection);
}

/** Odvodí závazné Excelové soupisy stejné vybrané části jako generate-bid. */
async function expectedSoupisOutputs(
  outputDir: string,
  tenderId: string,
  requireAnalysisIdentity: boolean,
): Promise<ExpectedSoupisOutput[]> {
  const extracted = await jsonFile(outputDir, 'extracted-text.json');
  if (extracted?.tenderId !== tenderId) {
    throw new Error(`extracted-text.json nepatří zakázce ${tenderId}.`);
  }
  let soupises: any[] = Array.isArray(extracted?.documents)
    ? extracted.documents.filter((document: any) => document?.isSoupis)
    : [];

  const analysis = await optionalJsonFile(outputDir, 'analysis.json');
  if (analysis && analysis?.tenderId !== undefined && analysis.tenderId !== tenderId) {
    throw new Error(`analysis.json nepatří zakázce ${tenderId}.`);
  }
  if (analysis && requireAnalysisIdentity && analysis?.tenderId !== tenderId) {
    throw new Error(`analysis.json nemá identitu aktuální zakázky ${tenderId}.`);
  }
  let selectedParts: Set<string> | null = null;
  if (Array.isArray(analysis?.casti) && analysis.casti.length > 0) {
    const knownPartIds = new Set(analysis.casti.map((part: any) => part?.id)
      .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0));
    const unknownSoupis = soupises.find((document: any) => {
      const partId = extractCastIdFromFilename(String(document?.filename ?? ''));
      return partId && !knownPartIds.has(partId);
    });
    if (unknownSoupis) {
      throw new Error(`${String(unknownSoupis.filename)} odkazuje na neznámou část zakázky.`);
    }
  }
  if (Array.isArray(analysis?.casti) && analysis.casti.length > 1) {
    const partsSelection = await optionalJsonFileStrict(outputDir, 'parts-selection.json');
    const selected = selectedPartsForCompleteness(
      analysis,
      partsSelection?.selected_parts,
      'parts-selection.json',
    )!;
    selectedParts = selected;
    const selectedUpper = new Set([...selected].map((id) => id.toUpperCase()));
    soupises = soupises.filter((document: any) => {
      const partId = extractCastIdFromFilename(String(document?.filename ?? ''));
      return !partId || selectedUpper.has(partId.toUpperCase());
    });
  }

  const productMatchRaw = await optionalJsonFileStrict(outputDir, 'product-match.json');
  if (productMatchRaw && productMatchRaw?.tenderId !== tenderId) {
    throw new Error(`product-match.json nepatří zakázce ${tenderId}.`);
  }
  const productMatch = productMatchRaw ? ProductMatchSchema.parse(productMatchRaw) : null;
  let matchedItems: any[] = Array.isArray(productMatch?.polozky_match)
    ? productMatch.polozky_match
    : (Array.isArray(productMatch?.kandidati) ? [productMatch] : []);
  const hasSelectionSnapshot = productMatch !== null
    && Object.prototype.hasOwnProperty.call(productMatch, 'selected_parts_snapshot');
  if (!hasSelectionSnapshot && selectedParts && Array.isArray(productMatch?.polozky_match)) {
    matchedItems = matchedItems.filter((item: any) =>
      !item?.cast_id || selectedParts!.has(item.cast_id));
  }
  const allMatchedItemsAreLegacyWithoutPart = matchedItems.length > 0
    && matchedItems.every((item: any) => typeof item?.cast_id !== 'string' || item.cast_id.length === 0);

  return soupises.map((document: any) => {
    const sourceName = String(document?.filename ?? 'neznámý soupis');
    const stem = sanitizeGeneratedStem(sourceName);
    const partId = extractCastIdFromFilename(sourceName);
    const partItems = partId
      ? matchedItems.filter((item: any) => item?.cast_id === partId)
      : matchedItems;
    // Legacy fallback je bezpečný jen tehdy, když cast_id chybí úplně všem položkám.
    // Explicitní cizí cast_id nesmí vyplnit soupis jiné části celým seznamem.
    const expectedItems = partId && partItems.length === 0 && allMatchedItemsAreLegacyWithoutPart
      ? matchedItems
      : partItems;
    return {
      sourceName,
      outputName: `soupis_filled_${stem}.xlsx`,
      mappingName: `soupis_mapping_${stem}.json`,
      expectedItems: expectedItems.map((item: any, index: number) => {
        const candidates = Array.isArray(item?.kandidati) ? item.kandidati : [];
        const selectedIndex = Number.isSafeInteger(item?.vybrany_index)
          ? item.vybrany_index
          : -1;
        const rawPrice = item?.cenova_uprava?.nabidkova_cena_bez_dph
          ?? candidates[selectedIndex]?.cena_bez_dph;
        return {
          name: String(item?.polozka_nazev ?? item?.nazev ?? `položka ${index + 1}`),
          priceBezDph: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null,
        };
      }),
      supported: document?.type === 'xls' || document?.type === 'xlsx',
    };
  });
}

async function validSoupisMapping(
  outputDir: string,
  filename: string,
  expectedItems: ReadonlyArray<{ name: string; priceBezDph: number | null }>,
  notBefore?: string,
): Promise<boolean> {
  if (!await existsSince(outputDir, filename, notBefore)) return false;
  const mapping = await optionalJsonFileStrict(outputDir, filename);
  if (!mapping || !Number.isSafeInteger(mapping.totalRows) || mapping.totalRows <= 0
    || mapping.filledRows !== mapping.totalRows || mapping.skippedRows !== 0
    || !Array.isArray(mapping.mappings) || mapping.mappings.length !== mapping.totalRows
    || expectedItems.length === 0
    || expectedItems.some((item) => item.priceBezDph === null)) {
    return false;
  }
  if (!mapping.mappings.every((entry: any) =>
    typeof entry?.matchedItem === 'string' && entry.matchedItem.trim().length > 0
      && Number.isFinite(entry?.priceBezDph) && entry.priceBezDph > 0)) return false;
  const mappedItems = mapping.mappings.map((entry: any) => ({
    name: entry.matchedItem.trim(),
    priceBezDph: entry.priceBezDph,
  }));
  for (const expected of expectedItems) {
    const index = mappedItems.findIndex((item: { name: string; priceBezDph: number }) =>
      item.name === expected.name && item.priceBezDph === expected.priceBezDph);
    if (index < 0) return false;
    mappedItems.splice(index, 1);
  }
  // Každý řádek musí odpovídat právě jedné naceněné položce včetně její ceny.
  // Jinak by dvě stejnojmenné položky s cenami 100/200 mohly být obě falešně
  // pokryté opakovaným mapováním první položky za 100.
  return mappedItems.length === 0;
}

async function soupiseCoverage(
  outputDir: string,
  tenderId: string,
  notBefore?: string,
  requireAnalysisIdentity = false,
): Promise<{ expected: number; actual: number; missing: string[] }> {
  const requirements = await expectedSoupisOutputs(outputDir, tenderId, requireAnalysisIdentity);
  // Multiset: dvě vstupní cesty, které sanitizer slije na stejný output, nesmí
  // jediným fyzickým souborem vytvořit falešné 2/2.
  const consumedOutputs = new Set<string>();
  const consumedMappings = new Set<string>();
  const missing: string[] = [];
  let actual = 0;
  for (const requirement of requirements) {
    if (!requirement.supported) {
      missing.push(`${requirement.sourceName}: nepodporovaný formát cenového soupisu (očekává se XLS/XLSX)`);
      continue;
    }
    const outputReady = !consumedOutputs.has(requirement.outputName)
      && await existsSince(outputDir, requirement.outputName, notBefore);
    const mappingReady = !consumedMappings.has(requirement.mappingName)
      && await validSoupisMapping(
        outputDir,
        requirement.mappingName,
        requirement.expectedItems,
        notBefore,
      );
    if (outputReady && mappingReady) {
      consumedOutputs.add(requirement.outputName);
      consumedMappings.add(requirement.mappingName);
      actual += 1;
    } else {
      missing.push(`${requirement.outputName} + úplná cenová mapa ${requirement.mappingName}`);
    }
  }
  return { expected: requirements.length, actual, missing };
}

function itemNames(items: any[]): string[] {
  return items.map((item, index) => String(item?.polozka_nazev ?? item?.nazev ?? `položka ${index + 1}`));
}

function hasSubstantiveMatchCandidates(value: unknown): value is any[] {
  return Array.isArray(value) && value.length > 0 && value.every((candidate: any) =>
    candidate && typeof candidate === 'object'
      && (candidate.zadna_shoda === true
        || (typeof candidate.vyrobce === 'string' && candidate.vyrobce.trim().length > 0
          && typeof candidate.model === 'string' && candidate.model.trim().length > 0)));
}

/**
 * Samotná pozice v poli není výsledkem matchingu. Vyžadujeme explicitní stabilní
 * index, název, neprázdnou sadu věcných kandidátů a platný vybraný kandidát.
 */
function isSubstantiveMatchedItem(item: any): boolean {
  return item && typeof item === 'object'
    && Number.isSafeInteger(item.polozka_index) && item.polozka_index >= 0
    && typeof item.polozka_nazev === 'string' && item.polozka_nazev.trim().length > 0
    && hasSubstantiveMatchCandidates(item.kandidati)
    && Number.isSafeInteger(item.vybrany_index) && item.vybrany_index >= 0
    && item.vybrany_index < item.kandidati.length
    && typeof item.oduvodneni_vyberu === 'string' && item.oduvodneni_vyberu.trim().length > 0;
}

interface MatchCoverage {
  expected: number;
  actual: number;
  missing: string[];
  relevantItems: any[];
}

function assertAnalysisIdentity(
  analysis: any,
  tenderId: string,
  requireIdentity: boolean,
): void {
  if (analysis?.tenderId !== undefined && analysis.tenderId !== tenderId) {
    throw new Error(`analysis.json nepatří zakázce ${tenderId}.`);
  }
  // Staré analysis.json identitu neobsahovaly. Připustíme je jen bez nového
  // analyze kontraktu; nový producent už tenderId zapisuje vždy.
  if (requireIdentity && analysis?.tenderId !== tenderId) {
    throw new Error(`analysis.json nemá identitu aktuální zakázky ${tenderId}.`);
  }
}

function calculateMatchCoverage(
  analysis: any,
  match: any,
  minimumExpected = 0,
  authoritativeSelection?: unknown,
): MatchCoverage {
  const allAnalysisItems: any[] = Array.isArray(analysis?.polozky) ? analysis.polozky : [];
  const selectedParts = selectedPartsForCompleteness(
    analysis,
    authoritativeSelection,
    'parts-selection.json.selected_parts',
  );
  const hasSelectionSnapshot = match !== null && typeof match === 'object'
    && Object.prototype.hasOwnProperty.call(match, 'selected_parts_snapshot');
  const snapshotParts = hasSelectionSnapshot
    ? selectedPartsForCompleteness(
      analysis,
      match?.selected_parts_snapshot,
      'product-match.json.selected_parts_snapshot',
    )
    : null;
  if (hasSelectionSnapshot && selectedParts && snapshotParts
    && (selectedParts.size !== snapshotParts.size
      || [...selectedParts].some((id) => !snapshotParts.has(id)))) {
    throw new Error('product-match.json.selected_parts_snapshot neodpovídá aktuálnímu výběru částí.');
  }
  let expectedEntries = allAnalysisItems
    .map((item, originalIndex) => ({ item, originalIndex }))
    .filter(({ item }) => !selectedParts || !item?.cast_id || selectedParts.has(item.cast_id));
  const declaredPartItemCount = (Array.isArray(analysis?.casti) ? analysis.casti : [])
    .filter((part: any) => !selectedParts || selectedParts.has(part?.id))
    .reduce((sum: number, part: any) => sum + (
      Number.isSafeInteger(part?.pocet_polozek) && part.pocet_polozek > 0
        ? part.pocet_polozek
        : 0
    ), 0);
  // Producent matchingu má pro zakázku bez explicitních položek podporovaný
  // fallback: jednu syntetickou položku z předmětu zakázky (match-product.ts).
  // Kontrakt musí měřit stejný základ, jinak platný výsledek označí false-red.
  if (expectedEntries.length === 0 && declaredPartItemCount === 0
    && typeof analysis?.zakazka?.predmet === 'string' && analysis.zakazka.predmet.trim()) {
    expectedEntries = [{ item: { nazev: analysis.zakazka.predmet.trim() }, originalIndex: 0 }];
  }
  if (expectedEntries.length === 0 && declaredPartItemCount === 0) {
    throw new Error('Analýza pro vybrané části neobsahuje žádnou položku k matchingu.');
  }
  let actualItems: any[] = Array.isArray(match?.polozky_match)
    ? match.polozky_match
    : (Array.isArray(match?.kandidati) ? [match] : []);
  // Starý match bez snapshotu je oficiálně podporovaný. Jeho položky mohly
  // vzniknout pro všechny části; generate-bid z nich používá jen dnešní výběr.
  // Stejně proto filtrujeme pouze tento legacy formát, zatímco modernímu
  // snapshotu žádné neočekávané položky neodpouštíme.
  if (!hasSelectionSnapshot && selectedParts && Array.isArray(match?.polozky_match)) {
    actualItems = actualItems.filter((item) => !item?.cast_id || selectedParts.has(item.cast_id));
  }
  const expectedByIndex = new Map(expectedEntries.map(({ item, originalIndex }) => [originalIndex, item]));
  const actualIndexes = new Set<number>();
  const coverageIssues: string[] = [];
  if (Array.isArray(match?.polozky_match)) {
    for (const item of actualItems) {
      const itemLabel = String(item?.polozka_nazev ?? 'neznámá položka');
      if (!isSubstantiveMatchedItem(item)) {
        coverageIssues.push(`${itemLabel}: neúplný záznam matchingu`);
        continue;
      }
      const expectedItem = expectedByIndex.get(item.polozka_index);
      if (!expectedItem) {
        coverageIssues.push(`${itemLabel}: neočekávaný index ${item.polozka_index}`);
        continue;
      }
      const expectedName = typeof expectedItem?.nazev === 'string' ? expectedItem.nazev.trim() : '';
      if (expectedName && item.polozka_nazev.trim() !== expectedName) {
        coverageIssues.push(`${itemLabel}: název neodpovídá indexu ${item.polozka_index}`);
        continue;
      }
      if (typeof expectedItem?.cast_id === 'string' && expectedItem.cast_id.length > 0
        && item.cast_id !== expectedItem.cast_id) {
        coverageIssues.push(`${itemLabel}: neodpovídá část ${expectedItem.cast_id}`);
        continue;
      }
      if (actualIndexes.has(item.polozka_index)) {
        coverageIssues.push(`${itemLabel}: duplicitní index ${item.polozka_index}`);
        continue;
      }
      actualIndexes.add(item.polozka_index);
    }
  } else if (hasSubstantiveMatchCandidates(match?.kandidati)
      && Number.isSafeInteger(match?.vybrany_index)
      && match.vybrany_index >= 0
      && match.vybrany_index < match.kandidati.length
      && typeof match?.oduvodneni_vyberu === 'string'
      && match.oduvodneni_vyberu.trim().length > 0
      && expectedEntries.length === 1) {
    actualIndexes.add(expectedEntries[0].originalIndex);
  }
  const missing = expectedEntries
    .filter(({ originalIndex }) => !actualIndexes.has(originalIndex))
    .map(({ item, originalIndex }) => String(item?.nazev ?? `položka ${originalIndex + 1}`));
  missing.push(...coverageIssues);
  const expectedLowerBound = Math.max(minimumExpected, declaredPartItemCount);
  const expected = Math.max(expectedEntries.length, expectedLowerBound);
  if (expectedLowerBound > expectedEntries.length) {
    const source = declaredPartItemCount >= minimumExpected
      ? 'deklarovaného počtu položek vybraných částí'
      : 'dříve potvrzeného matchingu';
    missing.push(`dalších ${expectedLowerBound - expectedEntries.length} položek podle ${source}`);
  }
  return { expected, actual: actualIndexes.size, missing, relevantItems: actualItems };
}

async function loadCurrentMatchCoverage(
  outputDir: string,
  tenderId: string,
  report: UplnostZakazky | null,
): Promise<MatchCoverage | null> {
  const analysis = await optionalJsonFileStrict(outputDir, 'analysis.json');
  if (!analysis) {
    if (report?.kroky.match) throw new Error('analysis.json chybí pro kontrolu návaznosti matchingu.');
    return null; // legacy artefakty bez nového kontraktu
  }
  assertAnalysisIdentity(analysis, tenderId, Boolean(report?.kroky.analyze));
  const matchRaw = await jsonFile(outputDir, 'product-match.json');
  if (matchRaw?.tenderId !== tenderId) throw new Error(`product-match.json nepatří zakázce ${tenderId}.`);
  const match = ProductMatchSchema.parse(matchRaw);
  const savedExpected = pocetUplnosti(report?.kroky.match, 'ocekavano', 'polozky') ?? 0;
  const partsSelection = await optionalJsonFileStrict(outputDir, 'parts-selection.json');
  return calculateMatchCoverage(analysis, match, savedExpected, partsSelection?.selected_parts);
}

function failedStep(krok: UplnostKrokNazev, error?: string): UplnostKroku {
  const detail = error || `Krok ${krok} skončil chybou.`;
  return vytvorUplnostKroku({
    krok,
    metriky: [{ nazev: 'dokonceni_kroku', jednotka: 'vystupy', ocekavano: 1, dostano: 0 }],
    chybi: [detail],
    selhalo: true,
    zprava: `Krok ${krok} selhal: ${detail}`,
    naprava: 'Opravte uvedenou příčinu a spusťte krok znovu.',
  });
}

/**
 * Dopočítá strukturální úplnost kroků, jejichž implementace nesmí být v této etapě měněna.
 * Extract/analyze zapisují přesnější vstupní kontrolu samy; při jejich chybě ji zachováme.
 */
export async function zaznamenejVysledekPipelineKroku(
  outputDir: string,
  tenderId: string,
  krok: Exclude<UplnostKrokNazev, 'ingest'>,
  processSucceeded: boolean,
  processError?: string,
): Promise<UplnostKroku> {
  const existing = await nactiUplnostZakazky(outputDir);
  const existingStep = existing?.kroky[krok];
  const currentAttemptStartedAt = existingStep
    && pocetUplnosti(existingStep, 'ocekavano', 'novy_vysledek') === 1
    && pocetUplnosti(existingStep, 'dostano', 'novy_vysledek') === 0
    ? existingStep.aktualizovano
    : undefined;
  if ((krok === 'extract' || krok === 'analyze') && existingStep && processSucceeded) {
    return existingStep;
  }
  if (!processSucceeded && existingStep && existingStep.stav !== 'uplne') {
    const inputGuardFailed = krok === 'extract'
      || (krok === 'analyze'
        && ((pocetUplnosti(existingStep, 'dostano', 'analyzovatelny_text') ?? 0)
          < (pocetUplnosti(existingStep, 'ocekavano', 'analyzovatelny_text') ?? 0)
          || (pocetUplnosti(existingStep, 'dostano', 'analysis_json') ?? 0) === 1));
    if (inputGuardFailed) return existingStep;
  }
  if (!processSucceeded) {
    const result = failedStep(krok, processError);
    await ulozUplnostKroku(outputDir, tenderId, result);
    return result;
  }

  let result: UplnostKroku;
  try {
    if (krok === 'match') {
      const analysis = await jsonFile(outputDir, 'analysis.json');
      if (!await existsSince(outputDir, 'product-match.json', currentAttemptStartedAt)) {
        throw new Error('product-match.json nevznikl v aktuálním běhu matchingu.');
      }
      const matchRaw = await jsonFile(outputDir, 'product-match.json');
      assertAnalysisIdentity(analysis, tenderId, Boolean(existing?.kroky.analyze));
      if (matchRaw?.tenderId !== tenderId) throw new Error(`product-match.json nepatří zakázce ${tenderId}.`);
      const match = ProductMatchSchema.parse(matchRaw);
      const partsSelection = await optionalJsonFileStrict(outputDir, 'parts-selection.json');
      const coverage = calculateMatchCoverage(analysis, match, 0, partsSelection?.selected_parts);
      result = vytvorUplnostKroku({
        krok,
        metriky: [{ nazev: 'polozky', jednotka: 'polozky', ocekavano: coverage.expected, dostano: coverage.actual }],
        chybi: coverage.missing,
        zprava: coverage.missing.length
          ? `Matching nevytvořil výsledek pro ${coverage.expected - coverage.actual} položek.`
          : undefined,
        naprava: coverage.missing.length ? 'Spusťte matching znovu nad úplnou analýzou.' : undefined,
      });
    } else if (krok === 'verify-prices') {
      if (!await existsSince(outputDir, 'product-match.json', currentAttemptStartedAt)) {
        throw new Error('product-match.json nebyl aktualizován v aktuálním běhu ověření cen.');
      }
      const matchRaw = await jsonFile(outputDir, 'product-match.json');
      if (matchRaw?.tenderId !== tenderId) throw new Error(`product-match.json nepatří zakázce ${tenderId}.`);
      const match = ProductMatchSchema.parse(matchRaw);
      const matchCoverage = await loadCurrentMatchCoverage(outputDir, tenderId, existing);
      const allItems = matchCoverage?.relevantItems
        ?? (Array.isArray(match?.polozky_match) ? match.polozky_match : [match]);
      if (allItems.length === 0) throw new Error('Matching neobsahuje žádnou položku k ověření.');
      const multiItemFormat = Array.isArray(match?.polozky_match);
      const isSubstantiveVerificationItem = (item: any): boolean => multiItemFormat
        ? isSubstantiveMatchedItem(item)
        : hasSubstantiveMatchCandidates(item?.kandidati)
          && Number.isSafeInteger(item?.vybrany_index)
          && item.vybrany_index >= 0
          && item.vybrany_index < item.kandidati.length
          && typeof item?.oduvodneni_vyberu === 'string'
          && item.oduvodneni_vyberu.trim().length > 0;
      // Služba nemá tržní produkt a je vědomě ignorovaná teprve poté, co má
      // strukturálně úplný matching. Vadný service záznam zůstává očekávaný
      // a chybějící; jinak by legacy service-only soubor vyšel zeleně jako 0/0.
      const serviceItems = allItems.filter((item: any) => item?.typ === 'sluzba');
      const ignoredItems = serviceItems.filter(isSubstantiveVerificationItem);
      const items = [
        ...allItems.filter((item: any) => item?.typ !== 'sluzba'),
        ...serviceItems.filter((item: any) => !isSubstantiveVerificationItem(item)),
      ];
      const hasConcreteCandidate = (item: any): boolean => {
        const candidates = Array.isArray(item?.kandidati) ? item.kandidati : [];
        const selectedIndex = Number.isSafeInteger(item?.vybrany_index) && item.vybrany_index >= 0
          ? item.vybrany_index
          : 0;
        const selected = candidates[selectedIndex];
        const storedFingerprint = item?.overeni_ceny?.kandidat_fingerprint;
        return typeof selected?.vyrobce === 'string' && selected.vyrobce.trim() !== ''
          && typeof selected?.model === 'string' && selected.model.trim() !== ''
          && (storedFingerprint === undefined
            || (typeof storedFingerprint === 'string'
              && storedFingerprint === candidateFingerprint(selected, selectedIndex)));
      };
      const completedStates = new Set(['nalezeno', 'ekvivalent', 'orientacni', 'nenalezeno']);
      const completed = items.filter((item: any) =>
        isSubstantiveVerificationItem(item)
          && hasConcreteCandidate(item)
          && completedStates.has(item?.overeni_ceny?.stav)
          && item?.overeni_ceny?.posledni_chyba === undefined);
      const missingVerification = itemNames(items.filter((item: any) =>
        !isSubstantiveVerificationItem(item)
          || !hasConcreteCandidate(item)
          || !completedStates.has(item?.overeni_ceny?.stav)
          || item?.overeni_ceny?.posledni_chyba !== undefined));
      const missingCoverage = (matchCoverage?.missing ?? []).map((name) => `matching: ${name}`);
      const missing = [...missingVerification, ...missingCoverage];
      result = vytvorUplnostKroku({
        krok,
        metriky: [
          { nazev: 'overene_polozky', jednotka: 'polozky', ocekavano: items.length, dostano: completed.length },
          ...(matchCoverage ? [{
            nazev: 'matching_polozek', jednotka: 'polozky' as const,
            ocekavano: matchCoverage.expected, dostano: matchCoverage.actual,
          }] : []),
        ],
        chybi: missing,
        vedomeIgnorovano: itemNames(ignoredItems),
        zprava: missing.length ? `Ověření cen chybí u ${missing.length} položek.` : undefined,
        naprava: missing.length ? 'Zopakujte ověření cen; nedostupné ceny doložte a potvrďte ručně.' : undefined,
      });
    } else if (krok === 'generate') {
      const extracted = await jsonFile(outputDir, 'extracted-text.json');
      if (extracted?.tenderId !== tenderId) throw new Error(`extracted-text.json nepatří zakázce ${tenderId}.`);
      const matchCoverage = await loadCurrentMatchCoverage(outputDir, tenderId, existing);
      const templates = Array.isArray(extracted?.documents)
        ? extracted.documents.filter((document: any) => document?.isTemplate)
        : [];
      if (!await existsSince(outputDir, 'generation-meta.json', currentAttemptStartedAt)) {
        throw new Error('generation-meta.json nevznikl v aktuálním běhu generování.');
      }
      const meta = await jsonFile(outputDir, 'generation-meta.json');
      const baseNames = ['technicky_navrh.docx', 'cenova_nabidka.docx'];
      const baseResults = await Promise.all(baseNames.map(async (name) => ({
        name,
        complete: await existsSince(outputDir, name, currentAttemptStartedAt)
          && meta?.[name]?.source === 'programmatic'
          && typeof meta?.[name]?.template_source !== 'string',
      })));
      const baseActual = baseResults.filter(({ complete }) => complete).length;
      const generatedSources: string[] = [];
      for (const [outputName, entry] of Object.entries(meta ?? {})) {
        const source = (entry as any)?.template_source;
        if (typeof source === 'string' && await existsSince(outputDir, outputName, currentAttemptStartedAt)) {
          generatedSources.push(source);
        }
      }
      const missingTemplates: string[] = [];
      for (const template of templates) {
        const name = String(template?.filename ?? 'neznámá šablona');
        const exact = name.toLowerCase();
        const leaf = name.split(/[\\/]/).pop()?.trim().toLowerCase() ?? exact;
        const sourceIndex = generatedSources.findIndex((source) => {
          const normalized = source.toLowerCase();
          return normalized === exact || normalized === leaf;
        });
        if (sourceIndex >= 0) generatedSources.splice(sourceIndex, 1);
        else missingTemplates.push(name);
      }
      const missingBase = baseResults.filter(({ complete }) => !complete).map(({ name }) => name);
      const soupises = await soupiseCoverage(
        outputDir,
        tenderId,
        currentAttemptStartedAt,
        Boolean(existing?.kroky.analyze),
      );
      result = vytvorUplnostKroku({
        krok,
        metriky: [
          { nazev: 'zakladni_dokumenty', jednotka: 'soubory', ocekavano: baseNames.length, dostano: baseActual },
          { nazev: 'sablony', jednotka: 'sablony', ocekavano: templates.length, dostano: templates.length - missingTemplates.length },
          { nazev: 'vyplnene_soupisy', jednotka: 'dokumenty', ocekavano: soupises.expected, dostano: soupises.actual },
          ...(matchCoverage ? [{
            nazev: 'matching_polozek', jednotka: 'polozky' as const,
            ocekavano: matchCoverage.expected, dostano: matchCoverage.actual,
          }] : []),
        ],
        chybi: [...missingBase, ...missingTemplates, ...soupises.missing, ...(matchCoverage?.missing ?? [])],
        zprava: missingBase.length + missingTemplates.length + soupises.missing.length
          + (matchCoverage?.missing.length ?? 0) > 0
          ? 'Generování nepokrylo všechny očekávané dokumenty nebo naceněné položky.'
          : undefined,
        naprava: 'Zkontrolujte zdrojové šablony a spusťte generování znovu.',
      });
    } else if (krok === 'validate') {
      const extracted = await jsonFile(outputDir, 'extracted-text.json');
      if (extracted?.tenderId !== tenderId) throw new Error(`extracted-text.json nepatří zakázce ${tenderId}.`);
      const matchCoverage = await loadCurrentMatchCoverage(outputDir, tenderId, existing);
      const templates = Array.isArray(extracted?.documents)
        ? extracted.documents.filter((document: any) => document?.isTemplate)
        : [];
      const meta = await jsonFile(outputDir, 'generation-meta.json');
      // Povinné programatické dokumenty jsou součástí kontraktu samy o sobě.
      // Neúplný generation-meta.json nesmí snížit očekávání na nulu a udělat z
      // chybějících technického návrhu / cenové nabídky falešně zelenou validaci.
      // Další šablonové výstupy z metadata i samostatná kontrola soupisů zůstávají zachovány.
      const expectedDocuments = [...new Set([
        'technicky_navrh.docx',
        'cenova_nabidka.docx',
        // Programatický validator záměrně zpracovává jen DOCX. Excelové šablony
        // kontroluje generate kontrakt a validate je explicitně eviduje jako ignorované.
        ...Object.keys(meta ?? {}).filter((name) => name.toLowerCase().endsWith('.docx')),
      ])];
      const reportFreshForAttempt = await existsSince(
        outputDir,
        'validation-report.json',
        currentAttemptStartedAt,
      );
      const report = reportFreshForAttempt
        ? await optionalJsonFile(outputDir, 'validation-report.json')
        : null;
      const parsedReport = ValidationReportSchema.safeParse(report);
      const reportExists = parsedReport.success && report?.tenderId === tenderId;
      // Bez platného reportu krok stejně nemůže být zelený; validní dílčí field
      // výsledky ale můžeme započítat. Jakmile existuje aktuální report této
      // zakázky, jeho čas je závazná freshness kotva proti starému souboru.
      let fieldValidationFresh = !reportExists
        && await existsSince(outputDir, 'field-validation.json', currentAttemptStartedAt);
      if (reportExists) {
        try {
          const fieldValidationStat = await stat(join(outputDir, 'field-validation.json'));
          fieldValidationFresh = fieldValidationStat.isFile()
            && fieldValidationStat.mtimeMs >= Date.parse(parsedReport.data.validatedAt)
            && (!currentAttemptStartedAt
              || fieldValidationStat.mtimeMs >= Date.parse(currentAttemptStartedAt));
        } catch {
          fieldValidationFresh = false;
        }
      }
      const fieldValidation = await jsonFile(outputDir, 'field-validation.json');
      const validFieldResults = (fieldValidationFresh && Array.isArray(fieldValidation) ? fieldValidation : [])
        .filter((entry: any) => typeof entry?.document === 'string' && entry.document.length > 0
          && (entry.overall === 'pass' || entry.overall === 'fail')
          && Array.isArray(entry.checks));
      const allValidatedNames = new Set(validFieldResults.map((entry: any) => entry.document as string));
      const baseNames = new Set(['technicky_navrh.docx', 'cenova_nabidka.docx']);
      const validatedNames = new Set((await Promise.all(expectedDocuments.map(async (name) => ({
        name,
        complete: allValidatedNames.has(name)
          && await exists(outputDir, name)
          && (!baseNames.has(name)
            || (meta?.[name]?.source === 'programmatic'
              && typeof meta?.[name]?.template_source !== 'string')),
      })))).filter(({ complete }) => complete).map(({ name }) => name));
      const missing = expectedDocuments.filter((name) => !validatedNames.has(name));

      // generation-meta je výsledek, ne zdroj očekávání. Každá vstupní šablona
      // musí mít vlastní (multisetové) metadata a fyzicky existující validovaný výstup.
      const templateEntries = Object.entries(meta ?? {}).flatMap(([outputName, entry]) => {
        const source = (entry as any)?.template_source;
        return typeof source === 'string' ? [{ outputName, source }] : [];
      });
      const missingTemplates: string[] = [];
      let validatedTemplates = 0;
      let expectedValidatedTemplates = 0;
      let preparedExcelTemplates = 0;
      let expectedExcelTemplates = 0;
      const ignoredTemplates: string[] = [];
      for (const template of templates) {
        const name = String(template?.filename ?? 'neznámá šablona');
        const exact = name.toLowerCase();
        const leaf = name.split(/[\\/]/).pop()?.trim().toLowerCase() ?? exact;
        const sourceMatches = (source: string): boolean => {
          const normalized = source.toLowerCase();
          return normalized === exact || normalized === leaf;
        };
        if (template?.type === 'xls' || template?.type === 'xlsx') {
          expectedExcelTemplates += 1;
          const entryIndex = templateEntries.findIndex(({ outputName, source }) =>
            outputName.toLowerCase().endsWith('.xlsx') && sourceMatches(source));
          if (entryIndex < 0) {
            missingTemplates.push(name);
            continue;
          }
          const [{ outputName }] = templateEntries.splice(entryIndex, 1);
          if (await exists(outputDir, outputName)) {
            preparedExcelTemplates += 1;
            // DOCX field-validator Excel záměrně neumí; ignorování je přípustné
            // až poté, co generation metadata i fyzický XLSX prokážou jeho vznik.
            ignoredTemplates.push(name);
          } else {
            missingTemplates.push(name);
          }
          continue;
        }
        expectedValidatedTemplates += 1;
        const entryIndex = templateEntries.findIndex(({ outputName, source }) =>
          outputName.toLowerCase().endsWith('.docx') && sourceMatches(source));
        if (entryIndex < 0) {
          missingTemplates.push(name);
          continue;
        }
        const [{ outputName }] = templateEntries.splice(entryIndex, 1);
        if (validatedNames.has(outputName)) validatedTemplates += 1;
      }
      missing.push(...missingTemplates);
      if (!reportExists) missing.push('validation-report.json');
      const soupises = await soupiseCoverage(
        outputDir,
        tenderId,
        undefined,
        Boolean(existing?.kroky.analyze),
      );
      missing.push(...soupises.missing);
      missing.push(...(matchCoverage?.missing ?? []));
      result = vytvorUplnostKroku({
        krok,
        metriky: [
          { nazev: 'validovane_dokumenty', jednotka: 'dokumenty', ocekavano: expectedDocuments.length, dostano: validatedNames.size },
          { nazev: 'validovane_sablony', jednotka: 'sablony', ocekavano: expectedValidatedTemplates, dostano: validatedTemplates },
          { nazev: 'pripravene_excel_sablony', jednotka: 'sablony', ocekavano: expectedExcelTemplates, dostano: preparedExcelTemplates },
          { nazev: 'validation_report', jednotka: 'vystupy', ocekavano: 1, dostano: reportExists ? 1 : 0 },
          { nazev: 'validovane_soupisy', jednotka: 'dokumenty', ocekavano: soupises.expected, dostano: soupises.actual },
          ...(matchCoverage ? [{
            nazev: 'matching_polozek', jednotka: 'polozky' as const,
            ocekavano: matchCoverage.expected, dostano: matchCoverage.actual,
          }] : []),
        ],
        chybi: missing,
        vedomeIgnorovano: ignoredTemplates,
        zprava: missing.length ? `Validace nepokryla ${missing.length} očekávaných výstupů.` : undefined,
        naprava: 'Doplňte chybějící dokumenty a spusťte validaci znovu.',
      });
    } else {
      throw new Error(`Neznámý krok úplnosti: ${krok}`);
    }
  } catch (error) {
    result = failedStep(krok, error instanceof Error ? error.message : String(error));
  }
  await ulozUplnostKroku(outputDir, tenderId, result);
  return result;
}
