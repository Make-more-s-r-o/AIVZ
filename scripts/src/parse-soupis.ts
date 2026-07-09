import ExcelJS from 'exceljs';

export interface SoupisItem {
  cislo: number;
  nazev: string;
  specifikace: string;
  mnozstvi: number;
  jednotka: string;
  kategorie?: string;
  umisteni?: string;
}

export interface SoupisResult {
  filename: string;
  sheetName: string;
  polozky: SoupisItem[];
  cast_id?: string;  // detected part ID from filename (e.g. "A", "B", "1")
}

/**
 * Extract part ID (cast_id) from a filename.
 * Detects patterns like: Část A, Část B, Cast_1, Part 1, Los 1
 */
export function extractCastIdFromFilename(filename: string): string | undefined {
  const normalized = filename.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Czech "Část A", "Cast B", "cast_C"
  const czMatch = normalized.match(/[Cc]ast[\s_]*([A-Za-z0-9]+)/i);
  if (czMatch) return czMatch[1].toUpperCase();
  // English "Part 1", "Part A"
  const enMatch = normalized.match(/Part[\s_]*(\d+|[A-Za-z])\b/i);
  if (enMatch) return enMatch[1].toUpperCase();
  // "Los 1", "Los A"
  const losMatch = normalized.match(/Los[\s_]*(\d+|[A-Za-z])\b/i);
  if (losMatch) return losMatch[1].toUpperCase();
  return undefined;
}

// Common header patterns for auto-detection (Czech tender soupis files)
// POZOR na `cislo`: dřívější holé `pol` greedy matchlo i „Položka" (názvový sloupec) →
// cislo i nazev ukazovaly na TENTÝŽ sloupec a numerický P.č. filtr zahodil VŠECHNY řádky
// (kancelarsky-material: 132 položek → tiše 0 → 1 lumpovaná). Proto jen „Pol. č." varianty.
const HEADER_PATTERNS = {
  cislo: /^(č[ií]slo|po[řr]\.?\s*[čc]|#|p\.č\.|pol\.?\s*[čc]|č\.)/i,
  nazev: /^(n[áa]zev|polo[žz]ka|popis\s*polo|ozna[čc]en[ií])/i,
  specifikace: /^(popis|specifikace|minim[áa]ln[ií]|tech.*param|pozn[áa]mka)/i,
  mnozstvi: /^(mno[žz]stv[ií]|po[čc]et|ks|mn\.|mj)/i,
  jednotka: /^(jednotka|mj|m\.j\.|jedn)/i,
  kategorie: /^(hashtag|kategorie|typ|druh|skupina)/i,
  umisteni: /^(um[ií]st[ěe]n[ií]|m[ií]stnost|lokace)/i,
};

/**
 * Detect header row by matching column names against known patterns.
 * Returns column mapping if found, null otherwise.
 */
function detectHeaders(sheet: ExcelJS.Worksheet): {
  headerRow: number;
  cols: {
    cislo?: number;
    nazev?: number;
    specifikace?: number;
    mnozstvi?: number;
    jednotka?: number;
    kategorie?: number;
    umisteni?: number;
  };
} | null {
  // Search first 50 rows for header. Some tender soupis files have a long preamble
  // (instructions, qualification text); e.g. N-485400 has its data-table header on row 22.
  for (let rowNum = 1; rowNum <= Math.min(50, sheet.rowCount); rowNum++) {
    const row = sheet.getRow(rowNum);
    const cols: Record<string, number> = {};
    let matchCount = 0;

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const val = String(getCellValue(cell) ?? '').trim();
      if (!val) return;

      for (const [key, pattern] of Object.entries(HEADER_PATTERNS)) {
        if (pattern.test(val) && !cols[key]) {
          cols[key] = colNumber;
          matchCount++;
        }
      }
    });

    // Jeden sloupec nesmí sloužit zároveň jako číslo I název — název má prioritu.
    // (Obrana proti pattern kolizi: kdyby se to stalo, P.č. filtr by porovnával názvy
    // položek s /^\d+$/ a tiše zahodil všechny datové řádky.)
    if (cols.cislo !== undefined && cols.cislo === cols.nazev) {
      delete cols.cislo;
    }

    // Need at least nazev column to be useful
    if (cols.nazev && matchCount >= 2) {
      return { headerRow: rowNum, cols };
    }
  }

  return null;
}

/**
 * Get cell value, handling formulas (use computed result).
 */
function getCellValue(cell: ExcelJS.Cell): string | number | null {
  const v = cell.value as any;
  if (v === null || v === undefined) return null;

  if (typeof v === 'object') {
    // Rich text cell ({ richText: [{ text }, ...] }) — concatenate runs.
    // Without this, String(cell.value) yields '[object Object]'.
    if (Array.isArray(v.richText)) {
      const t = v.richText.map((rt: any) => rt.text || '').join('');
      return t === '' ? null : t;
    }
    // Formula / shared-formula cell — use the computed result
    if ('result' in v) return v.result ?? null;
    // Hyperlink cell ({ text, hyperlink })
    if ('text' in v) return v.text ?? null;
    if (v instanceof Date) return v.toISOString();
    return null;
  }

  return v as string | number;
}

/**
 * Parse a soupis XLSX file into structured items.
 */
export async function parseSoupis(filePath: string): Promise<SoupisResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // Use the first sheet that has data
  const sheet = wb.worksheets.find(s => s.rowCount > 3) || wb.worksheets[0];
  if (!sheet) {
    throw new Error(`No worksheets found in ${filePath}`);
  }

  const headers = detectHeaders(sheet);
  if (!headers) {
    throw new Error(`Could not detect header row in ${filePath} (sheet: ${sheet.name})`);
  }

  const { headerRow, cols } = headers;
  const polozky: SoupisItem[] = [];

  for (let rowNum = headerRow + 1; rowNum <= sheet.rowCount; rowNum++) {
    const row = sheet.getRow(rowNum);

    // The data table consists only of rows with a numeric item number (P.č.) in the číslo
    // column. This excludes the totals block ("Celková cena") and the per-item spec blocks
    // ("Položka č. N ...") that follow the table — those are often merged across all columns,
    // so their text leaks into the name column and would otherwise be parsed as items.
    const cisloCell = cols.cislo ? getCellValue(row.getCell(cols.cislo)) : null;
    const isItemNumber = cisloCell != null && /^\s*\d+\s*\.?\s*$/.test(String(cisloCell).trim());
    if (cols.cislo && !isItemNumber) continue;

    // Get name — skip empty rows
    const nazevVal = cols.nazev ? getCellValue(row.getCell(cols.nazev)) : null;
    if (!nazevVal || !String(nazevVal).trim()) continue;
    const nazev = String(nazevVal).trim();

    // Skip summary/total rows (Czech: celkem / celková / součet ...)
    if (/^(celkem|celkov|součet|soucet|total|suma)/i.test(nazev)) continue;

    // Item number
    const cislo = isItemNumber ? parseInt(String(cisloCell).replace(/[^\d]/g, ''), 10) : polozky.length + 1;

    const specVal = cols.specifikace ? getCellValue(row.getCell(cols.specifikace)) : null;
    const specifikace = specVal ? String(specVal).trim() : '';

    const mnozstviVal = cols.mnozstvi ? getCellValue(row.getCell(cols.mnozstvi)) : null;
    const mnozstvi = typeof mnozstviVal === 'number' ? mnozstviVal :
      mnozstviVal ? parseInt(String(mnozstviVal)) || 1 : 1;

    const jednotkaVal = cols.jednotka ? getCellValue(row.getCell(cols.jednotka)) : null;
    const jednotka = jednotkaVal ? String(jednotkaVal).trim() : 'ks';

    const kategorieVal = cols.kategorie ? getCellValue(row.getCell(cols.kategorie)) : null;
    const kategorie = kategorieVal ? String(kategorieVal).trim() : undefined;

    const umisteniVal = cols.umisteni ? getCellValue(row.getCell(cols.umisteni)) : null;
    const umisteni = umisteniVal ? String(umisteniVal).trim() : undefined;

    polozky.push({
      cislo,
      nazev,
      specifikace,
      mnozstvi,
      jednotka,
      kategorie,
      umisteni,
    });
  }

  const filename = filePath.split('/').pop() || filePath;
  const cast_id = extractCastIdFromFilename(filename);
  console.log(`  Soupis parsed: ${filename} → ${polozky.length} items (sheet: ${sheet.name})${cast_id ? ` [Část ${cast_id}]` : ''}`);

  return {
    filename,
    sheetName: sheet.name,
    polozky,
    cast_id,
  };
}
