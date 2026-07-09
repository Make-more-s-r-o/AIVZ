import { readFile } from 'fs/promises';
import { join, extname, basename, dirname } from 'path';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import type { ExtractedDocument } from './types.js';
import { discoverInputFiles } from './input-discovery.js';

// Template files - these are filled in generate step, not analyzed
const TEMPLATE_PATTERNS = [
  'kryci list',
  'cestne prohlaseni',
  'cestneho prohlaseni',
  'seznam poddodavatel',
];

// Soupis files - contain item lists that need parsing, not template filling
const SOUPIS_PATTERNS = [
  'soupis vybaveni',
  'soupis polozek',
  'soupis dodavek',
  'cenova nabidka',  // some tenders use "cenová nabídka" as soupis
];

// Normalize for matching: lowercase, underscores→spaces, strip diacritics
function normalizeForMatching(str: string): string {
  return str
    .toLowerCase()
    .replace(/_/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isTemplate(filename: string): boolean {
  const normalized = normalizeForMatching(filename);
  return TEMPLATE_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isSoupis(filename: string): boolean {
  const normalized = normalizeForMatching(filename);
  return SOUPIS_PATTERNS.some((pattern) => normalized.includes(pattern));
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
      const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ' | ' });
      lines.push(csv);
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
      lines.push(cells.join(' | '));
    });
  });
  return lines.join('\n');
}

/** Resolve the LibreOffice/soffice binary across platforms. Returns null if not found. */
function findSoffice(): string | null {
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

export async function extractDocuments(
  inputDir: string
): Promise<ExtractedDocument[]> {
  // Robustní discovery: rekurzivně projde podadresáře + rozbalí ZIPy (viz input-discovery.ts).
  // Nahrazuje původní plochý readdir(), který vnořené složky / ZIPy neviděl.
  const { files, warnings } = await discoverInputFiles(inputDir);
  for (const w of warnings) console.log(`  [discovery] ${w}`);
  console.log(`  Objeveno ${files.length} souborů (vč. rozbalených ZIPů a podadresářů)`);

  const documents: ExtractedDocument[] = [];

  // Množina VŠECH objevených display names (lowercase) — pro dedup .doc↔.docx.
  const discoveredNamesLower = new Set(files.map((f) => f.name.toLowerCase()));

  for (const f of files) {
    const file = f.name; // display name (basename nebo relativní cesta při kolizi)
    const filePath = f.absPath;
    const ext = extname(f.name).toLowerCase();

    if (ext === '.pdf') {
      console.log(`  Parsing PDF: ${file}`);
      const text = await parsePdf(filePath);
      documents.push({
        filename: file,
        type: 'pdf',
        text,
        isTemplate: isTemplate(file),
        isSoupis: isSoupis(file),
      });
    } else if (ext === '.docx') {
      console.log(`  Parsing DOCX: ${file}`);
      const text = await parseDocx(filePath);
      documents.push({
        filename: file,
        type: 'docx',
        text,
        isTemplate: isTemplate(file),
        isSoupis: isSoupis(file),
      });
    } else if (ext === '.xls' || ext === '.xlsx') {
      console.log(`  Parsing Excel: ${file}`);
      try {
        const text = await parseExcel(filePath);
        documents.push({
          filename: file,
          type: ext.slice(1) as 'xls' | 'xlsx',
          text,
          isTemplate: isTemplate(file),
          isSoupis: isSoupis(file),
        });
      } catch (err) {
        console.log(`  Warning: Failed to parse Excel file ${file}: ${err}`);
      }
    } else if (ext === '.doc') {
      // Convert .doc → .docx via LibreOffice, then parse. Resolve the binary across
      // platforms (macOS bundle, Linux /usr/bin, PATH, SOFFICE_BIN) — the production VPS
      // is Linux, where the old hardcoded macOS path was always missing → .doc silently skipped.
      const libreoffice = findSoffice();
      if (libreoffice) {
        // Cílový .docx vzniká VEDLE zdrojového .doc (i uvnitř podadresáře/.extracted),
        // aby ho discoverTemplates() ve fázi generování našel — skenuje jen .docx/.xls/.xlsx.
        const srcDir = dirname(filePath);
        const docxBase = basename(file, extname(file)) + '.docx';
        const docxPath = join(srcDir, basename(filePath, extname(filePath)) + '.docx');

        // Idempotence + ochrana proti kolizi: pokud .docx se stejným názvem už objeven byl
        // (výsledek dřívějšího běhu NEBO původní soubor tendru), znovu nekonvertujeme —
        // ten .docx zpracuje .docx větev tohoto běhu.
        if (discoveredNamesLower.has(docxBase.toLowerCase()) || existsSync(docxPath)) {
          console.log(`  Skipping .doc conversion — .docx already present: ${docxBase}`);
        } else {
          console.log(`  Converting .doc → .docx (${libreoffice}): ${file}`);
          try {
            // execFile with an argument array (no shell) — filenames can't inject commands.
            execFileSync(libreoffice, ['--headless', '--convert-to', 'docx', filePath, '--outdir', srcDir], { timeout: 60000 });
            if (existsSync(docxPath)) {
              const text = await parseDocx(docxPath);
              // Konvertovaný .docx PONECHÁVÁME na disku vedle zdrojového .doc, aby ho
              // discoverTemplates() ve fázi generování našel (dřív se hned mazal → smlouva chyběla).
              documents.push({
                filename: docxBase,
                type: 'docx',
                text,
                isTemplate: isTemplate(docxBase),
                isSoupis: isSoupis(docxBase),
              });
            } else {
              console.log(`  Warning: .doc conversion produced no .docx for ${file}`);
            }
          } catch (err) {
            console.log(`  Warning: Failed to convert .doc ${file}: ${err}`);
          }
        }
      } else {
        console.log(`  Skipping .doc file (LibreOffice not found — set SOFFICE_BIN or install libreoffice): ${file}`);
      }
    }
  }

  return documents;
}
