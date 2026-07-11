import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ApprovalRequiredError,
  advanceRunAllChain,
  loadPipelineJobs,
  savePipelineJobs,
  selectJobsToStart,
  type PipelineJob,
  type PipelineStep,
  type SchedulableJob,
} from '../src/lib/pipeline-job-state.js';

function job(overrides: Partial<PipelineJob>): PipelineJob {
  return {
    id: 'job-1',
    tenderId: 'tender-1',
    step: 'extract',
    status: 'queued',
    logs: [],
    startedAt: '2026-07-10T10:00:00.000Z',
    kind: 'step',
    ...overrides,
  };
}

function sched(id: string, tenderId: string): SchedulableJob {
  return { id, tenderId };
}

test('plánovač: prázdná fronta nevrátí nic', () => {
  assert.deepEqual(selectJobsToStart([], [], 2), []);
});

test('plánovač: respektuje limit souběhu (default 2)', () => {
  const queue = [sched('a', 't1'), sched('b', 't2'), sched('c', 't3')];
  assert.deepEqual(selectJobsToStart(queue, [], 2), ['a', 'b']);
});

test('plánovač: FIFO pořadí — bere první způsobilé v pořadí zařazení', () => {
  const queue = [sched('a', 't1'), sched('b', 't2'), sched('c', 't3'), sched('d', 't4')];
  assert.deepEqual(selectJobsToStart(queue, [], 3), ['a', 'b', 'c']);
});

test('plánovač: per-tender lock — nikdy dvě úlohy téže zakázky současně (ve frontě)', () => {
  const queue = [sched('a', 't1'), sched('b', 't1'), sched('c', 't2')];
  // 't1' smí jen jednu (a), druhá (b) se přeskočí; slot vyplní 'c' jiné zakázky.
  assert.deepEqual(selectJobsToStart(queue, [], 2), ['a', 'c']);
});

test('plánovač: per-tender lock — zakázka s běžící úlohou se nespustí znovu', () => {
  const queue = [sched('a', 't1'), sched('b', 't2')];
  // 't1' už běží → přeskoč 'a', spusť jen 'b'; volný slot 1 (limit 2 − 1 běžící).
  assert.deepEqual(selectJobsToStart(queue, ['t1'], 2), ['b']);
});

test('plánovač: plné sloty nevrátí nic', () => {
  const queue = [sched('a', 't3')];
  assert.deepEqual(selectJobsToStart(queue, ['t1', 't2'], 2), []);
});

test('plánovač: limit < 1 se ošetří jako 1', () => {
  const queue = [sched('a', 't1'), sched('b', 't2')];
  assert.deepEqual(selectJobsToStart(queue, [], 0), ['a']);
  assert.deepEqual(selectJobsToStart(queue, [], Number.NaN), ['a']);
});

test('plánovač: vyšší limit spustí více zakázek naráz', () => {
  const queue = [sched('a', 't1'), sched('b', 't2'), sched('c', 't3'), sched('d', 't4')];
  assert.deepEqual(selectJobsToStart(queue, [], 4), ['a', 'b', 'c', 'd']);
});

test('run-all po chybě prvního kroku nespustí druhý krok', async () => {
  const parent = job({
    id: 'pipeline-1',
    step: 'all',
    status: 'running',
    kind: 'pipeline',
    currentStep: 'extract',
  });
  const failedChild = job({
    status: 'error',
    error: 'Extrakce selhala',
    parentJobId: parent.id,
  });
  const started: PipelineStep[] = [];

  await advanceRunAllChain(parent, failedChild, (step) => { started.push(step); });

  assert.deepEqual(started, []);
  assert.equal(parent.status, 'error');
  assert.equal(parent.failedStep, 'extract');
  assert.equal(parent.error, 'Extrakce selhala');
});

test('run-all po úspěchu kroku zařadí následující krok (sériové řetězení)', async () => {
  const parent = job({
    id: 'pipeline-1',
    step: 'all',
    status: 'running',
    kind: 'pipeline',
    currentStep: 'extract',
  });
  const doneChild = job({ step: 'extract', status: 'done', parentJobId: parent.id });
  const started: PipelineStep[] = [];

  await advanceRunAllChain(parent, doneChild, (step) => { started.push(step); });

  // Po extract se řetězí jen jediný další krok (analyze), ne celý zbytek naráz.
  assert.deepEqual(started, ['analyze']);
  assert.equal(parent.status, 'running');
  assert.equal(parent.currentStep, 'analyze');
});

test('run-all po posledním kroku označí pipeline jako done', async () => {
  const parent = job({
    id: 'pipeline-1',
    step: 'all',
    status: 'running',
    kind: 'pipeline',
    currentStep: 'validate',
  });
  const doneChild = job({ step: 'validate', status: 'done', parentJobId: parent.id });
  const started: PipelineStep[] = [];

  await advanceRunAllChain(parent, doneChild, (step) => { started.push(step); });

  assert.deepEqual(started, []);
  assert.equal(parent.status, 'done');
});

test('run-all: money-gate před generate pauzne řetězec do waiting_approval (ne error)', async () => {
  const parent = job({
    id: 'pipeline-1',
    step: 'all',
    status: 'running',
    kind: 'pipeline',
    currentStep: 'match',
  });
  const doneChild = job({ step: 'match', status: 'done', parentJobId: parent.id });
  const started: PipelineStep[] = [];

  await advanceRunAllChain(parent, doneChild, (step) => {
    if (step === 'generate') throw new ApprovalRequiredError(3, 'Čeká na potvrzení cen (3).');
    started.push(step);
  });

  // Generate se NEzařadil (čeká na potvrzení), řetězec je pauznutý, ne chybný.
  assert.deepEqual(started, []);
  assert.equal(parent.status, 'waiting_approval');
  assert.equal(parent.currentStep, 'generate');
  assert.equal(parent.failedStep, undefined);
  assert.equal(parent.finishedAt, undefined, 'waiting_approval nesmí mít finishedAt (není dokončen)');
  assert.match(parent.error ?? '', /\(3\)/);
});

test('run-all: jiná chyba při startu generate zůstává tvrdou chybou řetězce', async () => {
  const parent = job({
    id: 'pipeline-1',
    step: 'all',
    status: 'running',
    kind: 'pipeline',
    currentStep: 'match',
  });
  const doneChild = job({ step: 'match', status: 'done', parentJobId: parent.id });

  await advanceRunAllChain(parent, doneChild, () => {
    throw new Error('generate-bid selhal');
  }, '2026-07-10T12:00:00.000Z');

  assert.equal(parent.status, 'error');
  assert.equal(parent.failedStep, 'generate');
  assert.equal(parent.finishedAt, '2026-07-10T12:00:00.000Z');
});

test('restore: waiting_approval pipeline job přežije restart (neflipuje na interrupted)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-pipeline-jobs-'));
  const filePath = join(dir, '.jobs.json');
  try {
    const parent = job({
      id: 'pipeline-wait',
      step: 'all',
      status: 'waiting_approval',
      kind: 'pipeline',
      currentStep: 'generate',
      error: 'Čeká na potvrzení cen (2).',
    });
    const doneMatch = job({ id: 'child-match', step: 'match', status: 'done', parentJobId: parent.id });
    await savePipelineJobs(filePath, [parent, doneMatch]);

    const restored = await loadPipelineJobs(filePath, '2026-07-10T11:00:00.000Z');

    // Pauznutý řetězec zůstává waiting_approval — dá se pořád resumnout.
    assert.equal(restored.jobs.get('pipeline-wait')?.status, 'waiting_approval');
    assert.equal(restored.jobs.get('pipeline-wait')?.currentStep, 'generate');
    assert.equal(restored.jobs.get('pipeline-wait')?.finishedAt, undefined);
    assert.equal(restored.interruptedCount, 0);
    assert.deepEqual(restored.queuedJobIds, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore: přerušený pipeline řetězec zastaví i navazující queued krok', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-pipeline-jobs-'));
  const filePath = join(dir, '.jobs.json');
  try {
    const parent = job({ id: 'pipeline-1', step: 'all', status: 'running', kind: 'pipeline', currentStep: 'analyze' });
    const runningChild = job({ id: 'child-run', step: 'analyze', status: 'running', parentJobId: parent.id });
    const queuedChild = job({ id: 'child-queued', step: 'match', status: 'queued', parentJobId: parent.id });
    await savePipelineJobs(filePath, [parent, runningChild, queuedChild]);

    const restored = await loadPipelineJobs(filePath, '2026-07-10T11:00:00.000Z');

    assert.equal(restored.jobs.get('pipeline-1')?.status, 'interrupted');
    assert.equal(restored.jobs.get('child-run')?.status, 'interrupted');
    assert.equal(restored.jobs.get('child-queued')?.status, 'interrupted');
    // Navazující krok přerušeného řetězce NESMÍ zůstat ve frontě ke spuštění.
    assert.deepEqual(restored.queuedJobIds, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restore: samostatný queued krok (bez rodiče) zůstane ve frontě', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-pipeline-jobs-'));
  const filePath = join(dir, '.jobs.json');
  try {
    const running = job({ id: 'run-1', tenderId: 't1', status: 'running' });
    const q1 = job({ id: 'q-1', tenderId: 't2', step: 'analyze', status: 'queued', startedAt: '2026-07-10T10:00:01.000Z' });
    const q2 = job({ id: 'q-2', tenderId: 't3', step: 'extract', status: 'queued', startedAt: '2026-07-10T10:00:02.000Z' });
    await savePipelineJobs(filePath, [running, q2, q1]);

    const restored = await loadPipelineJobs(filePath, '2026-07-10T11:00:00.000Z');

    assert.equal(restored.jobs.get('run-1')?.status, 'interrupted');
    // Fronta seřazená dle startedAt (FIFO), nezávisle na pořadí v souboru.
    assert.deepEqual(restored.queuedJobIds, ['q-1', 'q-2']);
    assert.equal(restored.interruptedCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('uložení a reload označí running job jako interrupted a zachová queued frontu', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-pipeline-jobs-'));
  const filePath = join(dir, '.jobs.json');
  try {
    const running = job({ id: 'running-1', status: 'running' });
    const queued = job({ id: 'queued-1', step: 'analyze', status: 'queued' });
    await savePipelineJobs(filePath, [running, queued]);

    const restored = await loadPipelineJobs(filePath, '2026-07-10T11:00:00.000Z');

    assert.equal(restored.jobs.get('running-1')?.status, 'interrupted');
    assert.equal(restored.jobs.get('running-1')?.finishedAt, '2026-07-10T11:00:00.000Z');
    assert.match(restored.jobs.get('running-1')?.error ?? '', /restartem serveru/);
    assert.deepEqual(restored.queuedJobIds, ['queued-1']);
    assert.equal(restored.interruptedCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
