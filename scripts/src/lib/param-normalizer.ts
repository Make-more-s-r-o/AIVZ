/**
 * Normalizace parametrů produktů.
 * 1. Regex matching přes parameter_synonyms tabulku
 * 2. AI fallback (Haiku) pro složité popisy
 */
import { query } from './db.js';
import { callClaude } from './ai-client.js';

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

/** Invalidovat cache (po změně synonymů) */
export function invalidateSynonymCache(): void {
  synonymCache = null;
}

/**
 * Extrahuje normalizované parametry z textového popisu produktu.
 * Kombinuje regex matching z DB synonymů + AI fallback.
 */
export async function normalizeParameters(
  description: string,
  rawDescription?: string,
): Promise<Record<string, unknown>> {
  const text = `${description}\n${rawDescription ?? ''}`;
  const params: Record<string, unknown> = {};

  // 1. Regex matching přes synonymy
  const synonyms = await loadSynonyms();
  for (const syn of synonyms) {
    if (!syn.regex_pattern) continue;
    try {
      const regex = new RegExp(syn.regex_pattern, 'i');
      const match = text.match(regex);
      if (match && match[1]) {
        const value = parseNumericValue(match[1], syn.canonical_key);
        if (value !== null) {
          params[syn.canonical_key] = value;
        }
      }
    } catch {
      // Invalid regex — skip
    }
  }

  // 2. Pokud regex nic nenašel, AI fallback
  if (Object.keys(params).length === 0 && text.length > 20) {
    try {
      const aiParams = await extractParamsWithAI(text);
      Object.assign(params, aiParams);
    } catch {
      // Non-fatal
    }
  }

  return params;
}

function parseNumericValue(raw: string, key: string): number | string | null {
  // Čárka → tečka
  const cleaned = raw.replace(',', '.').trim();
  const num = parseFloat(cleaned);
  if (isNaN(num)) return cleaned || null;

  // Konverze TB → GB pro storage parametry
  if (key.endsWith('_gb') && /tb/i.test(raw)) {
    return num * 1024;
  }

  return num;
}

/**
 * AI extrakce parametrů z popisu (Haiku — levný a rychlý).
 */
async function extractParamsWithAI(text: string): Promise<Record<string, unknown>> {
  const systemPrompt = `Extrahuj strukturované technické parametry z popisu produktu. Vrať POUZE JSON objekt s normalizovanými klíči.

Klíče používej v angličtině s jednotkou:
- ram_gb, ssd_gb, hdd_gb, cpu_model, cpu_cores, gpu, display_size, resolution
- weight_kg, battery_wh, build_x_mm, build_y_mm, build_z_mm
- lumens, contrast_ratio, technology, os, warranty_months

Hodnoty: čísla bez jednotek (ram_gb: 16, ne "16 GB"). Text tam, kde číslo nedává smysl (cpu_model: "Intel Core i7-1365U").

Pokud parametr nelze z textu určit, NEZAHRNUJ ho.`;

  const result = await callClaude(systemPrompt, text.slice(0, 2000), {
    maxTokens: 1024,
    temperature: 0,
    model: 'haiku',
  });

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

/**
 * Batch normalizace — efektivnější pro velké importy.
 * Zpracuje max 10 produktů v jednom AI callu.
 */
export async function normalizeParametersBatch(
  items: Array<{ id: string; description: string }>,
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  const batchSize = 10;

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    const systemPrompt = `Pro každý produkt extrahuj normalizované technické parametry. Vrať JSON objekt kde klíče jsou ID produktů a hodnoty jsou objekty s parametry.

Parametrové klíče: ram_gb, ssd_gb, hdd_gb, cpu_model, cpu_cores, gpu, display_size, resolution, weight_kg, battery_wh, lumens, contrast_ratio, technology, os, warranty_months, build_x_mm, build_y_mm, build_z_mm, nozzle_temp_max, bed_temp_max, layer_min_mm.

Hodnoty: čísla bez jednotek. Nezahrnuj parametry, které nelze určit.`;

    const userMessage = batch
      .map((item) => `[${item.id}]: ${item.description.slice(0, 500)}`)
      .join('\n\n');

    try {
      const aiResult = await callClaude(systemPrompt, userMessage, {
        maxTokens: 4096,
        temperature: 0,
        model: 'haiku',
      });

      const jsonMatch = aiResult.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        for (const [id, params] of Object.entries(parsed)) {
          if (typeof params === 'object' && params !== null) {
            result.set(id, params as Record<string, unknown>);
          }
        }
      }
    } catch {
      // Non-fatal — pokračuj s dalším batchem
    }
  }

  return result;
}
