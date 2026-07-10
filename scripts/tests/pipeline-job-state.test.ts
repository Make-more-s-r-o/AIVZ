import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  advanceRunAllChain,
  loadPipelineJobs,
  savePipelineJobs,
  type PipelineJob,
  type PipelineStep,
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
