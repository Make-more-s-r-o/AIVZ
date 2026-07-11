import { strict as assert } from 'node:assert';
import test from 'node:test';

import { FINALIZED_DOWNLOAD_ERROR, finalizeWithInvalidation } from '../src/lib/finalize-flow.js';

test('úspěšná finalizace se invaliduje i při následném selhání stažení', async () => {
  const calls: string[] = [];
  await finalizeWithInvalidation({
    finalize: async () => { calls.push('finalize'); },
    invalidate: () => { calls.push('invalidate'); },
  });
  let downloadError: unknown;
  try {
    calls.push('download');
    throw new Error('síť');
  } catch (error) {
    downloadError = error;
  }
  assert.deepEqual(calls, ['finalize', 'invalidate', 'download']);
  assert.ok(downloadError instanceof Error);
  assert.equal(FINALIZED_DOWNLOAD_ERROR, 'Zakázka finalizována, ale stažení selhalo — stáhněte znovu z Dokumentů.');
});

test('selhání finalizace invaliduje stav a stažení vůbec nespustí', async () => {
  const calls: string[] = [];
  await assert.rejects(
    finalizeWithInvalidation({
      finalize: async () => { calls.push('finalize'); throw new Error('gate'); },
      invalidate: () => { calls.push('invalidate'); },
    }),
    /gate/,
  );
  assert.deepEqual(calls, ['finalize', 'invalidate']);
});
