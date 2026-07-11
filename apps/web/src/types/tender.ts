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
  go_no_go?: {
    score: number;
    doporuceni: 'GO' | 'ZVAZIT' | 'NOGO';
    duvody: string[];
  };
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
  // AI nenašla reálný odpovídající produkt — zástupný kandidát s nulovou cenou (ruční nacenění)
  zadna_shoda?: boolean;
}

export interface PriceOverride {
  nakupni_cena_bez_dph: number;
  nakupni_cena_s_dph: number;
  marze_procent: number;
  nabidkova_cena_bez_dph: number;
  nabidkova_cena_s_dph: number;
  potvrzeno: boolean;
  poznamka?: string;
  zdroj_nakupu?: {
    url: string;
    dodavatel: string | null;
  };
}

export interface PriceSanityFlag {
  polozka_index: number;
  level: 'hard' | 'warn';
  code: 'overcap' | 'zero_price' | 'below_cost' | 'bid_share' | 'low_confidence_big' | 'outlier_vs_batch' | 'extreme_outlier' | 'ai_cena_pod_trhem';
  message: string;
}

// Ověření ceny web-searchem — návrh dohledaný z webu.
// NIKDY nepřepisuje cenova_uprava; slouží jen jako podklad, který uživatel ručně potvrdí.
// (Strukturálně shodné s OvereniCeny v lib/api.ts — držíme lokálně, aby tento typový
// modul nezáležel na api vrstvě.)
export interface WebPriceSource {
  url: string;
  dodavatel: string | null;
  nazev_produktu?: string;
  cena_bez_dph: number | null;
  cena_s_dph: number | null;
  dostupnost: string | null;
  poznamka: string | null;
}

export interface OvereniCeny {
  stav: 'nalezeno' | 'ekvivalent' | 'nenalezeno' | 'chyba';
  shoda_typ?: 'presny' | 'ekvivalent';
  web_cena_bez_dph?: number;
  web_cena_s_dph?: number;
  mena?: string;
  zdroj_url?: string;
  dodavatel?: string;
  dostupnost?: string;
  poznamka?: string;
  overeno_at: string;
  prekracuje_strop?: boolean;
  zdroje?: WebPriceSource[];
  realita?: {
    nejlevnejsi_bez_dph: number | null;
    rozdil_procent: number | null;
    pod_trhem: boolean;
  };
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
  sanity_flags?: PriceSanityFlag[];
  overeni_ceny?: OvereniCeny;
}

export interface ProductMatch {
  tenderId: string;
  matchedAt: string;
  kandidati?: ProductCandidate[];
  vybrany_index?: number;
  oduvodneni_vyberu?: string;
  cenova_uprava?: PriceOverride;
  overeni_ceny?: OvereniCeny;
  polozky_match?: PolozkaMatch[];
  bid_score?: {
    score: number;
    doporuceni: 'GO' | 'ZVAZIT' | 'NOGO';
    duvody: string[];
    zisk_kc: number;
    marze_procent: number;
  };
}

export interface ValidationCheck {
  kategorie: string;
  kontrola: string;
  status: 'pass' | 'fail' | 'warning';
  detail: string;
  zdroj?: 'deterministic' | 'ai';
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
