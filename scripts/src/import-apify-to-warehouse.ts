#!/usr/bin/env npx tsx
/**
 * Import Apify e-commerce scraping výsledků do warehouse DB.
 * Použití: npx tsx scripts/src/import-apify-to-warehouse.ts <datasetId> [--source <id|name>] [--category <id>]
 *
 * Příklady:
 *   npx tsx import-apify-to-warehouse.ts abc123                          # Alza (default)
 *   npx tsx import-apify-to-warehouse.ts abc123 --source czc --category 14
 *   npx tsx import-apify-to-warehouse.ts abc123 --source 4 --category 16
 *
 * Transformuje Apify output → POST /api/warehouse/products + /prices
 */

const API_BASE = process.env.API_BASE || 'https://vz.ludone.cz/api/warehouse';
const APIFY_TOKEN = process.env.APIFY_TOKEN;
if (!APIFY_TOKEN) {
  console.error('Chybi APIFY_TOKEN env variable. Nastav: export APIFY_TOKEN=<tvuj_token>');
  process.exit(1);
}

// Mapování jmen zdrojů na source_id v DB
const SOURCE_NAME_MAP: Record<string, number> = {
  alza: 2,
  czc: 3,
  heureka: 4,
  mironet: 5,
  prusa: 6,
};

// Parsování --source parametru (číslo nebo jméno)
function resolveSourceId(value: string | undefined): number {
  if (!value) return 2; // default = Alza
  const asNum = parseInt(value);
  if (!isNaN(asNum)) return asNum;
  const lower = value.toLowerCase();
  if (SOURCE_NAME_MAP[lower]) return SOURCE_NAME_MAP[lower];
  throw new Error(`Neznámý zdroj: "${value}". Povolené: ${Object.keys(SOURCE_NAME_MAP).join(', ')} nebo číslo ID.`);
}

// Parsování CLI argumentů
function parseArgs(argv: string[]): { datasetId: string; sourceId: number; categoryId: number | null } {
  const positional: string[] = [];
  let sourceRaw: string | undefined;
  let categoryRaw: string | undefined;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--source' && argv[i + 1]) {
      sourceRaw = argv[++i];
    } else if (argv[i] === '--category' && argv[i + 1]) {
      categoryRaw = argv[++i];
    } else if (!argv[i].startsWith('--')) {
      positional.push(argv[i]);
    }
  }

  const datasetId = positional[0];
  // Backward compat: starý formát <datasetId> <categoryId>
  if (!categoryRaw && positional[1]) {
    categoryRaw = positional[1];
  }

  if (!datasetId) {
    throw new Error('USAGE');
  }

  return {
    datasetId,
    sourceId: resolveSourceId(sourceRaw),
    categoryId: categoryRaw ? parseInt(categoryRaw) : null,
  };
}

// Auth headers — same-origin bypass pro API
const API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'Origin': 'https://vz.ludone.cz',
};

interface ApifyItem {
  url: string;
  name: string;
  offers: { price: number; priceCurrency: string };
  mpn?: string;
  brand?: { slogan?: string };
  image?: string;
  description?: string;
  additionalProperties?: {
    segment?: string;
    currentPriceWithoutVAT?: number;
    discounted?: boolean;
    initialPrice?: number;
    ratingCount?: number;
    ratingValue?: number;
    condition?: string;
    availability?: string;
    specifications?: Array<{ parameter: string; value: string }>;
  };
}

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  pricesAdded: number;
  errors: Array<{ name: string; error: string }>;
}

// Stáhne items z Apify datasetu
async function fetchApifyDataset(datasetId: string): Promise<ApifyItem[]> {
  const res = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}&format=json&limit=1000`
  );
  if (!res.ok) throw new Error(`Apify dataset fetch failed: ${res.status}`);
  return res.json() as Promise<ApifyItem[]>;
}

// Rozpoznej kategorii ze segmentu
function detectCategoryId(item: ApifyItem, defaultCategoryId: number | null): number | null {
  const segment = item.additionalProperties?.segment?.toLowerCase() || '';
  const desc = item.description?.toLowerCase() || '';
  const name = item.name.toLowerCase();

  // 3D tiskárny
  if (segment.includes('3d tisk') || desc.includes('3d tiskárna')) {
    // SLA/DLP/MSLA
    if (desc.includes('sla') || desc.includes('msla') || desc.includes('dlp') || desc.includes('resin')) {
      return 15; // SLA/DLP tiskárny
    }
    // FDM
    if (desc.includes('fdm') || desc.includes('tiskový prostor')) {
      return 14; // FDM tiskárny
    }
    // Filamenty
    if (segment.includes('filament') || desc.includes('filament') || desc.startsWith('filament')) {
      return 16; // 3D materiály
    }
    // Příslušenství — vrať parent kategorii 3D tisk (13)
    if (segment.includes('příslušenství')) {
      return 13;
    }
    return 14; // FDM jako default pro 3D tiskárny
  }

  // Filamenty (detekce mimo segment)
  if (name.includes('filament') || name.includes('pla ') || name.includes('petg ') ||
      name.includes('abs ') || name.includes('tpu ') || desc.includes('filament')) {
    return 16; // 3D materiály
  }

  // Notebooky
  if (segment.includes('notebook') || desc.includes('notebook')) return 2;
  // Servery
  if (segment.includes('server')) return 3;
  // Monitory
  if (segment.includes('monitor')) return 4;
  // Tiskárny (klasické)
  if (segment.includes('tiskárn') && !segment.includes('3d')) return 5;
  // Síťové prvky
  if (segment.includes('síťov') || segment.includes('switch') || segment.includes('router')) return 6;
  // Projektory
  if (segment.includes('projektor')) return 10;

  return defaultCategoryId;
}

// Extrahuj hmotnost z parametrů
function extractWeight(specs: Array<{ parameter: string; value: string }> | undefined): number | null {
  if (!specs) return null;
  const weight = specs.find(s => s.parameter === 'Hmotnost');
  if (!weight) return null;
  const match = weight.value.replace(',', '.').match(/([\d.]+)\s*kg/i);
  return match ? parseFloat(match[1]) : null;
}

// Transformuj specifikace na normalizované parametry
function specsToParams(specs: Array<{ parameter: string; value: string }> | undefined): Record<string, string> {
  if (!specs) return {};
  const params: Record<string, string> = {};
  for (const s of specs) {
    // Vyčisti název parametru (obsahuje občas help text)
    let key = s.parameter;
    // Zkrať na první větu pokud je to moc dlouhé
    if (key.length > 50) {
      const firstSentence = key.match(/^[^.!?]+/);
      if (firstSentence) key = firstSentence[0].trim();
    }
    params[key] = s.value;
  }
  return params;
}

// Hlavní import — sourceId jako parametr místo hardcoded konstanty
async function importDataset(datasetId: string, defaultCategoryId: number | null, sourceId: number = 2): Promise<ImportResult> {
  console.log(`Fetching Apify dataset ${datasetId}...`);
  const items = await fetchApifyDataset(datasetId);
  console.log(`Got ${items.length} items from Apify`);

  const result: ImportResult = {
    total: items.length,
    created: 0,
    updated: 0,
    pricesAdded: 0,
    errors: [],
  };

  for (const item of items) {
    try {
      if (!item.name || !item.offers?.price) {
        result.errors.push({ name: item.name || '?', error: 'Missing name or price' });
        continue;
      }

      const brand = item.brand?.slogan || item.name.split(/\s+/)[0];
      const categoryId = detectCategoryId(item, defaultCategoryId);
      const specs = item.additionalProperties?.specifications;
      const params = specsToParams(specs);
      const weight = extractWeight(specs);

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
        hmotnost_kg: weight,
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
        result.created++;
        console.log(`  + ${item.name} (${priceSdph} CZK) → #${productId}`);
      } else if (createRes.status === 409) {
        // Duplikát — zkus najít existující produkt přes search
        const searchRes = await fetch(
          `${API_BASE}/products?q=${encodeURIComponent(item.name)}&limit=1`,
          { headers: { 'Origin': 'https://vz.ludone.cz' } }
        );
        const searchData = await searchRes.json() as any;
        if (searchData.items?.[0]) {
          productId = searchData.items[0].id;
          result.updated++;
          console.log(`  ~ ${item.name} (existuje, #${productId})`);
        } else {
          result.errors.push({ name: item.name, error: 'Duplicate but not found in search' });
          continue;
        }
      } else {
        const errText = await createRes.text();
        result.errors.push({ name: item.name, error: `Create failed: ${createRes.status} ${errText}` });
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
        result.pricesAdded++;
      } else {
        const errText = await priceRes.text();
        result.errors.push({ name: item.name, error: `Price failed: ${priceRes.status} ${errText}` });
      }

      // Mírné zpoždění aby se nepřetížil server
      await new Promise(r => setTimeout(r, 100));

    } catch (err: any) {
      result.errors.push({ name: item.name || '?', error: err.message || String(err) });
    }
  }

  return result;
}

// Export pro použití z orchestrátoru
export { importDataset, fetchApifyDataset, type ImportResult };

// CLI
async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e: any) {
    if (e.message === 'USAGE') {
      console.error('Použití: npx tsx import-apify-to-warehouse.ts <datasetId> [--source <id|name>] [--category <id>]');
      console.error('');
      console.error('  datasetId  — ID Apify datasetu z běhu e-commerce scraperu');
      console.error('  --source   — ID nebo jméno zdroje (alza=2, czc=3, heureka=4, mironet=5, prusa=6)');
      console.error('  --category — výchozí ID kategorie (14=FDM, 15=SLA, 16=materiály)');
      console.error('');
      console.error('Příklady:');
      console.error('  npx tsx import-apify-to-warehouse.ts abc123 --source czc --category 14');
      console.error('  npx tsx import-apify-to-warehouse.ts abc123 14              # backward compat');
      process.exit(1);
    }
    throw e;
  }

  const sourceNames = Object.entries(SOURCE_NAME_MAP);
  const sourceName = sourceNames.find(([_, v]) => v === args.sourceId)?.[0] || `id=${args.sourceId}`;

  console.log(`\nImporting Apify dataset ${args.datasetId} → ${API_BASE}`);
  console.log(`Zdroj: ${sourceName} (source_id=${args.sourceId})`);
  if (args.categoryId) console.log(`Default category: ${args.categoryId}`);
  console.log('');

  const result = await importDataset(args.datasetId, args.categoryId, args.sourceId);

  console.log('\n=== VYSLEDEK IMPORTU ===');
  console.log(`Celkem: ${result.total}`);
  console.log(`Vytvoreno: ${result.created}`);
  console.log(`Aktualizovano: ${result.updated}`);
  console.log(`Cen pridano: ${result.pricesAdded}`);
  if (result.errors.length) {
    console.log(`Chyb: ${result.errors.length}`);
    for (const e of result.errors.slice(0, 10)) {
      console.log(`  X ${e.name}: ${e.error}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
