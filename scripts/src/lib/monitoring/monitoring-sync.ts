import type { HlidacTenderCandidate } from './hlidac-client.js';
import type { NenFetchResult } from './nen-client.js';
import {
  toHlidacFeedInput,
  toNenFeedInput,
  type FeedUpsertInput,
} from './monitoring-store.js';

export type MonitoringSource = 'nen' | 'hlidac' | 'both';

export interface MonitoringSyncResult {
  inputs: FeedUpsertInput[];
  zdroje_pouzite: string[];
  varovani?: string;
}

interface MonitoringSyncDeps {
  fetchNen: (query: string) => Promise<NenFetchResult>;
  fetchHlidac: (query: string) => Promise<HlidacTenderCandidate[]>;
}

/** Sestaví sync vstupy včetně automatického fallbacku z NEN na Hlídač státu. */
export async function collectMonitoringInputs(
  source: MonitoringSource,
  query: string | string[],
  hasHlidacToken: boolean,
  deps: MonitoringSyncDeps,
): Promise<MonitoringSyncResult> {
  const queries = (Array.isArray(query) ? query : [query])
    .map((value) => value.trim());
  const effectiveQueries = queries.length > 0 ? queries : [''];
  const bySourceId = new Map<string, FeedUpsertInput>();
  const zdroje = new Set<string>();
  const warnings = new Set<string>();

  for (const currentQuery of effectiveQueries) {
    let useHlidac = source === 'hlidac' || source === 'both';

    if (source === 'nen' || source === 'both') {
      zdroje.add('nen');
      const nen = await deps.fetchNen(currentQuery);
      for (const candidate of nen.items) {
        const input = toNenFeedInput(candidate);
        if (!bySourceId.has(input.zdroj_id)) bySourceId.set(input.zdroj_id, input);
      }

      if (!nen.ok || nen.items.length === 0) {
        const reason = nen.ok ? 'NEN nevrátil žádné položky.' : 'NEN se nepodařilo načíst.';
        if (hasHlidacToken) {
          useHlidac = true;
          warnings.add(`${reason} Výsledky byly doplněny z Hlídače státu.`);
        } else {
          warnings.add(`${reason} Fallback na Hlídač státu není dostupný bez HLIDAC_TOKEN.`);
        }
      }
    }

    if (useHlidac) {
      zdroje.add('hlidac');
      const hlidac = await deps.fetchHlidac(currentQuery);
      for (const candidate of hlidac) {
        const input = toHlidacFeedInput(candidate);
        if (!bySourceId.has(input.zdroj_id)) bySourceId.set(input.zdroj_id, input);
      }
    }
  }

  const varovani = [...warnings].join(' ');
  return {
    inputs: [...bySourceId.values()],
    zdroje_pouzite: [...zdroje],
    ...(varovani ? { varovani } : {}),
  };
}
