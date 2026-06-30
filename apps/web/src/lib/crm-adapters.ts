// Adapters that bridge the existing pipeline backend (scripts + Express + JSON)
// to the CRM design-system vocabulary. NO backend changes — everything here is
// derived read-only from data already returned by /api endpoints.

import type { PipelineSteps, StepStatus } from './api';
import type { StageKey } from './stages';

export type Decision = 'GO' | 'NOGO' | 'ZVAZIT';

export function isStepDone(s: StepStatus | undefined): boolean {
  return s === 'done';
}

/**
 * deriveStage — map pipeline step progress (+ optional decision) onto the CRM
 * lifecycle. Only the stages reachable from local pipeline state are produced:
 * Nová → Analyzovaná → Oceněná → Připravená. Relevantní needs a relevance score
 * and Odeslaná+ need a submission record (neither exists yet) — so those stay empty.
 */
export function deriveStage(steps: PipelineSteps | undefined): StageKey {
  if (!steps) return 'nova';
  if (isStepDone(steps.validate) || isStepDone(steps.generate)) return 'pripravena';
  if (isStepDone(steps.match)) return 'ocenena';
  if (isStepDone(steps.analyze)) return 'analyzovana';
  return 'nova';
}

/** Count of completed processing steps — drives the StageStepper `current` index (0–5). */
export function stepperCurrent(steps: PipelineSteps | undefined): number {
  if (!steps) return 0;
  return [steps.extract, steps.analyze, steps.match, steps.generate, steps.validate].filter(isStepDone).length;
}

/** True while any step is running (for the processing spinner / "probíhá"). */
export function isProcessing(steps: PipelineSteps | undefined): boolean {
  if (!steps) return false;
  return Object.values(steps).some((s) => s === 'running');
}

/** True if any step errored. */
export function hasStepError(steps: PipelineSteps | undefined): boolean {
  if (!steps) return false;
  return Object.values(steps).some((s) => s === 'error');
}

/**
 * normalizeDecision — the backend writes `doporuceni.rozhodnuti` as
 * NABIDNOUT | NEUCASTNIT_SE (free string). Map onto the CRM gate GO/NOGO/ZVÁŽIT.
 */
export function normalizeDecision(raw: string | null | undefined): Decision | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  // NOGO first — "NEUCASTNIT_SE" also contains "UCASTNIT".
  if (v === 'NOGO' || v.includes('NEUCAST') || v.includes('NEZUCAST') || v.includes('NEUC')) return 'NOGO';
  if (v === 'GO' || v.includes('NABID') || v.includes('UCASTNIT')) return 'GO';
  if (v === 'ZVAZIT' || v.includes('ZVAZ') || v.includes('ZVÁŽ')) return 'ZVAZIT';
  return 'ZVAZIT';
}

/**
 * effectiveStage — persistovaný lifecycle `status` (M2, zdroj pravdy) má přednost;
 * když chybí (žádná DB / žádný záznam), spadne zpět na odvozenou fázi z pipeline kroků.
 */
export function effectiveStage(tender: { status?: StageKey | null; steps?: PipelineSteps }): StageKey {
  return tender.status ?? deriveStage(tender.steps);
}

/** Days until an ISO deadline (negative = overdue). null if missing/invalid. */
export function deadlineDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.ceil((t - start) / 86400000);
}
