/**
 * Převod technických požadavků z analýzy na SQL WHERE filtry
 * pro parametrické vyhledávání v product_prices_normalized JSONB.
 */
import { query } from './db.js';

interface TechRequirement {
  parametr: string;
  pozadovana_hodnota: string;
  jednotka?: string | null;
  povinny: boolean;
}

export interface ParameterFilter {
  key: string;           // normalized key (ram_gb, ssd_gb, ...)
  operator: '>=' | '<=' | '=' | 'LIKE';
  value: number | string;
  original: TechRequirement;
}

interface SynonymRow {
  canonical_key: string;
  synonym: string;
  regex_pattern: string | null;
}

let synonymCache: SynonymRow[] | null = null;

async function loadSynonyms(): Promise<SynonymRow[]> {
  if (synonymCache) return synonymCache;
  try {
    const { rows } = await query<SynonymRow>(
      'SELECT canonical_key, synonym, regex_pattern FROM parameter_synonyms',
    );
    synonymCache = rows;
    return rows;
  } catch {
    return [];
  }
}

/**
 * Mapuje název parametru z požadavku na kanonický klíč v DB.
 * Např. "Operační paměť" → "ram_gb", "Procesor" → "cpu_model"
 */
async function resolveParamKey(paramName: string): Promise<string | null> {
  const synonyms = await loadSynonyms();
  const lower = paramName.toLowerCase().trim();

  for (const syn of synonyms) {
    if (syn.synonym.toLowerCase() === lower) {
      return syn.canonical_key;
    }
  }

  // Fuzzy match — podřetězce
  for (const syn of synonyms) {
    if (lower.includes(syn.synonym.toLowerCase()) || syn.synonym.toLowerCase().includes(lower)) {
      return syn.canonical_key;
    }
  }

  return null;
}

/**
 * Extrahuje číselnou hodnotu z textového požadavku.
 * "min. 16 GB" → 16, "1920x1080" → "1920x1080", "Intel Core i7" → "Intel Core i7"
 */
function parseRequirementValue(value: string, key: string): { numValue: number | null; textValue: string } {
  const cleaned = value
    .replace(/min\.?\s*/i, '')
    .replace(/max\.?\s*/i, '')
    .replace(/alespoň\s*/i, '')
    .replace(/minimálně\s*/i, '')
    .trim();

  // Extrahuj číslo
  const numMatch = cleaned.match(/(\d+[.,]?\d*)/);
  if (numMatch) {
    let num = parseFloat(numMatch[1].replace(',', '.'));

    // Konverze TB → GB
    if (key.endsWith('_gb') && /tb/i.test(cleaned)) {
      num = num * 1024;
    }

    return { numValue: num, textValue: cleaned };
  }

  return { numValue: null, textValue: cleaned };
}

/**
 * Převede technické požadavky na parametrické SQL filtry.
 */
export async function parseRequirements(
  requirements: TechRequirement[],
): Promise<ParameterFilter[]> {
  const filters: ParameterFilter[] = [];

  for (const req of requirements) {
    const key = await resolveParamKey(req.parametr);
    if (!key) continue;

    const { numValue, textValue } = parseRequirementValue(req.pozadovana_hodnota, key);

    if (numValue !== null) {
      // Numerický parametr — min. hodnota (>=)
      filters.push({
        key,
        operator: '>=',
        value: numValue,
        original: req,
      });
    } else if (textValue) {
      // Textový parametr — LIKE match
      filters.push({
        key,
        operator: 'LIKE',
        value: textValue,
        original: req,
      });
    }
  }

  return filters;
}

/**
 * Sestaví SQL WHERE fragment z parametrických filtrů.
 * Vrací {clause, values, nextParamIdx} pro doplnění do většího dotazu.
 */
export function buildParameterWhereClause(
  filters: ParameterFilter[],
  startParamIdx: number,
): { clause: string; values: unknown[]; nextParamIdx: number } {
  if (filters.length === 0) {
    return { clause: '', values: [], nextParamIdx: startParamIdx };
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = startParamIdx;

  for (const f of filters) {
    if (f.operator === 'LIKE') {
      idx++;
      conditions.push(
        `parameters_normalized->>'${f.key}' ILIKE $${idx}`,
      );
      values.push(`%${f.value}%`);
    } else {
      // Numeric: cast JSONB value to numeric for comparison
      idx++;
      conditions.push(
        `(parameters_normalized->>'${f.key}')::numeric ${f.operator} $${idx}`,
      );
      values.push(f.value);
    }
  }

  return {
    clause: conditions.join(' AND '),
    values,
    nextParamIdx: idx,
  };
}
