/**
 * Importer — konzumuje AsyncGenerator<ScrapedProduct> a zapisuje do DB.
 * Používá warehouse-store.ts (upsertProduct, upsertPrice).
 */
import type { ScrapedProduct, ScrapeRunResult } from './types.js';
import { upsertProduct, upsertPrice } from '../lib/warehouse-store.js';
import type { CreateProductInput } from '../lib/warehouse-store.js';

/**
 * Importuje produkty z generátoru do warehouse DB.
 */
export async function importProducts(
  generator: AsyncGenerator<ScrapedProduct, void, undefined>,
  shopName: string,
  categoryName: string,
  sourceId: number,
  dryRun = false,
): Promise<ScrapeRunResult> {
  const start = Date.now();
  const result: ScrapeRunResult = {
    shop: shopName,
    category: categoryName,
    itemsScraped: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    errors: [],
    durationMs: 0,
  };

  for await (const item of generator) {
    result.itemsScraped++;

    if (dryRun) {
      console.log(`  [DRY] ${item.manufacturer} ${item.model} — ${item.price_bez_dph} Kč`);
      continue;
    }

    try {
      // Mapování ScrapedProduct → CreateProductInput
      const productInput: CreateProductInput = {
        manufacturer: item.manufacturer,
        model: item.model,
        ean: item.ean ?? null,
        part_number: item.part_number ?? null,
        category_id: item.category_id ?? null,
        product_family: item.product_family ?? null,
        description: item.description ?? null,
        image_url: item.image_url ?? null,
        hmotnost_kg: item.hmotnost_kg ?? null,
        zaruka_mesice: item.zaruka_mesice ?? null,
        parameters: item.parameters ?? {},
        parameters_normalized: item.parameters_normalized ?? {},
        is_active: true,
        zdroj_dat: shopName,
      };

      const { product, created } = await upsertProduct(productInput);

      if (created) {
        result.itemsCreated++;
      } else {
        result.itemsUpdated++;
      }

      // Upsert cena
      await upsertPrice({
        product_id: product.id,
        source_id: sourceId,
        price_bez_dph: item.price_bez_dph,
        price_s_dph: item.price_s_dph ?? null,
        currency: item.currency ?? 'CZK',
        availability: item.availability ?? null,
        stock_quantity: item.stock_quantity ?? null,
        delivery_days: item.delivery_days ?? null,
        source_url: item.source_url ?? null,
        source_sku: item.source_sku ?? null,
      });

      // Progress každých 10 produktů
      if (result.itemsScraped % 10 === 0) {
        console.log(`  ... ${result.itemsScraped} produktů zpracováno`);
      }
    } catch (err: any) {
      const msg = `${item.manufacturer} ${item.model}: ${err.message}`;
      result.errors.push(msg);
      console.error(`  ✗ ${msg}`);

      // Po 50 chybách přestaň
      if (result.errors.length >= 50) {
        console.error('  ✗ Příliš mnoho chyb, přerušuji kategorii');
        break;
      }
    }
  }

  result.durationMs = Date.now() - start;
  return result;
}
