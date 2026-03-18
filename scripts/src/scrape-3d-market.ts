#!/usr/bin/env npx tsx
/**
 * Orchestrátor scrapingu 3D tiskáren a filamentů z českého trhu.
 * Spouští Apify runy sekvenčně a importuje výsledky do warehouse.
 *
 * Použití:
 *   npx tsx scripts/src/scrape-3d-market.ts              # plný run
 *   npx tsx scripts/src/scrape-3d-market.ts --dry-run     # jen vypíše joby
 *   npx tsx scripts/src/scrape-3d-market.ts --test         # max 5 items per job
 */

const API_BASE = process.env.API_BASE || 'https://vz.ludone.cz/api/warehouse';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
if (!APIFY_TOKEN) {
  console.error('Chybi APIFY_TOKEN env variable. Nastav: export APIFY_TOKEN=<tvuj_token>');
  process.exit(1);
}
const APIFY_ACTOR = 'epctex/e-commerce-scraping-tool';

// ============================================================
// Definice všech scraping jobů
// ============================================================

interface ScrapeJob {
  name: string;
  sourceId: number;       // warehouse data_source ID
  sourceName: string;
  categoryId: number;     // default warehouse kategorie
  mode: 'keyword' | 'listingUrls';
  keyword?: string;
  listingUrls?: string[];
  maxItems: number;
}

const JOBS: ScrapeJob[] = [
  // --- Alza.cz (keyword mode) ---
  {
    name: 'Alza - SLA/Resin tiskárny',
    sourceId: 2, sourceName: 'alza',
    categoryId: 15, mode: 'keyword',
    keyword: '3D tiskarna SLA resin',
    maxItems: 100,
  },
  {
    name: 'Alza - PETG filament',
    sourceId: 2, sourceName: 'alza',
    categoryId: 16, mode: 'keyword',
    keyword: 'filament PETG 1.75',
    maxItems: 200,
  },
  {
    name: 'Alza - ABS/TPU/Nylon filament',
    sourceId: 2, sourceName: 'alza',
    categoryId: 16, mode: 'keyword',
    keyword: 'filament ABS TPU nylon',
    maxItems: 200,
  },
  {
    name: 'Alza - UV resin',
    sourceId: 2, sourceName: 'alza',
    categoryId: 16, mode: 'keyword',
    keyword: 'UV resin 3D',
    maxItems: 100,
  },
  {
    name: 'Alza - 3D prislusenstvi',
    sourceId: 2, sourceName: 'alza',
    categoryId: 13, mode: 'keyword',
    keyword: '3D tisk prislusenstvi',
    maxItems: 100,
  },

  // --- CZC.cz (listing URLs) ---
  {
    name: 'CZC - 3D tiskarny',
    sourceId: 3, sourceName: 'czc',
    categoryId: 14, mode: 'listingUrls',
    listingUrls: ['https://www.czc.cz/3d-tiskarny/produkty'],
    maxItems: 200,
  },
  {
    name: 'CZC - Filamenty a materialy',
    sourceId: 3, sourceName: 'czc',
    categoryId: 16, mode: 'listingUrls',
    listingUrls: ['https://www.czc.cz/filamenty-a-materialy-pro-3d-tisk/produkty'],
    maxItems: 500,
  },

  // --- Heureka.cz (listing URLs) ---
  {
    name: 'Heureka - 3D tiskarny',
    sourceId: 4, sourceName: 'heureka',
    categoryId: 14, mode: 'listingUrls',
    listingUrls: ['https://3d-tiskarny.heureka.cz/'],
    maxItems: 300,
  },
  {
    name: 'Heureka - 3D filamenty',
    sourceId: 4, sourceName: 'heureka',
    categoryId: 16, mode: 'listingUrls',
    listingUrls: ['https://3d-filamenty.heureka.cz/'],
    maxItems: 500,
  },

  // --- Prusa e-shop (listing URLs) ---
  {
    name: 'Prusa - Tiskarny',
    sourceId: 6, sourceName: 'prusa',
    categoryId: 14, mode: 'listingUrls',
    listingUrls: ['https://www.prusa3d.cz/kategorie/originalni-prusa-tiskarny'],
    maxItems: 50,
  },
  {
    name: 'Prusa - Prusament',
    sourceId: 6, sourceName: 'prusa',
    categoryId: 16, mode: 'listingUrls',
    listingUrls: ['https://www.prusa3d.cz/kategorie/prusament'],
    maxItems: 100,
  },
  {
    name: 'Prusa - Prislusenstvi',
    sourceId: 6, sourceName: 'prusa',
    categoryId: 13, mode: 'listingUrls',
    listingUrls: ['https://www.prusa3d.cz/kategorie/prislusenstvi'],
    maxItems: 100,
  },
];

// ============================================================
// Apify API funkce
// ============================================================

interface ApifyRunResult {
  id: string;
  status: string;
  defaultDatasetId: string;
}

// Spustí Apify actor a čeká na dokončení
async function runApifyActor(job: ScrapeJob, maxItems: number): Promise<ApifyRunResult> {
  const input: Record<string, unknown> = {
    maxResults: maxItems,
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  };

  if (job.mode === 'keyword') {
    input.search = job.keyword;
  } else if (job.mode === 'listingUrls') {
    input.listingUrls = job.listingUrls!.map(url => ({ url }));
  }

  console.log(`  Spoustim Apify actor pro: ${job.name} (max ${maxItems} items)...`);

  // Spustit actor synchronně (čeká na výsledek)
  const res = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=900`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  // run-sync-get-dataset-items vrací rovnou items, ale potřebujeme i run ID
  // Použijeme raději dvou-krokový přístup: start + poll
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Apify actor start failed: ${res.status} ${errText}`);
  }

  // Získáme run info z headeru
  const runId = res.headers.get('x-apify-run-id');
  const datasetId = res.headers.get('x-apify-dataset-id');

  // Pokud nemáme headery, fallback — parsujeme items přímo
  if (!datasetId) {
    throw new Error('Apify nevrátil dataset ID v response headerech');
  }

  return {
    id: runId || 'unknown',
    status: 'SUCCEEDED',
    defaultDatasetId: datasetId,
  };
}

// Alternativní přístup: start run → poll → get dataset
async function startApifyRun(job: ScrapeJob, maxItems: number): Promise<string> {
  const input: Record<string, unknown> = {
    maxResults: maxItems,
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  };

  if (job.mode === 'keyword') {
    input.search = job.keyword;
  } else if (job.mode === 'listingUrls') {
    input.listingUrls = job.listingUrls!.map(url => ({ url }));
  }

  const res = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Apify run start failed: ${res.status} ${errText}`);
  }

  const data = await res.json() as any;
  return data.data.id;
}

// Polluje stav Apify runu
async function waitForRun(runId: string, timeoutMs: number = 900_000): Promise<ApifyRunResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`
    );
    if (!res.ok) throw new Error(`Apify run status failed: ${res.status}`);
    const data = await res.json() as any;
    const run = data.data;

    if (run.status === 'SUCCEEDED' || run.status === 'FAILED' || run.status === 'ABORTED' || run.status === 'TIMED-OUT') {
      return {
        id: run.id,
        status: run.status,
        defaultDatasetId: run.defaultDatasetId,
      };
    }

    // Čekej 10s mezi polly
    console.log(`    ... bezi (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise(r => setTimeout(r, 10_000));
  }
  throw new Error(`Apify run ${runId} timeout po ${timeoutMs / 1000}s`);
}

// Stáhne items z datasetu
async function fetchDatasetItems(datasetId: string): Promise<any[]> {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&limit=2000`
  );
  if (!res.ok) throw new Error(`Dataset fetch failed: ${res.status}`);
  return res.json() as Promise<any[]>;
}

// ============================================================
// Import funkce (volá warehouse API)
// ============================================================

const API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Origin': 'https://vz.ludone.cz',
};

interface JobResult {
  jobName: string;
  sourceId: number;
  datasetId: string;
  itemsScraped: number;
  created: number;
  updated: number;
  pricesAdded: number;
  errors: number;
  durationSec: number;
}

async function importItems(items: any[], sourceId: number, categoryId: number): Promise<{ created: number; updated: number; pricesAdded: number; errors: number }> {
  let created = 0, updated = 0, pricesAdded = 0, errors = 0;

  for (const item of items) {
    try {
      if (!item.name || !item.offers?.price) {
        errors++;
        continue;
      }

      const brand = item.brand?.slogan || item.name.split(/\s+/)[0];
      const specs = item.additionalProperties?.specifications;
      const params: Record<string, string> = {};
      if (specs) {
        for (const s of specs) {
          let key = s.parameter;
          if (key.length > 50) {
            const m = key.match(/^[^.!?]+/);
            if (m) key = m[0].trim();
          }
          params[key] = s.value;
        }
      }

      const priceSdph = item.offers.price;
      const priceBezDph = item.additionalProperties?.currentPriceWithoutVAT
        ?? Math.round((priceSdph / 1.21) * 100) / 100;

      // Vytvoř produkt
      const productBody = {
        manufacturer: brand,
        model: item.name,
        ean: null,
        part_number: item.mpn || null,
        category_id: categoryId,
        description: item.description || null,
        raw_description: item.description || null,
        parameters: params,
        parameters_normalized: params,
        image_url: item.image || null,
        hmotnost_kg: null,
        is_active: true,
        zdroj_dat: 'apify',
      };

      const createRes = await fetch(`${API_BASE}/products`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify(productBody),
      });

      let productId: string;

      if (createRes.ok) {
        const product = await createRes.json() as any;
        productId = product.id;
        created++;
      } else if (createRes.status === 409) {
        const searchRes = await fetch(
          `${API_BASE}/products?q=${encodeURIComponent(item.name)}&limit=1`,
          { headers: { 'Origin': 'https://vz.ludone.cz' } }
        );
        const searchData = await searchRes.json() as any;
        if (searchData.items?.[0]) {
          productId = searchData.items[0].id;
          updated++;
        } else {
          errors++;
          continue;
        }
      } else {
        errors++;
        continue;
      }

      // Přidej cenu
      const priceBody = {
        source_id: sourceId,
        price_bez_dph: priceBezDph,
        price_s_dph: priceSdph,
        currency: 'CZK',
        availability: item.additionalProperties?.availability || null,
        source_url: item.url || null,
        source_sku: item.mpn || null,
      };

      const priceRes = await fetch(`${API_BASE}/products/${productId}/prices`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify(priceBody),
      });

      if (priceRes.ok) {
        pricesAdded++;
      } else {
        errors++;
      }

      // Mírné zpoždění
      await new Promise(r => setTimeout(r, 50));
    } catch {
      errors++;
    }
  }

  return { created, updated, pricesAdded, errors };
}

// ============================================================
// Hlavní orchestrátor
// ============================================================

async function runAllJobs(testMode: boolean): Promise<JobResult[]> {
  const results: JobResult[] = [];
  const maxItemsOverride = testMode ? 5 : undefined;

  console.log(`\n=== SCRAPING 3D TRHU ===`);
  console.log(`Mod: ${testMode ? 'TEST (max 5 items/job)' : 'PLNY RUN'}`);
  console.log(`Pocet jobu: ${JOBS.length}`);
  console.log(`API: ${API_BASE}\n`);

  for (let i = 0; i < JOBS.length; i++) {
    const job = JOBS[i];
    const maxItems = maxItemsOverride ?? job.maxItems;
    const startTime = Date.now();

    console.log(`\n[${i + 1}/${JOBS.length}] ${job.name}`);
    console.log(`  Zdroj: ${job.sourceName} (id=${job.sourceId}), kategorie: ${job.categoryId}`);

    try {
      // Krok 1: Spustit Apify run
      const runId = await startApifyRun(job, maxItems);
      console.log(`  Apify run: ${runId}`);

      // Krok 2: Čekat na dokončení
      const run = await waitForRun(runId);
      console.log(`  Status: ${run.status}, dataset: ${run.defaultDatasetId}`);

      if (run.status !== 'SUCCEEDED') {
        console.log(`  PRESKOCENO - run selhal (${run.status})`);
        results.push({
          jobName: job.name, sourceId: job.sourceId,
          datasetId: run.defaultDatasetId,
          itemsScraped: 0, created: 0, updated: 0, pricesAdded: 0, errors: 1,
          durationSec: Math.round((Date.now() - startTime) / 1000),
        });
        continue;
      }

      // Krok 3: Stáhnout items
      const items = await fetchDatasetItems(run.defaultDatasetId);
      console.log(`  Stazeno: ${items.length} items`);

      // Krok 4: Importovat do warehouse
      const importResult = await importItems(items, job.sourceId, job.categoryId);
      const durationSec = Math.round((Date.now() - startTime) / 1000);

      console.log(`  Import: +${importResult.created} novych, ~${importResult.updated} existujicich, ${importResult.pricesAdded} cen, ${importResult.errors} chyb (${durationSec}s)`);

      results.push({
        jobName: job.name,
        sourceId: job.sourceId,
        datasetId: run.defaultDatasetId,
        itemsScraped: items.length,
        ...importResult,
        durationSec,
      });

    } catch (err: any) {
      const durationSec = Math.round((Date.now() - startTime) / 1000);
      console.log(`  CHYBA: ${err.message}`);
      results.push({
        jobName: job.name, sourceId: job.sourceId,
        datasetId: '', itemsScraped: 0, created: 0, updated: 0, pricesAdded: 0, errors: 1,
        durationSec,
      });
    }
  }

  return results;
}

function printSummary(results: JobResult[]) {
  console.log('\n\n========================================');
  console.log('         SOUHRNNE VYSLEDKY');
  console.log('========================================\n');

  let totalScraped = 0, totalCreated = 0, totalUpdated = 0, totalPrices = 0, totalErrors = 0, totalTime = 0;

  for (const r of results) {
    console.log(`${r.jobName}`);
    console.log(`  scraped=${r.itemsScraped} created=${r.created} updated=${r.updated} prices=${r.pricesAdded} errors=${r.errors} (${r.durationSec}s)`);
    totalScraped += r.itemsScraped;
    totalCreated += r.created;
    totalUpdated += r.updated;
    totalPrices += r.pricesAdded;
    totalErrors += r.errors;
    totalTime += r.durationSec;
  }

  console.log('\n----------------------------------------');
  console.log(`CELKEM: ${totalScraped} scraped, ${totalCreated} novych, ${totalUpdated} existujicich, ${totalPrices} cen, ${totalErrors} chyb`);
  console.log(`Cas: ${Math.round(totalTime / 60)} minut`);
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const testMode = args.includes('--test');

  if (dryRun) {
    console.log('=== DRY RUN — seznam jobu ===\n');
    for (let i = 0; i < JOBS.length; i++) {
      const j = JOBS[i];
      const target = j.mode === 'keyword' ? `keyword="${j.keyword}"` : `urls=${j.listingUrls?.join(', ')}`;
      console.log(`[${i + 1}] ${j.name} (${j.sourceName}, cat=${j.categoryId}, max=${j.maxItems})`);
      console.log(`    ${target}`);
    }
    console.log(`\nCelkem: ${JOBS.length} jobu`);
    return;
  }

  const results = await runAllJobs(testMode);
  printSummary(results);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
