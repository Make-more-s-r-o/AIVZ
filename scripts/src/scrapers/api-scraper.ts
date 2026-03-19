/**
 * Base class pro shopy s REST/GraphQL API (SPA, React...).
 * Podtřída implementuje API volání místo parsování HTML.
 */
import { ShopScraper } from './base-scraper.js';
import type { ScrapedProduct, ShopCategory, ScrapeOptions } from './types.js';
import { RateLimiter } from './http-utils.js';

export abstract class ApiScraper extends ShopScraper {
  protected rateLimiter: RateLimiter;

  constructor(concurrency = 2, delayMs = 300) {
    super();
    this.rateLimiter = new RateLimiter(concurrency, delayMs);
  }

  /**
   * Fetch produkty z API pro danou kategorii.
   * Implementace v podtřídě — typicky GraphQL query s paginací.
   */
  protected abstract fetchProducts(
    category: ShopCategory,
    options: ScrapeOptions,
  ): AsyncGenerator<ScrapedProduct, void, undefined>;

  async *scrape(
    categories: ShopCategory[],
    options: ScrapeOptions,
  ): AsyncGenerator<ScrapedProduct, void, undefined> {
    let totalYielded = 0;

    for (const category of categories) {
      for await (const product of this.fetchProducts(category, options)) {
        // Nastav warehouse category_id pokud je definováno
        if (category.warehouse_category_id && !product.category_id) {
          product.category_id = category.warehouse_category_id;
        }

        yield product;
        totalYielded++;

        if (options.limit && totalYielded >= options.limit) return;
      }
    }
  }
}
