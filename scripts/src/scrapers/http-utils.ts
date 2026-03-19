/**
 * HTTP utility — rate limiter, fetch s retry, parsování cen.
 */
import * as cheerio from 'cheerio';

// ============================================================
// Rate limiter
// ============================================================

export class RateLimiter {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(
    private concurrency: number = 2,
    private delayMs: number = 500,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      const result = await fn();
      // Mezidobí mezi requesty
      if (this.delayMs > 0) {
        await sleep(this.delayMs);
      }
      return result;
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// ============================================================
// Fetch s retry
// ============================================================

export interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  retryDelayMs?: number;
}

export async function fetchWithRetry(
  url: string,
  options: FetchOptions & RequestInit = {},
): Promise<Response> {
  const { retries = 3, retryDelayMs = 1000, timeout = 30_000, ...fetchOpts } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        ...fetchOpts,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) return response;

      // 429 Too Many Requests — čekáme a zkusíme znovu
      if (response.status === 429 && attempt < retries) {
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : retryDelayMs * attempt;
        console.warn(`  ⏳ Rate limited (429), čekám ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }

      // 5xx — retry
      if (response.status >= 500 && attempt < retries) {
        console.warn(`  ⚠ Server error ${response.status}, pokus ${attempt}/${retries}...`);
        await sleep(retryDelayMs * attempt);
        continue;
      }

      throw new Error(`HTTP ${response.status}: ${response.statusText} (${url})`);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (attempt < retries) {
          console.warn(`  ⚠ Timeout, pokus ${attempt}/${retries}...`);
          await sleep(retryDelayMs * attempt);
          continue;
        }
        throw new Error(`Timeout po ${timeout}ms: ${url}`);
      }
      if (attempt < retries && err.code !== 'ERR_INVALID_URL') {
        console.warn(`  ⚠ Fetch error, pokus ${attempt}/${retries}: ${err.message}`);
        await sleep(retryDelayMs * attempt);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Všechny pokusy selhaly: ${url}`);
}

// ============================================================
// JSON + HTML helpers
// ============================================================

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchOptions & RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  const response = await fetchWithRetry(url, { ...options, headers });
  return response.json() as Promise<T>;
}

export async function fetchPage(
  url: string,
  options: FetchOptions = {},
): Promise<cheerio.CheerioAPI> {
  const headers: Record<string, string> = {
    'Accept': 'text/html',
    'User-Agent': 'Mozilla/5.0 (compatible; VZ-Scraper/1.0)',
    ...(options.headers as Record<string, string> | undefined),
  };
  const response = await fetchWithRetry(url, { ...options, headers });
  const html = await response.text();
  return cheerio.load(html);
}

// ============================================================
// Parsování cen
// ============================================================

/**
 * Parsuje českou cenu ("1 234,56 Kč" → 1234.56).
 * Zvládá formáty: "1234", "1 234", "1.234,56", "1234.56", "1 234 Kč"
 */
export function parseCzechPrice(text: string): number | null {
  if (!text) return null;
  // Odstraň měnu, mezery kolem
  let cleaned = text.replace(/\s*(Kč|CZK|EUR|€|,-)\s*/gi, '').trim();
  // "1 234,56" nebo "1.234,56" → "1234.56"
  if (cleaned.includes(',')) {
    cleaned = cleaned.replace(/[\s.]/g, '').replace(',', '.');
  } else {
    // "1 234" → "1234"
    cleaned = cleaned.replace(/\s/g, '');
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Cena bez DPH z ceny s DPH (21% DPH ČR).
 */
export function priceWithoutVat(priceWithVat: number, vatRate: number = 0.21): number {
  return Math.round((priceWithVat / (1 + vatRate)) * 100) / 100;
}

// ============================================================
// Helpers
// ============================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
