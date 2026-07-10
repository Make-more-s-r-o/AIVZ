import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

export const RUN_ALL_STEPS = ['extract', 'analyze', 'match', 'generate', 'validate'] as const;

export type PipelineStep = typeof RUN_ALL_STEPS[number];
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted';

export interface PipelineJob {
  id: string;
  tenderId: string;
  step: string;
  status: JobStatus;
  logs: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  kind?: 'step' | 'pipeline';
  parentJobId?: string;
  currentStep?: PipelineStep;
  failedStep?: PipelineStep;
}

interface PersistedJobFile {
  version: 1;
  jobs: PipelineJob[];
}

export interface RestoredJobs {
  jobs: Map<string, PipelineJob>;
  queuedJobIds: string[];
  interruptedCount: number;
}

function isPipelineJob(value: unknown): value is PipelineJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<PipelineJob>;
  return typeof job.id === 'string'
    && typeof job.tenderId === 'string'
    && typeof job.step === 'string'
    && typeof job.status === 'string'
    && Array.isArray(job.logs)
    && typeof job.startedAt === 'string';
}

/** Atomicky uloží snapshot fronty, aby restart nikdy nenačetl napůl zapsaný JSON. */
export async function savePipelineJobs(filePath: string, jobs: Iterable<PipelineJob>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const data: PersistedJobFile = { version: 1, jobs: [...jobs] };
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tempPath, filePath);
}

/**
 * Obnoví frontu a rozpracované úlohy označí jako přerušené. Ve frontě zůstanou pouze
 * běžné queued kroky; rodičovský pipeline job se spouští prostřednictvím svého child jobu.
 */
export async function loadPipelineJobs(
  filePath: string,
  now = new Date().toISOString(),
): Promise<RestoredJobs> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { jobs: new Map(), queuedJobIds: [], interruptedCount: 0 };
    }
    throw err;
  }

  const rawJobs = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as PersistedJobFile).jobs)
      ? (parsed as PersistedJobFile).jobs
      : []);
  const restored = new Map<string, PipelineJob>();
  let interruptedCount = 0;

  for (const rawJob of rawJobs) {
    if (!isPipelineJob(rawJob)) continue;
    const job: PipelineJob = { ...rawJob, logs: [...rawJob.logs] };
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.finishedAt = now;
      job.error = job.error || 'Úloha byla přerušena restartem serveru.';
      if (job.kind === 'pipeline' && job.currentStep) job.failedStep = job.currentStep;
      interruptedCount += 1;
    }
    restored.set(job.id, job);
  }

  // Queued child přerušeného řetězce už nesmí po restartu samostatně pokračovat.
  const interruptedParents = new Set(
    [...restored.values()]
      .filter((job) => job.kind === 'pipeline' && job.status === 'interrupted')
      .map((job) => job.id),
  );
  for (const job of restored.values()) {
    if (job.status === 'queued' && job.parentJobId && interruptedParents.has(job.parentJobId)) {
      job.status = 'interrupted';
      job.finishedAt = now;
      job.error = 'Navazující krok byl zastaven, protože server přerušil celý pipeline řetězec.';
      interruptedCount += 1;
    }
  }

  const queuedJobIds = [...restored.values()]
    .filter((job) => job.status === 'queued' && job.kind !== 'pipeline')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((job) => job.id);

  return { jobs: restored, queuedJobIds, interruptedCount };
}

/** Posune run-all řetězec až po úspěchu child kroku; chyba řetězec okamžitě zastaví. */
export async function advanceRunAllChain(
  parent: PipelineJob,
  child: PipelineJob,
  startStep: (step: PipelineStep) => Promise<void> | void,
  now = new Date().toISOString(),
): Promise<void> {
  const childStep = child.step as PipelineStep;
  if (child.status !== 'done') {
    parent.status = child.status === 'interrupted' ? 'interrupted' : 'error';
    parent.currentStep = childStep;
    parent.failedStep = childStep;
    parent.error = child.error || `Krok ${childStep} selhal.`;
    parent.finishedAt = now;
    return;
  }

  const index = RUN_ALL_STEPS.indexOf(childStep);
  if (index < 0 || index === RUN_ALL_STEPS.length - 1) {
    parent.status = 'done';
    parent.currentStep = childStep;
    parent.finishedAt = now;
    return;
  }

  const nextStep = RUN_ALL_STEPS[index + 1];
  parent.currentStep = nextStep;
  try {
    await startStep(nextStep);
  } catch (err) {
    parent.status = 'error';
    parent.failedStep = nextStep;
    parent.error = err instanceof Error ? err.message : String(err);
    parent.finishedAt = now;
  }
}
