import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  assertPartsSelectionUnchanged,
  PARTS_SELECTION_CHANGED_MESSAGE,
  samePartSelection,
} from '../src/lib/parts-selection-guard.js';
import { ProductMatchSchema } from '../src/lib/types.js';

test('generate guard tvrdě selže při změně množiny částí', () => {
  const productMatch = { selected_parts_snapshot: ['A'] } as any;
  assert.throws(
    () => assertPartsSelectionUnchanged(productMatch, ['A', 'B'], ['A', 'B']),
    (error: Error) => error.message === PARTS_SELECTION_CHANGED_MESSAGE,
  );
});

test('generate guard propustí shodnou množinu bez ohledu na pořadí', () => {
  const productMatch = { selected_parts_snapshot: ['B', 'A'] } as any;
  assert.doesNotThrow(() => assertPartsSelectionUnchanged(productMatch, ['A', 'B'], ['A', 'B']));
  assert.equal(samePartSelection(['A', 'B'], ['B', 'A'], ['A', 'B']), true);
});

test('generate guard propustí starý product-match bez snapshot pole', () => {
  assert.doesNotThrow(() => assertPartsSelectionUnchanged({} as any, ['B'], ['A', 'B']));
});

test('ProductMatchSchema přijímá nový snapshot i starý formát bez něj', () => {
  const base = {
    tenderId: 't1', matchedAt: '2026-07-11T00:00:00.000Z',
    polozky_match: [],
  };
  assert.equal(ProductMatchSchema.safeParse({ ...base, selected_parts_snapshot: ['A'] }).success, true);
  assert.equal(ProductMatchSchema.safeParse(base).success, true);
});
