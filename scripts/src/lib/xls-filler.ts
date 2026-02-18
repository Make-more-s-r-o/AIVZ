import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { readFile } from 'fs/promises';
import { callClaude } from './ai-client.js';

interface XlsFillResult {
  buffer: Buffer;
  replacements: Array<{ cell: string; sheet: string; original: string; replacement: string }>;
  costCZK: number;
}

/**
 * Read an Excel file and extract its content as structured text for AI analysis.
 * Supports both .xls (via SheetJS) and .xlsx (via ExcelJS).
 */
async function excelToText(filePath: string): Promise<string> {
  const isLegacyXls = filePath.toLowerCase().endsWith('.xls');
  const lines: string[] = [];

  if (isLegacyXls) {
    const buf = await readFile(filePath);
    const wb = XLSX.read(buf, { type: 'buffer' });
    for (const sheetName of wb.SheetNames) {
      lines.push(`=== Sheet: ${sheetName} ===`);
      const sheet = wb.Sheets[sheetName];
      const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells: string[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const addr = XLSX.utils.encode_cell({ r, c });
          const cell = sheet[addr];
          const val = cell ? String(cell.v ?? '') : '[EMPTY]';
          cells.push(`${addr}=${val}`);
        }
        if (cells.length > 0) lines.push(cells.join(' | '));
      }
    }
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    workbook.eachSheet((sheet) => {
      lines.push(`=== Sheet: ${sheet.name} ===`);
      sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const addr = `${String.fromCharCode(64 + colNumber)}${rowNumber}`;
          const val = cell.value === null || cell.value === undefined ? '[EMPTY]' : String(cell.value);
          cells.push(`${addr}=${val}`);
        });
        if (cells.length > 0) lines.push(cells.join(' | '));
      });
    });
  }

  return lines.join('\n');
}

const XLS_FILL_SYSTEM = `Jsi expert na vyplňování Excel formulářů pro české veřejné zakázky. Dostaneš obsah Excel souboru s označením buněk a data, která máš doplnit.

Identifikuj buňky, které:
- Obsahují "[EMPTY]" a sousedí s popiskem (např. buňka B3 je "IČO:" a C3 je "[EMPTY]")
- Obsahují placeholder text ("doplní účastník", "doplní uchazeč", "vyplní účastník" apod.)
- Obsahují "___" nebo "......" (prázdná pole)

Pro každou buňku k vyplnění vrať:
- "sheet": název listu
- "cell": adresa buňky (např. "C3")
- "original": aktuální obsah buňky
- "replacement": hodnota k vyplnění

PRAVIDLA:
1. Vyplň VŠECHNO, co dokážeš z poskytnutých dat
2. Pokud pro pole nemáš data, nech "[EMPTY]" — nenahrazuj
3. Datum ve formátu "DD.MM.YYYY"
4. Ceny ve formátu "XXX XXX,XX" (s mezerou jako oddělovačem tisíců)
5. Neměň buňky s existujícím obsahem, pokud nejsou placeholdery

Odpověz POUZE validním JSON polem:
[{"sheet": "List1", "cell": "C3", "original": "[EMPTY]", "replacement": "07023987"}, ...]`;

/**
 * Fill an XLS/XLSX template using AI to identify empty cells and fill them.
 * Always saves as .xlsx (neither ExcelJS nor SheetJS community can write legacy .xls).
 */
export async function fillExcelWithAI(
  filePath: string,
  companyData: Record<string, string>,
  tenderData: {
    nazev_zakazky: string;
    evidencni_cislo?: string;
    zadavatel?: string;
    cena_bez_dph?: string;
    cena_s_dph?: string;
    dph?: string;
    datum?: string;
  }
): Promise<XlsFillResult> {
  const isLegacyXls = filePath.toLowerCase().endsWith('.xls');

  // Read and extract text for AI (works for both .xls and .xlsx)
  const excelText = await excelToText(filePath);

  const userMessage = `EXCEL SOUBOR:
---
${excelText}
---

DATA FIRMY (uchazeč/dodavatel):
${Object.entries(companyData).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

DATA ZAKÁZKY:
- Název zakázky: ${tenderData.nazev_zakazky}
${tenderData.evidencni_cislo ? `- Evidenční číslo: ${tenderData.evidencni_cislo}` : ''}
${tenderData.zadavatel ? `- Zadavatel: ${tenderData.zadavatel}` : ''}
${tenderData.cena_bez_dph ? `- Nabídková cena bez DPH: ${tenderData.cena_bez_dph} Kč` : ''}
${tenderData.cena_s_dph ? `- Nabídková cena s DPH: ${tenderData.cena_s_dph} Kč` : ''}
${tenderData.dph ? `- DPH (21%): ${tenderData.dph} Kč` : ''}
- Datum: ${tenderData.datum || new Date().toLocaleDateString('cs-CZ')}

Identifikuj VŠECHNY buňky k vyplnění a vrať JSON pole.`;

  const result = await callClaude(XLS_FILL_SYSTEM, userMessage, {
    maxTokens: 4096,
    temperature: 0.1,
  });

  // Parse AI response
  let replacements: XlsFillResult['replacements'];
  try {
    let jsonStr = result.content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
    if (!jsonStr.startsWith('[')) {
      const start = jsonStr.indexOf('[');
      const end = jsonStr.lastIndexOf(']');
      if (start !== -1 && end > start) jsonStr = jsonStr.slice(start, end + 1);
    }
    replacements = JSON.parse(jsonStr);
  } catch (err) {
    console.log(`    Warning: Failed to parse AI XLS response: ${err}`);
    replacements = [];
  }

  // Apply replacements and write as .xlsx
  // For .xls: read with SheetJS, apply changes, write via SheetJS as xlsx
  // For .xlsx: read with ExcelJS, apply changes, write via ExcelJS
  let buffer: Buffer;
  let appliedCount = 0;

  if (isLegacyXls) {
    const buf = await readFile(filePath);
    const wb = XLSX.read(buf, { type: 'buffer' });
    for (const { sheet: sheetName, cell, replacement } of replacements) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) {
        console.log(`    Warning: Sheet "${sheetName}" not found`);
        continue;
      }
      sheet[cell] = { t: 's', v: replacement };
      appliedCount++;
    }
    const output = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    buffer = Buffer.from(output);
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    for (const { sheet: sheetName, cell, replacement } of replacements) {
      const sheet = workbook.getWorksheet(sheetName);
      if (!sheet) {
        console.log(`    Warning: Sheet "${sheetName}" not found`);
        continue;
      }
      sheet.getCell(cell).value = replacement;
      appliedCount++;
    }
    const arrayBuffer = await workbook.xlsx.writeBuffer();
    buffer = Buffer.from(arrayBuffer);
  }

  console.log(`    XLS replacements: ${appliedCount}/${replacements.length} applied`);

  return { buffer, replacements, costCZK: result.costCZK };
}
