/**
 * Klient pro NEN (Národní elektronický nástroj, nen.nipez.cz).
 *
 * NEN nemá pro anonymní přístup veřejné JSON API (public API vyžaduje registraci/JKSB).
 * Seznam veřejných zakázek na /verejne-zakazky je ale server-rendered HTML tabulka
 * (gov design system) se sémantickými `data-title` kotvami u buněk — ty jsou stabilní
 * parsovací cíl (nezávislý na pořadí sloupců). Ověřeno reálným voláním 2026-07.
 *
 * Fetch vždy bezpečně vrací výsledek s příznakem dostupnosti zdroje (žádný pád).
 */

const NEN_BASE_URL = 'https://nen.nipez.cz';
const NEN_LIST_PATH = '/verejne-zakazky';
const NEN_REQUEST_TIMEOUT_MS = 20_000;
const NEN_PAGE_DELAY_MS = 300;
export const DEFAULT_MAX_NEN_PAGES = 5;

function envMaxPages(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_NEN_PAGES;
}

export const MAX_NEN_PAGES = envMaxPages(process.env.NEN_MAX_PAGES);

// Jen zakázky, které ještě přijímají nabídky (mají smysl pro feed „nové k převzetí").
const OPEN_STATE = 'Neukončen';

export interface NenTenderCandidate {
  /** Systémové číslo NEN, např. „N006/26/V00021897" — stabilní identifikátor zdroje. */
  zdroj_id: string;
  nazev: string;
  zadavatel: string | null;
  stav: string | null;
  /** Lhůta pro podání nabídek jako ISO datum (YYYY-MM-DD) nebo null. */
  lhuta_nabidek: string | null;
  /** Absolutní odkaz na detail zakázky u zdroje. */
  url: string;
}

export interface NenFetchResult {
  items: NenTenderCandidate[];
  ok: boolean;
}

export interface NenFetchOptions {
  fetchFn?: typeof fetch;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

function listingPath(query: string, page: number): string {
  const querySegment = query ? `/p:vz:query=${encodeURIComponent(query)}` : '';
  // Ověřeno proti odkazu „Stránka 2“ na NEN 2026-07-11.
  const pageSegment = page > 1 ? `/p:vz:page=${page}` : '';
  return `${NEN_LIST_PATH}${querySegment}${pageSegment}`;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Natáhne aktuální veřejné zakázky z NEN. `query` je volitelný fulltext filtr
 * (mapuje se na NEN `p:vz:query=…`). Stránkuje přes ověřené `p:vz:page=N`,
 * zastaví se na prázdné stránce nebo na konfigurovaném maximu a deduplikuje ID.
 */
export async function fetchNenTenders(query = '', options: NenFetchOptions = {}): Promise<NenFetchResult> {
  const trimmed = query.trim();
  const fetchFn = options.fetchFn ?? fetch;
  const maxPages = options.maxPages ?? MAX_NEN_PAGES;
  const sleep = options.sleep ?? delay;
  const byId = new Map<string, NenTenderCandidate>();

  for (let page = 1; page <= maxPages; page += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), NEN_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchFn(`${NEN_BASE_URL}${listingPath(trimmed, page)}`, {
        headers: { Accept: 'text/html', 'User-Agent': 'vz-ai-tool/monitoring' },
        signal: controller.signal,
      });
      if (!response.ok) {
        console.warn(`NEN vrátil HTTP ${response.status} — monitoring použije dostupná data.`);
        return { items: [...byId.values()], ok: false };
      }
      const rows = parseNenListing(await response.text());
      if (rows.length === 0) break;
      for (const candidate of rows) {
        if (candidate.stav === OPEN_STATE && !byId.has(candidate.zdroj_id)) {
          byId.set(candidate.zdroj_id, candidate);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`NEN není dostupný (${message}) — monitoring použije dostupná data.`);
      return { items: [...byId.values()], ok: false };
    } finally {
      clearTimeout(timeout);
    }
    if (page < maxPages) await sleep(NEN_PAGE_DELAY_MS);
  }

  return { items: [...byId.values()], ok: true };
}

/**
 * Čistý parser HTML seznamu zakázek NEN. Oddělený od fetchování, aby šel testovat
 * nad uloženou fixture. Robustní vůči změně pořadí sloupců — buňky se čtou přes
 * `data-title`. Vrací VŠECHNY řádky (bez filtru stavu); filtr aplikuje volající.
 */
export function parseNenListing(html: string): NenTenderCandidate[] {
  const candidates: NenTenderCandidate[] = [];
  const rowRegex = /<tr class="gov-table__row">([\s\S]*?)<\/tr>/g;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const detailHref = firstMatch(rowHtml, /href="([^"]*\/detail-zakazky\/[^"]+)"/);
    const zdroj_id = cellByTitle(rowHtml, 'Systémové číslo NEN');
    const nazev = cellByTitle(rowHtml, 'Název zadávacího postupu');
    if (!zdroj_id || !nazev) continue; // řádek bez identifikátoru/názvu přeskoč

    const zadavatel = cellByTitle(rowHtml, 'Zadavatel');
    const stav = cellByTitle(rowHtml, 'Aktuální stav');
    const lhutaRaw = cellByTitle(rowHtml, 'Lhůta podání nabídek');

    candidates.push({
      zdroj_id,
      nazev,
      zadavatel: zadavatel || null,
      stav: stav || null,
      lhuta_nabidek: parseCzechDate(lhutaRaw),
      url: detailHref
        ? `${NEN_BASE_URL}${detailHref}`
        : `${NEN_BASE_URL}${NEN_LIST_PATH}`,
    });
  }

  return candidates;
}

/** Vytáhne text buňky podle `data-title` atributu (case/attr-order tolerantní). */
function cellByTitle(rowHtml: string, title: string): string | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`data-title="${escaped}"[^>]*>([\\s\\S]*?)</td>`, 'i');
  const raw = firstMatch(rowHtml, regex);
  return raw ? cleanText(raw) : null;
}

function firstMatch(haystack: string, regex: RegExp): string | null {
  const m = regex.exec(haystack);
  return m ? m[1] : null;
}

/** Odstraní vnořené tagy, dekóduje základní HTML entity a normalizuje whitespace. */
function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Převede český datum/čas z NEN („21. 07. 2026 09:00") na ISO datum „2026-07-21".
 * Vrací null, když formát nesedí.
 */
export function parseCzechDate(value: string | null): string | null {
  if (!value) return null;
  const m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(value);
  if (!m) return null;
  const [, d, mo, y] = m;
  const day = d.padStart(2, '0');
  const month = mo.padStart(2, '0');
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${y}-${month}-${day}`;
}
