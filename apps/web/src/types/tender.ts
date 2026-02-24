// Plain TS interfaces (no Zod dependency) mirroring scripts/src/lib/types.ts

export interface TenderAnalysis {
  zakazka: {
    nazev: string;
    evidencni_cislo?: string | null;
    zadavatel: { nazev: string; ico?: string | null; kontakt?: string | null };
    predmet: string;
    predpokladana_hodnota?: number | null;
    typ_zakazky: string;
    typ_rizeni: string;
  };
  kvalifikace: Array<{ typ: string; popis: string; splnitelne: boolean }>;
  hodnotici_kriteria: Array<{ nazev: string; vaha_procent: number; popis: string }>;
  terminy: {
    lhuta_nabidek?: string | null;
    otevirani_obalek?: string | null;
    doba_plneni_od?: string | null;
    doba_plneni_do?: string | null;
  };
  casti: Array<{ id: string; nazev: string; predpokladana_hodnota?: number; pocet_polozek: number; soupis_filename?: string }>;
  polozky: Array<{ nazev: string; mnozstvi?: number | null; jednotka?: string | null; specifikace: string; cast_id?: string }>;
  technicke_pozadavky: Array<{ parametr: string; pozadovana_hodnota: string; jednotka?: string | null; povinny: boolean }>;
  rizika: Array<{ popis: string; zavaznost: string; mitigace: string }>;
  doporuceni: { rozhodnuti: string; oduvodneni: string; klicove_body: string[] };
}

export interface ProductCandidate {
  vyrobce: string;
  model: string;
  popis: string;
  parametry: Record<string, string>;
  shoda_s_pozadavky: Array<{ pozadavek: string; splneno: boolean; hodnota: string; komentar?: string }>;
  cena_bez_dph: number;
  cena_s_dph: number;
  cena_spolehlivost: 'vysoka' | 'stredni' | 'nizka';
  cena_komentar?: string;
  dodavatele: string[];
  dostupnost: string;
  zdroj_ceny?: string;
  katalogove_cislo?: string;
}

export interface PriceOverride {
  nakupni_cena_bez_dph: number;
  nakupni_cena_s_dph: number;
  marze_procent: number;
  nabidkova_cena_bez_dph: number;
  nabidkova_cena_s_dph: number;
  potvrzeno: boolean;
  poznamka?: string;
}

export interface PolozkaMatch {
  polozka_nazev: string;
  polozka_index: number;
  mnozstvi?: number;
  jednotka?: string;
  specifikace?: string;
  typ: 'produkt' | 'prislusenstvi' | 'sluzba';
  cast_id?: string;
  kandidati: ProductCandidate[];
  vybrany_index: number;
  oduvodneni_vyberu: string;
  cenova_uprava?: PriceOverride;
}

export interface ProductMatch {
  tenderId: string;
  matchedAt: string;
  kandidati?: ProductCandidate[];
  vybrany_index?: number;
  oduvodneni_vyberu?: string;
  cenova_uprava?: PriceOverride;
  polozky_match?: PolozkaMatch[];
}

export interface ValidationCheck {
  kategorie: string;
  kontrola: string;
  status: 'pass' | 'fail' | 'warning';
  detail: string;
}

export interface ValidationReport {
  tenderId: string;
  validatedAt: string;
  overall_score: number;
  ready_to_submit: boolean;
  checks: ValidationCheck[];
  kriticke_problemy: string[];
  doporuceni: string[];
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Neznama chyba';
}
