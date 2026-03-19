/**
 * Registry — auto-discover scraperů z shops/ adresáře.
 */
import type { ShopScraper } from './base-scraper.js';

// Manuální registrace shopů (auto-discover přes fs by nefungovalo s bundlery)
const shopModules: Record<string, () => Promise<{ default: ShopScraper }>> = {
  prusa: () => import('./shops/prusa.js') as Promise<{ default: ShopScraper }>,
};

/** Vrátí instanci scraperu podle shop ID */
export async function getScraper(shopId: string): Promise<ShopScraper | null> {
  const loader = shopModules[shopId];
  if (!loader) return null;

  const mod = await loader();
  return mod.default;
}

/** Vrátí seznam všech registrovaných shopů */
export function getRegisteredShops(): string[] {
  return Object.keys(shopModules);
}

/**
 * Registruje nový shop (pro dynamické přidávání).
 */
export function registerShop(
  id: string,
  loader: () => Promise<{ default: ShopScraper }>,
): void {
  shopModules[id] = loader;
}
