/**
 * CRM lifecycle state-machine (M2) — autoritativní pravidla přechodů na backendu.
 * Pragmatické guardy: precondition se odvozuje z dostupných dat (dokončené pipeline
 * kroky). RBAC se zatím nevynucuje. Frontend má zrcadlo v apps/web/src/lib/stage-machine.ts.
 */

export type StageKey =
  | 'nova'
  | 'relevantni'
  | 'analyzovana'
  | 'ocenena'
  | 'pripravena'
  | 'odeslana'
  | 'vyhodnocena'
  | 'vyhrano'
  | 'prohrano'
  | 'nepodano';

// 7 aktivních fází v pořadí (terminální 3 jsou mimo).
export const ACTIVE_ORDER: StageKey[] = [
  'nova', 'relevantni', 'analyzovana', 'ocenena', 'pripravena', 'odeslana', 'vyhodnocena',
];
export const TERMINAL_STAGES: StageKey[] = ['vyhrano', 'prohrano', 'nepodano'];

export const ALL_STAGES: StageKey[] = [...ACTIVE_ORDER, ...TERMINAL_STAGES];

export function isTerminal(s: StageKey): boolean {
  return TERMINAL_STAGES.includes(s);
}

/** Dokončené pipeline kroky (mapováno z getPipelineStatus steps === 'done'). */
export interface StepFlags {
  extract: boolean;
  analyze: boolean;
  match: boolean;
  generate: boolean;
  validate: boolean;
}

/** Odvozená fáze z postupu pipeline (musí být shodná s frontend deriveStage). */
export function deriveStageFromSteps(done: StepFlags): StageKey {
  if (done.validate || done.generate) return 'pripravena';
  if (done.match) return 'ocenena';
  if (done.analyze) return 'analyzovana';
  return 'nova';
}

// Precondition pro VSTUP do fáze (z dostupných dat). Vrací null když OK, jinak důvod zákazu.
function enterPrecondition(to: StageKey, done: StepFlags): string | null {
  switch (to) {
    case 'analyzovana': return done.analyze ? null : 'chybí dokončená AI analýza';
    case 'ocenena': return done.match ? null : 'chybí dokončené ocenění položek';
    case 'pripravena': return done.generate || done.validate ? null : 'chybí vygenerované dokumenty';
    case 'odeslana': return done.validate ? null : 'nabídka není připravená k podání (chybí validace)';
    default: return null; // nova, relevantni, vyhodnocena, terminální — bez precondition (řeší pořadí)
  }
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

/**
 * Smí se přejít from → to při daném postupu pipeline?
 * - dopředu o/přes fáze, drží-li precondition cílové fáze;
 * - zpět na libovolnou ne-terminální fázi volně (oprava);
 * - nepodano z libovolné ne-terminální (důvod vynucuje endpoint);
 * - vyhrano/prohrano jen z Odeslaná/Vyhodnocená;
 * - z terminální fáze pouze „Znovu otevřít" na ne-terminální.
 */
export function canTransition(from: StageKey, to: StageKey, done: StepFlags): TransitionResult {
  if (from === to) return { ok: false, reason: 'Zakázka už je v tomto stavu' };

  // Z terminální fáze — pouze znovu otevřít na ne-terminální.
  if (isTerminal(from)) {
    if (isTerminal(to)) return { ok: false, reason: 'Z terminálního stavu lze jen znovu otevřít' };
    return { ok: true };
  }

  // Nepodáno / Zrušeno — z libovolné ne-terminální.
  if (to === 'nepodano') return { ok: true };

  // Výsledek — jen z Odeslaná / Vyhodnocená.
  if (to === 'vyhrano' || to === 'prohrano') {
    if (from === 'odeslana' || from === 'vyhodnocena') return { ok: true };
    return { ok: false, reason: 'Výsledek lze nastavit jen ze stavu Odeslaná nebo Vyhodnocená' };
  }

  // Vyhodnocení (čeká na výsledek) — jen po podání.
  if (to === 'vyhodnocena' && from !== 'odeslana') {
    return { ok: false, reason: 'Vyhodnocení je možné jen ze stavu Odeslaná' };
  }

  // Obě fáze v aktivním pořadí.
  const fromIdx = ACTIVE_ORDER.indexOf(from);
  const toIdx = ACTIVE_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return { ok: false, reason: 'Neplatný přechod' };

  if (toIdx < fromIdx) return { ok: true }; // zpět = oprava, volně

  const pre = enterPrecondition(to, done);
  return pre ? { ok: false, reason: pre } : { ok: true };
}

/** Seznam fází, do kterých lze z `from` přejít (pro „Změnit stav" dropdown / drag). */
export function allowedTransitions(from: StageKey, done: StepFlags): StageKey[] {
  return ALL_STAGES.filter((s) => canTransition(from, s, done).ok);
}
