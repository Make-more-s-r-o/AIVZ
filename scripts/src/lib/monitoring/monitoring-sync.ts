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
  query: string,
  hasHlidacToken: boolean,
  deps: MonitoringSyncDeps,
): Promise<MonitoringSyncResult> {
  const inputs: FeedUpsertInput[] = [];
  const zdroje_pouzite: string[] = [];
  let varovani: string | undefined;
  let useHlidac = source === 'hlidac' || source === 'both';

  if (source === 'nen' || source === 'both') {
    zdroje_pouzite.push('nen');
    const nen = await deps.fetchNen(query);
    inputs.push(...nen.items.map(toNenFeedInput));

    if (!nen.ok || nen.items.length === 0) {
      const reason = nen.ok ? 'NEN nevrátil žádné položky.' : 'NEN se nepodařilo načíst.';
      if (hasHlidacToken) {
        useHlidac = true;
        varovani = `${reason} Výsledky byly doplněny z Hlídače státu.`;
      } else {
        varovani = `${reason} Fallback na Hlídač státu není dostupný bez HLIDAC_TOKEN.`;
      }
    }
  }

  if (useHlidac) {
    zdroje_pouzite.push('hlidac');
    const hlidac = await deps.fetchHlidac(query);
    inputs.push(...hlidac.map(toHlidacFeedInput));
  }

  return { inputs, zdroje_pouzite, ...(varovani ? { varovani } : {}) };
}
