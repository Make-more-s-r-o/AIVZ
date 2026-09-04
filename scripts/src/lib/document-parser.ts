import { mkdtemp, readFile, rm } from 'fs/promises';
import { join, extname, basename, dirname } from 'path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import type { ExtractedDocument } from './types.js';
import {
  CONVERTED_DOC_DIRNAME,
  discoverInputFiles,
  isIntentionallyIgnoredInputName,
} from './input-discovery.js';

const CONTENT_TEMPLATE_PATTERNS = [
  'doplní účastník', 'doplní uchazeč', 'vyplní účastník', 'vyplní uchazeč',
  '[doplnit]', '[vyplnit]', '[účastník vyplní]',
];

// Soupis files - contain item lists that need parsing, not template filling.
// Keep these phrases in one exported classifier so other filename-based consumers
// can use exactly the same decision instead of maintaining a second regex.
export const SOUPIS_PATTERNS = [
  'soupis',
  'vykaz vymer',
  'polozkovy rozpocet',
  'kalkulace nabidkove ceny',
  'cenova nabidka',
] as const;

// Normalize for matching: lowercase, underscores→spaces, strip diacritics
function normalizeForMatching(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export interface DocumentFilenameClassification {
  isTemplate: boolean;
  isSoupis: boolean;
}

/** Classify a document from its filename. Templates always take precedence. */
export function classifyDocumentFilename(filename: string): DocumentFilenameClassification {
  // Kopie přesné vstupní domény discoverTemplates(): jen editovatelné typy a
  // normalizace podtržítek (pomlčku generátor záměrně nepřevádí na mezeru).
  const leaf = filename.split(/[\\/]/).pop()?.trim() || filename;
  const editable = ['.doc', '.docx', '.xls', '.xlsx'].includes(extname(leaf).toLowerCase());
  const generatorName = leaf.replace(/_/g, ' ');
  const skipped = [
    /obchodn[ií]\s*podm[ií]nky/i,
    /výzva/i,
    /zadávac[ií]\s*dokument/i,
  ].some((pattern) => pattern.test(generatorName));
  const isTemplate = editable && !skipped && [
    /kryc[ií]\s*list/i,
    /cover\s*sheet/i,
    /[čc]estn[ée]\s*prohl[áa][šs]en[ií]/i,
    /sworn\s*statement/i,
    /seznam\s*poddodavatel/i,
    /subcontractor/i,
    /kupn[ií]\s*smlouv/i,
    /smlouva.*dodávk/i,
    /technick[áa]\s*specifikace/i,
    /tech.*spec/i,
  ].some((pattern) => pattern.test(generatorName));
  const normalized = normalizeForMatching(leaf);
  return {
    isTemplate,
    // A cover sheet remains a template even if its filename also mentions a price list.
    isSoupis: !isTemplate && SOUPIS_PATTERNS.some((pattern) => normalized.includes(pattern)),
  };
}

/** Sjednotí filename i content fallback s tím, co následně vyplňuje generator. */
export function classifyExtractedDocument(
  filename: string,
  text: string,
): DocumentFilenameClassification {
  const byFilename = classifyDocumentFilename(filename);
  const editable = ['.doc', '.docx', '.xls', '.xlsx'].includes(extname(filename).toLowerCase());
  const leaf = filename.split(/[\\/]/).pop()?.trim() || filename;
  const skipped = [
    /obchodn[ií]\s*podm[ií]nky/i,
    /výzva/i,
    /zadávac[ií]\s*dokument/i,
  ].some((pattern) => pattern.test(leaf));
  const lowerText = text.toLowerCase();
  const contentTemplate = editable && !skipped && (
    CONTENT_TEMPLATE_PATTERNS.some((pattern) => lowerText.includes(pattern))
    || /_{3,}|\.{4,}|…{2,}|\[vyplnit\]|\[doplnit\]|\[účastník vyplní\]/i.test(text)
  );
  return contentTemplate
    ? { isTemplate: true, isSoupis: false }
    : byFilename;
}

export function isSoupisFilename(filename: string): boolean {
  return classifyDocumentFilename(filename).isSoupis;
}

export async function parsePdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

export async function parseDocx(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/** Convert an ExcelJS cell value (string | number | richText | formula | hyperlink | Date) to text. */
function excelValueToText(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((rt: any) => rt.text || '').join('');
    if ('result' in v) return v.result === null || v.result === undefined ? '' : String(v.result);
    if ('text' in v) return v.text == null ? '' : String(v.text);
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return String(v);
}

export async function parseExcel(filePath: string): Promise<string> {
  const isLegacyXls = filePath.toLowerCase().endsWith('.xls');

  if (isLegacyXls) {
    // Legacy .xls (BIFF binary) — use SheetJS which handles both formats
    const buffer = await readFile(filePath);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const lines: string[] = [];
    for (const sheetName of wb.SheetNames) {
      lines.push(`=== List: ${sheetName} ===`);
      const sheet = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: '',
      });
      for (const row of rows) {
        const cells = row.map((value) => value == null ? '' : String(value));
        if (cells.some((cell) => cell.trim().length > 0)) lines.push(cells.join(' | '));
      }
    }
    return lines.join('\n');
  }

  // .xlsx — use ExcelJS
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const lines: string[] = [];
  workbook.eachSheet((sheet) => {
    lines.push(`=== List: ${sheet.name} ===`);
    sheet.eachRow((row) => {
      const cells = (row.values as any[]).slice(1).map(excelValueToText);
      // ExcelJS může evidovat stovky fyzických řádků tvořených jen prázdnými
      // hodnotami. Oddělovače takových řádků nejsou obsah dokumentu.
      if (cells.some((cell) => cell.trim().length > 0)) lines.push(cells.join(' | '));
    });
  });
  return lines.join('\n');
}

const SOUPIS_HEADER_PATTERNS = {
  cislo: /^(č[ií]slo|po[řr]\.?\s*[čc]|#|p\.č\.|pol\.?\s*[čc]|č\.)/i,
  nazev: /^(n[áa]zev|polo[žz]ka|za[řr][ií]zen[ií]|popis\s*polo|ozna[čc]en[ií])/i,
  specifikace: /^(popis|specifikace|minim[áa]ln[ií]|tech.*param|pozn[áa]mka)/i,
  mnozstvi: /^(mno[žz]stv[ií]|po[čc]et|ks|mn\.|mj)/i,
  jednotka: /^(jednotka|m[ěe]rn[áa]\s+jednotka|mj|m\.j\.|jedn)/i,
  kategorie: /^(hashtag|kategorie|typ|druh|skupina)/i,
  umisteni: /^(um[ií]st[ěe]n[ií]|m[ií]stnost|lokace)/i,
} as const;

export interface SoupisWorkbookInspection {
  dataSheetNames: string[];
  unsupportedNumberedRows: string[];
}

/**
 * Provede fail-closed kontrolu známých omezení jednosheetového parseru soupisu.
 * Vedle více datových listů odhalí i hierarchická čísla řádků (např. 1.1),
 * která dnešní parseSoupis() neumí a jinak by je tiše zahodil.
 */
export async function inspectSoupisWorkbook(filePath: string): Promise<SoupisWorkbookInspection> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const dataSheetNames: string[] = [];
  const unsupportedNumberedRows: string[] = [];
  for (const sheet of workbook.worksheets) {
    // Inspekce je fail-closed pojistka nad starším parserem. Musí proto projít celý
    // použitý rozsah: jinak by druhý datový list s delším preambulem (hlavička
    // až za řádkem 50) unikl a snapshot pouze prvního listu jej tiše zahodil.
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const columns: Partial<Record<keyof typeof SOUPIS_HEADER_PATTERNS, number>> = {};
      let headerMatches = 0;
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const value = excelValueToText(cell.value).trim();
        if (!value) return;
        for (const [key, pattern] of Object.entries(SOUPIS_HEADER_PATTERNS) as Array<
          [keyof typeof SOUPIS_HEADER_PATTERNS, RegExp]
        >) {
          if (!columns[key] && pattern.test(value)) {
            columns[key] = columnNumber;
            headerMatches += 1;
          }
        }
      });
      if (columns.cislo !== undefined && columns.cislo === columns.nazev) {
        delete columns.cislo;
      }
      const numberColumn = columns.cislo;
      const nameColumn = columns.nazev;
      if (!nameColumn || headerMatches < 2) continue;
      let hasData = false;
      for (let dataRowNumber = rowNumber + 1; dataRowNumber <= sheet.rowCount; dataRowNumber += 1) {
        const dataRow = sheet.getRow(dataRowNumber);
        const name = excelValueToText(dataRow.getCell(nameColumn).value).trim();
        if (!name || /^(celkem|celkov|součet|soucet|total|suma)/i.test(name)) continue;
        if (!numberColumn) {
          hasData = true;
          continue;
        }
        const number = excelValueToText(dataRow.getCell(numberColumn).value).trim();
        if (/^\d+\s*\.?$/.test(number)) {
          hasData = true;
        } else if (!/^polo[žz]ka\s*[čc]\.?\s*\d+/i.test(number)) {
          hasData = true;
          unsupportedNumberedRows.push(`${sheet.name}: ${number || '[bez čísla]'} ${name}`);
        }
      }
      if (hasData) dataSheetNames.push(sheet.name);
      break;
    }
  }
  return { dataSheetNames, unsupportedNumberedRows };
}

/** Zpětně čitelný úzký helper pro volající, kteří potřebují jen seznam listů. */
export async function findSoupisDataSheetNames(filePath: string): Promise<string[]> {
  return (await inspectSoupisWorkbook(filePath)).dataSheetNames;
}

/**
 * Vytvoří dočasný workbook pouze s ověřeným datovým listem. Tím obejde starou
 * heuristiku parseSoupis(), která jinak vybere první delší list s pokyny.
 */
export async function createSingleSheetSoupisSnapshot(
  filePath: string,
  sheetName: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const selected = workbook.getWorksheet(sheetName);
  if (!selected) throw new Error(`Datový list ${sheetName} nebyl v soupisu nalezen.`);
  for (const sheet of [...workbook.worksheets]) {
    if (sheet.id !== selected.id) workbook.removeWorksheet(sheet.id);
  }
  const directory = await mkdtemp(join(tmpdir(), 'vz-soupis-'));
  const snapshotPath = join(directory, basename(filePath));
  try {
    await workbook.xlsx.writeFile(snapshotPath);
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    path: snapshotPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Resolve the LibreOffice/soffice binary across platforms. Returns null if not found. */
export function findSoffice(): string | null {
  const candidates = [
    process.env.SOFFICE_BIN,
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  for (const bin of ['soffice', 'libreoffice']) {
    try {
      // execFile (no shell) — avoids shell-injection; `which` exits non-zero if absent.
      const p = execFileSync('which', [bin], { encoding: 'utf-8' }).trim();
      if (p) return p;
    } catch { /* not on PATH */ }
  }
  return null;
}

const convertedDocCache = new Map<string, {
  sourceMtimeMs: number;
  sourceSize: number;
  outputPath: string;
}>();

/**
 * Konvertuje `.doc` → `.docx` přes LibreOffice do pracovní podsložky, která se
 * nepočítá mezi zdrojové přílohy. Vrací cestu k `.docx`, nebo null
 * (LibreOffice chybí / konverze selhala).
 *
 * Idempotence: pokud pracovní `.docx` už existuje, vrátí ho bez rekonverze.
 *
 * DŮLEŽITÉ: konverzi musí volat KAŽDÝ discovery-based krok, který `.doc` šablonu
 * potřebuje jako `.docx`. U souborů ze ZIPu se pracovní strom před každým discovery
 * znovu vytvoří, takže si generate krok konverzi zopakuje.
 */
export function convertDocToDocx(docPath: string): string | null {
  const soffice = findSoffice();
  if (!soffice) {
    console.log(`  Skipping .doc file (LibreOffice not found — set SOFFICE_BIN or install libreoffice): ${basename(docPath)}`);
    return null;
  }
  const srcDir = dirname(docPath);
  const convertedDir = join(srcDir, CONVERTED_DOC_DIRNAME);
  mkdirSync(convertedDir, { recursive: true });
  const docxPath = join(convertedDir, basename(docPath, extname(docPath)) + '.docx');
  const sourceStat = statSync(docPath);
  const cached = convertedDocCache.get(docPath);
  if (cached
    && cached.sourceMtimeMs === sourceStat.mtimeMs
    && cached.sourceSize === sourceStat.size
    && cached.outputPath === docxPath
    && existsSync(docxPath)) return docxPath;
  // Diskový soubor z jiného procesu/běhu není důkaz freshness. Vždy ho odstraň
  // a znovu konvertuj; pouze in-process cache výše je svázaná se source statem.
  if (existsSync(docxPath)) {
    try { unlinkSync(docxPath); } catch { /* exec níže vrátí srozumitelnou chybu */ }
  }
  console.log(`  Converting .doc → .docx (${soffice}): ${basename(docPath)}`);
  try {
    // execFile s polem argumentů (žádný shell) — názvy souborů nemohou injektovat příkazy.
    execFileSync(soffice, ['--headless', '--convert-to', 'docx', docPath, '--outdir', convertedDir], { timeout: 60000 });
    if (existsSync(docxPath)) {
      convertedDocCache.set(docPath, {
        sourceMtimeMs: sourceStat.mtimeMs,
        sourceSize: sourceStat.size,
        outputPath: docxPath,
      });
      return docxPath;
    }
    console.log(`  Warning: .doc conversion produced no .docx for ${basename(docPath)}`);
    return null;
  } catch (err) {
    console.log(`  Warning: Failed to convert .doc ${basename(docPath)}: ${err}`);
    return null;
  }
}

export interface DocumentExtractionResult {
  documents: ExtractedDocument[];
  /** Podporované, obsahově odlišné vstupy, které měl parser zpracovat. */
  expectedDocumentNames: string[];
  /** Konkrétní vstupy, ze kterých parser nedokázal vytvořit textový dokument. */
  missingDocumentNames: string[];
  /** Technické přílohy vědomě vynechané z textové extrakce. */
  ignoredDocumentNames: string[];
  /** Zdrojové ZIP kontejnery, které mohou přímo odpovídat chybě z ingest kontraktu. */
  sourceArchiveNames: string[];
  warnings: string[];
}

function hasUsableExtractedBody(
  text: string,
  type: ExtractedDocument['type'],
  classification: DocumentFilenameClassification,
): boolean {
  // Prázdná editovatelná šablona může být strukturální formulář bez textových buněk.
  // Excelový soupis zase autoritativně prověří deterministický parser v analyze kroku.
  if (classification.isTemplate || (classification.isSoupis && (type === 'xls' || type === 'xlsx'))) {
    return true;
  }
  const body = (type === 'xls' || type === 'xlsx')
    ? text.replace(/^=== List: .* ===\s*$/gm, '').replace(/\|/g, '')
    : text;
  return body.replace(/\s+/g, '').length > 0;
}

export async function extractDocumentsWithReport(
  inputDir: string
): Promise<DocumentExtractionResult> {
  // Robustní discovery: rekurzivně projde podadresáře + rozbalí ZIPy (viz input-discovery.ts).
  // Nahrazuje původní plochý readdir(), který vnořené složky / ZIPy neviděl.
  const { files, warnings, archiveNames } = await discoverInputFiles(inputDir);
  for (const w of warnings) console.log(`  [discovery] ${w}`);
  console.log(`  Objeveno ${files.length} souborů (vč. rozbalených ZIPů a podadresářů)`);

  const documents: ExtractedDocument[] = [];
  const expectedDocumentNames: string[] = [];
  const missingDocumentNames: string[] = [];
  const ignoredDocumentNames: string[] = [];

  const appendParsedDocument = (
    sourceName: string,
    outputName: string,
    type: ExtractedDocument['type'],
    text: string,
  ): void => {
    const classification = classifyExtractedDocument(outputName, text);
    if (!hasUsableExtractedBody(text, type, classification)) {
      missingDocumentNames.push(sourceName);
      console.log(`  Warning: Parsed document contains no usable text: ${sourceName}`);
      return;
    }
    documents.push({ filename: outputName, type, text, ...classification });
  };

  const discoveredDocxBasenames = new Map<string, number>();
  for (const discovered of files) {
    const base = basename(discovered.relPath).toLowerCase();
    if (base.endsWith('.docx')) {
      discoveredDocxBasenames.set(base, (discoveredDocxBasenames.get(base) ?? 0) + 1);
    }
  }

  for (const f of files) {
    const file = f.name; // display name (basename nebo relativní cesta při kolizi)
    const filePath = f.absPath;
    const ext = extname(f.name).toLowerCase();

    if (isIntentionallyIgnoredInputName(f.relPath)) {
      // Podpisy/certifikáty, obrázky a technická metadata nejsou textové dokumenty
      // pro tuto pipeline. Jsou ale explicitně reportované, ne tiše zahozené.
      ignoredDocumentNames.push(file);
      console.log(`  Ignoring non-document attachment: ${file}`);
      continue;
    }

    // Nulový podporovaný soubor hlásíme deterministicky; nespoléháme na to, zda
    // konkrétní parser prázdný buffer odmítne výjimkou, nebo vrátí prázdný text.
    if (f.size === 0 && ['.pdf', '.docx', '.doc', '.xls', '.xlsx'].includes(ext)) {
      expectedDocumentNames.push(file);
      missingDocumentNames.push(file);
      console.log(`  Warning: Empty ${ext || 'document'} file cannot be parsed: ${file}`);
      continue;
    }

    if (ext === '.pdf') {
      expectedDocumentNames.push(file);
      console.log(`  Parsing PDF: ${file}`);
      try {
        const text = await parsePdf(filePath);
        appendParsedDocument(file, file, 'pdf', text);
      } catch (err) {
        console.log(`  Warning: Failed to parse PDF file ${file}: ${err}`);
        missingDocumentNames.push(file);
      }
    } else if (ext === '.docx') {
      expectedDocumentNames.push(file);
      console.log(`  Parsing DOCX: ${file}`);
      try {
        const text = await parseDocx(filePath);
        appendParsedDocument(file, file, 'docx', text);
      } catch (err) {
        console.log(`  Warning: Failed to parse DOCX file ${file}: ${err}`);
        missingDocumentNames.push(file);
      }
    } else if (ext === '.xls' || ext === '.xlsx') {
      expectedDocumentNames.push(file);
      console.log(`  Parsing Excel: ${file}`);
      try {
        const text = await parseExcel(filePath);
        appendParsedDocument(file, file, ext.slice(1) as 'xls' | 'xlsx', text);
      } catch (err) {
        console.log(`  Warning: Failed to parse Excel file ${file}: ${err}`);
        missingDocumentNames.push(file);
      }
    } else if (ext === '.doc') {
      // Convert .doc → .docx via LibreOffice, then parse. findSoffice() resolves the binary
      // across platforms (macOS bundle, Linux /usr/bin, PATH, SOFFICE_BIN) — the production
      // VPS is Linux, where the old hardcoded macOS path was always missing → .doc silently
      // skipped. Konverze je sdílená s discoverTemplates() (generate krok), aby se zipovaná
      // .doc smlouva zkonvertovala v OBOU krocích konzistentně.
      const docxBase = basename(file, extname(file)) + '.docx';

      // `.doc` a vedle něj existující `.docx` jsou dva samostatné zdrojové záměry.
      // Konverze jde do skryté pracovní složky, takže legitimní `.docx` nepřepíše.
      expectedDocumentNames.push(file);
      const docxPath = convertDocToDocx(filePath);
      if (docxPath) {
        try {
          const text = await parseDocx(docxPath);
          const convertedDisplayName = (discoveredDocxBasenames.get(docxBase.toLowerCase()) ?? 0) > 0
            ? `${f.relPath.slice(0, -ext.length)}.docx`.split('/').join(' / ')
            : docxBase;
          appendParsedDocument(file, convertedDisplayName, 'docx', text);
        } catch (err) {
          console.log(`  Warning: Failed to parse converted DOC file ${file}: ${err}`);
          missingDocumentNames.push(file);
        }
      } else {
        missingDocumentNames.push(file);
      }
    } else {
      // Každá jiná neznámá přípona může být věcnou součástí ZD (RTF/ODT/TXT/...).
      // Dokud pro ni parser nemáme, musí zakázka zůstat neúplná.
      expectedDocumentNames.push(file);
      missingDocumentNames.push(file);
      const extensionLabel = ext || '(bez přípony)';
      const warning = `Nepodporovaný dokument "${file}" (${extensionLabel}) nebyl extrahován`;
      warnings.push(warning);
      console.log(`  Warning: ${warning}`);
    }
  }

  return {
    documents,
    expectedDocumentNames,
    missingDocumentNames,
    ignoredDocumentNames,
    sourceArchiveNames: archiveNames,
    warnings,
  };
}

/** Zpětně kompatibilní pohodlný vstup pro případné další konzumenty parseru. */
export async function extractDocuments(inputDir: string): Promise<ExtractedDocument[]> {
  return (await extractDocumentsWithReport(inputDir)).documents;
}
