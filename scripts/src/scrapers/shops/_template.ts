/**
 * Šablona pro nový shop scraper.
 *
 * Kopíruj tento soubor a přejmenuj na slug shopu (např. filament-pm.ts).
 *
 * Pro HTML e-shopy: extends DirectHttpScraper
 * Pro API/GraphQL shopy: extends ApiScraper
 *
 * Po vytvoření: registruj v ../registry.ts
 */
import { ApiScraper } from '../api-scraper.js';
// import { DirectHttpScraper, type ListingResult } from '../direct-http-scraper.js';
import type { ScrapedProduct, ShopConfig, ShopCategory, ScrapeOptions } from '../types.js';

class TemplateShopScraper extends ApiScraper {
  readonly config: ShopConfig = {
    id: 'template-shop',
    name: 'Template Shop',
    url: 'https://example.com',
    source_id: 0, // ID z tabulky data_sources
    categories: [
      { slug: 'category-1', name: 'Kategorie 1', warehouse_category_id: 14 },
    ],
  };

  // Volitelná inicializace (login, token refresh...)
  async init(): Promise<void> {
    // Příklad: OAuth login
    // this.accessToken = await login(process.env.SHOP_EMAIL, process.env.SHOP_PASSWORD);
  }

  protected async *fetchProducts(
    category: ShopCategory,
    options: ScrapeOptions,
  ): AsyncGenerator<ScrapedProduct, void, undefined> {
    // TODO: implementovat API volání + paginaci

    // Příklad yield:
    // yield {
    //   name: 'Produkt X',
    //   manufacturer: 'Výrobce',
    //   model: 'Model ABC',
    //   source_url: 'https://example.com/produkt-x',
    //   price_bez_dph: 1000,
    //   price_s_dph: 1210,
    //   category_id: category.warehouse_category_id,
    // };
  }
}

export default new TemplateShopScraper();
