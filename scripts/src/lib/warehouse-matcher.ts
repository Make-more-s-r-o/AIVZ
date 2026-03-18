/**
 * 3-tier warehouse product matching:
 * Tier 1: Exact match (EAN/MPN) → 0ms, 100% confidence
 * Tier 2: Czech FTS + parametric filters → 5-50ms
 * Tier 3: pgvector semantic similarity → 50-200ms
 */
import { query, isDbAvailable } from './db.js';
import { parseRequirements, buildParameterWhereClause, type ParameterFilter } from './requirement-parser.js';
import { embedQuery } from './embedding-service.js';

// ============================================================
// Typy
// ============================================================

export interface WarehouseMatch {
  product_id: string;
  manufacturer: string;
  model: string;
  ean: string | null;
  part_number: string | null;
  description: string | null;
  parameters_normalized: Record<string, unknown>;
  category_slug: string | null;

  // Cenové údaje
  price_bez_dph: number | null;
  price_s_dph: number | null;
  price_source: string | null;
  price_fetched_at: string | null;

  // Matching metadata
  match_tier: 'exact' | 'text' | 'vector';
  match_score: number;        // 0-1
  text_rank?: number;
  trgm_similarity?: number;
  vector_similarity?: number;
}

export interface MatchRequest {
  /** Název položky z analýzy */
  nazev: string;
  /** Textový popis / specifikace */
  specifikace?: string;
  /** EAN kód (pokud znám) */
  ean?: string;
  /** Part number / MPN (pokud znám) */
  part_number?: string;
  /** Výrobce (pokud znám) */
  manufacturer?: string;
  /** Technické požadavky z analýzy */
  technicke_pozadavky?: Array<{
    parametr: string;
    pozadovana_hodnota: string;
    jednotka?: string | null;
    povinny: boolean;
  }>;
  /** Max počet výsledků */
  limit?: number;
}

export interface MatchResult {
  matches: WarehouseMatch[];
  tier_used: 'exact' | 'text' | 'vector' | 'none';
  search_time_ms: number;
}

// ============================================================
// Hlavní funkce
// ============================================================

/**
 * 3-tier vyhledávání ve skladu.
 * Vrací null pokud DB není dostupná (graceful degradation).
 */
export async function searchWarehouse(request: MatchRequest): Promise<MatchResult | null> {
  if (!(await isDbAvailable())) return null;

  const start = Date.now();
  const limit = request.limit ?? 5;

  // Tier 1: Exact match (EAN / MPN)
  const exactMatches = await tier1Exact(request);
  if (exactMatches.length > 0) {
    return {
      matches: exactMatches.slice(0, limit),
      tier_used: 'exact',
      search_time_ms: Date.now() - start,
    };
  }

  // Tier 2: FTS + parametric filters
  const textMatches = await tier2TextSearch(request, limit);
  if (textMatches.length > 0) {
    return {
      matches: textMatches,
      tier_used: 'text',
      search_time_ms: Date.now() - start,
    };
  }

  // Tier 3: pgvector semantic similarity
  const vectorMatches = await tier3Vector(request, limit);
  if (vectorMatches.length > 0) {
    return {
      matches: vectorMatches,
      tier_used: 'vector',
      search_time_ms: Date.now() - start,
    };
  }

  return {
    matches: [],
    tier_used: 'none',
    search_time_ms: Date.now() - start,
  };
}

// ============================================================
// Tier 1: Exact match (EAN / MPN)
// ============================================================

async function tier1Exact(request: MatchRequest): Promise<WarehouseMatch[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 0;

  if (request.ean) {
    idx++;
    conditions.push(`p.ean = $${idx}`);
    values.push(request.ean);
  }

  if (request.part_number) {
    idx++;
    if (request.manufacturer) {
      idx++;
      conditions.push(`(p.part_number = $${idx - 1} AND lower(p.manufacturer) = lower($${idx}))`);
      values.push(request.part_number, request.manufacturer);
    } else {
      conditions.push(`p.part_number = $${idx}`);
      values.push(request.part_number);
    }
  }

  if (conditions.length === 0) return [];

  const { rows } = await query<WarehouseMatch>(
    `SELECT p.id as product_id, p.manufacturer, p.model, p.ean, p.part_number,
            p.description, p.parameters_normalized,
            pc.slug as category_slug,
            bp.price_bez_dph, bp.price_s_dph,
            ds.name as price_source, bp.fetched_at as price_fetched_at,
            'exact'::text as match_tier,
            1.0::numeric as match_score
     FROM products p
     LEFT JOIN product_categories pc ON p.category_id = pc.id
     LEFT JOIN v_best_prices bp ON p.id = bp.product_id
     LEFT JOIN data_sources ds ON bp.source_id = ds.id
     WHERE (${conditions.join(' OR ')}) AND p.is_active = true
     LIMIT 5`,
    values,
  );

  return rows;
}

// ============================================================
// Tier 2: FTS + parametric filters + trigram
// ============================================================

async function tier2TextSearch(request: MatchRequest, limit: number): Promise<WarehouseMatch[]> {
  const searchText = buildSearchText(request);
  if (!searchText) return [];

  const values: unknown[] = [];
  let idx = 0;
  const conditions: string[] = ['p.is_active = true'];

  // FTS + trigram search
  idx++;
  const ftsParam = `$${idx}`;
  values.push(searchText);

  idx++;
  const trgParam = `$${idx}`;
  values.push(searchText);

  conditions.push(
    `(p.search_vector @@ plainto_tsquery('simple', ${ftsParam}) OR similarity(p.search_text, ${trgParam}) > 0.08)`,
  );

  // Parametric filters from requirements
  if (request.technicke_pozadavky && request.technicke_pozadavky.length > 0) {
    const filters = await parseRequirements(request.technicke_pozadavky);
    // Pouze povinné požadavky jako WHERE filtry
    const mandatoryFilters = filters.filter(f => f.original.povinny);
    if (mandatoryFilters.length > 0) {
      const { clause, values: filterValues, nextParamIdx } = buildParameterWhereClause(mandatoryFilters, idx);
      if (clause) {
        conditions.push(clause);
        values.push(...filterValues);
        idx = nextParamIdx;
      }
    }
  }

  // Manufacturer filter (soft — boost, not exclude)
  let manufacturerBoost = '';
  if (request.manufacturer) {
    idx++;
    manufacturerBoost = `, CASE WHEN lower(p.manufacturer) = lower($${idx}) THEN 0.3 ELSE 0 END`;
    values.push(request.manufacturer);
  }

  idx++;
  values.push(limit);

  const { rows } = await query<WarehouseMatch>(
    `SELECT p.id as product_id, p.manufacturer, p.model, p.ean, p.part_number,
            p.description, p.parameters_normalized,
            pc.slug as category_slug,
            bp.price_bez_dph, bp.price_s_dph,
            ds.name as price_source, bp.fetched_at as price_fetched_at,
            'text'::text as match_tier,
            (ts_rank(p.search_vector, plainto_tsquery('simple', ${ftsParam})) +
             similarity(p.search_text, ${trgParam})${manufacturerBoost})::numeric as match_score,
            ts_rank(p.search_vector, plainto_tsquery('simple', ${ftsParam}))::numeric as text_rank,
            similarity(p.search_text, ${trgParam})::numeric as trgm_similarity
     FROM products p
     LEFT JOIN product_categories pc ON p.category_id = pc.id
     LEFT JOIN v_best_prices bp ON p.id = bp.product_id
     LEFT JOIN data_sources ds ON bp.source_id = ds.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY match_score DESC
     LIMIT $${idx}`,
    values,
  );

  return rows;
}

// ============================================================
// Tier 3: pgvector semantic similarity
// ============================================================

async function tier3Vector(request: MatchRequest, limit: number): Promise<WarehouseMatch[]> {
  const searchText = buildSearchText(request);
  if (!searchText) return [];

  // Potřebujeme OPENAI_API_KEY pro embedding
  if (!process.env.OPENAI_API_KEY) return [];

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedQuery(searchText);
  } catch {
    return [];
  }

  const vectorStr = `[${queryEmbedding.join(',')}]`;

  const { rows } = await query<WarehouseMatch>(
    `SELECT p.id as product_id, p.manufacturer, p.model, p.ean, p.part_number,
            p.description, p.parameters_normalized,
            pc.slug as category_slug,
            bp.price_bez_dph, bp.price_s_dph,
            ds.name as price_source, bp.fetched_at as price_fetched_at,
            'vector'::text as match_tier,
            (1 - (p.embedding <=> $1::vector))::numeric as match_score,
            (1 - (p.embedding <=> $1::vector))::numeric as vector_similarity
     FROM products p
     LEFT JOIN product_categories pc ON p.category_id = pc.id
     LEFT JOIN v_best_prices bp ON p.id = bp.product_id
     LEFT JOIN data_sources ds ON bp.source_id = ds.id
     WHERE p.is_active = true
       AND p.embedding IS NOT NULL
       AND 1 - (p.embedding <=> $1::vector) > 0.55
     ORDER BY p.embedding <=> $1::vector
     LIMIT $2`,
    [vectorStr, limit],
  );

  return rows;
}

// ============================================================
// Helpers
// ============================================================

function buildSearchText(request: MatchRequest): string {
  const parts = [request.nazev];
  if (request.manufacturer) parts.push(request.manufacturer);
  if (request.specifikace) parts.push(request.specifikace.slice(0, 200));
  return parts.join(' ').trim();
}

/**
 * Určí spolehlivost ceny na základě stáří.
 */
export function getPriceConfidence(fetchedAt: string | null): 'vysoka' | 'stredni' | 'nizka' {
  if (!fetchedAt) return 'nizka';
  const ageMs = Date.now() - new Date(fetchedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 7) return 'vysoka';
  if (ageDays <= 30) return 'vysoka'; // stále OK, jen doporučit ověření
  return 'stredni';
}

/**
 * Formátuje zdroj ceny pro výstup.
 */
export function formatPriceSource(
  match: WarehouseMatch,
): string {
  const confidence = getPriceConfidence(match.price_fetched_at);
  const source = match.price_source || 'Cenový sklad';
  const date = match.price_fetched_at
    ? new Date(match.price_fetched_at).toLocaleDateString('cs-CZ')
    : '';

  if (confidence === 'vysoka') {
    return `Cenový sklad — ${source}, ${date}`;
  }
  if (confidence === 'stredni') {
    return `Cenový sklad — ${source}, ${date} — doporučujeme ověřit`;
  }
  return `Cenový sklad — zastaralá cena (${date})`;
}

/**
 * Konvertuje WarehouseMatch na ProductCandidate formát (kompatibilní s AI výstupem).
 */
export function warehouseMatchToCandidate(match: WarehouseMatch): Record<string, unknown> {
  const confidence = getPriceConfidence(match.price_fetched_at);

  return {
    vyrobce: match.manufacturer,
    model: match.model,
    popis: match.description || `${match.manufacturer} ${match.model}`,
    parametry: match.parameters_normalized || {},
    shoda_s_pozadavky: [],
    cena_bez_dph: match.price_bez_dph ? Number(match.price_bez_dph) : 0,
    cena_s_dph: match.price_s_dph ? Number(match.price_s_dph) : (match.price_bez_dph ? Math.round(Number(match.price_bez_dph) * 1.21) : 0),
    cena_spolehlivost: confidence,
    cena_komentar: `Reálná cena z cenového skladu (${match.price_source || 'neznámý zdroj'})`,
    zdroj_ceny: formatPriceSource(match),
    katalogove_cislo: match.part_number || match.ean || undefined,
    dodavatele: match.price_source ? [match.price_source] : [],
    dostupnost: 'dle cenového skladu',
    // Extra: warehouse metadata
    warehouse_product_id: match.product_id,
    match_tier: match.match_tier,
    match_score: match.match_score,
  };
}
