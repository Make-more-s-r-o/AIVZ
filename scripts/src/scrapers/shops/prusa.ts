/**
 * Prusa Research e-shop scraper.
 *
 * Prusa web je React SPA — produkty jdou přes GraphQL API.
 * GraphQL endpoint: https://www.prusa3d.com/graphql/
 * Auth: NENÍ potřeba pro čtení katalogu (veřejné API).
 *
 * categorySlug argument na products query NEfunguje pro filtrování,
 * proto stahujeme všechny produkty a filtrujeme client-side
 * podle pole categories na každém produktu.
 */
import { ApiScraper } from '../api-scraper.js';
import type { ScrapedProduct, ShopConfig, ShopCategory, ScrapeOptions } from '../types.js';
import { fetchWithRetry, sleep } from '../http-utils.js';

// ============================================================
// GraphQL typy
// ============================================================

interface GqlProduct {
  name: string;
  slug: string;
  shortDescription: string | null;
  images: Array<{ url: string; alt: string | null }>;
  categories: Array<{ name: string; slug: string }>;
  availability: { name: string } | null;
  brand: { name: string } | null;
  parameters: Array<{ name: string; values: Array<{ text: string }> }>;
  price: {
    priceWithVat: string;
    priceWithoutVat: string;
  };
}

interface GqlProductsResponse {
  data: {
    products: {
      edges: Array<{ node: GqlProduct }>;
      totalCount: number;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

// ============================================================
// Konstanty
// ============================================================

const GRAPHQL_URL = 'https://www.prusa3d.com/graphql/';
const PRUSA_BASE = 'https://www.prusa3d.com';
const BATCH_SIZE = 50;

const PRODUCTS_QUERY = `
query Products($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    edges {
      node {
        name
        slug
        shortDescription
        images { url alt }
        categories { name slug }
        availability { name }
        brand { name }
        parameters { name values { text } }
        price(priceOptionInput: { currencyCode: "CZK", vatCountryCode: "CZ" }) {
          priceWithVat
          priceWithoutVat
        }
      }
    }
    totalCount
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}`;

// Mapování kategorií Prusa → naše warehouse kategorie
// Klíč = slug kategorie na Prusa, hodnota = warehouse category_id
const CATEGORY_MAP: Record<string, { warehouseId: number; name: string }> = {
  // 3D tiskárny
  'category/3d-printers/': { warehouseId: 14, name: '3D tiskárny' },
  'category/prusa-core-one-l-2/': { warehouseId: 14, name: '3D tiskárny' },
  'category/prusa-core-one-l/': { warehouseId: 14, name: '3D tiskárny' },
  'category/original-prusa-xl-2/': { warehouseId: 14, name: '3D tiskárny' },
  'category/original-prusa-mk4s/': { warehouseId: 14, name: '3D tiskárny' },
  'category/original-prusa-mini/': { warehouseId: 14, name: '3D tiskárny' },
  // Filamenty
  'category/filament/': { warehouseId: 16, name: 'Filamenty' },
  'category/prusament/': { warehouseId: 16, name: 'Filamenty' },
  'category/pla/': { warehouseId: 16, name: 'Filamenty' },
  'category/petg/': { warehouseId: 16, name: 'Filamenty' },
  'category/asa-abs/': { warehouseId: 16, name: 'Filamenty' },
  'category/pa-nylon/': { warehouseId: 16, name: 'Filamenty' },
  'category/pc-polycarbonate/': { warehouseId: 16, name: 'Filamenty' },
  'category/composites/': { warehouseId: 16, name: 'Filamenty' },
  'category/flex/': { warehouseId: 16, name: 'Filamenty' },
  'category/special/': { warehouseId: 16, name: 'Filamenty' },
  'category/eco/': { warehouseId: 16, name: 'Filamenty' },
  // Resin
  'category/resin-printing/': { warehouseId: 15, name: 'Resiny' },
  // Příslušenství
  'category/accessories/': { warehouseId: 13, name: 'Příslušenství' },
  'category/nozzles/': { warehouseId: 13, name: 'Příslušenství' },
  'category/print-sheets/': { warehouseId: 13, name: 'Příslušenství' },
  'category/essential-accessories/': { warehouseId: 13, name: 'Příslušenství' },
  'category/enclosure-2/': { warehouseId: 13, name: 'Příslušenství' },
  // Upgrady
  'category/upgrades/': { warehouseId: 13, name: 'Příslušenství' },
  'category/original-prusa-mmu3/': { warehouseId: 13, name: 'Příslušenství' },
};

// Slugy kategorií, které nás nezajímají (merchandise, kurzy, extended warranty...)
const IGNORED_CATEGORY_SLUGS = new Set([
  'category/merchandise/',
  'category/clothing/',
  'category/gear/',
  'category/prusa-academy/',
  'category/extended-warranty/',
  'category/buddy3d/',
  'category/3d-printers-autodesk-bundle/',
  'category/back-to-school-closed/',
]);

// ============================================================
// Scraper
// ============================================================

class PrusaScraper extends ApiScraper {
  readonly config: ShopConfig = {
    id: 'prusa',
    name: 'Prusa Research',
    url: 'https://www.prusa3d.com',
    source_id: 6, // data_sources.id pro Prusa
    categories: [
      { slug: '3d-printers', name: '3D tiskárny', warehouse_category_id: 14 },
      { slug: 'filament', name: 'Filamenty', warehouse_category_id: 16 },
      { slug: 'resin', name: 'Resiny', warehouse_category_id: 15 },
      { slug: 'accessories', name: 'Příslušenství', warehouse_category_id: 13 },
    ],
  };

  constructor() {
    super(1, 300); // 1 concurrent, 300ms delay
  }

  /**
   * GraphQL query na Prusa API.
   */
  private async gqlQuery(query: string, variables: Record<string, unknown>): Promise<GqlProductsResponse> {
    const response = await fetchWithRetry(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      },
      body: JSON.stringify({ query, variables }),
    });
    return response.json() as Promise<GqlProductsResponse>;
  }

  /**
   * Zjistí warehouse_category_id produktu podle jeho kategorií.
   */
  private resolveCategory(gqlProduct: GqlProduct): number | null {
    for (const cat of gqlProduct.categories) {
      const mapped = CATEGORY_MAP[cat.slug];
      if (mapped) return mapped.warehouseId;
    }
    return null;
  }

  /**
   * Zjistí, zda produkt patří do požadované ShopCategory.
   */
  private matchesCategory(gqlProduct: GqlProduct, shopCategory: ShopCategory): boolean {
    const slug = shopCategory.slug;
    const productCatSlugs = gqlProduct.categories.map((c) => c.slug);

    switch (slug) {
      case '3d-printers':
        return productCatSlugs.some(
          (s) =>
            s.includes('3d-printers') ||
            s.includes('prusa-core-one') ||
            s.includes('original-prusa-xl') ||
            s.includes('original-prusa-mk4') ||
            s.includes('original-prusa-mini'),
        );
      case 'filament':
        return productCatSlugs.some(
          (s) =>
            s.includes('filament') ||
            s.includes('prusament') ||
            s.includes('pla') ||
            s.includes('petg') ||
            s.includes('asa-abs') ||
            s.includes('pa-nylon') ||
            s.includes('pc-polycarbonate') ||
            s.includes('composites') ||
            s.includes('flex/') ||
            s.includes('special/') ||
            s.includes('eco/'),
        );
      case 'resin':
        return productCatSlugs.some((s) => s.includes('resin'));
      case 'accessories':
        return productCatSlugs.some(
          (s) =>
            s.includes('accessories') ||
            s.includes('nozzles') ||
            s.includes('print-sheets') ||
            s.includes('enclosure') ||
            s.includes('upgrades') ||
            s.includes('mmu3') ||
            s.includes('cameras'),
        );
      default:
        return false;
    }
  }

  /**
   * Zda produkt ignorujeme (merch, kurzy...).
   */
  private shouldIgnore(gqlProduct: GqlProduct): boolean {
    // Ignoruj produkty, které mají POUZE nezajímavé kategorie
    const categorySlugs = gqlProduct.categories.map((c) => c.slug);
    if (categorySlugs.length === 0) return true;
    return categorySlugs.every((s) => IGNORED_CATEGORY_SLUGS.has(s));
  }

  /**
   * Převede GQL produkt na ScrapedProduct.
   */
  private toScrapedProduct(gql: GqlProduct): ScrapedProduct {
    const priceWithVat = parseFloat(gql.price.priceWithVat);
    const priceWithoutVat = parseFloat(gql.price.priceWithoutVat);

    // Parsuj parametry
    const parameters: Record<string, string> = {};
    for (const param of gql.parameters) {
      if (param.values.length > 0) {
        parameters[param.name] = param.values.map((v) => v.text).join(', ');
      }
    }

    // Extrahuj clean description z shortDescription (HTML → text)
    const description = gql.shortDescription
      ? gql.shortDescription.replace(/<[^>]+>/g, '').trim()
      : null;

    // Image URL — relativní → absolutní
    const imageUrl = gql.images[0]?.url
      ? gql.images[0].url.startsWith('http')
        ? gql.images[0].url
        : `${PRUSA_BASE}${gql.images[0].url}`
      : null;

    return {
      name: gql.name,
      manufacturer: 'Prusa Research',
      model: gql.name,
      source_url: `${PRUSA_BASE}/${gql.slug}`,
      source_sku: gql.slug,
      description,
      image_url: imageUrl,
      price_bez_dph: Math.round(priceWithoutVat * 100) / 100,
      price_s_dph: Math.round(priceWithVat * 100) / 100,
      currency: 'CZK',
      availability: gql.availability?.name ?? null,
      category_id: this.resolveCategory(gql),
      parameters,
    };
  }

  /**
   * Stahuje produkty přes GraphQL s paginací.
   * Filtruje client-side podle kategorie, protože GraphQL categorySlug nefunguje.
   */
  protected async *fetchProducts(
    category: ShopCategory,
    options: ScrapeOptions,
  ): AsyncGenerator<ScrapedProduct, void, undefined> {
    let cursor: string | null = null;
    let hasNext = true;
    let yielded = 0;
    let totalFetched = 0;

    console.log(`  Stahuji produkty z GraphQL (filtr: ${category.name})...`);

    while (hasNext) {
      const variables: Record<string, unknown> = { first: BATCH_SIZE };
      if (cursor) variables.after = cursor;

      let result: GqlProductsResponse;
      try {
        result = await this.rateLimiter.run(() =>
          this.gqlQuery(PRODUCTS_QUERY, variables),
        );
      } catch (err: any) {
        console.error(`  Fetch selhalo (batch po ${totalFetched}): ${err.message}`);
        console.error(`  Pokračuji s tím co už mám...`);
        break;
      }

      if (result.errors) {
        console.error(`  GraphQL errors:`, result.errors.map((e) => e.message).join(', '));
        break;
      }

      const { edges, pageInfo, totalCount } = result.data.products;
      totalFetched += edges.length;

      if (totalFetched === BATCH_SIZE) {
        console.log(`  Celkem produktů v katalogu: ${totalCount}`);
      }

      for (const edge of edges) {
        const gql = edge.node;

        // Filtruj: patří do naší kategorie?
        if (!this.matchesCategory(gql, category)) continue;

        // Ignoruj merch/kurzy
        if (this.shouldIgnore(gql)) continue;

        // Ignoruj produkty bez ceny
        if (!gql.price || parseFloat(gql.price.priceWithVat) === 0) continue;

        yield this.toScrapedProduct(gql);
        yielded++;

        if (options.limit && yielded >= options.limit) return;
      }

      hasNext = pageInfo.hasNextPage;
      cursor = pageInfo.endCursor;

      // Progress
      if (totalFetched % 200 === 0) {
        console.log(`  ... ${totalFetched}/${totalCount} staženo, ${yielded} odpovídajících`);
      }
    }

    console.log(`  Hotovo: ${totalFetched} staženo, ${yielded} v kategorii "${category.name}"`);
  }
}

// Export jako singleton (pro registry)
export default new PrusaScraper();
