import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertScoreSnapshot,
  persistScoreSnapshotBestEffort,
  type ScoreSnapshotInput,
} from '../src/lib/score-snapshot-store.js';

const snapshot: ScoreSnapshotInput = {
  tender_id: 'T-1', typ: 'bid', skore: 71, doporuceni: 'ZVAZIT', kontext: 'finalize',
  features: { typ: 'bid', skore: 71, doporuceni: 'ZVAZIT', faktory: [] },
};

test('score snapshot store bez DB degraduje graceful', async () => {
  let called = false;
  const result = await insertScoreSnapshot(snapshot, {
    hasDb: () => false,
    insert: async () => { called = true; return null; },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test('score snapshot store je append-only a používá pouze INSERT', async () => {
  let sql = '';
  await insertScoreSnapshot(snapshot, {
    hasDb: () => true,
    insert: async (statement) => { sql = statement; return null; },
  });
  assert.match(sql, /^INSERT INTO crm_score_snapshots/);
  assert.doesNotMatch(sql, /\bUPDATE\b|ON\s+CONFLICT/i);
});

test('best-effort chyba DB nesrazí finalize tok', async () => {
  const warnings: unknown[][] = [];
  let finalizeContinued = false;
  const ok = await persistScoreSnapshotBestEffort(
    snapshot,
    (...args) => warnings.push(args),
    async () => { throw new Error('DB down'); },
  );
  finalizeContinued = true;
  assert.equal(ok, false);
  assert.equal(finalizeContinued, true);
  assert.equal(warnings.length, 1);
});
