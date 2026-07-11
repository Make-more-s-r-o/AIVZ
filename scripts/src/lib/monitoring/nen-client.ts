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
const MAX_NEN_REDIRECTS = 3;
export const DEFAULT_MAX_NEN_PAGES = 5;

/**
 * SSRF pojistka pro všechny URL, které pocházejí z HTML/DB. NEN smí být osloven
 * pouze přes HTTPS, přesně na produkčním hostname a bez nestandardního portu.
 */
export function isAllowedNenUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'nen.nipez.cz'
      && url.port === ''
      && url.username === ''
      && url.password === '';
  } catch {
    return false;
  }
}

/** Fetch s ručně ověřenými redirecty; automatické následování by obcházelo SSRF allowlist. */
export async function fetchAllowedNenUrl(
  initialUrl: string,
  fetchFn: typeof fetch,
  init: RequestInit = {},
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirects = 0; ; redirects += 1) {
    if (!isAllowedNenUrl(currentUrl)) {
      throw new Error(`nepovolená NEN URL: ${currentUrl}`);
    }
    const response = await fetchFn(currentUrl, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    // Tělo redirect odpovědi nepotřebujeme; zrušení uvolní spojení před dalším hopem.
    await response.body?.cancel().catch(() => {});
    if (redirects >= MAX_NEN_REDIRECTS) {
      throw new Error(`překročen limit ${MAX_NEN_REDIRECTS} přesměrování`);
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('redirect neobsahuje hlavičku Location');
    currentUrl = new URL(location, currentUrl).toString();
  }
}

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

// --- Přílohy zadávací dokumentace (podstránka /zadavaci-dokumentace) ---

export interface NenAttachment {
  /** Zobrazovaný název z tabulky ZD; NEN jej může uvést i bez přípony. */
  nazev: string;
  /** Absolutní odkaz na stažení souboru (NEN `/file?id=…`, 302 → skutečný obsah). */
  url: string;
}

/**
 * Sestaví URL podstránky se zadávací dokumentací z odkazu na detail zakázky.
 * NEN drží přílohy na `<detail>/zadavaci-dokumentace` (ověřeno reálně 2026-07 na
 * 3 zakázkách). Ořízne případný trailing slash i existující `/zadavaci-dokumentace`
 * (idempotentní), aby fungovalo jak nad čistým detailem, tak nad už doplněnou cestou.
 */
export function zadavaciDokumentaceUrl(detailUrl: string): string {
  const trimmed = detailUrl.replace(/\/+$/, '');
  if (/\/zadavaci-dokumentace$/i.test(trimmed)) return trimmed;
  return `${trimmed}/zadavaci-dokumentace`;
}

/**
 * Čistý parser HTML podstránky se ZD. Oddělený od fetchování kvůli testu nad fixture.
 * Přílohy jsou kotvy `<a class="file-value__file" href="/file?id=…">Název</a>` v buňce
 * `data-title="Soubor"`. Deduplikuje podle absolutní URL (stejný soubor bývá odkazovaný
 * víckrát). Relativní `/file?id=` odkazy zabsolutní na NEN doménu.
 */
export function parseNenAttachments(html: string): NenAttachment[] {
  const attachments: NenAttachment[] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a\b[^>]*class="[^"]*file-value__file[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const anchorTag = match[0];
    const href = firstMatch(anchorTag, /href="([^"]+)"/i);
    if (!href) continue;
    const nazev = cleanText(match[1]);
    if (!nazev) continue;
    const url = href.startsWith('http') ? href : `${NEN_BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    if (seen.has(url)) continue;
    seen.add(url);
    attachments.push({ nazev, url });
  }

  return attachments;
}

/**
 * Natáhne seznam příloh zadávací dokumentace pro danou zakázku z NEN. `detailUrl` je
 * odkaz na detail zakázky (z feedu `monitoring_zakazky.url`). Graceful: jakákoli chyba
 * (nedostupný zdroj, HTTP != 2xx, timeout) vrací prázdné pole — volající to bere jako
 * „přílohy nejsou k dispozici", ne jako pád. Názvy zde záměrně nefiltrujeme podle
 * přípony: skutečný název a typ může dodat až odpověď `/file` v HTTP hlavičkách.
 */
export async function fetchNenAttachments(
  detailUrl: string,
  options: { fetchFn?: typeof fetch } = {},
): Promise<NenAttachment[]> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = zadavaciDokumentaceUrl(detailUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NEN_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchAllowedNenUrl(url, fetchFn, {
      headers: { Accept: 'text/html', 'User-Agent': 'vz-ai-tool/monitoring' },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`NEN ZD vrátil HTTP ${response.status} pro ${url} — přílohy přeskočeny.`);
      return [];
    }
    return parseNenAttachments(await response.text());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`NEN ZD není dostupná (${message}) pro ${url} — přílohy přeskočeny.`);
    return [];
  } finally {
    clearTimeout(timeout);
  }
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
