import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { maybeSendDailyBudgetWarning } from '../src/lib/ai-budget.js';
import { DEFAULT_GOVERNANCE, dailyAiLimitBlock } from '../src/lib/governance.js';
import {
  BudgetPausedError,
  advanceRunAllChain,
  claimBudgetPaused,
  loadPipelineJobs,
  savePipelineJobs,
  type PipelineJob,
  type PipelineStep,
} from '../src/lib/pipeline-job-state.js';

function pipeline(overrides: Partial<PipelineJob> = {}): PipelineJob {
  return {
    id: 'pipeline-1', tenderId: 'tender-1', step: 'all', status: 'running', logs: [],
    startedAt: '2026-07-13T10:00:00.000Z', kind: 'pipeline', currentStep: 'analyze',
    ...overrides,
  };
}

test('80% Slack alert se persistentně odešle jen jednou za den', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'vz-ai-budget-'));
  const messages: string[] = [];
  const send = async (message: string) => { messages.push(message); };
  try {
    const first = await maybeSendDailyBudgetWarning({
      todayCzk: 1_600, limitCzk: 2_000,
      now: new Date('2026-07-13T10:00:00.000Z'), stateDir, send,
    });
    const afterRestart = await maybeSendDailyBudgetWarning({
      todayCzk: 1_900, limitCzk: 2_000,
      now: new Date('2026-07-13T18:00:00.000Z'), stateDir, send,
    });

    assert.equal(first, 'sent');
    assert.equal(afterRestart, 'already_sent');
    assert.equal(messages.length, 1);
    assert.match(messages[0], /80 %/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('běžící pipeline dokončí child krok a pauzne před dalším jako budget_paused', async () => {
  const parent = pipeline();
  const completedChild = pipeline({
    id: 'child-analyze', kind: 'step', step: 'analyze', status: 'done',
    parentJobId: parent.id, currentStep: undefined,
  });
  const started: PipelineStep[] = [];

  await advanceRunAllChain(parent, completedChild, (nextStep) => {
    started.push(nextStep);
    throw new BudgetPausedError('Dosažen denní limit AI nákladů.');
  });

  assert.deepEqual(started, ['match'], 'budget se kontroluje až na hranici po dokončení analyze');
  assert.equal(completedChild.status, 'done');
  assert.equal(parent.status, 'budget_paused');
  assert.equal(parent.currentStep, 'match');
  assert.equal(parent.failedStep, undefined);
  assert.equal(parent.finishedAt, undefined);
});

test('budget_paused pipeline lze po denním resetu claimnout a resumnout uloženým krokem', () => {
  const parent = pipeline({ status: 'budget_paused', currentStep: 'match', error: 'limit' });
  const resetGovernance = { ...DEFAULT_GOVERNANCE, denni_ai_limit_czk: 2_000 };

  assert.equal(dailyAiLimitBlock(resetGovernance, 0), null);
  assert.equal(claimBudgetPaused(parent), true);
  assert.equal(parent.status, 'running');
  assert.equal(parent.currentStep, 'match');
  assert.equal(parent.error, undefined);
  assert.equal(claimBudgetPaused(parent), false, 'souběžný druhý resume se nesmí claimnout');
});

test('budget_paused stav přežije restart a zůstane resumovatelný', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-budget-job-'));
  const path = join(dir, '.jobs.json');
  try {
    await savePipelineJobs(path, [pipeline({
      status: 'budget_paused', currentStep: 'match', error: 'Dosažen denní limit.',
    })]);
    const restored = await loadPipelineJobs(path, '2026-07-14T00:00:01.000Z');
    const parent = restored.jobs.get('pipeline-1');

    assert.equal(parent?.status, 'budget_paused');
    assert.equal(parent?.currentStep, 'match');
    assert.equal(restored.interruptedCount, 0);
    assert.equal(parent ? claimBudgetPaused(parent) : false, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nad 100 % guard zablokuje nový job ještě před založením', () => {
  const governance = { ...DEFAULT_GOVERNANCE, denni_ai_limit_czk: 100 };
  let created = false;
  const block = dailyAiLimitBlock(governance, 100);
  if (!block) created = true;

  assert.match(block ?? '', /Dosažen denní limit/);
  assert.equal(created, false);
});
