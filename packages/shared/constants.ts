// --- Document slot types for company qualification docs ---

export const DOC_SLOTS = [
  { type: 'vypis_or',           label: 'Výpis z obchodního rejstříku', multi: false },
  { type: 'rejstrik_trestu',    label: 'Výpis z rejstříku trestů',     multi: false },
  { type: 'potvrzeni_fu',       label: 'Potvrzení finančního úřadu',   multi: false },
  { type: 'potvrzeni_ossz',     label: 'Potvrzení OSSZ',               multi: false },
  { type: 'profesni_opravneni', label: 'Profesní oprávnění',           multi: false },
  { type: 'ostatni',            label: 'Ostatní',                       multi: true  },
] as const;

export type DocSlotType = (typeof DOC_SLOTS)[number]['type'];

export interface DocSlotEntry {
  slot: DocSlotType;
  filename: string;
  uploadedAt: string;  // ISO datetime
  platnost_do?: string | null;  // ISO datum (YYYY-MM-DD) platnosti dokladu; nepovinné (staré manifesty)
}

export interface DocManifest {
  version: number;
  entries: DocSlotEntry[];
}

// --- Pipeline steps ---

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
