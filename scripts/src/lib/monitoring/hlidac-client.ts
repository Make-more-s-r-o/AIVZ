const HLIDAC_SEARCH_URL = 'https://api.hlidacstatu.cz/api/v2/verejnezakazky/hledat';
const HLIDAC_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_HLIDAC_PAGES = 5;
export const DEFAULT_HLIDAC_PAGE_DELAY_MS = 300;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Maximální počet stran jednoho přímého hledání; sync může předat nižší limit. */
export const MAX_HLIDAC_PAGES = positiveInteger(process.env.HLIDAC_MAX_PAGES, DEFAULT_MAX_HLIDAC_PAGES);
export const HLIDAC_PAGE_DELAY_MS = nonNegativeInteger(
  process.env.HLIDAC_PAGE_DELAY_MS,
  DEFAULT_HLIDAC_PAGE_DELAY_MS,
);

export interface HlidacTenderDocument {
  nazev: string;
  url: string;
}

export interface HlidacTenderCandidate {
  id: string;
  nazev: string;
  zadavatel: string;
  budget: number | null;
  lhuta: string | null;
  stavVZ: string | null;
  url: string;
  dokumenty: HlidacTenderDocument[];
  cpv: unknown[];
}

/** Stav zdroje musí odlišit skutečnou nulu od výpadku nebo chybějící autentizace. */
export type SourceHealth = 'ok' | 'partial' | 'error' | 'missing_token';

export interface HlidacFetchResult {
  items: HlidacTenderCandidate[];
  health: SourceHealth;
  /** Počet skutečně zahájených HTTP požadavků. */
  requests: number;
  /** Počet úspěšně načtených a strukturálně platných stran. */
  pages: number;
  /** Celkový počet výsledků oznámený zdrojem, pokud jej odpověď obsahovala. */
  total: number | null;
  /** true = další výsledky mohou existovat, ale limit nebo chyba průchod ukončily. */
  truncated: boolean;
  warning?: string;
}

export interface HlidacFetchOptions {
  fetchFn?: typeof fetch;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
  pageDelayMs?: number;
  /** `null` v testu výslovně simuluje chybějící token; `undefined` čte prostředí. */
  token?: string | null;
}

interface HlidacSearchPage {
  results: unknown[];
  total: number | null;
  pageSize: number | null;
  hasMore: boolean | null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Načte kandidáty z Hlídače státu po stránkách. Výsledek je vždy strukturovaný:
 * legitimní prázdná stránka je `ok`, chyba první strany `error`, chyba po dřívějším
 * úspěchu a dosažený limit bez důkazu o konci jsou `partial`.
 */
export async function fetchNewTenders(
  query: string,
  options: HlidacFetchOptions = {},
): Promise<HlidacFetchResult> {
  const token = options.token === undefined ? process.env.HLIDAC_TOKEN : options.token;
  if (!token) {
    const warning = 'HLIDAC_TOKEN není nastaven.';
    console.warn(warning);
    return {
      items: [], health: 'missing_token', requests: 0, pages: 0,
      total: null, truncated: false, warning,
    };
  }

  const fetchFn = options.fetchFn ?? fetch;
  const maxPages = positiveInteger(options.maxPages, MAX_HLIDAC_PAGES);
  const sleep = options.sleep ?? delay;
  const pageDelayMs = nonNegativeInteger(options.pageDelayMs, HLIDAC_PAGE_DELAY_MS);
  const byId = new Map<string, HlidacTenderCandidate>();
  let requests = 0;
  let pages = 0;
  let total: number | null = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(HLIDAC_SEARCH_URL);
    url.searchParams.set('dotaz', query.trim());
    url.searchParams.set('strana', String(page));
    url.searchParams.set('razeni', '1');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HLIDAC_REQUEST_TIMEOUT_MS);
    requests += 1;
    try {
      const response = await fetchFn(url, {
        headers: { Authorization: `Token ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        return failedSearchResult(
          byId, requests, pages, total,
          `Hlídač státu vrátil HTTP ${response.status}.`,
        );
      }

      const parsed = parseSearchPage(await response.json());
      if (!parsed) {
        return failedSearchResult(
          byId, requests, pages, total,
          'Hlídač státu vrátil odpověď bez pole Results.',
        );
      }
      pages += 1;
      if (parsed.total !== null) total = parsed.total;
      for (const rawCandidate of parsed.results) {
        const candidate = toCandidate(rawCandidate);
        if (candidate && !byId.has(candidate.id)) byId.set(candidate.id, candidate);
      }

      // Explicitní prázdná stránka je platný konec, včetně nuly na první straně.
      if (parsed.results.length === 0
        || parsed.hasMore === false
        || (total !== null && byId.size >= total)
        || (parsed.pageSize !== null && parsed.results.length < parsed.pageSize)) {
        return successfulSearchResult(byId, requests, pages, total);
      }

      if (page === maxPages) {
        const warning = `Hlídač státu dosáhl limitu ${maxPages} stran; výsledky mohou být neúplné.`;
        console.warn(warning);
        return {
          items: [...byId.values()], health: 'partial', requests, pages,
          total, truncated: true, warning,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failedSearchResult(
        byId, requests, pages, total,
        `Hlídač státu není dostupný (${message}).`,
      );
    } finally {
      clearTimeout(timeout);
    }

    await sleep(pageDelayMs);
  }

  // Smyčka vždy skončí návratem na poslední povolené straně.
  return successfulSearchResult(byId, requests, pages, total);
}

function successfulSearchResult(
  byId: Map<string, HlidacTenderCandidate>,
  requests: number,
  pages: number,
  total: number | null,
): HlidacFetchResult {
  return { items: [...byId.values()], health: 'ok', requests, pages, total, truncated: false };
}

function failedSearchResult(
  byId: Map<string, HlidacTenderCandidate>,
  requests: number,
  pages: number,
  total: number | null,
  warning: string,
): HlidacFetchResult {
  console.warn(warning);
  return {
    items: [...byId.values()],
    health: pages > 0 ? 'partial' : 'error',
    requests,
    pages,
    total,
    truncated: pages > 0,
    warning,
  };
}

function parseSearchPage(value: unknown): HlidacSearchPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const results = Array.isArray(body.Results)
    ? body.Results
    : Array.isArray(body.results)
      ? body.results
      : null;
  if (!results) return null;
  return {
    results,
    total: firstNonNegativeInteger(body, [
      'Total', 'total', 'TotalCount', 'totalCount', 'Celkem', 'celkem', 'TotalResults', 'totalResults',
    ]),
    pageSize: firstPositiveInteger(body, ['PageSize', 'pageSize', 'PerPage', 'perPage', 'VelikostStranky']),
    hasMore: firstBoolean(body, ['HasMore', 'hasMore', 'MaDalsi', 'maDalsi']),
  };
}

function firstNonNegativeInteger(body: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = body[key];
    if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function firstPositiveInteger(body: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = body[key];
    if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function firstBoolean(body: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof body[key] === 'boolean') return body[key];
  }
  return null;
}

function toCandidate(value: unknown): HlidacTenderCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const tender = value as Record<string, unknown>;
  const id = asString(tender.Id ?? tender.id);
  if (!id) return null;

  const zadavatelRaw = tender.Zadavatel ?? tender.zadavatel;
  const zadavatel = zadavatelRaw && typeof zadavatelRaw === 'object'
    ? asString((zadavatelRaw as Record<string, unknown>).Jmeno ?? (zadavatelRaw as Record<string, unknown>).jmeno)
    : null;
  const documentsRaw = Array.isArray(tender.Dokumenty)
    ? tender.Dokumenty
    : Array.isArray(tender.dokumenty)
      ? tender.dokumenty
      : [];
  const cpvRaw = tender.CPV ?? tender.cpv;

  return {
    id,
    nazev: asString(tender.NazevZakazky ?? tender.nazevZakazky) ?? 'Zakázka bez názvu',
    zadavatel: zadavatel ?? 'Neznámý zadavatel',
    budget: asNumber(tender.OdhadovanaHodnotaBezDPH ?? tender.odhadovanaHodnotaBezDPH),
    lhuta: asString(tender.LhutaDoruceni ?? tender.lhutaDoruceni),
    stavVZ: asString(tender.StavVZ ?? tender.stavVZ),
    url: `https://www.hlidacstatu.cz/verejnezakazky/zakazka/${encodeURIComponent(id)}`,
    dokumenty: documentsRaw.map(toDocument).filter((document): document is HlidacTenderDocument => document !== null),
    cpv: Array.isArray(cpvRaw) ? cpvRaw : cpvRaw == null ? [] : [cpvRaw],
  };
}

const HLIDAC_DETAIL_URL = 'https://api.hlidacstatu.cz/api/v2/verejnezakazky';

/**
 * Natáhne přílohy ZD pro jednu zakázku z detail endpointu Hlídače státu.
 * Bulk `hledat` endpoint (fetchNewTenders) dokumenty nevrací — jsou jen v detailu.
 * Graceful degradace: chybějící token / chyba / žádné dokumenty → prázdné pole,
 * volající to bere jako „přílohy nejsou k dispozici", ne jako pád.
 */
export async function fetchHlidacTenderDocuments(zdrojId: string): Promise<HlidacTenderDocument[]> {
  const token = process.env.HLIDAC_TOKEN;
  if (!token || !zdrojId) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLIDAC_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${HLIDAC_DETAIL_URL}/${encodeURIComponent(zdrojId)}`, {
      headers: { Authorization: `Token ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`Hlídač státu detail vrátil HTTP ${response.status} pro ${zdrojId} — přílohy přeskočeny.`);
      return [];
    }
    const body = await response.json() as Record<string, unknown>;
    const rawDocuments = Array.isArray(body.dokumenty) ? body.dokumenty : [];
    return rawDocuments.map(toDetailDocument).filter((doc): doc is HlidacTenderDocument => doc !== null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Hlídač státu detail není dostupný (${message}) pro ${zdrojId} — přílohy přeskočeny.`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function toDetailDocument(value: unknown): HlidacTenderDocument | null {
  if (!value || typeof value !== 'object') return null;
  const document = value as Record<string, unknown>;
  const directUrls = Array.isArray(document.directUrls) ? document.directUrls : [];
  const oficialUrls = Array.isArray(document.oficialUrls) ? document.oficialUrls : [];
  const url = asString(directUrls[0]) ?? asString(oficialUrls[0]);
  if (!url) return null;
  return {
    nazev: asString(document.name) ?? asString(document.typDokumentu) ?? 'Dokument',
    url,
  };
}

function toDocument(value: unknown): HlidacTenderDocument | null {
  if (!value || typeof value !== 'object') return null;
  const document = value as Record<string, unknown>;
  const url = asString(document.DirectUrl ?? document.Url ?? document.url);
  if (!url) return null;
  return {
    nazev: asString(document.TypDokumentu ?? document.nazev) ?? 'Dokument',
    url,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}
