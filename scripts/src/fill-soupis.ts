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
    matchMethod: 'cislo' | 'index' | 'fuzzy' | 'none';
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

/**
 * Read a cell as text, handling ExcelJS rich-text / formula / hyperlink objects.
 * String(cell.value) on a rich-text cell yields '[object Object]', which silently
 * breaks name matching and corrupts the audit log — so always go through this.
 */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as any;
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
  let cisloCol = 0;
  let nazevCol = 0;
  let unitPriceCol = 0;
  let totalPriceCol = 0;
  let mnozstviCol = 0;

  // Search first 50 rows for header. Some tender soupis have a long preamble before the
  // data table (instructions, qualification text); e.g. N-485400 header is on row 22.
  for (let rowNum = 1; rowNum <= Math.min(50, sheet.rowCount); rowNum++) {
    const row = sheet.getRow(rowNum);
    let hasNazev = false;
    let hasPrice = false;

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const val = cellText(cell).trim();
      if (!val) return;
      const normalized = val.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

      // Item-number column (P.\u010d. / po\u0159adov\u00e9 \u010d\u00edslo) \u2014 stable matching key
      if (!cisloCol && /^(p\.?\s*c\.?|por\.?\s*c|cislo|poradi|#)/i.test(normalized)) {
        cisloCol = colNumber;
      }
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

  // Build maps for matching soupis rows to priced items:
  //  - byPolozkaIndex: stable key = analysis polozka_index (soupis "P.č." - 1)
  //  - indexMap: part-local positional fallback
  //  - nameMap: fuzzy-name fallback
  const byPolozkaIndex = new Map<number, PolozkaMatch>();
  const indexMap = new Map<number, PolozkaMatch>();
  const nameMap = new Map<string, PolozkaMatch>();
  for (let i = 0; i < partItems.length; i++) {
    const pm = partItems[i];
    if (typeof pm.polozka_index === 'number') byPolozkaIndex.set(pm.polozka_index, pm);
    indexMap.set(i, pm);  // part-local index
    nameMap.set(normalizeForMatching(pm.polozka_nazev), pm);
  }

  const mappings: SoupisFillResult['mappings'] = [];
  let filledRows = 0;
  let skippedRows = 0;
  let dataRowIndex = 0;

  for (let rowNum = headerRow + 1; rowNum <= sheet.rowCount; rowNum++) {
    const row = sheet.getRow(rowNum);

    // Only fill actual table rows — those with a numeric item number (P.č.). Excludes the
    // totals block and the per-item spec blocks ("Položka č. N ...") after the table (often
    // merged across all columns, so their text would otherwise look like a data row).
    const cisloText = cisloCol ? cellText(row.getCell(cisloCol)).trim() : '';
    const isItemRow = cisloCol ? /^\d+\.?$/.test(cisloText) : true;
    if (cisloCol && !isItemRow) continue;

    const name = cellText(row.getCell(nazevCol)).trim();
    if (!name) continue;

    // Skip summary rows (Czech: celkem / celková / součet ...)
    if (/^(celkem|celkov|součet|soucet|total|suma)/i.test(name)) continue;

    // Stable key: item number (P.č.) → polozka_index (P.č. - 1)
    const pc: number | null = isItemRow && cisloText ? parseInt(cisloText.replace(/[^\d]/g, ''), 10) : null;

    // Find matching item: 1) by P.č., 2) positional, 3) fuzzy name
    let matched: PolozkaMatch | undefined;
    let matchMethod: 'cislo' | 'index' | 'fuzzy' | 'none' = 'none';

    if (pc !== null && byPolozkaIndex.has(pc - 1)) {
      matched = byPolozkaIndex.get(pc - 1);
      matchMethod = 'cislo';
    }
    if (!matched && indexMap.has(dataRowIndex)) {
      matched = indexMap.get(dataRowIndex);
      matchMethod = 'index';
    }
    if (!matched) {
      for (const [, pm] of nameMap) {
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
      const unitPrice = override?.nabidkova_cena_bez_dph ?? selectedProduct?.cena_bez_dph ?? 0;
      const unitPriceSdph = override?.nabidkova_cena_s_dph ?? selectedProduct?.cena_s_dph ?? 0;

      // C3: warn if the unit price breaches the per-item hard cap. We never add markers
      // to the buyer's binding form (that could invalidate it) — validation flags it instead.
      if (matched.cena_max_s_dph && unitPriceSdph > matched.cena_max_s_dph) {
        console.warn(`  ⚠ Cap exceeded: "${matched.polozka_nazev}" ${unitPriceSdph} Kč s DPH > limit ${matched.cena_max_s_dph} Kč (row ${rowNum})`);
      }
      if (unitPrice <= 0) {
        console.warn(`  ⚠ Zero/missing price for "${matched.polozka_nazev}" (row ${rowNum})`);
      }

      // Write unit price
      row.getCell(unitPriceCol).value = unitPrice;

      // Write the per-row total as a static computed number so the binding offer is correct
      // even in viewers that don't recalculate formulas (template cells are =G*H / shared formulas).
      if (totalPriceCol) {
        const qty = mnozstviCol ? (Number(cellText(row.getCell(mnozstviCol))) || 1) : (matched.mnozstvi || 1);
        row.getCell(totalPriceCol).value = Math.round(unitPrice * qty * 100) / 100;
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

  // Completeness asserts: every priced item should land on a row, and no data row blank.
  if (filledRows < partItems.length) {
    console.warn(`  ⚠ Soupis fill incomplete: filled ${filledRows} rows but had ${partItems.length} priced items (${partItems.length - filledRows} unmatched) — check P.č./name alignment.`);
  }
  if (skippedRows > 0) {
    console.warn(`  ⚠ Soupis fill: ${skippedRows} data rows had NO matching priced item (left blank).`);
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
