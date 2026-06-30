// Canonical 10-stage lifecycle for VZ CRM. `key` maps to the --stage-<key>-* tokens.
// Single source of truth — StageBadge, kanban columns, funnel all read from here.

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

export interface StageDef {
  key: StageKey;
  label: string;
}

export const STAGES: StageDef[] = [
  { key: 'nova', label: 'Nová' },
  { key: 'relevantni', label: 'Relevantní' },
  { key: 'analyzovana', label: 'Analyzovaná' },
  { key: 'ocenena', label: 'Oceněná' },
  { key: 'pripravena', label: 'Připravená' },
  { key: 'odeslana', label: 'Odeslaná' },
  { key: 'vyhodnocena', label: 'Vyhodnocená' },
  { key: 'vyhrano', label: 'Vyhráno' },
  { key: 'prohrano', label: 'Prohráno' },
  { key: 'nepodano', label: 'Nepodáno / Zrušeno' },
];

export const STAGE_LABELS: Record<StageKey, string> = Object.fromEntries(
  STAGES.map((s) => [s.key, s.label]),
) as Record<StageKey, string>;

// Terminal (excluded from active pipeline value).
export const TERMINAL_STAGES: StageKey[] = ['vyhrano', 'prohrano', 'nepodano'];

export function isTerminalStage(key: StageKey): boolean {
  return TERMINAL_STAGES.includes(key);
}

// Default phase probabilities for vážená hodnota (design-brief §2.5). Editable later in Nastavení.
export const STAGE_PROBABILITY: Record<StageKey, number> = {
  nova: 0.05,
  relevantni: 0.1,
  analyzovana: 0.2,
  ocenena: 0.35,
  pripravena: 0.5,
  odeslana: 0.6,
  vyhodnocena: 0.7,
  vyhrano: 1,
  prohrano: 0,
  nepodano: 0,
};

// The 5 processing steps that drive transitions (StageStepper default order).
export const PROCESSING_STEPS = ['Extrakce', 'Analýza', 'Ocenění', 'Generování', 'Validace'] as const;
