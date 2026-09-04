import type { AgentIdentity } from '../lib/agent-identity.js';
import { AgentRestClient } from './rest-client.js';
import { persistPriceProposal, type PriceProposalInput } from './price-proposal.js';

export interface McpAgentServices {
  findOrCreateTender(input: { url: string }): Promise<unknown>;
  startPipeline(input: { tenderId: string }): Promise<unknown>;
  getJob(input: { jobId: string; since: number }): Promise<unknown>;
  readAnalysis(input: { tenderId: string }): Promise<unknown>;
  readParts(input: { tenderId: string }): Promise<unknown>;
  readItems(input: { tenderId: string }): Promise<unknown>;
  readCompleteness(input: { tenderId: string }): Promise<unknown>;
  proposePrice(input: PriceProposalInput, agent: AgentIdentity): Promise<unknown>;
}

export interface SnapshotMutationConflict {
  id: string;
  step: string;
}

export type WithSnapshotMutation = <T>(
  tenderId: string,
  operation: () => Promise<T>,
) => Promise<T>;

/**
 * Propojí MCP cenový návrh se stejnou krátkou rezervací snapshotu, kterou používají
 * lidské REST cenové handlery. Rezervace je předaná z jejich vlastnícího modulu při mountu.
 */
export function createSnapshotMutationRunner(hooks: {
  reserve(tenderId: string): SnapshotMutationConflict | undefined;
  release(tenderId: string): void;
}): WithSnapshotMutation {
  return async <T>(tenderId: string, operation: () => Promise<T>): Promise<T> => {
    const conflict = hooks.reserve(tenderId);
    if (conflict) {
      throw new Error(
        `Produkt ani cenu nelze měnit souběžně s jinou změnou nebo běžícím krokem pipeline (${conflict.id}, ${conflict.step}).`,
      );
    }
    try {
      return await operation();
    } finally {
      hooks.release(tenderId);
    }
  };
}

interface MonitoringSource {
  source: 'nen' | 'hlidac';
  sourceId: string;
  canonicalUrl: string;
}

interface FeedItem {
  id?: unknown;
  zdroj?: unknown;
  zdroj_id?: unknown;
  url?: unknown;
  stav?: unknown;
  tender_id?: unknown;
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function monitoringSource(value: string): MonitoringSource | null {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'nen.nipez.cz' && url.protocol === 'https:') {
    const match = /\/detail-zakazky\/([^/]+)/i.exec(url.pathname);
    if (!match) return null;
    const slug = decodeURIComponent(match[1]);
    const idMatch = /^(N\d{3})-(\d{2})-(V\d+)$/i.exec(slug);
    const sourceId = idMatch
      ? `${idMatch[1].toUpperCase()}/${idMatch[2]}/${idMatch[3].toUpperCase()}`
      : slug;
    return {
      source: 'nen',
      sourceId,
      canonicalUrl: `${url.protocol}//${url.host}/verejne-zakazky/detail-zakazky/${slug}`,
    };
  }
  if ((hostname === 'hlidacstatu.cz' || hostname === 'www.hlidacstatu.cz') && url.protocol === 'https:') {
    const match = /\/verejnezakazky\/zakazka\/([^/]+)/i.exec(url.pathname);
    if (!match) return null;
    return {
      source: 'hlidac',
      sourceId: decodeURIComponent(match[1]),
      canonicalUrl: `${url.protocol}//${url.host}/verejnezakazky/zakazka/${match[1]}`,
    };
  }
  return null;
}

function feedItems(value: unknown): FeedItem[] {
  if (Array.isArray(value)) return value as FeedItem[];
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) {
    return (value as { items: FeedItem[] }).items;
  }
  return [];
}

function matchingFeedItem(items: FeedItem[], source: MonitoringSource): FeedItem | undefined {
  const canonical = normalizedUrl(source.canonicalUrl);
  return items.find((item) => {
    if (item.zdroj !== source.source) return false;
    if (String(item.zdroj_id ?? '') === source.sourceId) return true;
    if (typeof item.url !== 'string') return false;
    try {
      return normalizedUrl(item.url).startsWith(canonical);
    } catch {
      return false;
    }
  });
}

function activeJob(value: unknown): { id?: unknown; status?: unknown } | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((job) => job && typeof job === 'object'
    && ['running', 'queued'].includes(String((job as { status?: unknown }).status))) as
    { id?: unknown; status?: unknown } | undefined;
}

export interface CreateMcpAgentServicesOptions {
  restBaseUrl: string;
  authorization: string;
  outputDir: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  withSnapshotMutation: WithSnapshotMutation;
}

/** Produkční adapter zachovává REST jako jedinou cestu pro existující operace. */
export function createMcpAgentServices(options: CreateMcpAgentServicesOptions): McpAgentServices {
  const rest = new AgentRestClient(options.restBaseUrl, options.authorization, options.fetchFn);

  return {
    async findOrCreateTender({ url }) {
      const source = monitoringSource(url);
      if (!source) {
        const result = await rest.request('uploadTenderFromUrl', {
          body: {
            urls: [url],
            metadata: { source: { url }, imported_by: 'mcp' },
          },
        });
        return { ...result, existing: false, source: 'direct_url' };
      }

      await rest.request('monitoringSync', {
        body: { zdroj: source.source, q: source.sourceId },
      });
      const states = ['prevzata', 'nova', 'ignorovana'] as const;
      const feeds = await Promise.all(states.map(async (stav) => ({
        stav,
        data: await rest.request('monitoringFeed', {
          query: { stav, vse: '1', meta: '1' },
        }),
      })));
      const matches = feeds.map(({ stav, data }) => ({
        stav,
        item: matchingFeedItem(feedItems(data), source),
      }));
      const taken = matches.find(({ stav, item }) => stav === 'prevzata' && item);
      if (taken?.item && typeof taken.item.tender_id === 'string' && taken.item.tender_id) {
        return {
          tenderId: taken.item.tender_id,
          tender_id: taken.item.tender_id,
          existing: true,
          source: source.source,
        };
      }
      const ignored = matches.find(({ stav, item }) => stav === 'ignorovana' && item);
      if (ignored?.item) {
        throw new Error('Zakázka je v monitoringu označená jako ignorovaná; agent ji nesmí svévolně obnovit.');
      }
      const fresh = matches.find(({ stav, item }) => stav === 'nova' && item);
      if (!fresh?.item || typeof fresh.item.id !== 'string') {
        throw new Error(`Zakázku ${source.sourceId} se v podporovaném zdroji nepodařilo dohledat.`);
      }
      const result = await rest.request('takeMonitoringTender', {
        path: { id: fresh.item.id },
        body: { stahnout_zd: true, spustit: false },
      });
      return { ...result, existing: false, source: source.source };
    },

    startPipeline({ tenderId }) {
      return rest.request('runPipeline', { path: { id: tenderId } });
    },

    getJob({ jobId, since }) {
      return rest.request('getJob', {
        path: { jobId },
        query: { since: String(since) },
      });
    },

    readAnalysis({ tenderId }) {
      return rest.request('getTenderAnalysis', { path: { id: tenderId } });
    },

    readParts({ tenderId }) {
      return rest.request('getTenderParts', { path: { id: tenderId } });
    },

    async readItems({ tenderId }) {
      const data = await rest.request('getTenderItems', { path: { id: tenderId } });
      if (Array.isArray(data?.polozky_match)) {
        return {
          tenderId,
          legacy: false,
          polozky: data.polozky_match.map((item: unknown, pozice: number) => ({ pozice, ...(item as object) })),
          pricesUpdatedAt: data.prices_updated_at ?? null,
        };
      }
      return {
        tenderId,
        legacy: true,
        polozky: [{ pozice: 0, ...data }],
        pricesUpdatedAt: data?.prices_updated_at ?? null,
      };
    },

    async readCompleteness({ tenderId }) {
      const status = await rest.request('getTenderStatus', { path: { id: tenderId } });
      return {
        tenderId,
        steps: status?.steps ?? null,
        uplnost: status?.uplnost ?? null,
        uplnostChyba: status?.uplnostChyba,
        runAll: status?.runAll,
      };
    },

    proposePrice(input, agent) {
      return options.withSnapshotMutation(input.tenderId, async () => {
        const jobs = await rest.request('listJobs', { query: { tenderId: input.tenderId } });
        const conflict = activeJob(jobs);
        if (conflict) {
          throw new Error(`Cenový návrh nelze uložit během ${String(conflict.status)} jobu ${String(conflict.id)}.`);
        }
        // Autorizované REST čtení ověří existenci a znovu i případnou revokaci klíče.
        await rest.request('getTenderItems', { path: { id: input.tenderId } });
        return persistPriceProposal(input, agent, {
          outputDir: options.outputDir,
          now: options.now,
        });
      });
    },
  };
}
