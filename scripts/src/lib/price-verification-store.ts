import { readFile, rename, writeFile } from 'fs/promises';

import { mergePriceVerifications, type ItemVerification } from './price-verifier.js';
import { refreshProductMatchPriceSanity } from './price-sanity.js';
import type { ProductMatch } from './types.js';
import { invalidatePriceReview } from './price-review.js';

/**
 * Sloučí ověření do čerstvé kopie souboru, přepočítá sanity flagy a vše uloží
 * atomicky. Čerstvé načtení chrání potvrzené ceny před přepsáním dlouhým verify během.
 */
export async function persistPriceVerifications(
  matchPath: string,
  results: ItemVerification[],
  onReviewsInvalidated?: (indexes: number[]) => Promise<void>,
): Promise<ProductMatch> {
  let fresh: ProductMatch;
  try {
    fresh = JSON.parse(await readFile(matchPath, 'utf-8')) as ProductMatch;
  } catch (error) {
    throw new Error(`Čerstvé načtení product-match.json před merge selhalo; ověření nezapisuji: ${error instanceof Error ? error.message : String(error)}`);
  }

  mergePriceVerifications(fresh, results);
  const findings = refreshProductMatchPriceSanity(fresh);
  const belowCost = new Set(findings
    .filter((finding) => finding.level === 'hard' && finding.code === 'cena_pod_nakupem')
    .map((finding) => finding.polozka_index));
  const invalidated: number[] = [];
  for (const item of fresh.polozky_match ?? []) {
    if (belowCost.has(item.polozka_index) && invalidatePriceReview(item.cenova_uprava)) {
      invalidated.push(item.polozka_index);
    }
  }
  const tmpPath = `${matchPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(fresh, null, 2), 'utf-8');
  await rename(tmpPath, matchPath);
  if (invalidated.length > 0) await onReviewsInvalidated?.(invalidated);
  return fresh;
}
