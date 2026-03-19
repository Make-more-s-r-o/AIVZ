/**
 * Template method scraper pro klasické HTML e-shopy.
 * Podtřída implementuje parsování HTML stránek.
 */
import type { CheerioAPI } from 'cheerio';
import { ShopScraper } from './base-scraper.js';
import type { ScrapedProduct, ShopCategory, ScrapeOptions } from './types.js';
import { RateLimiter, fetchPage } from './http-utils.js';

export interface ListingResult {
  /** Parsované produkty z listing stránky */
  products: ScrapedProduct[];
  /** URL další stránky (null = konec) */
  nextPageUrl: string | null;
}

export abstract class DirectHttpScraper extends ShopScraper {
  protected rateLimiter: RateLimiter;

  constructor(concurrency = 2, delayMs = 500) {
    super();
    this.rateLimiter = new RateLimiter(concurrency, delayMs);
  }

  /**
   * Vrátí URL první listing stránky pro kategorii.
   */
  protected abstract getListingUrl(category: ShopCategory, page: number): string;

  /**
   * Parsuje listing stránku — produkty + odkaz na další stránku.
   */
  protected abstract parseListing($: CheerioAPI, url: string): ListingResult;

  /**
   * Volitelně: fetchne a doplní detail produktu (specs, popis...).
   * Defaultně vrací produkt beze změny.
   */
  protected async enrichFromDetail(
    product: ScrapedProduct,
    _$: CheerioAPI,
  ): Promise<ScrapedProduct> {
    return product;
  }

  async *scrape(
    categories: ShopCategory[],
    options: ScrapeOptions,
  ): AsyncGenerator<ScrapedProduct, void, undefined> {
    let totalYielded = 0;

    for (const category of categories) {
      let page = 1;
      let nextUrl: string | null = this.getListingUrl(category, page);

      while (nextUrl) {
        const $ = await this.rateLimiter.run(() => fetchPage(nextUrl!));
        const result = this.parseListing($, nextUrl);

        for (const product of result.products) {
          // Nastav warehouse category_id pokud je definováno
          if (category.warehouse_category_id && !product.category_id) {
            product.category_id = category.warehouse_category_id;
          }

          yield product;
          totalYielded++;

          if (options.limit && totalYielded >= options.limit) return;
        }

        nextUrl = result.nextPageUrl;
        page++;
      }
    }
  }
}
