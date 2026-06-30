// Frontend zrcadlo state-machine pravidel (autoritativní je backend scripts/src/lib/stage-machine.ts).
// Slouží pro UX: které cílové fáze nabídnout v „Změnit stav" dropdownu a kam smí drag na kanbanu.
// Backend přechod stejně ověří a případně vrátí 409 + důvod (guard toast).
import type { PipelineSteps } from './api';
import { STAGES, TERMINAL_STAGES, type StageKey } from './stages';

const ACTIVE_ORDER: StageKey[] = [
  'nova', 'relevantni', 'analyzovana', 'ocenena', 'pripravena', 'odeslana', 'vyhodnocena',
];
const ALL: StageKey[] = STAGES.map((s) => s.key);

function isTerminal(s: StageKey): boolean {
  return TERMINAL_STAGES.includes(s);
}

interface Done {
  analyze: boolean;
  match: boolean;
  generate: boolean;
  validate: boolean;
}

function flags(steps?: PipelineSteps): Done {
  return {
    analyze: steps?.analyze === 'done',
    match: steps?.match === 'done',
    generate: steps?.generate === 'done',
    validate: steps?.validate === 'done',
  };
}

function enterPrecondition(to: StageKey, d: Done): string | null {
  switch (to) {
    case 'analyzovana': return d.analyze ? null : 'chybí dokončená AI analýza';
    case 'ocenena': return d.match ? null : 'chybí dokončené ocenění položek';
    case 'pripravena': return d.generate || d.validate ? null : 'chybí vygenerované dokumenty';
    case 'odeslana': return d.validate ? null : 'nabídka není připravená k podání (chybí validace)';
    default: return null;
  }
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

export function canTransition(from: StageKey, to: StageKey, steps?: PipelineSteps): TransitionResult {
  if (from === to) return { ok: false, reason: 'Zakázka už je v tomto stavu' };
  if (isTerminal(from)) {
    if (isTerminal(to)) return { ok: false, reason: 'Z terminálního stavu lze jen znovu otevřít' };
    return { ok: true };
  }
  if (to === 'nepodano') return { ok: true };
  if (to === 'vyhrano' || to === 'prohrano') {
    if (from === 'odeslana' || from === 'vyhodnocena') return { ok: true };
    return { ok: false, reason: 'Výsledek lze nastavit jen ze stavu Odeslaná nebo Vyhodnocená' };
  }
  if (to === 'vyhodnocena' && from !== 'odeslana') {
    return { ok: false, reason: 'Vyhodnocení je možné jen ze stavu Odeslaná' };
  }
  const fromIdx = ACTIVE_ORDER.indexOf(from);
  const toIdx = ACTIVE_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return { ok: false, reason: 'Neplatný přechod' };
  if (toIdx < fromIdx) return { ok: true };
  const pre = enterPrecondition(to, flags(steps));
  return pre ? { ok: false, reason: pre } : { ok: true };
}

/** Cílové fáze, do kterých lze z `from` přejít při daném postupu pipeline. */
export function allowedNextStages(from: StageKey, steps?: PipelineSteps): StageKey[] {
  return ALL.filter((s) => canTransition(from, s, steps).ok);
}
