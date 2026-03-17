/**
 * Document slot types for company qualification docs.
 * Mirrors packages/shared/constants.ts — keep in sync.
 */

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
}

export interface DocManifest {
  version: number;
  entries: DocSlotEntry[];
}
