import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  invalidatePriceDerivedQueries,
  priceDerivedQueryKeys,
} from '../src/lib/product-match-invalidation.js';

test('cenová mutace invaliduje všechny odvozené query včetně globálního inboxu', async () => {
  const seen: unknown[][] = [];
  await invalidatePriceDerivedQueries({
    invalidateQueries: async ({ queryKey }) => { seen.push([...queryKey]); },
  }, 'tender-1');

  assert.deepEqual(seen, priceDerivedQueryKeys('tender-1').map((key) => [...key]));
  assert.deepEqual(seen, [
    ['product-match', 'tender-1'],
    ['tender-status', 'tender-1'],
    ['bid-score', 'tender-1'],
    ['validation', 'tender-1'],
    ['inbox'],
  ]);
});
