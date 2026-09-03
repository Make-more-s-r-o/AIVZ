import type {
  HlidacFetchResult,
  SourceHealth,
} from './hlidac-client.js';
import type { NenFetchOptions, NenFetchResult } from './nen-client.js';
import {
  toHlidacFeedInput,
  toNenFeedInput,
  type FeedUpsertInput,
} from './monitoring-store.js';

export type MonitoringSource = 'nen' | 'hlidac' | 'both';

export const DEFAULT_MAX_QUERIES_PER_SYNC = 14;
export const DEFAULT_MONITORING_QUERY_DELAY_MS = 500;
export const DEFAULT_MAX_PAGES_PER_QUERY = 3;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Provozní pojistky lze změnit prostředím; výchozí limit pokryje 14 schválených výrazů. */
export const MAX_QUERIES_PER_SYNC = positiveInteger(
  process.env.MONITORING_MAX_QUERIES_PER_SYNC,
  DEFAULT_MAX_QUERIES_PER_SYNC,
);
export const MONITORING_QUERY_DELAY_MS = nonNegativeInteger(
  process.env.MONITORING_QUERY_DELAY_MS,
  DEFAULT_MONITORING_QUERY_DELAY_MS,
);
export const MAX_PAGES_PER_QUERY = positiveInteger(
  process.env.MONITORING_MAX_PAGES_PER_QUERY,
  DEFAULT_MAX_PAGES_PER_QUERY,
);

export interface MonitoringRequestCounts {
  nen: number;
  hlidac: number;
  total: number;
}

export interface MonitoringQueryCounts {
  /** Počet dodaných logických dotazů; prázdné pole se počítá jako jeden prázdný dotaz. */
  requested: number;
  /** Počet unikátních dotazů, které sync skutečně zpracoval. */
  processed: number;
  /** Počet unikátních dotazů odříznutých provozním limitem. */
  dropped: number;
  /** Počet duplicit odstraněných před aplikací limitu. */
  deduplicated: number;
}

export interface MonitoringSyncLimits {
  maxQueries: number;
  maxPagesPerQuery: number;
  /** Tvrdý rozpočet HTTP požadavků jednoho zdroje pro tento sync. */
  maxRequestsPerSource: number;
  /** Horní mez přes zdroje, které mohou být v daném režimu skutečně osloveny. */
  maxRequestsTotal: number;
}

export interface MonitoringSyncResult {
  inputs: FeedUpsertInput[];
  zdroje_pouzite: string[];
  health: Partial<Record<Exclude<MonitoringSource, 'both'>, SourceHealth>>;
  requests: MonitoringRequestCounts;
  queries: MonitoringQueryCounts;
  limits: MonitoringSyncLimits;
  varovani?: string;
}

/** Plná produkční odpověď NEN; volitelnost metrik zachovává kompatibilitu testovacích stubů. */
export type NenSyncFetchResult = Pick<NenFetchResult, 'items' | 'ok'>
  & Partial<Omit<NenFetchResult, 'items' | 'ok'>>;

export interface MonitoringPageOptions {
  maxPages?: number;
}

export interface MonitoringSyncDeps {
  fetchNen: (query: string, options?: NenFetchOptions & MonitoringPageOptions) => Promise<NenSyncFetchResult>;
  fetchHlidac: (
    query: string,
    options?: MonitoringPageOptions,
  ) => Promise<HlidacFetchResult>;
  sleep?: (ms: number) => Promise<void>;
  maxQueries?: number;
  queryDelayMs?: number;
  maxPagesPerQuery?: number;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Sestaví sync vstupy včetně fallbacku z NEN na Hlídač a diagnostiky zdrojů. */
export async function collectMonitoringInputs(
  source: MonitoringSource,
  query: string | string[],
  hasHlidacToken: boolean,
  deps: MonitoringSyncDeps,
): Promise<MonitoringSyncResult> {
  const rawQueries = (Array.isArray(query) ? query : [query]).map((value) => value.trim());
  const effectiveQueries = rawQueries.length > 0 ? rawQueries : [''];
  const uniqueQueries = [...new Set(effectiveQueries)];
  const maxQueries = positiveInteger(deps.maxQueries, MAX_QUERIES_PER_SYNC);
  const maxPagesPerQuery = positiveInteger(deps.maxPagesPerQuery, MAX_PAGES_PER_QUERY);
  const queryDelayMs = nonNegativeInteger(deps.queryDelayMs, MONITORING_QUERY_DELAY_MS);
  const sleep = deps.sleep ?? delay;
  const selectedQueries = uniqueQueries.slice(0, maxQueries);
  const droppedQueries = Math.max(0, uniqueQueries.length - selectedQueries.length);

  const bySourceId = new Map<string, FeedUpsertInput>();
  const zdroje = new Set<string>();
  const warnings = new Set<string>();
  const observedHealth: Record<'nen' | 'hlidac', SourceHealth[]> = { nen: [], hlidac: [] };
  const requests: MonitoringRequestCounts = { nen: 0, hlidac: 0, total: 0 };

  if (droppedQueries > 0) {
    warnings.add(
      `Monitoring zpracoval ${selectedQueries.length} z ${uniqueQueries.length} unikátních dotazů; `
      + `${droppedQueries} bylo odříznuto limitem.`,
    );
  }

  for (let queryIndex = 0; queryIndex < selectedQueries.length; queryIndex += 1) {
    const currentQuery = selectedQueries[queryIndex];
    let useHlidac = source === 'hlidac' || source === 'both';

    if (source === 'nen' || source === 'both') {
      zdroje.add('nen');
      const nen = await fetchNenSafely(deps, currentQuery, maxPagesPerQuery);
      const nenHealth = healthForNen(nen);
      observedHealth.nen.push(nenHealth);
      requests.nen += requestCount(nen.requests, 1);
      if (nen.warning) warnings.add(nen.warning);
      for (const candidate of nen.items) {
        const input = toNenFeedInput(candidate);
        if (!bySourceId.has(input.zdroj_id)) bySourceId.set(input.zdroj_id, input);
      }

      if (nenHealth !== 'ok' || nen.items.length === 0) {
        const reason = nenHealth === 'ok'
          ? 'NEN nevrátil žádné položky.'
          : nenHealth === 'partial'
            ? 'NEN vrátil jen částečné výsledky.'
            : 'NEN se nepodařilo načíst.';
        if (hasHlidacToken) {
          useHlidac = true;
          warnings.add(`${reason} Výsledky byly doplněny z Hlídače státu.`);
        } else {
          observedHealth.hlidac.push('missing_token');
          warnings.add(`${reason} Fallback na Hlídač státu není dostupný bez HLIDAC_TOKEN.`);
        }
      }
    }

    if (useHlidac) {
      zdroje.add('hlidac');
      const hlidac = await fetchHlidacSafely(deps, currentQuery, maxPagesPerQuery);
      observedHealth.hlidac.push(hlidac.health);
      requests.hlidac += requestCount(hlidac.requests, 0);
      if (hlidac.warning) warnings.add(hlidac.warning);
      for (const candidate of hlidac.items) {
        const input = toHlidacFeedInput(candidate);
        if (!bySourceId.has(input.zdroj_id)) bySourceId.set(input.zdroj_id, input);
      }
    }

    if (queryIndex < selectedQueries.length - 1) await sleep(queryDelayMs);
  }

  requests.total = requests.nen + requests.hlidac;
  const health: MonitoringSyncResult['health'] = {};
  if (observedHealth.nen.length > 0) health.nen = aggregateHealth(observedHealth.nen);
  if (observedHealth.hlidac.length > 0) health.hlidac = aggregateHealth(observedHealth.hlidac);

  // Odříznuté dotazy znamenají neúplný běh i při bezchybných odpovědích zdroje.
  if (droppedQueries > 0) {
    if (health.nen === 'ok') health.nen = 'partial';
    if (health.hlidac === 'ok') health.hlidac = 'partial';
  }

  const possibleSourceCount = source === 'hlidac'
    ? 1
    : source === 'both' || hasHlidacToken
      ? 2
      : 1;
  const maxRequestsPerSource = maxQueries * maxPagesPerQuery;
  const varovani = [...warnings].join(' ');
  return {
    inputs: [...bySourceId.values()],
    zdroje_pouzite: [...zdroje],
    health,
    requests,
    queries: {
      requested: effectiveQueries.length,
      processed: selectedQueries.length,
      dropped: droppedQueries,
      deduplicated: effectiveQueries.length - uniqueQueries.length,
    },
    limits: {
      maxQueries,
      maxPagesPerQuery,
      maxRequestsPerSource,
      maxRequestsTotal: maxRequestsPerSource * possibleSourceCount,
    },
    ...(varovani ? { varovani } : {}),
  };
}

async function fetchNenSafely(
  deps: MonitoringSyncDeps,
  query: string,
  maxPages: number,
): Promise<NenSyncFetchResult> {
  try {
    return await deps.fetchNen(query, { maxPages });
  } catch (error) {
    const warning = `NEN adapter selhal (${errorMessage(error)}).`;
    console.warn(warning);
    return { items: [], ok: false, health: 'error', requests: 0, warning };
  }
}

async function fetchHlidacSafely(
  deps: MonitoringSyncDeps,
  query: string,
  maxPages: number,
): Promise<HlidacFetchResult> {
  try {
    return await deps.fetchHlidac(query, { maxPages });
  } catch (error) {
    const warning = `Hlídač adapter selhal (${errorMessage(error)}).`;
    console.warn(warning);
    return {
      items: [], health: 'error', requests: 0, pages: 0,
      total: null, truncated: false, warning,
    };
  }
}

function healthForNen(result: NenSyncFetchResult): SourceHealth {
  if (result.health) return result.health;
  if (result.truncated || (!result.ok && result.items.length > 0)) return 'partial';
  return result.ok ? 'ok' : 'error';
}

function requestCount(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function aggregateHealth(values: SourceHealth[]): SourceHealth {
  const unique = new Set(values);
  if (unique.size === 1) return values[0];
  if (unique.has('partial') || unique.has('ok')) return 'partial';
  // Směs chyby a chybějícího tokenu není zdravý ani jednoznačně autentizační běh.
  return 'error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
