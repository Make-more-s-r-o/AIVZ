/** Čisté a defenzivní sestavení feature vektoru nabídky v okamžiku finalize. */
import { computeBidEconomics, type BidEconomics } from './go-no-go.js';

export interface BidSnapshot {
  tender_id: string;
  snapshot_at: string;
  zadavatel_nazev: string | null; zadavatel_ico: string | null; kategorie: string | null;
  zdroj: string | null; evidencni_cislo: string | null;
  predpokladana_hodnota: number | null; lhuta_nabidek: string | null; pocet_polozek: number | null;
  nase_cena_bez_dph: number | null; nase_cena_s_dph: number | null; nakupni_naklad_bez_dph: number | null;
  marze_procent: number | null; zisk_kc: number | null;
  go_no_go_score: number | null; bid_score: number | null;
  winprice_median: number | null; winprice_p25: number | null; winprice_p75: number | null; winprice_n: number | null;
  podil_overenych_cen: number | null; podil_orientacnich: number | null;
  pocet_hard_flagu: number | null; pocet_warn_flagu: number | null; pocet_kandidat_neexistuje: number | null;
  validation_fails: number | null; ai_naklad_czk: number | null; cas_zpracovani_min: number | null;
  raw: Record<string, unknown>;
}

export interface BuildBidSnapshotInput {
  tenderId: string; analysis?: unknown; productMatch?: unknown; validationReport?: unknown;
  costLog?: unknown; winPriceBand?: unknown; monitoringItem?: unknown; snapshotAt?: string;
  bidEconomics?: BidEconomics;
}

const obj = (v: unknown): Record<string, any> => v != null && typeof v === 'object' ? v as Record<string, any> : {};
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
const round = (v: number): number => Math.round(v * 100) / 100;

/** Multi-product i historický single-product tvar převede na jednotné položky. */
function itemsOf(pm: Record<string, any>): Record<string, any>[] {
  if (Array.isArray(pm.polozky_match)) return pm.polozky_match.filter((x: unknown) => x && typeof x === 'object');
  return Array.isArray(pm.kandidati) ? [pm] : [];
}

function hasNonOrientationalSource(item: Record<string, any>): boolean {
  const verification = obj(item.overeni_ceny);
  if (verification.stav !== 'nalezeno' && verification.stav !== 'ekvivalent') return false;
  const sources = Array.isArray(verification.zdroje) ? verification.zdroje.map(obj) : [];
  // Ověřená je položka jen tehdy, když skutečně existuje oceněný neorientační zdroj.
  return sources.some((source) => source.orientacni !== true
    && (num(source.cena_bez_dph) != null || num(source.cena_s_dph) != null));
}

function isOrientational(item: Record<string, any>): boolean {
  const verification = obj(item.overeni_ceny);
  if (verification.stav === 'orientacni') return true;
  const sources = Array.isArray(verification.zdroje) ? verification.zdroje.map(obj) : [];
  return sources.length > 0 && sources.every((source) => source.orientacni === true);
}

export function buildBidSnapshot(input: BuildBidSnapshotInput): BidSnapshot {
  try {
    const analysis = obj(input.analysis); const zakazka = obj(analysis.zakazka);
    const pm = obj(input.productMatch); const validation = obj(input.validationReport);
    const band = obj(input.winPriceBand); const monitoring = obj(input.monitoringItem);
    const items = itemsOf(pm);
    const total = items.length;
    const flags = items.flatMap((item) => Array.isArray(item.sanity_flags) ? item.sanity_flags.map(obj) : []);
    let economics: ReturnType<typeof computeBidEconomics> | null = input.bidEconomics ?? null;
    try { economics ??= computeBidEconomics(pm as any); } catch { /* vadný legacy vstup */ }
    const costEntries = Array.isArray(input.costLog) ? input.costLog.map(obj) : [];
    const aiCost = costEntries.reduce((sum, entry) => sum + (num(entry.costCZK) ?? 0), 0);
    const timestamps = costEntries.map((entry) => Date.parse(str(entry.timestamp) ?? '')).filter(Number.isFinite);
    const duration = timestamps.length >= 2 ? (Math.max(...timestamps) - Math.min(...timestamps)) / 60_000 : null;
    const bid = obj(pm.bid_score);

    return {
      tender_id: typeof input.tenderId === 'string' ? input.tenderId : '',
      snapshot_at: str(input.snapshotAt) ?? new Date().toISOString(),
      zadavatel_nazev: str(zakazka.zadavatel?.nazev) ?? str(zakazka.zadavatel) ?? str(monitoring.zadavatel),
      zadavatel_ico: str(zakazka.zadavatel?.ico) ?? str(zakazka.ico_zadavatele),
      kategorie: str(monitoring.kategorie) ?? str(zakazka.kategorie) ?? str(zakazka.typ_zakazky), zdroj: str(monitoring.zdroj) ?? str(zakazka.zdroj),
      evidencni_cislo: str(zakazka.evidencni_cislo) ?? str(monitoring.zdroj_id),
      predpokladana_hodnota: num(zakazka.predpokladana_hodnota) ?? num(monitoring.predpokladana_hodnota),
      lhuta_nabidek: str(analysis.terminy?.lhuta_nabidek) ?? str(zakazka.lhuta_pro_podani) ?? str(zakazka.lhuta_nabidek) ?? str(monitoring.lhuta_nabidek),
      pocet_polozek: total || (Array.isArray(analysis.polozky) ? analysis.polozky.length : null),
      nase_cena_bez_dph: economics && economics.polozek > 0 ? economics.obrat_bez_dph : null,
      nase_cena_s_dph: items.length ? round(items.reduce((sum, item) => sum + (num(item.cenova_uprava?.nabidkova_cena_s_dph) ?? num(item.kandidati?.[item.vybrany_index]?.cena_s_dph) ?? 0) * (num(item.mnozstvi) ?? 1), 0)) : null,
      nakupni_naklad_bez_dph: economics && economics.polozek > 0 ? economics.naklady_bez_dph : null,
      marze_procent: num(bid.marze_procent) ?? (economics && economics.polozek > 0 ? economics.marze_procent : null),
      zisk_kc: num(bid.zisk_kc) ?? (economics && economics.polozek > 0 ? economics.zisk_kc : null),
      go_no_go_score: num(analysis.go_no_go?.score), bid_score: num(bid.score),
      winprice_median: num(band.median), winprice_p25: num(band.p25), winprice_p75: num(band.p75),
      winprice_n: num(band.n) ?? num(band.count),
      podil_overenych_cen: total ? round(items.filter(hasNonOrientationalSource).length / total) : null,
      podil_orientacnich: total ? round(items.filter(isOrientational).length / total) : null,
      pocet_hard_flagu: total ? flags.filter((flag) => flag.level === 'hard').length : null,
      pocet_warn_flagu: total ? flags.filter((flag) => flag.level === 'warn').length : null,
      pocet_kandidat_neexistuje: total ? items.filter((item) => item.overeni_ceny?.kandidat_neexistuje === true).length : null,
      validation_fails: Array.isArray(validation.checks) ? validation.checks.filter((check: any) => check?.status === 'fail').length : null,
      ai_naklad_czk: costEntries.length ? round(aiCost) : null, cas_zpracovani_min: duration == null ? null : round(duration),
      raw: { analysis: input.analysis ?? null, product_match: input.productMatch ?? null, validation_report: input.validationReport ?? null, cost_log: input.costLog ?? null, win_price_band: input.winPriceBand ?? null, monitoring_item: input.monitoringItem ?? null },
    };
  } catch {
    return buildBidSnapshot({ tenderId: input?.tenderId ?? '', snapshotAt: input?.snapshotAt, analysis: {}, productMatch: {} });
  }
}

/** Best-effort obálka použitelná endpointem i unit testem. */
export async function persistSnapshotBestEffort(action: () => Promise<unknown>, warn: (message: string, error: unknown) => void): Promise<boolean> {
  try { await action(); return true; } catch (error) { warn('Uložení bid snapshotu selhalo', error); return false; }
}
