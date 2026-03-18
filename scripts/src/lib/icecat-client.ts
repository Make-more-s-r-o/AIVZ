/**
 * Icecat Open Catalog — zdarma technické specifikace produktů.
 * Lookup přes EAN (GTIN) nebo Brand + ProductCode (MPN).
 * https://icecat.biz/
 */
import { query } from './db.js';

const ICECAT_API_URL = 'https://live.icecat.biz/api';

// ============================================================
// Typy
// ============================================================

interface IcecatProduct {
  productId: number;
  title: string;
  brand: string;
  category: string;
  description: string;
  specs: Record<string, string>;       // Normalizované parametry
  images: string[];
  ean: string | null;
  mpn: string | null;
}

// ============================================================
// API
// ============================================================

function getIcecatCredentials(): { username: string; language: string } {
  const username = process.env.ICECAT_USERNAME;
  if (!username) throw new Error('ICECAT_USERNAME not set (register free at https://icecat.biz)');
  return { username, language: process.env.ICECAT_LANGUAGE || 'cs' };
}

/**
 * Lookup produktu přes EAN (GTIN).
 */
export async function lookupByEan(ean: string): Promise<IcecatProduct | null> {
  const { username, language } = getIcecatCredentials();

  const url = `${ICECAT_API_URL}/?UserName=${encodeURIComponent(username)}&Language=${language}&GTIN=${encodeURIComponent(ean)}`;
  return fetchIcecatProduct(url);
}

/**
 * Lookup produktu přes Brand + MPN (ProductCode).
 */
export async function lookupByMpn(brand: string, mpn: string): Promise<IcecatProduct | null> {
  const { username, language } = getIcecatCredentials();

  const url = `${ICECAT_API_URL}/?UserName=${encodeURIComponent(username)}&Language=${language}&Brand=${encodeURIComponent(brand)}&ProductCode=${encodeURIComponent(mpn)}`;
  return fetchIcecatProduct(url);
}

async function fetchIcecatProduct(url: string): Promise<IcecatProduct | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) return null;

    const data = await res.json() as any;
    const product = data?.data?.GeneralInfo;
    if (!product) return null;

    // Extrahuj specifikace
    const specs: Record<string, string> = {};
    const featureGroups = data?.data?.FeaturesGroups || [];
    for (const group of featureGroups) {
      for (const feature of group.Features || []) {
        const name = feature.Feature?.Name?.Value;
        const value = feature.PresentationValue || feature.Value;
        if (name && value) {
          specs[name] = value;
        }
      }
    }

    // Extrahuj obrázky
    const images: string[] = [];
    const gallery = data?.data?.Gallery || [];
    for (const img of gallery) {
      if (img.Pic) images.push(img.Pic);
    }
    // Hlavní obrázek
    const mainPic = product.ProductPicture?.Pic || product.ProductPicture?.LowPic;
    if (mainPic && !images.includes(mainPic)) {
      images.unshift(mainPic);
    }

    return {
      productId: product.IcecatId || 0,
      title: product.Title?.Value || product.ProductName?.Value || '',
      brand: product.BrandInfo?.BrandName || '',
      category: product.Category?.Name?.Value || '',
      description: product.SummaryDescription?.LongSummaryDescription || product.SummaryDescription?.ShortSummaryDescription || '',
      specs,
      images,
      ean: data?.data?.GeneralInfo?.GTIN?.[0] || null,
      mpn: product.ProductCode || null,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Enrichment — doplnění specifikací do warehouse produktů
// ============================================================

/**
 * Obohatí produkty v DB o Icecat specifikace.
 * Hledá produkty s EAN nebo MPN, které nemají parametry.
 */
export async function enrichProductsFromIcecat(limit = 50): Promise<{
  processed: number;
  enriched: number;
  not_found: number;
  errors: number;
}> {
  // Najdi produkty s EAN/MPN ale bez normalizovaných parametrů
  const { rows } = await query<{
    id: string;
    manufacturer: string;
    ean: string | null;
    part_number: string | null;
  }>(
    `SELECT id, manufacturer, ean, part_number FROM products
     WHERE is_active = true
       AND (ean IS NOT NULL OR part_number IS NOT NULL)
       AND (parameters_normalized IS NULL OR parameters_normalized = '{}'::jsonb)
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );

  let enriched = 0;
  let notFound = 0;
  let errors = 0;

  console.log(`Icecat: enriching ${rows.length} products...`);

  for (const product of rows) {
    try {
      let icecat: IcecatProduct | null = null;

      // Zkus EAN
      if (product.ean) {
        icecat = await lookupByEan(product.ean);
      }

      // Fallback na MPN
      if (!icecat && product.part_number && product.manufacturer) {
        icecat = await lookupByMpn(product.manufacturer, product.part_number);
      }

      if (!icecat || Object.keys(icecat.specs).length === 0) {
        notFound++;
        continue;
      }

      // Normalizuj Icecat specs do našeho formátu
      const normalized = normalizeIcecatSpecs(icecat.specs);

      // Aktualizuj produkt
      const updates: string[] = [];
      const values: unknown[] = [];
      let idx = 0;

      if (Object.keys(normalized).length > 0) {
        idx++;
        updates.push(`parameters_normalized = $${idx}`);
        values.push(JSON.stringify(normalized));
      }

      // Lidsky čitelné parametry
      if (Object.keys(icecat.specs).length > 0) {
        idx++;
        updates.push(`parameters = $${idx}`);
        values.push(JSON.stringify(icecat.specs));
      }

      // Obrázek
      if (icecat.images.length > 0) {
        idx++;
        updates.push(`image_url = COALESCE(image_url, $${idx})`);
        values.push(icecat.images[0]);
      }

      // Popis
      if (icecat.description) {
        idx++;
        updates.push(`description = COALESCE(description, $${idx})`);
        values.push(icecat.description);
      }

      if (updates.length > 0) {
        idx++;
        values.push(product.id);
        await query(
          `UPDATE products SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
          values,
        );
        enriched++;
      }

      // Rate limiting — 1 request / 500ms
      await new Promise(r => setTimeout(r, 500));

    } catch {
      errors++;
    }
  }

  console.log(`Icecat: enriched ${enriched}, not found ${notFound}, errors ${errors}`);
  return { processed: rows.length, enriched, not_found: notFound, errors };
}

/**
 * Normalizuje Icecat specs do warehouse parametrového formátu.
 */
function normalizeIcecatSpecs(specs: Record<string, string>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  const mappings: Array<{ patterns: RegExp[]; key: string; transform?: (v: string) => unknown }> = [
    { patterns: [/ram|paměť.*ram|operační paměť/i], key: 'ram_gb', transform: extractNumber },
    { patterns: [/ssd|kapacita.*ssd/i], key: 'ssd_gb', transform: extractNumber },
    { patterns: [/hdd|kapacita.*hdd|pevný disk/i], key: 'hdd_gb', transform: extractNumber },
    { patterns: [/procesor|cpu|řada procesoru/i], key: 'cpu_model' },
    { patterns: [/úhlopříčka|velikost.*displej|obrazovka/i], key: 'display_size', transform: extractDecimal },
    { patterns: [/rozlišení.*displej|nativní rozlišení/i], key: 'resolution' },
    { patterns: [/hmotnost|váha/i], key: 'weight_kg', transform: extractDecimal },
    { patterns: [/baterie|kapacita.*baterie/i], key: 'battery_wh', transform: extractDecimal },
    { patterns: [/jas.*lumen|svítivost|ansi/i], key: 'lumens', transform: extractNumber },
    { patterns: [/kontrast/i], key: 'contrast_ratio' },
    { patterns: [/typ.*panelu/i], key: 'panel_type' },
    { patterns: [/obnovovací.*frekvence|refresh/i], key: 'refresh_rate_hz', transform: extractNumber },
  ];

  for (const [specName, specValue] of Object.entries(specs)) {
    for (const mapping of mappings) {
      if (mapping.patterns.some(p => p.test(specName))) {
        const value = mapping.transform ? mapping.transform(specValue) : specValue;
        if (value !== null && value !== undefined) {
          normalized[mapping.key] = value;
        }
        break;
      }
    }
  }

  return normalized;
}

function extractNumber(value: string): number | null {
  const match = value.match(/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function extractDecimal(value: string): number | null {
  const match = value.match(/(\d+[.,]?\d*)/);
  return match ? parseFloat(match[1].replace(',', '.')) : null;
}
