const HLIDAC_SEARCH_URL = 'https://api.hlidacstatu.cz/api/v2/verejnezakazky/hledat';
const HLIDAC_REQUEST_TIMEOUT_MS = 15_000;

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

/** Načte kandidáty z Hlídače státu; při chybě vždy bezpečně degraduje na prázdné pole. */
export async function fetchNewTenders(query: string): Promise<HlidacTenderCandidate[]> {
  const token = process.env.HLIDAC_TOKEN;
  if (!token) {
    console.warn('HLIDAC_TOKEN není nastaven — monitoring vrací prázdný seznam.');
    return [];
  }

  const url = new URL(HLIDAC_SEARCH_URL);
  url.searchParams.set('dotaz', query.trim());
  url.searchParams.set('strana', '1');
  url.searchParams.set('razeni', '1');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HLIDAC_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Token ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`Hlídač státu vrátil HTTP ${response.status} — monitoring vrací prázdný seznam.`);
      return [];
    }

    const body = await response.json() as Record<string, unknown>;
    const rawResults = Array.isArray(body.Results)
      ? body.Results
      : Array.isArray(body.results)
        ? body.results
        : [];
    return rawResults.map(toCandidate).filter((candidate): candidate is HlidacTenderCandidate => candidate !== null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Hlídač státu není dostupný (${message}) — monitoring vrací prázdný seznam.`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
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
