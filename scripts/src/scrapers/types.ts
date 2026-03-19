/**
 * Typy pro univerzální scraping systém.
 */

/** Produkt ze scraperu — společný formát pro všechny shopy */
export interface ScrapedProduct {
  /** Název produktu */
  name: string;
  /** Výrobce */
  manufacturer: string;
  /** Model / SKU v rámci výrobce */
  model: string;
  /** EAN kód (pokud dostupný) */
  ean?: string | null;
  /** Číslo dílu / MPN */
  part_number?: string | null;
  /** Popis produktu */
  description?: string | null;
  /** URL obrázku */
  image_url?: string | null;
  /** URL produktu ve zdrojovém shopu */
  source_url: string;
  /** SKU ve zdrojovém shopu */
  source_sku?: string | null;
  /** Cena bez DPH (CZK) */
  price_bez_dph: number;
  /** Cena s DPH (CZK) */
  price_s_dph?: number | null;
  /** Měna */
  currency?: string;
  /** Dostupnost (textově) */
  availability?: string | null;
  /** Počet kusů na skladě */
  stock_quantity?: number | null;
  /** Dodací lhůta ve dnech */
  delivery_days?: number | null;
  /** ID kategorie v našem warehouse */
  category_id?: number | null;
  /** Rodina produktů */
  product_family?: string | null;
  /** Hmotnost v kg */
  hmotnost_kg?: number | null;
  /** Záruka v měsících */
  zaruka_mesice?: number | null;
  /** Parametry (klíč-hodnota) */
  parameters?: Record<string, string>;
  /** Normalizované parametry */
  parameters_normalized?: Record<string, unknown>;
}

/** Konfigurace kategorie pro scraping */
export interface ShopCategory {
  /** Slug/identifikátor kategorie ve shopu */
  slug: string;
  /** Lidský název */
  name: string;
  /** ID kategorie v našem warehouse */
  warehouse_category_id?: number;
}

/** Konfigurace shopu */
export interface ShopConfig {
  /** Unikátní ID shopu (snake_case) */
  id: string;
  /** Lidský název */
  name: string;
  /** URL shopu */
  url: string;
  /** ID data_source v DB */
  source_id: number;
  /** Dostupné kategorie */
  categories: ShopCategory[];
}

/** Volby pro scraping run */
export interface ScrapeOptions {
  /** Maximální počet produktů (pro testování) */
  limit?: number;
  /** Filtr na konkrétní kategorii (slug nebo název) */
  category?: string;
  /** Dry run — nepsat do DB */
  dryRun?: boolean;
}

/** Výsledek jednoho scrape runu */
export interface ScrapeRunResult {
  shop: string;
  category: string;
  itemsScraped: number;
  itemsCreated: number;
  itemsUpdated: number;
  errors: string[];
  durationMs: number;
}

/** Celkový výsledek scrapingu */
export interface ScrapeSummary {
  shop: string;
  runs: ScrapeRunResult[];
  totalScraped: number;
  totalCreated: number;
  totalUpdated: number;
  totalErrors: number;
  totalDurationMs: number;
}
