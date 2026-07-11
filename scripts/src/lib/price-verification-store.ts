import { readFile, rename, writeFile } from 'fs/promises';

import { mergePriceVerifications, type ItemVerification } from './price-verifier.js';
import { refreshProductMatchPriceSanity } from './price-sanity.js';
import type { ProductMatch } from './types.js';

/**
 * Sloučí ověření do čerstvé kopie souboru, přepočítá sanity flagy a vše uloží
 * atomicky. Čerstvé načtení chrání potvrzené ceny před přepsáním dlouhým verify během.
 */
export async function persistPriceVerifications(
  matchPath: string,
  results: ItemVerification[],
): Promise<ProductMatch> {
  let fresh: ProductMatch;
  try {
    fresh = JSON.parse(await readFile(matchPath, 'utf-8')) as ProductMatch;
  } catch (error) {
    throw new Error(`Čerstvé načtení product-match.json před merge selhalo; ověření nezapisuji: ${error instanceof Error ? error.message : String(error)}`);
  }

  mergePriceVerifications(fresh, results);
  refreshProductMatchPriceSanity(fresh);

  const tmpPath = `${matchPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(fresh, null, 2), 'utf-8');
  await rename(tmpPath, matchPath);
  return fresh;
}
