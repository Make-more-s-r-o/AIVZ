/**
 * CSV/Excel importer pro cenový sklad.
 * Parsuje soubor → AI navrhne mapování sloupců → preview → batch upsert.
 */
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { readFile } from 'fs/promises';
import { extname } from 'path';
import { callClaude } from './ai-client.js';
import { upsertProduct, upsertPrice, resolveManufacturer, type CreateProductInput } from './warehouse-store.js';
import { normalizeParameters } from './param-normalizer.js';

// ============================================================
// Typy
// ============================================================

export interface ColumnMapping {
  /** Index sloupce v souboru (0-based) */
  source_index: number;
  /** Název sloupce v souboru */
  source_name: string;
  /** Cílové pole v DB */
  target_field: string | null;
}

export interface ImportPreview {
  filename: string;
  total_rows: number;
  columns: string[];
  suggested_mapping: ColumnMapping[];
  sample_rows: Record<string, string>[];
}

export interface ImportResult {
  total_rows: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; error: string }>;
}

// Cílová pole pro mapování
const TARGET_FIELDS = [
  'manufacturer', 'model', 'ean', 'part_number', 'description',
  'price_bez_dph', 'price_s_dph', 'category', 'product_family',
  'image_url', 'hmotnost_kg', 'zaruka_mesice', 'availability',
  'stock_quantity', 'delivery_days', 'source_url', 'source_sku',
  'ignore',
] as const;

// ============================================================
// Parsování souborů
// ============================================================

interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

async function parseExcelFile(filePath: string): Promise<ParsedSheet> {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.xls') {
    // Starší XLS — použít xlsx knihovnu
    const buffer = await readFile(filePath);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { header: 1, raw: false });

    if (json.length === 0) return { headers: [], rows: [] };

    const headers = (json[0] as any as string[]).map((h) => String(h ?? '').trim());
    const rows = json.slice(1).map((row: any) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        if (h) obj[h] = String(row[i] ?? '').trim();
      });
      return obj;
    });

    return { headers, rows };
  }

  // XLSX/CSV — ExcelJS
  const workbook = new ExcelJS.Workbook();
  if (ext === '.csv') {
    await workbook.csv.readFile(filePath);
  } else {
    await workbook.xlsx.readFile(filePath);
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet || worksheet.rowCount === 0) {
    return { headers: [], rows: [] };
  }

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? '').trim();
  });

  const rows: Record<string, string>[] = [];
  for (let i = 2; i <= worksheet.rowCount; i++) {
    const row = worksheet.getRow(i);
    const obj: Record<string, string> = {};
    let hasData = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const header = headers[colNumber - 1];
      if (header) {
        const val = String(cell.value ?? '').trim();
        obj[header] = val;
        if (val) hasData = true;
      }
    });
    if (hasData) rows.push(obj);
  }

  return { headers: headers.filter(Boolean), rows };
}

// ============================================================
// AI mapování sloupců
// ============================================================

async function suggestColumnMapping(
  headers: string[],
  sampleRows: Record<string, string>[],
): Promise<ColumnMapping[]> {
  const sampleData = sampleRows.slice(0, 5).map((row) => {
    const subset: Record<string, string> = {};
    headers.forEach((h) => {
      if (row[h]) subset[h] = row[h];
    });
    return subset;
  });

  const systemPrompt = `Jsi expert na mapování dat. Analyzuj sloupce ceníku a přiřaď je k cílovým polím produktové databáze.

Cílová pole:
- manufacturer — výrobce/značka
- model — název/model produktu
- ean — EAN/GTIN kód (13 číslic)
- part_number — katalogové číslo / MPN / SKU výrobce
- description — popis produktu
- price_bez_dph — cena bez DPH (číslo)
- price_s_dph — cena s DPH (číslo)
- category — kategorie produktu
- product_family — produktová řada
- image_url — URL obrázku
- hmotnost_kg — hmotnost v kg
- zaruka_mesice — záruka v měsících
- availability — dostupnost (text)
- stock_quantity — počet kusů na skladě
- delivery_days — dodací lhůta ve dnech
- source_url — URL produktu v e-shopu
- source_sku — SKU v daném e-shopu/distribuci
- ignore — sloupec ignorovat

DŮLEŽITÉ: Pokud sloupec neodpovídá žádnému poli, použij "ignore".
Pokud je výrobce obsažen v názvu produktu, mapuj název na "model" a výrobce na "manufacturer".

Vrať POUZE JSON pole:
[{"source_index": 0, "source_name": "...", "target_field": "..."}]`;

  const userMessage = `Sloupce: ${JSON.stringify(headers)}

Vzorová data (první 5 řádků):
${JSON.stringify(sampleData, null, 2)}`;

  const result = await callClaude(systemPrompt, userMessage, {
    maxTokens: 2048,
    temperature: 0,
    model: 'haiku',
  });

  try {
    const jsonMatch = result.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found');
    return JSON.parse(jsonMatch[0]);
  } catch {
    // Fallback: heuristické mapování
    return headers.map((h, i) => ({
      source_index: i,
      source_name: h,
      target_field: guessTargetField(h),
    }));
  }
}

/** Heuristické mapování podle názvu sloupce */
function guessTargetField(header: string): string {
  const h = header.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/vyrobce|znacka|brand|manufacturer/i.test(h)) return 'manufacturer';
  if (/^nazev|^model|product.?name|nazev.?produktu/i.test(h)) return 'model';
  if (/ean|gtin|barcode/i.test(h)) return 'ean';
  if (/part.?n|mpn|sku|katalog|cislo/i.test(h)) return 'part_number';
  if (/popis|description|detail/i.test(h)) return 'description';
  if (/cena.?bez|price.?ex|netto/i.test(h)) return 'price_bez_dph';
  if (/cena.?s|price.?inc|brutto|moc/i.test(h)) return 'price_s_dph';
  if (/kategori|category/i.test(h)) return 'category';
  if (/url|link|odkaz/i.test(h)) return 'source_url';
  if (/dostupn|avail|stock|sklad/i.test(h)) return 'availability';
  if (/obraz|image|foto/i.test(h)) return 'image_url';
  if (/hmotnost|weight|vaha/i.test(h)) return 'hmotnost_kg';
  if (/zaruk|warranty|garanci/i.test(h)) return 'zaruka_mesice';
  return 'ignore';
}

// ============================================================
// Preview
// ============================================================

export async function getImportPreview(filePath: string): Promise<ImportPreview> {
  const { headers, rows } = await parseExcelFile(filePath);
  const sampleRows = rows.slice(0, 10);
  const suggested_mapping = await suggestColumnMapping(headers, sampleRows);

  return {
    filename: filePath.split('/').pop() ?? '',
    total_rows: rows.length,
    columns: headers,
    suggested_mapping,
    sample_rows: sampleRows,
  };
}

// ============================================================
// Import
// ============================================================

export async function runImport(
  filePath: string,
  mapping: ColumnMapping[],
  options: {
    source_id: number;
    category_id?: number;
    dry_run?: boolean;
    enrich_params?: boolean;
  },
): Promise<ImportResult> {
  const { headers, rows } = await parseExcelFile(filePath);

  // Vytvořit mapovací lookup: target_field → source_name
  const fieldMap = new Map<string, string>();
  for (const m of mapping) {
    if (m.target_field && m.target_field !== 'ignore') {
      fieldMap.set(m.target_field, m.source_name);
    }
  }

  const getValue = (row: Record<string, string>, field: string): string => {
    const sourceCol = fieldMap.get(field);
    return sourceCol ? (row[sourceCol] ?? '').trim() : '';
  };

  const result: ImportResult = {
    total_rows: rows.length,
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    try {
      const rawManufacturer = getValue(row, 'manufacturer');
      const model = getValue(row, 'model');

      if (!model) {
        result.skipped++;
        continue;
      }

      // Resolve manufacturer alias
      const manufacturer = rawManufacturer
        ? await resolveManufacturer(rawManufacturer)
        : extractManufacturer(model);

      const input: CreateProductInput = {
        manufacturer,
        model,
        ean: getValue(row, 'ean') || null,
        part_number: getValue(row, 'part_number') || null,
        category_id: options.category_id ?? null,
        product_family: getValue(row, 'product_family') || null,
        description: getValue(row, 'description') || null,
        raw_description: buildRawDescription(row, headers),
        image_url: getValue(row, 'image_url') || null,
        hmotnost_kg: parseFloat(getValue(row, 'hmotnost_kg')) || null,
        zaruka_mesice: parseInt(getValue(row, 'zaruka_mesice')) || null,
        zdroj_dat: 'csv_import',
      };

      // AI normalizace parametrů z popisu
      if (options.enrich_params && input.description) {
        try {
          const normalized = await normalizeParameters(
            input.description,
            input.raw_description ?? '',
          );
          input.parameters_normalized = normalized;
        } catch {
          // Non-fatal — import pokračuje bez normalizovaných parametrů
        }
      }

      if (options.dry_run) {
        result.imported++;
        continue;
      }

      const { product, created } = await upsertProduct(input);
      if (created) {
        result.imported++;
      } else {
        result.updated++;
      }

      // Upsert ceny pokud máme
      const priceBez = parsePrice(getValue(row, 'price_bez_dph'));
      const priceS = parsePrice(getValue(row, 'price_s_dph'));
      if (priceBez > 0) {
        await upsertPrice({
          product_id: product.id,
          source_id: options.source_id,
          price_bez_dph: priceBez,
          price_s_dph: priceS || null,
          availability: getValue(row, 'availability') || null,
          stock_quantity: parseInt(getValue(row, 'stock_quantity')) || null,
          delivery_days: parseInt(getValue(row, 'delivery_days')) || null,
          source_url: getValue(row, 'source_url') || null,
          source_sku: getValue(row, 'source_sku') || null,
        });
      }
    } catch (err: any) {
      result.errors.push({ row: i + 2, error: err.message || String(err) });
      if (result.errors.length > 100) {
        result.errors.push({ row: 0, error: 'Too many errors, stopping import' });
        break;
      }
    }
  }

  return result;
}

// ============================================================
// Helpery
// ============================================================

function parsePrice(val: string): number {
  if (!val) return 0;
  // Odstranit měnu, mezery, nahradit čárku tečkou
  const cleaned = val.replace(/[^\d,.-]/g, '').replace(',', '.');
  return parseFloat(cleaned) || 0;
}

/** Extrahuje výrobce z názvu produktu (první slovo) */
function extractManufacturer(model: string): string {
  const parts = model.split(/[\s-]+/);
  return parts[0] || 'Unknown';
}

/** Sestaví raw popis ze všech sloupců (pro AI enrichment) */
function buildRawDescription(row: Record<string, string>, headers: string[]): string {
  return headers
    .map((h) => row[h] ? `${h}: ${row[h]}` : '')
    .filter(Boolean)
    .join('\n');
}
