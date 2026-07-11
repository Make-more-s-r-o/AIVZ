/**
 * Outcomes store — výsledky podaných nabídek (win-rate feedback loop) v tabulce
 * crm_vysledky. Vzor crm-store/terminy-store: graceful degradace — bez DB
 * (getPool() === null) čtení vrací prázdno, zápisy vyhazují 'db_unavailable'
 * (endpoint to přeloží na 503). Jeden řádek na zakázku (upsert dle tender_id).
 */
import { query, queryOne, getPool } from './db.js';

export type VysledekPodani = 'vyhra' | 'prohra' | 'zruseno';

export interface OutcomeRow {
  id: string;
  tender_id: string;
  vysledek: VysledekPodani;
  vitezna_cena_bez_dph: number | null;
  nase_cena_bez_dph: number | null;
  pocet_uchazecu: number | null;
  vitez_nazev: string | null;
  poznamka: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutcomeInput {
  vysledek: VysledekPodani;
  vitezna_cena_bez_dph?: number | null;
  nase_cena_bez_dph?: number | null;
  pocet_uchazecu?: number | null;
  vitez_nazev?: string | null;
  poznamka?: string | null;
}

function dbReady(): boolean {
  return getPool() !== null;
}

// NUMERIC vrací node-pg jako string → ::float8 pro čísla v JSON (vzor to_char u DATE).
const OUTCOME_COLS = `id::text, tender_id, vysledek,
  vitezna_cena_bez_dph::float8 AS vitezna_cena_bez_dph,
  nase_cena_bez_dph::float8 AS nase_cena_bez_dph,
  pocet_uchazecu, vitez_nazev, poznamka, created_at, updated_at`;

export async function getOutcome(tenderId: string): Promise<OutcomeRow | null> {
  if (!dbReady()) return null;
  try {
    return await queryOne<OutcomeRow>(
      `SELECT ${OUTCOME_COLS} FROM crm_vysledky WHERE tender_id = $1`,
      [tenderId],
    );
  } catch {
    return null;
  }
}

/** Idempotentní upsert výsledku zakázky (jeden řádek na tender_id). */
export async function upsertOutcome(tenderId: string, data: OutcomeInput): Promise<OutcomeRow> {
  if (!dbReady()) throw new Error('db_unavailable');
  const row = await queryOne<OutcomeRow>(
    `INSERT INTO crm_vysledky
       (tender_id, vysledek, vitezna_cena_bez_dph, nase_cena_bez_dph, pocet_uchazecu, vitez_nazev, poznamka)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tender_id) DO UPDATE SET
       vysledek = EXCLUDED.vysledek,
       vitezna_cena_bez_dph = EXCLUDED.vitezna_cena_bez_dph,
       nase_cena_bez_dph = EXCLUDED.nase_cena_bez_dph,
       pocet_uchazecu = EXCLUDED.pocet_uchazecu,
       vitez_nazev = EXCLUDED.vitez_nazev,
       poznamka = EXCLUDED.poznamka,
       updated_at = NOW()
     RETURNING ${OUTCOME_COLS}`,
    [
      tenderId, data.vysledek, data.vitezna_cena_bez_dph ?? null, data.nase_cena_bez_dph ?? null,
      data.pocet_uchazecu ?? null, data.vitez_nazev ?? null, data.poznamka ?? null,
    ],
  );
  return row!;
}

// ============================================================
// Statistiky (win-rate)
// ============================================================

export interface OutcomeStats {
  celkem: number;
  vyhry: number;
  prohry: number;
  zrusene: number;
  /** vyhry / (vyhry + prohry) * 100; null když žádná rozhodnutá zakázka. */
  win_rate_procent: number | null;
  /**
   * Průměr (nase - vitezna) / vitezna * 100 přes prohry, kde jsou obě ceny > 0.
   * Kladné číslo = o kolik % jsme byli dražší než vítěz. null bez dat.
   */
  prumerna_odchylka_od_viteze_procent: number | null;
}

/** Řádek pro čistý výpočet statistik (podmnožina OutcomeRow — testovatelné bez DB). */
export interface OutcomeStatsRow {
  vysledek: VysledekPodani;
  vitezna_cena_bez_dph: number | null;
  nase_cena_bez_dph: number | null;
}

/** Čistý výpočet statistik z řádků — exportováno kvůli unit testům. */
export function computeOutcomeStats(rows: OutcomeStatsRow[]): OutcomeStats {
  const vyhry = rows.filter((r) => r.vysledek === 'vyhra').length;
  const prohry = rows.filter((r) => r.vysledek === 'prohra').length;
  const zrusene = rows.filter((r) => r.vysledek === 'zruseno').length;
  const rozhodnuto = vyhry + prohry;

  // Odchylka od vítěze jen u proher s oběma cenami (vitezna > 0 kvůli dělení).
  const odchylky = rows
    .filter((r) => r.vysledek === 'prohra'
      && typeof r.nase_cena_bez_dph === 'number' && r.nase_cena_bez_dph > 0
      && typeof r.vitezna_cena_bez_dph === 'number' && r.vitezna_cena_bez_dph > 0)
    .map((r) => ((r.nase_cena_bez_dph! - r.vitezna_cena_bez_dph!) / r.vitezna_cena_bez_dph!) * 100);

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    celkem: rows.length,
    vyhry,
    prohry,
    zrusene,
    win_rate_procent: rozhodnuto > 0 ? round2((vyhry / rozhodnuto) * 100) : null,
    prumerna_odchylka_od_viteze_procent: odchylky.length > 0
      ? round2(odchylky.reduce((s, o) => s + o, 0) / odchylky.length)
      : null,
  };
}

const EMPTY_STATS: OutcomeStats = {
  celkem: 0, vyhry: 0, prohry: 0, zrusene: 0,
  win_rate_procent: null, prumerna_odchylka_od_viteze_procent: null,
};

export async function getOutcomeStats(): Promise<OutcomeStats> {
  if (!dbReady()) return EMPTY_STATS;
  try {
    const r = await query<OutcomeStatsRow>(
      `SELECT vysledek,
              vitezna_cena_bez_dph::float8 AS vitezna_cena_bez_dph,
              nase_cena_bez_dph::float8 AS nase_cena_bez_dph
       FROM crm_vysledky`,
    );
    return computeOutcomeStats(r.rows);
  } catch {
    return EMPTY_STATS;
  }
}
