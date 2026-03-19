/**
 * Abstraktní base class pro scrapery.
 * Každý scraper je AsyncGenerator — yield-uje ScrapedProduct.
 */
import type { ScrapedProduct, ShopConfig, ShopCategory, ScrapeOptions } from './types.js';

export abstract class ShopScraper {
  abstract readonly config: ShopConfig;

  /**
   * Hlavní metoda — vrací AsyncGenerator produktů.
   * Implementace v konkrétním scraperu.
   */
  abstract scrape(
    categories: ShopCategory[],
    options: ScrapeOptions,
  ): AsyncGenerator<ScrapedProduct, void, undefined>;

  /**
   * Vrátí kategorie k scrapování (filtrované podle options).
   */
  getCategories(options: ScrapeOptions): ShopCategory[] {
    if (!options.category) return this.config.categories;

    const filter = options.category.toLowerCase();
    return this.config.categories.filter(
      (c) =>
        c.slug.toLowerCase() === filter ||
        c.name.toLowerCase().includes(filter),
    );
  }

  /**
   * Volitelná inicializace (login, token refresh...).
   */
  async init(): Promise<void> {
    // override v podtřídě
  }

  /**
   * Volitelný cleanup.
   */
  async cleanup(): Promise<void> {
    // override v podtřídě
  }
}
