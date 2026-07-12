export interface GoldenItem {
  id: string;
  nazev_polozky: string;
  specifikace: string;
  mnozstvi: number;
  jednotka: string;
  ocekavany_vyrobce?: string;
  ocekavany_model?: string;
  ocekavane_katalogove_cislo?: string;
  realna_cena_bez_dph: number;
  zdroj_url_domena: string;
  kategorie: string;
}

export interface EvalCandidate {
  vyrobce?: string;
  model?: string;
  katalogove_cislo?: string;
  cena_bez_dph?: number;
  zadna_shoda?: boolean;
}

export interface EvalItem {
  id: string;
  kandidati?: EvalCandidate[];
  vybrany_index?: number;
  overeni_ceny?: {
    stav?: string;
    zdroj_url?: string;
    web_cena_bez_dph?: number;
    zdroje?: Array<{ url?: string; cena_bez_dph?: number | null; orientacni?: boolean }>;
  };
}

export interface EvalMetrics {
  pocet_polozek: number;
  pocet_kandidatu: number;
  identifikace_pct: number | null;
  katalogove_cislo_pct: number | null;
  genericky_kandidat_pct: number | null;
  hit_rate_pct: number | null;
  cenovych_porovnani: number;
  mape_pct: number | null;
  podil_pod_trhem_pct: number | null;
  median_relativni_chyby_pct: number | null;
  p90_relativni_chyby_pct: number | null;
  podceneno: number;
  nadceneno: number;
  shoda_ceny: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Placeholdery nejsou smysluplná identifikace výrobku. */
export function meaningful(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !/^(neuveden[ýy]?|nezn[aá]m[ýy]?|n\/a|bez zna[čc]ky|generick[ýy]|—|-)$/i.test(value.trim());
}

export function hasNonOrientationalSource(item: EvalItem): boolean {
  const verification = item.overeni_ceny;
  if (!verification || !['nalezeno', 'ekvivalent'].includes(verification.stav ?? '')) return false;
  if (verification.zdroje?.some((source) => source.orientacni !== true && meaningful(source.url))) return true;
  return meaningful(verification.zdroj_url);
}

function percentile(sorted: number[], percentileValue: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/** Čistý výpočet metrik; nulové a chybějící reálné ceny se z cenových metrik vynechají. */
export function calculateEvalMetrics(items: EvalItem[], golden: GoldenItem[]): EvalMetrics {
  const candidates = items.flatMap((item) => item.kandidati ?? []);
  const identified = candidates.filter((candidate) => meaningful(candidate.vyrobce) && meaningful(candidate.model)).length;
  const catalogue = candidates.filter((candidate) => meaningful(candidate.katalogove_cislo)).length;
  const generic = candidates.filter((candidate) => candidate.zadna_shoda === true || !(meaningful(candidate.vyrobce) && meaningful(candidate.model))).length;
  const goldenById = new Map(golden.filter((item) => item.realna_cena_bez_dph > 0).map((item) => [item.id, item]));
  const errors: number[] = [];
  let below = 0;
  let above = 0;
  let equal = 0;

  for (const item of items) {
    const truth = goldenById.get(item.id);
    const selected = item.kandidati?.[item.vybrany_index ?? 0];
    const estimate = selected?.cena_bez_dph;
    if (!truth || typeof estimate !== 'number' || estimate <= 0) continue;
    errors.push(Math.abs(estimate - truth.realna_cena_bez_dph) / truth.realna_cena_bez_dph);
    if (estimate < truth.realna_cena_bez_dph) below++;
    else if (estimate > truth.realna_cena_bez_dph) above++;
    else equal++;
  }

  const sorted = [...errors].sort((a, b) => a - b);
  const count = errors.length;
  return {
    pocet_polozek: items.length,
    pocet_kandidatu: candidates.length,
    identifikace_pct: candidates.length ? round(identified / candidates.length * 100) : null,
    katalogove_cislo_pct: candidates.length ? round(catalogue / candidates.length * 100) : null,
    genericky_kandidat_pct: candidates.length ? round(generic / candidates.length * 100) : null,
    hit_rate_pct: items.length ? round(items.filter(hasNonOrientationalSource).length / items.length * 100) : null,
    cenovych_porovnani: count,
    mape_pct: count ? round(errors.reduce((sum, error) => sum + error, 0) / count * 100) : null,
    podil_pod_trhem_pct: count ? round(below / count * 100) : null,
    median_relativni_chyby_pct: count ? round((percentile(sorted, 0.5) ?? 0) * 100) : null,
    p90_relativni_chyby_pct: count ? round((percentile(sorted, 0.9) ?? 0) * 100) : null,
    podceneno: below,
    nadceneno: above,
    shoda_ceny: equal,
  };
}
