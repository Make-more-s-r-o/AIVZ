export const PIPELINE_STEPS = [
  'extract',
  'analyze',
  'match',
  'generate',
  'validate',
] as const;

export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_LABELS: Record<PipelineStep, string> = {
  extract: 'Extrakce dokumentů',
  analyze: 'AI analýza',
  match: 'Výběr produktu',
  generate: 'Generování nabídky',
  validate: 'Kontrola kvality',
};
