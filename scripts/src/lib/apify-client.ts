/**
 * Apify client pro scraping českých e-shopů (Alza.cz, Heureka.cz).
 * Spouští Apify Actors, stahuje výsledky, ukládá do warehouse.
 */
import { query, queryOne } from './db.js';
import { upsertProduct, upsertPrice, resolveManufacturer } from './warehouse-store.js';
import { normalizeParameters } from './param-normalizer.js';

const APIFY_API_URL = 'https://api.apify.com/v2';

// Známé Apify Actors pro české e-shopy
const ACTORS = {
  alza: 'apify/web-scraper', // Generic — custom config pro Alza
  heureka: 'apify/web-scraper',
} as const;

// ============================================================
// Typy
// ============================================================

export interface ScrapeConfig {
  source_id: number;
  source_name: string;
  query?: string;           // hledaný výraz ("notebook dell latitude")
  category_url?: string;    // URL kategorie k scrape
  max_items?: number;
  category_id?: number;     // warehouse category ID pro nové produkty
}

export interface ScrapeJobResult {
  job_id: number;
  items_found: number;
  items_new: number;
  items_updated: number;
  items_price_changed: number;
  errors: Array<{ item?: string; error: string }>;
  duration_ms: number;
}

interface ApifyRunResult {
  id: string;
  status: string;
  datasetId: string;
}

// ============================================================
// Apify API
// ============================================================

function getApifyToken(): string {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN not set');
  return token;
}

/** Spustí Apify Actor a počká na dokončení */
async function runActor(
  actorId: string,
  input: Record<string, unknown>,
  timeoutSecs = 300,
): Promise<ApifyRunResult> {
  const token = getApifyToken();

  const res = await fetch(`${APIFY_API_URL}/acts/${actorId}/runs?token=${token}&waitForFinish=${timeoutSecs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apify Actor run failed (${res.status}): ${err}`);
  }

  const data = await res.json() as any;
  return {
    id: data.data.id,
    status: data.data.status,
    datasetId: data.data.defaultDatasetId,
  };
}

/** Stáhne výsledky z datasetu */
async function getDatasetItems(datasetId: string, limit = 1000): Promise<any[]> {
  const token = getApifyToken();
  const res = await fetch(
    `${APIFY_API_URL}/datasets/${datasetId}/items?token=${token}&limit=${limit}&format=json`,
  );
  if (!res.ok) throw new Error(`Failed to fetch dataset: ${res.status}`);
  return res.json() as Promise<any[]>;
}

// ============================================================
// Alza.cz scraping
// ============================================================

function buildAlzaInput(config: ScrapeConfig): Record<string, unknown> {
  const startUrls: Array<{ url: string }> = [];

  if (config.category_url) {
    startUrls.push({ url: config.category_url });
  } else if (config.query) {
    startUrls.push({ url: `https://www.alza.cz/search.htm?exps=${encodeURIComponent(config.query)}` });
  }

  return {
    startUrls,
    maxRequestsPerCrawl: config.max_items || 100,
    pageFunction: `async function pageFunction(context) {
      const { $, request, log } = context;
      const results = [];
      $('.browsingitem').each((i, el) => {
        const $el = $(el);
        const name = $el.find('.name').text().trim();
        const price = $el.find('.price-box__price').text().replace(/[^\\d,]/g, '').replace(',', '.');
        const url = $el.find('a.name').attr('href');
        const img = $el.find('img.js-gallery-image').attr('src');
        const ean = $el.attr('data-ean');
        const avail = $el.find('.avlVal').text().trim();
        if (name && price) {
          results.push({
            name,
            price: parseFloat(price) || 0,
            url: url ? 'https://www.alza.cz' + url : null,
            image: img,
            ean: ean || null,
            availability: avail || null,
            source: 'alza',
          });
        }
      });
      return results;
    }`,
  };
}

/** Transformuje Alza scrape data na warehouse produkty */
function parseAlzaItem(item: any): {
  product: Parameters<typeof upsertProduct>[0];
  price: { price_bez_dph: number; price_s_dph: number; source_url: string | null; availability: string | null };
} | null {
  if (!item.name || !item.price) return null;

  // Extrahuj výrobce z názvu (první slovo)
  const parts = item.name.split(/\s+/);
  const manufacturer = parts[0] || 'Unknown';
  const model = parts.slice(1).join(' ') || item.name;

  const priceSDph = item.price;
  const priceBezDph = Math.round((priceSDph / 1.21) * 100) / 100;

  return {
    product: {
      manufacturer,
      model: item.name, // Celý název jako model (AI rozliší)
      ean: item.ean || null,
      description: item.name,
      image_url: item.image || null,
      zdroj_dat: 'apify',
    },
    price: {
      price_bez_dph: priceBezDph,
      price_s_dph: priceSDph,
      source_url: item.url || null,
      availability: item.availability || null,
    },
  };
}

// ============================================================
// Hlavní scraping funkce
// ============================================================

/**
 * Spustí scraping pro daný zdroj a uloží výsledky do warehouse.
 */
export async function runScraping(config: ScrapeConfig): Promise<ScrapeJobResult> {
  const start = Date.now();
  const errors: Array<{ item?: string; error: string }> = [];

  // Vytvořit job záznam
  const job = await queryOne<{ id: number }>(
    `INSERT INTO scrape_jobs (source_id, status, query, category_slug, started_at)
     VALUES ($1, 'running', $2, $3, NOW()) RETURNING id`,
    [config.source_id, config.query || config.category_url || null, null],
  );
  const jobId = job?.id ?? 0;

  let itemsFound = 0;
  let itemsNew = 0;
  let itemsUpdated = 0;
  let itemsPriceChanged = 0;

  try {
    // Spustit Apify Actor
    console.log(`Scrape: starting Apify actor for ${config.source_name}...`);
    const input = buildAlzaInput(config);
    const run = await runActor(ACTORS.alza, input, 600);

    if (run.status !== 'SUCCEEDED') {
      throw new Error(`Apify run status: ${run.status}`);
    }

    // Stáhnout výsledky
    const items = await getDatasetItems(run.datasetId, config.max_items || 1000);
    itemsFound = items.length;
    console.log(`Scrape: got ${itemsFound} items from ${config.source_name}`);

    // Zpracovat a uložit
    for (const item of items) {
      try {
        const parsed = parseAlzaItem(item);
        if (!parsed) continue;

        // Resolve manufacturer alias
        parsed.product.manufacturer = await resolveManufacturer(parsed.product.manufacturer);

        // Kategorie z configu
        if (config.category_id) {
          parsed.product.category_id = config.category_id;
        }

        // Upsert produkt
        const { product, created } = await upsertProduct(parsed.product);
        if (created) {
          itemsNew++;
        } else {
          itemsUpdated++;
        }

        // Upsert cena
        await upsertPrice({
          product_id: product.id,
          source_id: config.source_id,
          ...parsed.price,
        });

        // AI normalizace parametrů (pokud produkt nový)
        if (created && parsed.product.description) {
          try {
            const params = await normalizeParameters(parsed.product.description);
            if (Object.keys(params).length > 0) {
              await query(
                'UPDATE products SET parameters_normalized = $1 WHERE id = $2',
                [JSON.stringify(params), product.id],
              );
            }
          } catch {
            // Non-fatal
          }
        }
      } catch (err: any) {
        errors.push({ item: item.name, error: err.message || String(err) });
      }
    }

    // Aktualizovat job
    const durationMs = Date.now() - start;
    await query(
      `UPDATE scrape_jobs SET
        status = 'done', items_found = $1, items_new = $2, items_updated = $3,
        items_price_changed = $4, errors = $5, duration_ms = $6, completed_at = NOW()
       WHERE id = $7`,
      [itemsFound, itemsNew, itemsUpdated, itemsPriceChanged,
       JSON.stringify(errors.slice(0, 50)), durationMs, jobId],
    );

    // Aktualizovat last_scraped_at na zdroji
    await query(
      'UPDATE data_sources SET last_scraped_at = NOW() WHERE id = $1',
      [config.source_id],
    );

    return { job_id: jobId, items_found: itemsFound, items_new: itemsNew, items_updated: itemsUpdated, items_price_changed: itemsPriceChanged, errors, duration_ms: durationMs };

  } catch (err: any) {
    const durationMs = Date.now() - start;
    errors.push({ error: err.message || String(err) });
    await query(
      `UPDATE scrape_jobs SET status = 'error', errors = $1, duration_ms = $2, completed_at = NOW() WHERE id = $3`,
      [JSON.stringify(errors), durationMs, jobId],
    ).catch(() => {});
    throw err;
  }
}

/**
 * Vrátí seznam scraping jobů.
 */
export async function getScrapeJobs(limit = 20): Promise<any[]> {
  const { rows } = await query(
    `SELECT sj.*, ds.name as source_name
     FROM scrape_jobs sj
     JOIN data_sources ds ON sj.source_id = ds.id
     ORDER BY sj.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}
