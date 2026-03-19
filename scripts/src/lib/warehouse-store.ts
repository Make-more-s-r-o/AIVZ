/**
 * Warehouse CRUD store — produkty, ceny, zdroje, kategorie.
 * Používá PostgreSQL přes db.ts pool.
 */
import { query, queryOne, isDbAvailable, getPool } from './db.js';

// ============================================================
// Typy
// ============================================================

export interface WarehouseProduct {
  id: string;
  manufacturer: string;
  model: string;
  ean: string | null;
  part_number: string | null;
  category_id: number | null;
  product_family: string | null;
  description: string | null;
  raw_description: string | null;
  parameters: Record<string, string>;
  parameters_normalized: Record<string, unknown>;
  image_url: string | null;
  hmotnost_kg: number | null;
  zaruka_mesice: number | null;
  is_active: boolean;
  zdroj_dat: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields (optional)
  category_slug?: string;
  category_nazev?: string;
  best_price?: number | null;
  best_price_source?: string | null;
}

export interface CreateProductInput {
  manufacturer: string;
  model: string;
  ean?: string | null;
  part_number?: string | null;
  category_id?: number | null;
  product_family?: string | null;
  description?: string | null;
  raw_description?: string | null;
  parameters?: Record<string, string>;
  parameters_normalized?: Record<string, unknown>;
  image_url?: string | null;
  hmotnost_kg?: number | null;
  zaruka_mesice?: number | null;
  is_active?: boolean;
  zdroj_dat?: string | null;
}

export interface ProductPrice {
  product_id: string;
  source_id: number;
  source_name?: string;
  price_bez_dph: number;
  price_s_dph: number | null;
  currency: string;
  availability: string | null;
  stock_quantity: number | null;
  delivery_days: number | null;
  source_url: string | null;
  source_sku: string | null;
  fetched_at: string;
}

export interface Category {
  id: number;
  slug: string;
  nazev: string;
  parent_id: number | null;
  ikona: string | null;
  children?: Category[];
}

export interface DataSource {
  id: number;
  name: string;
  type: string;
  base_url: string | null;
  is_active: boolean;
  last_scraped_at: string | null;
  created_at: string;
  scraper_config: Record<string, unknown> | null;
}

export interface WarehouseStats {
  products: number;
  products_active: number;
  sources: number;
  categories: number;
  prices: number;
  last_import: string | null;
}

export interface ProductSearchParams {
  q?: string;
  category_id?: number;
  manufacturer?: string;
  price_min?: number;
  price_max?: number;
  is_active?: boolean;
  limit?: number;
  offset?: number;
  sort_by?: 'name' | 'price' | 'updated' | 'relevance';
  sort_dir?: 'asc' | 'desc';
}

// ============================================================
// Stats
// ============================================================

export async function getWarehouseStats(): Promise<WarehouseStats> {
  const [products, active, sources, categories, prices, lastImport] = await Promise.all([
    queryOne<{ count: string }>('SELECT count(*) as count FROM products'),
    queryOne<{ count: string }>('SELECT count(*) as count FROM products WHERE is_active = true'),
    queryOne<{ count: string }>('SELECT count(*) as count FROM data_sources'),
    queryOne<{ count: string }>('SELECT count(*) as count FROM product_categories'),
    queryOne<{ count: string }>('SELECT count(*) as count FROM product_prices_current'),
    queryOne<{ last: string | null }>('SELECT max(created_at) as last FROM products'),
  ]);

  return {
    products: parseInt(products?.count ?? '0'),
    products_active: parseInt(active?.count ?? '0'),
    sources: parseInt(sources?.count ?? '0'),
    categories: parseInt(categories?.count ?? '0'),
    prices: parseInt(prices?.count ?? '0'),
    last_import: lastImport?.last ?? null,
  };
}

// Rozšířené statistiky kvality dat pro warehouse dashboard
export interface WarehouseQualityStats {
  price_freshness: { fresh: number; aging: number; stale: number }; // <7d, 7-30d, >30d
  products_without_price: number;
  products_without_image: number;
  products_without_description: number;
  categories_breakdown: Array<{ category_id: number; category_nazev: string; product_count: number; avg_price: number | null }>;
  sources_breakdown: Array<{ source_id: number; source_name: string; product_count: number; price_count: number; last_scraped_at: string | null }>;
  avg_prices_per_product: number;
}

export async function getWarehouseQualityStats(): Promise<WarehouseQualityStats> {
  const [
    freshness,
    withoutPrice,
    withoutImage,
    withoutDescription,
    categoriesBreakdown,
    sourcesBreakdown,
    avgPrices,
  ] = await Promise.all([
    // Čerstvost cen: kolik je fresh (<7d), aging (7-30d), stale (>30d)
    queryOne<{ fresh: string; aging: string; stale: string }>(`
      SELECT
        COALESCE(SUM(CASE WHEN fetched_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END), 0) as fresh,
        COALESCE(SUM(CASE WHEN fetched_at <= NOW() - INTERVAL '7 days' AND fetched_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END), 0) as aging,
        COALESCE(SUM(CASE WHEN fetched_at <= NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END), 0) as stale
      FROM product_prices_current
    `),
    // Produkty bez ceny
    queryOne<{ count: string }>(`
      SELECT count(*) as count FROM products p
      LEFT JOIN product_prices_current ppc ON p.id = ppc.product_id
      WHERE ppc.product_id IS NULL AND p.is_active = true
    `),
    // Produkty bez obrázku
    queryOne<{ count: string }>(`
      SELECT count(*) as count FROM products WHERE image_url IS NULL AND is_active = true
    `),
    // Produkty bez popisu
    queryOne<{ count: string }>(`
      SELECT count(*) as count FROM products WHERE description IS NULL AND is_active = true
    `),
    // Rozložení podle kategorií s průměrnou cenou
    query<{ category_id: number; category_nazev: string; product_count: string; avg_price: number | null }>(`
      SELECT pc.id as category_id, pc.nazev as category_nazev,
             count(p.id)::int as product_count,
             avg(bp.price_bez_dph) as avg_price
      FROM product_categories pc
      LEFT JOIN products p ON p.category_id = pc.id AND p.is_active = true
      LEFT JOIN v_best_prices bp ON p.id = bp.product_id
      GROUP BY pc.id, pc.nazev
      ORDER BY count(p.id) DESC
    `),
    // Rozložení podle zdrojů s počtem cen
    query<{ source_id: number; source_name: string; product_count: string; price_count: string; last_scraped_at: string | null }>(`
      SELECT ds.id as source_id, ds.name as source_name,
             count(DISTINCT ppc.product_id)::int as product_count,
             count(ppc.product_id)::int as price_count,
             ds.last_scraped_at
      FROM data_sources ds
      LEFT JOIN product_prices_current ppc ON ds.id = ppc.source_id
      GROUP BY ds.id, ds.name, ds.last_scraped_at
      ORDER BY count(ppc.product_id) DESC
    `),
    // Průměrný počet cen na produkt (kolik zdrojů má typicky produkt)
    queryOne<{ avg_prices: string }>(`
      SELECT COALESCE(avg(cnt), 0) as avg_prices FROM (
        SELECT count(*) as cnt FROM product_prices_current GROUP BY product_id
      ) sub
    `),
  ]);

  return {
    price_freshness: {
      fresh: parseInt(freshness?.fresh ?? '0'),
      aging: parseInt(freshness?.aging ?? '0'),
      stale: parseInt(freshness?.stale ?? '0'),
    },
    products_without_price: parseInt(withoutPrice?.count ?? '0'),
    products_without_image: parseInt(withoutImage?.count ?? '0'),
    products_without_description: parseInt(withoutDescription?.count ?? '0'),
    categories_breakdown: categoriesBreakdown.rows.map((r) => ({
      category_id: r.category_id,
      category_nazev: r.category_nazev,
      product_count: parseInt(String(r.product_count)),
      avg_price: r.avg_price ? parseFloat(String(r.avg_price)) : null,
    })),
    sources_breakdown: sourcesBreakdown.rows.map((r) => ({
      source_id: r.source_id,
      source_name: r.source_name,
      product_count: parseInt(String(r.product_count)),
      price_count: parseInt(String(r.price_count)),
      last_scraped_at: r.last_scraped_at,
    })),
    avg_prices_per_product: parseFloat(avgPrices?.avg_prices ?? '0'),
  };
}

// ============================================================
// Kategorie
// ============================================================

export async function getCategories(): Promise<Category[]> {
  const { rows } = await query<Category>(
    'SELECT id, slug, nazev, parent_id, ikona FROM product_categories ORDER BY parent_id NULLS FIRST, nazev',
  );
  return rows;
}

export async function getCategoryTree(): Promise<Category[]> {
  const all = await getCategories();
  const map = new Map<number, Category>();
  for (const c of all) {
    map.set(c.id, { ...c, children: [] });
  }
  const roots: Category[] = [];
  for (const c of map.values()) {
    if (c.parent_id && map.has(c.parent_id)) {
      map.get(c.parent_id)!.children!.push(c);
    } else {
      roots.push(c);
    }
  }
  return roots;
}

// ============================================================
// Produkty — CRUD
// ============================================================

export async function getProduct(id: string): Promise<WarehouseProduct | null> {
  return queryOne<WarehouseProduct>(
    `SELECT p.*,
            pc.slug as category_slug, pc.nazev as category_nazev,
            bp.price_bez_dph as best_price, ds.name as best_price_source
     FROM products p
     LEFT JOIN product_categories pc ON p.category_id = pc.id
     LEFT JOIN v_best_prices bp ON p.id = bp.product_id
     LEFT JOIN data_sources ds ON bp.source_id = ds.id
     WHERE p.id = $1`,
    [id],
  );
}

export async function searchProducts(params: ProductSearchParams): Promise<{
  items: WarehouseProduct[];
  total: number;
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 0;

  const addParam = (val: unknown) => {
    paramIdx++;
    values.push(val);
    return `$${paramIdx}`;
  };

  if (params.is_active !== undefined) {
    conditions.push(`p.is_active = ${addParam(params.is_active)}`);
  }

  if (params.category_id) {
    conditions.push(`p.category_id IN (SELECT get_category_tree(${addParam(params.category_id)}))`);
  }

  if (params.manufacturer) {
    conditions.push(`lower(p.manufacturer) = lower(${addParam(params.manufacturer)})`);
  }

  if (params.price_min !== undefined) {
    conditions.push(`bp.price_bez_dph >= ${addParam(params.price_min)}`);
  }

  if (params.price_max !== undefined) {
    conditions.push(`bp.price_bez_dph <= ${addParam(params.price_max)}`);
  }

  // Textové vyhledávání (FTS + trigram fallback)
  let orderByRelevance = '';
  if (params.q && params.q.trim()) {
    const q = params.q.trim();
    const tsParam = addParam(q);
    const trgParam = addParam(q);
    conditions.push(
      `(p.search_vector @@ plainto_tsquery('simple', ${tsParam}) OR similarity(p.search_text, ${trgParam}) > 0.1)`,
    );
    orderByRelevance = `ts_rank(p.search_vector, plainto_tsquery('simple', ${tsParam})) DESC, similarity(p.search_text, ${trgParam}) DESC`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Počet výsledků
  const countSql = `
    SELECT count(*) as total FROM products p
    LEFT JOIN v_best_prices bp ON p.id = bp.product_id
    ${where}
  `;
  const { rows: countRows } = await query<{ total: string }>(countSql, [...values]);
  const total = parseInt(countRows[0]?.total ?? '0');

  // Řazení
  let orderBy: string;
  const dir = params.sort_dir === 'desc' ? 'DESC' : 'ASC';
  switch (params.sort_by) {
    case 'price':
      orderBy = `bp.price_bez_dph ${dir} NULLS LAST`;
      break;
    case 'updated':
      orderBy = `p.updated_at ${dir}`;
      break;
    case 'relevance':
      orderBy = orderByRelevance || `p.updated_at DESC`;
      break;
    case 'name':
    default:
      orderBy = `p.manufacturer ${dir}, p.model ${dir}`;
  }

  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;
  const limitParam = addParam(limit);
  const offsetParam = addParam(offset);

  const dataSql = `
    SELECT p.id, p.manufacturer, p.model, p.ean, p.part_number,
           p.category_id, p.product_family, p.description,
           p.parameters, p.parameters_normalized,
           p.image_url, p.hmotnost_kg, p.zaruka_mesice,
           p.is_active, p.zdroj_dat, p.created_at, p.updated_at,
           pc.slug as category_slug, pc.nazev as category_nazev,
           bp.price_bez_dph as best_price, ds.name as best_price_source,
           bp.fetched_at as best_price_fetched_at
    FROM products p
    LEFT JOIN product_categories pc ON p.category_id = pc.id
    LEFT JOIN v_best_prices bp ON p.id = bp.product_id
    LEFT JOIN data_sources ds ON bp.source_id = ds.id
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const { rows } = await query<WarehouseProduct>(dataSql, values);
  return { items: rows, total };
}

export async function createProduct(input: CreateProductInput): Promise<WarehouseProduct> {
  const row = await queryOne<WarehouseProduct>(
    `INSERT INTO products (
      manufacturer, model, ean, part_number, category_id, product_family,
      description, raw_description, parameters, parameters_normalized,
      image_url, hmotnost_kg, zaruka_mesice, is_active, zdroj_dat
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *`,
    [
      input.manufacturer,
      input.model,
      input.ean ?? null,
      input.part_number ?? null,
      input.category_id ?? null,
      input.product_family ?? null,
      input.description ?? null,
      input.raw_description ?? null,
      JSON.stringify(input.parameters ?? {}),
      JSON.stringify(input.parameters_normalized ?? {}),
      input.image_url ?? null,
      input.hmotnost_kg ?? null,
      input.zaruka_mesice ?? null,
      input.is_active ?? true,
      input.zdroj_dat ?? null,
    ],
  );
  if (!row) throw new Error('Failed to create product');
  return row;
}

export async function updateProduct(
  id: string,
  input: Partial<CreateProductInput>,
): Promise<WarehouseProduct | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 0;

  const addSet = (col: string, val: unknown) => {
    idx++;
    sets.push(`${col} = $${idx}`);
    values.push(val);
  };

  if (input.manufacturer !== undefined) addSet('manufacturer', input.manufacturer);
  if (input.model !== undefined) addSet('model', input.model);
  if (input.ean !== undefined) addSet('ean', input.ean);
  if (input.part_number !== undefined) addSet('part_number', input.part_number);
  if (input.category_id !== undefined) addSet('category_id', input.category_id);
  if (input.product_family !== undefined) addSet('product_family', input.product_family);
  if (input.description !== undefined) addSet('description', input.description);
  if (input.raw_description !== undefined) addSet('raw_description', input.raw_description);
  if (input.parameters !== undefined) addSet('parameters', JSON.stringify(input.parameters));
  if (input.parameters_normalized !== undefined)
    addSet('parameters_normalized', JSON.stringify(input.parameters_normalized));
  if (input.image_url !== undefined) addSet('image_url', input.image_url);
  if (input.hmotnost_kg !== undefined) addSet('hmotnost_kg', input.hmotnost_kg);
  if (input.zaruka_mesice !== undefined) addSet('zaruka_mesice', input.zaruka_mesice);
  if (input.is_active !== undefined) addSet('is_active', input.is_active);
  if (input.zdroj_dat !== undefined) addSet('zdroj_dat', input.zdroj_dat);

  if (sets.length === 0) return getProduct(id);

  addSet('updated_at', new Date().toISOString());
  idx++;
  values.push(id);

  return queryOne<WarehouseProduct>(
    `UPDATE products SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
}

export async function deleteProduct(id: string): Promise<boolean> {
  const result = await query('DELETE FROM products WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Upsert produkt s deduplikací: EAN > MPN > manufacturer+model.
 * Vrací {product, created: boolean}.
 */
export async function upsertProduct(input: CreateProductInput): Promise<{
  product: WarehouseProduct;
  created: boolean;
}> {
  // Resolve manufacturer alias (HP = Hewlett-Packard atd.)
  input = { ...input, manufacturer: await resolveManufacturer(input.manufacturer) };

  // 1. Hledej existující produkt
  let existing: WarehouseProduct | null = null;

  if (input.ean) {
    existing = await queryOne<WarehouseProduct>(
      'SELECT * FROM products WHERE ean = $1',
      [input.ean],
    );
  }

  if (!existing && input.part_number && input.manufacturer) {
    existing = await queryOne<WarehouseProduct>(
      'SELECT * FROM products WHERE manufacturer = $1 AND part_number = $2',
      [input.manufacturer, input.part_number],
    );
  }

  if (!existing) {
    existing = await queryOne<WarehouseProduct>(
      `SELECT * FROM products WHERE lower(manufacturer) = lower($1) AND model_normalized = lower(regexp_replace(regexp_replace($2, '\\s+', ' ', 'g'), '(?i)\\bgen\\s*', 'G', 'g'))`,
      [input.manufacturer, input.model],
    );
  }

  if (existing) {
    const updated = await updateProduct(existing.id, input);
    return { product: updated!, created: false };
  }

  const product = await createProduct(input);
  return { product, created: true };
}

// ============================================================
// Ceny
// ============================================================

export async function getProductPrices(productId: string): Promise<ProductPrice[]> {
  const { rows } = await query<ProductPrice>(
    `SELECT ppc.*, ds.name as source_name
     FROM product_prices_current ppc
     JOIN data_sources ds ON ppc.source_id = ds.id
     WHERE ppc.product_id = $1
     ORDER BY ppc.price_bez_dph ASC`,
    [productId],
  );
  return rows;
}

export async function upsertPrice(price: {
  product_id: string;
  source_id: number;
  price_bez_dph: number;
  price_s_dph?: number | null;
  currency?: string;
  availability?: string | null;
  stock_quantity?: number | null;
  delivery_days?: number | null;
  source_url?: string | null;
  source_sku?: string | null;
}): Promise<void> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Zjistit jestli se cena změnila → INSERT do historie
    const { rows } = await client.query<{ price_bez_dph: number }>(
      'SELECT price_bez_dph FROM product_prices_current WHERE product_id = $1 AND source_id = $2',
      [price.product_id, price.source_id],
    );
    const current = rows[0] ?? null;

    if (current && Number(current.price_bez_dph) !== price.price_bez_dph) {
      await client.query(
        `UPDATE product_prices_history SET valid_to = NOW()
         WHERE product_id = $1 AND source_id = $2 AND valid_to IS NULL`,
        [price.product_id, price.source_id],
      );
      await client.query(
        `INSERT INTO product_prices_history (product_id, source_id, price_bez_dph, price_s_dph, availability)
         VALUES ($1, $2, $3, $4, $5)`,
        [price.product_id, price.source_id, price.price_bez_dph, price.price_s_dph ?? null, price.availability ?? null],
      );
    } else if (!current) {
      await client.query(
        `INSERT INTO product_prices_history (product_id, source_id, price_bez_dph, price_s_dph, availability)
         VALUES ($1, $2, $3, $4, $5)`,
        [price.product_id, price.source_id, price.price_bez_dph, price.price_s_dph ?? null, price.availability ?? null],
      );
    }

    // Upsert aktuální cena
    await client.query(
      `INSERT INTO product_prices_current (product_id, source_id, price_bez_dph, price_s_dph, currency, availability, stock_quantity, delivery_days, source_url, source_sku, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (product_id, source_id) DO UPDATE SET
         price_bez_dph = EXCLUDED.price_bez_dph,
         price_s_dph = EXCLUDED.price_s_dph,
         currency = EXCLUDED.currency,
         availability = EXCLUDED.availability,
         stock_quantity = EXCLUDED.stock_quantity,
         delivery_days = EXCLUDED.delivery_days,
         source_url = EXCLUDED.source_url,
         source_sku = EXCLUDED.source_sku,
         fetched_at = NOW()`,
      [
        price.product_id,
        price.source_id,
        price.price_bez_dph,
        price.price_s_dph ?? null,
        price.currency ?? 'CZK',
        price.availability ?? null,
        price.stock_quantity ?? null,
        price.delivery_days ?? null,
        price.source_url ?? null,
        price.source_sku ?? null,
      ],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface PriceHistoryEntry {
  id: number;
  product_id: string;
  source_id: number;
  source_name: string;
  price_bez_dph: number;
  price_s_dph: number | null;
  availability: string | null;
  valid_from: string;
  valid_to: string | null;
}

export async function getPriceHistory(
  productId: string,
  sourceId?: number,
  limit = 50,
): Promise<PriceHistoryEntry[]> {
  const conditions = ['product_id = $1'];
  const values: unknown[] = [productId];
  let paramIdx = 1;

  if (sourceId !== undefined) {
    paramIdx++;
    conditions.push(`source_id = $${paramIdx}`);
    values.push(sourceId);
  }

  paramIdx++;
  values.push(Math.min(limit, 200));

  const { rows } = await query<PriceHistoryEntry>(
    `SELECT pph.*, ds.name as source_name
     FROM product_prices_history pph
     JOIN data_sources ds ON pph.source_id = ds.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY pph.valid_from DESC
     LIMIT $${paramIdx}`,
    values,
  );
  return rows;
}

// ============================================================
// Datové zdroje
// ============================================================

export async function getDataSources(): Promise<(DataSource & { price_count: number; scraper_config: any })[]> {
  const { rows } = await query(
    `SELECT ds.*,
            COALESCE(pc.cnt, 0)::int as price_count
     FROM data_sources ds
     LEFT JOIN (SELECT source_id, count(*) as cnt FROM product_prices_current GROUP BY source_id) pc ON ds.id = pc.source_id
     ORDER BY ds.name`,
  );
  return rows as (DataSource & { price_count: number; scraper_config: any })[];
}

export async function createDataSource(input: {
  name: string;
  type: string;
  base_url?: string | null;
}): Promise<DataSource> {
  const row = await queryOne<DataSource>(
    `INSERT INTO data_sources (name, type, base_url)
     VALUES ($1, $2, $3) RETURNING *`,
    [input.name, input.type, input.base_url ?? null],
  );
  if (!row) throw new Error('Failed to create data source');
  return row;
}

// ============================================================
// Výrobci (unikátní z produktů)
// ============================================================

export async function getManufacturers(): Promise<string[]> {
  const { rows } = await query<{ manufacturer: string }>(
    `SELECT DISTINCT manufacturer FROM products WHERE is_active = true ORDER BY manufacturer`,
  );
  return rows.map((r) => r.manufacturer);
}

/**
 * Resolve alias na kanonický název výrobce.
 */
export async function resolveManufacturer(name: string): Promise<string> {
  const row = await queryOne<{ canonical_name: string }>(
    'SELECT canonical_name FROM manufacturer_aliases WHERE lower(alias) = lower($1)',
    [name],
  );
  return row?.canonical_name ?? name;
}
