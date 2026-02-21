import { readFile, readdir, unlink } from 'fs/promises';
import { join, extname, basename } from 'path';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import type { ExtractedDocument } from './types.js';

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
      const cells = (row.values as any[]).slice(1).map((v) =>
        v === null || v === undefined ? '' : String(v)
      );
      lines.push(cells.join(' | '));
    });
  });
  return lines.join('\n');
}

export async function extractDocuments(
  inputDir: string
): Promise<ExtractedDocument[]> {
  const files = await readdir(inputDir);
  const documents: ExtractedDocument[] = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const filePath = join(inputDir, file);

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
      // Convert .doc → .docx via LibreOffice, then parse
      const libreoffice = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
      if (existsSync(libreoffice)) {
        console.log(`  Converting .doc → .docx: ${file}`);
        try {
          execSync(`"${libreoffice}" --headless --convert-to docx "${filePath}" --outdir "${inputDir}"`, { timeout: 30000 });
          const docxPath = join(inputDir, basename(file, '.doc') + '.docx');
          if (existsSync(docxPath)) {
            const text = await parseDocx(docxPath);
            // Remove the converted file to keep input clean
            await unlink(docxPath);
            documents.push({
              filename: file,
              type: 'docx',
              text,
              isTemplate: isTemplate(file),
              isSoupis: isSoupis(file),
            });
          }
        } catch (err) {
          console.log(`  Warning: Failed to convert .doc ${file}: ${err}`);
        }
      } else {
        console.log(`  Skipping .doc file (LibreOffice not found): ${file}`);
      }
    }
  }

  return documents;
}
