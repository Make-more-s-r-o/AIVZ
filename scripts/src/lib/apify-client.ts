/**
 * Apify client pro scraping českých e-shopů.
 * Používá apify~e-commerce-scraping-tool actor pro Alza.cz (a další marketplace).
 * Spouští Apify Actors, stahuje výsledky, ukládá do warehouse.
 */
import { query, queryOne } from './db.js';
import { upsertProduct, upsertPrice, resolveManufacturer } from './warehouse-store.js';
import { normalizeParameters } from './param-normalizer.js';

const APIFY_API_URL = 'https://api.apify.com/v2';

// Apify actor pro e-commerce scraping (stejný jako v CLI orchestrátoru)
const ACTORS = {
  alza: 'apify~e-commerce-scraping-tool',
} as const;

// Mapování zdrojů na marketplace domény
const MARKETPLACE_MAP: Record<string, string> = {
  'alza': 'www.alza.cz',
};

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
// E-commerce scraping (apify~e-commerce-scraping-tool)
// ============================================================

/** Sestaví input pro e-commerce scraping actor */
function buildEcommerceInput(config: ScrapeConfig): Record<string, unknown> {
  const marketplace = MARKETPLACE_MAP[config.source_name] || 'www.alza.cz';

  // Pokud je zadaná URL kategorie, použij startUrls místo keyword
  if (config.category_url) {
    return {
      startUrls: [{ url: config.category_url }],
      marketplaces: [marketplace],
      maxProductResults: config.max_items || 100,
      additionalProperties: true,
    };
  }

  return {
    keyword: config.query || '',
    marketplaces: [marketplace],
    maxProductResults: config.max_items || 100,
    additionalProperties: true,
  };
}

/** Transformuje e-commerce scrape data na warehouse produkty */
function parseEcommerceItem(item: any): {
  product: Parameters<typeof upsertProduct>[0];
  price: { price_bez_dph: number; price_s_dph: number; source_url: string | null; availability: string | null };
} | null {
  if (!item.name || !item.offers?.price) return null;

  // Výrobce — z brand.slogan nebo první slovo názvu
  const manufacturer = item.brand?.slogan || item.name.split(/\s+/)[0] || 'Unknown';

  const priceSDph = item.offers.price;
  const priceBezDph = item.additionalProperties?.currentPriceWithoutVAT
    ?? Math.round((priceSDph / 1.21) * 100) / 100;

  // Extrakce parametrů ze specifications pole
  const params: Record<string, string> = {};
  const specs = item.additionalProperties?.specifications;
  if (specs && Array.isArray(specs)) {
    for (const s of specs) {
      let key = s.parameter;
      // Oříznout příliš dlouhé klíče na první větu
      if (key && key.length > 50) {
        const m = key.match(/^[^.!?]+/);
        if (m) key = m[0].trim();
      }
      if (key) {
        params[key] = s.value;
      }
    }
  }

  return {
    product: {
      manufacturer,
      model: item.name,
      ean: null,
      part_number: item.mpn || null,
      description: item.description || null,
      image_url: item.image || null,
      zdroj_dat: 'apify',
      parameters_normalized: Object.keys(params).length > 0 ? params : undefined,
    },
    price: {
      price_bez_dph: priceBezDph,
      price_s_dph: priceSDph,
      source_url: item.url || null,
      availability: item.additionalProperties?.availability || null,
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
    // Určit actor ID podle zdroje
    const sourceName = config.source_name.toLowerCase();
    const actorId = (ACTORS as Record<string, string>)[sourceName] || ACTORS.alza;

    // Spustit Apify Actor
    console.log(`Scrape: starting Apify actor ${actorId} for ${config.source_name}...`);
    const input = buildEcommerceInput(config);
    const run = await runActor(actorId, input, 600);

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
        const parsed = parseEcommerceItem(item);
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

        // AI normalizace parametrů (pokud produkt nový a nemá je z e-commerce dat)
        if (created && parsed.product.description && !parsed.product.parameters_normalized) {
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
