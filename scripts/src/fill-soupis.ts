import ExcelJS from 'exceljs';
import type { PolozkaMatch } from './lib/types.js';
import { extractCastIdFromFilename } from './parse-soupis.js';

export interface SoupisFillResult {
  filename: string;
  outputPath: string;
  totalRows: number;
  filledRows: number;
  skippedRows: number;
  mappings: Array<{
    soupisRow: number;
    soupisName: string;
    matchedItem: string | null;
    priceBezDph: number | null;
    matchMethod: 'index' | 'fuzzy' | 'none';
  }>;
}

// Price column header patterns (Czech)
const PRICE_COL_PATTERNS = {
  unitPriceBezDph: /cena\s*(za)?\s*(jednotku|jedn\.?)?\s*(bez)?\s*dph|jednotkov[áa]\s*cena/i,
  unitPriceSdph: /cena\s*(za)?\s*(jednotku|jedn\.?)?\s*(s|vč\.?|včetně)?\s*dph/i,
  totalPriceBezDph: /cena\s*celkem\s*(bez)?\s*dph|celkov[áa]\s*cena\s*(bez)?\s*dph/i,
};

function normalizeForMatching(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function fuzzyMatch(a: string, b: string): boolean {
  const na = normalizeForMatching(a);
  const nb = normalizeForMatching(b);
  return na.includes(nb) || nb.includes(na);
}

export async function fillSoupisWithPrices(
  soupisPath: string,
  polozkyMatch: PolozkaMatch[],
  outputPath: string,
): Promise<SoupisFillResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(soupisPath);

  const filename = soupisPath.split('/').pop() || soupisPath;

  const sheet = wb.worksheets.find(s => s.rowCount > 3) || wb.worksheets[0];
  if (!sheet) throw new Error(`No worksheets in ${soupisPath}`);

  // Detect header row and price columns
  let headerRow = 0;
  let nazevCol = 0;
  let unitPriceCol = 0;
  let totalPriceCol = 0;
  let mnozstviCol = 0;

  // Search first 10 rows for header
  for (let rowNum = 1; rowNum <= Math.min(10, sheet.rowCount); rowNum++) {
    const row = sheet.getRow(rowNum);
    let hasNazev = false;
    let hasPrice = false;

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const val = String(cell.value || '').trim();
      if (!val) return;
      const normalized = val.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // Name column
      if (/^(nazev|polozka|popis\s*poloz|oznacen)/i.test(normalized)) {
        nazevCol = colNumber;
        hasNazev = true;
      }
      // Quantity column
      if (/^(mnozstv|pocet|ks|mn\.|mj$)/i.test(normalized)) {
        mnozstviCol = colNumber;
      }
      // Unit price column (without "celkem")
      if (PRICE_COL_PATTERNS.unitPriceBezDph.test(val) && !/celkem/i.test(val)) {
        unitPriceCol = colNumber;
        hasPrice = true;
      }
      // Total price column
      if (PRICE_COL_PATTERNS.totalPriceBezDph.test(val)) {
        totalPriceCol = colNumber;
      }
      // Fallback: any "cena" column that's not total
      if (!unitPriceCol && /cena/i.test(val) && !/celkem/i.test(val) && !/s\s*dph/i.test(val)) {
        unitPriceCol = colNumber;
        hasPrice = true;
      }
    });

    if (hasNazev && (hasPrice || unitPriceCol)) {
      headerRow = rowNum;
      break;
    }
  }

  if (!headerRow || !nazevCol) {
    console.log(`  Warning: Could not detect header/name column in ${filename}`);
    return { filename, outputPath, totalRows: 0, filledRows: 0, skippedRows: 0, mappings: [] };
  }

  if (!unitPriceCol) {
    console.log(`  Warning: No price column found in ${filename}, skipping`);
    return { filename, outputPath, totalRows: 0, filledRows: 0, skippedRows: 0, mappings: [] };
  }

  console.log(`  Soupis fill: header row ${headerRow}, name col ${nazevCol}, price col ${unitPriceCol}${totalPriceCol ? `, total col ${totalPriceCol}` : ''}`);

  // Detect part ID from filename and filter polozky_match to this part's items
  const soupisCastId = extractCastIdFromFilename(filename);
  let partItems = polozkyMatch;
  if (soupisCastId) {
    const filtered = polozkyMatch.filter(pm => (pm as any).cast_id === soupisCastId);
    if (filtered.length > 0) {
      partItems = filtered;
      console.log(`  Soupis part filter: Část ${soupisCastId} → ${filtered.length}/${polozkyMatch.length} items`);
    }
  }

  // Build index map from filtered part items using part-local index (0-based within part)
  const indexMap = new Map<number, PolozkaMatch>();
  const nameMap = new Map<string, PolozkaMatch>();
  for (let i = 0; i < partItems.length; i++) {
    const pm = partItems[i];
    indexMap.set(i, pm);  // part-local index
    nameMap.set(normalizeForMatching(pm.polozka_nazev), pm);
  }

  const mappings: SoupisFillResult['mappings'] = [];
  let filledRows = 0;
  let skippedRows = 0;
  let dataRowIndex = 0;

  for (let rowNum = headerRow + 1; rowNum <= sheet.rowCount; rowNum++) {
    const row = sheet.getRow(rowNum);
    const nameCell = row.getCell(nazevCol);
    const nameVal = nameCell.value;
    if (!nameVal || !String(nameVal).trim()) continue;

    const name = String(nameVal).trim();
    // Skip summary rows
    if (/^(celkem|součet|total|suma)/i.test(name)) continue;

    // Try to find matching item
    let matched: PolozkaMatch | undefined;
    let matchMethod: 'index' | 'fuzzy' | 'none' = 'none';

    // 1. Match by index (polozka_index corresponds to soupis row order, 0-based)
    if (indexMap.has(dataRowIndex)) {
      matched = indexMap.get(dataRowIndex);
      matchMethod = 'index';
    }

    // 2. Fallback: fuzzy name match
    if (!matched) {
      const normalizedName = normalizeForMatching(name);
      for (const [key, pm] of nameMap) {
        if (fuzzyMatch(name, pm.polozka_nazev)) {
          matched = pm;
          matchMethod = 'fuzzy';
          break;
        }
      }
    }

    if (matched) {
      // Get the price (user-confirmed or AI-estimated)
      const override = matched.cenova_uprava;
      const selectedProduct = matched.kandidati[matched.vybrany_index];
      const unitPrice = override?.nabidkova_cena_bez_dph ?? selectedProduct.cena_bez_dph;

      // Write unit price
      const priceCell = row.getCell(unitPriceCol);
      priceCell.value = unitPrice;

      // If total price column exists and is NOT a formula, fill it too
      if (totalPriceCol) {
        const totalCell = row.getCell(totalPriceCol);
        const isFormula = totalCell.value && typeof totalCell.value === 'object' && 'formula' in totalCell.value;
        if (!isFormula) {
          const qty = mnozstviCol ? (Number(row.getCell(mnozstviCol).value) || 1) : (matched.mnozstvi || 1);
          totalCell.value = unitPrice * qty;
        }
        // If it IS a formula, leave it — Excel will recalculate
      }

      mappings.push({
        soupisRow: rowNum,
        soupisName: name,
        matchedItem: matched.polozka_nazev,
        priceBezDph: unitPrice,
        matchMethod,
      });
      filledRows++;
    } else {
      mappings.push({
        soupisRow: rowNum,
        soupisName: name,
        matchedItem: null,
        priceBezDph: null,
        matchMethod: 'none',
      });
      skippedRows++;
    }

    dataRowIndex++;
  }

  // Save the filled workbook
  await wb.xlsx.writeFile(outputPath);

  console.log(`  Soupis filled: ${filledRows}/${filledRows + skippedRows} rows, saved to ${outputPath.split('/').pop()}`);

  return {
    filename,
    outputPath,
    totalRows: filledRows + skippedRows,
    filledRows,
    skippedRows,
    mappings,
  };
}
