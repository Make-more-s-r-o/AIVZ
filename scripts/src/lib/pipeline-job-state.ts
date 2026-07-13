import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

export const RUN_ALL_STEPS = ['extract', 'analyze', 'match', 'generate', 'validate'] as const;

export type PipelineStep = typeof RUN_ALL_STEPS[number];
export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'waiting_approval' | 'budget_paused';

export interface PipelineStepTiming {
  startedAt: string;
  finishedAt?: string;
}

export type PipelineStepTimings = Partial<Record<PipelineStep, PipelineStepTiming>>;

/**
 * Signál z run-all řetězce, že další krok (generate) narazil na lidský money-gate —
 * nepotvrzené ceny. Není to chyba: řetězec se PAUZNE (waiting_approval), ne error.
 * Nese počet cen čekajících na potvrzení pro hlášku uživateli.
 */
export class ApprovalRequiredError extends Error {
  constructor(public readonly pendingCount: number, message: string) {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}

/** Rozpočtový checkpoint: dokončený child krok zůstává done, parent čeká před dalším krokem. */
export class BudgetPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetPausedError';
  }
}

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
  initiator?: 'monitoring' | 'operator';
  /** Skutečný wall-clock start/konec jednotlivých kroků run-all pipeline. */
  stepTimings?: PipelineStepTimings;
}

/** Zapíše skutečný start kroku. Opakované volání původní start nepřepíše. */
export function markPipelineStepStarted(
  job: PipelineJob,
  step: PipelineStep,
  now = new Date().toISOString(),
): void {
  if (job.kind !== 'pipeline') return;
  job.stepTimings ??= {};
  job.stepTimings[step] ??= { startedAt: now };
}

/** Uzavře měřený krok; bez známého startu nic nesyntetizuje (legacy kompatibilita). */
export function markPipelineStepFinished(
  job: PipelineJob,
  step: PipelineStep,
  now = new Date().toISOString(),
): void {
  const timing = job.stepTimings?.[step];
  if (job.kind !== 'pipeline' || !timing || timing.finishedAt) return;
  timing.finishedAt = now;
}

/** Trvání kroků v ms; běžící krok se počítá proti `now`. Nevalidní legacy data ignoruje. */
export function getPipelineStepDurationsMs(
  job: PipelineJob,
  now = new Date().toISOString(),
): Partial<Record<PipelineStep, number>> | undefined {
  if (!job.stepTimings) return undefined;
  const nowMs = Date.parse(now);
  const durations: Partial<Record<PipelineStep, number>> = {};
  for (const step of RUN_ALL_STEPS) {
    const timing = job.stepTimings[step];
    if (!timing) continue;
    const startMs = Date.parse(timing.startedAt);
    const endMs = timing.finishedAt ? Date.parse(timing.finishedAt) : nowMs;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
      durations[step] = endMs - startMs;
    }
  }
  return Object.keys(durations).length > 0 ? durations : undefined;
}

/**
 * Synchronně rezervuje pauznutý parent job pro jediný resume požadavek.
 * Volající mezi nalezením jobu a touto změnou nesmí provést await; v jednom Node procesu
 * tak druhý souběžný request už neuvidí waiting_approval a nezařadí druhý generate.
 */
export function claimWaitingApproval(job: PipelineJob): boolean {
  if (job.kind !== 'pipeline' || job.status !== 'waiting_approval') return false;
  job.status = 'running';
  job.currentStep = 'generate';
  job.error = undefined;
  job.failedStep = undefined;
  job.finishedAt = undefined;
  return true;
}

/** Vrátí neúspěšně ověřený claim do stavu, ve kterém ho může operátor opravit a zopakovat. */
export function restoreWaitingApproval(job: PipelineJob, error: string): void {
  job.status = 'waiting_approval';
  job.currentStep = 'generate';
  job.error = error;
  job.failedStep = undefined;
  job.finishedAt = undefined;
}

/** Synchronní claim společný pro rozpočtovou pauzu; resume krok je uložen v currentStep. */
export function claimBudgetPaused(job: PipelineJob): boolean {
  if (job.kind !== 'pipeline' || job.status !== 'budget_paused' || !job.currentStep) return false;
  job.status = 'running';
  job.error = undefined;
  job.failedStep = undefined;
  job.finishedAt = undefined;
  return true;
}

export function restoreBudgetPaused(job: PipelineJob, error: string): void {
  job.status = 'budget_paused';
  job.error = error;
  job.failedStep = undefined;
  job.finishedAt = undefined;
}

/** Synchronní rezervace pipeline přerušené deployem/restartem pro jediný resume request. */
export function claimInterrupted(job: PipelineJob): boolean {
  if (job.kind !== 'pipeline' || job.status !== 'interrupted' || !job.currentStep) return false;
  job.status = 'running';
  job.error = undefined;
  job.failedStep = undefined;
  job.finishedAt = undefined;
  // Opakovaný krok dostane nové měření; původní nedokončený pokus je v logu jobu.
  if (job.stepTimings) delete job.stepTimings[job.currentStep];
  return true;
}

export function restoreInterrupted(job: PipelineJob, error: string): void {
  job.status = 'interrupted';
  job.error = error;
  job.failedStep = job.currentStep;
  job.finishedAt = new Date().toISOString();
}

export interface DrainHttpResponse {
  status: 503;
  body: { error: 'draining' };
}

/** Během drainu odmítáme všechny API mutace, aby se po finálním snapshotu nic nezařadilo. */
export function getDrainHttpResponse(
  draining: boolean,
  method: string,
  path: string,
): DrainHttpResponse | null {
  if (!draining || method.toUpperCase() === 'GET' || !path.startsWith('/api/')) return null;
  return { status: 503, body: { error: 'draining' } };
}

/**
 * Fail-closed checkpoint všech aktivních a dosud nezačatých jobů. Parent pipeline si ponechá
 * currentStep; u legacy parentu ho odvodíme z child jobu, aby zůstal resumovatelný.
 */
export function checkpointJobsForDrain(
  jobs: Iterable<PipelineJob>,
  now = new Date().toISOString(),
): number {
  const all = [...jobs];
  const childStepByParent = new Map<string, PipelineStep>();
  for (const job of all) {
    if (job.parentJobId && RUN_ALL_STEPS.includes(job.step as PipelineStep)) {
      childStepByParent.set(job.parentJobId, job.step as PipelineStep);
    }
  }

  let count = 0;
  for (const job of all) {
    if (job.status !== 'running' && job.status !== 'queued') continue;
    if (job.kind === 'pipeline' && !job.currentStep) {
      job.currentStep = childStepByParent.get(job.id);
    }
    job.status = 'interrupted';
    job.finishedAt = now;
    job.error = 'Úloha byla bezpečně přerušena kvůli nasazení nové verze.';
    if (job.kind === 'pipeline' && job.currentStep) {
      job.failedStep = job.currentStep;
      markPipelineStepFinished(job, job.currentStep, now);
    }
    count += 1;
  }
  return count;
}

/** Po dokončení aktuálního kroku během drainu uloží jako resume bod krok následující. */
export function checkpointPipelineAfterCompletedStep(
  parent: PipelineJob,
  completedStep: PipelineStep,
  now = new Date().toISOString(),
): void {
  const index = RUN_ALL_STEPS.indexOf(completedStep);
  if (index === RUN_ALL_STEPS.length - 1) {
    parent.status = 'done';
    parent.currentStep = completedStep;
    parent.failedStep = undefined;
    parent.error = undefined;
    parent.finishedAt = now;
    return;
  }
  const resumeStep = index >= 0 ? RUN_ALL_STEPS[index + 1] : completedStep;
  parent.status = 'interrupted';
  parent.currentStep = resumeStep;
  parent.failedStep = resumeStep;
  parent.error = 'Pipeline byla po dokončení aktuálního kroku pozastavena kvůli nasazení nové verze.';
  parent.finishedAt = now;
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

/** Minimální tvar úlohy potřebný pro rozhodnutí plánovače (kdo smí běžet). */
export interface SchedulableJob {
  id: string;
  tenderId: string;
}

/**
 * Čistá funkce plánovače souběžné fronty. Z FIFO fronty vybere úlohy, které smí odstartovat,
 * při dodržení dvou invariantů:
 *  (a) per-tender serializace — nikdy dvě úlohy TÉŽE zakázky současně (čtou/píší stejné soubory);
 *  (b) FIFO férovost — prochází frontu v pořadí zařazení a bere první způsobilé.
 * Souběh je omezen `maxConcurrent`; volné sloty = maxConcurrent − počet právě běžících úloh.
 *
 * `runningTenderIds` = zakázky, které už mají běžící úlohu (délka pole = počet běžících úloh,
 * protože invariant (a) drží nejvýše jednu běžící úlohu na zakázku). Vrací ID úloh k odstartování
 * ve FIFO pořadí.
 */
export function selectJobsToStart(
  queue: SchedulableJob[],
  runningTenderIds: string[],
  maxConcurrent: number,
): string[] {
  const limit = Number.isFinite(maxConcurrent) && maxConcurrent >= 1 ? Math.floor(maxConcurrent) : 1;
  const slots = limit - runningTenderIds.length;
  if (slots <= 0) return [];

  const busyTenders = new Set(runningTenderIds);
  const selected: string[] = [];
  for (const job of queue) {
    if (selected.length >= slots) break;
    // Zakázka už běží (nebo ji bereme v tomto kole) → přeskoč, ať se kroky neserializují souběžně.
    if (busyTenders.has(job.tenderId)) continue;
    busyTenders.add(job.tenderId);
    selected.push(job.id);
  }
  return selected;
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
    // Pauznuté stavy NEJSOU 'running' → restart je zachová a existující resume je může obnovit.
    if (job.status === 'running') {
      job.status = 'interrupted';
      job.finishedAt = now;
      job.error = job.error || 'Úloha byla přerušena restartem serveru.';
      if (job.kind === 'pipeline' && job.currentStep) {
        job.failedStep = job.currentStep;
        markPipelineStepFinished(job, job.currentStep, now);
      }
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
    // Lidský money-gate (nepotvrzené ceny před generate) NENÍ chyba — řetězec se pauzne
    // ve waiting_approval a čeká na potvrzení cen + explicitní resume. Bez finishedAt,
    // aby restore snapshot nepovažoval job za dokončený.
    if (err instanceof ApprovalRequiredError) {
      parent.status = 'waiting_approval';
      parent.currentStep = nextStep;
      parent.failedStep = undefined;
      parent.error = err.message;
      parent.finishedAt = undefined;
      return;
    }
    if (err instanceof BudgetPausedError) {
      parent.status = 'budget_paused';
      parent.currentStep = nextStep;
      parent.failedStep = undefined;
      parent.error = err.message;
      parent.finishedAt = undefined;
      return;
    }
    parent.status = 'error';
    parent.failedStep = nextStep;
    parent.error = err instanceof Error ? err.message : String(err);
    parent.finishedAt = now;
  }
}
