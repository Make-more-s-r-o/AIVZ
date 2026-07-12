/** Perzistence návrhů výsledků. Žádná funkce zde nezapisuje do crm_vysledky. */
import { getPool, query, queryOne } from './db.js';
import type { OutcomeCandidateInput, TenderProSledovani } from './outcome-watcher.js';

export type KandidatStav = 'navrh' | 'potvrzeno' | 'zamitnuto';
export interface OutcomeKandidat extends OutcomeCandidateInput { id: string; nalezeno_at: string; stav: KandidatStav }
const COLS = `id::text, tender_id, zdroj, zdroj_id, nalezeno_at, vitez_nazev, vitez_ico,
 vitezna_cena_bez_dph::float8 AS vitezna_cena_bez_dph, pocet_uchazecu, url,
 shoda_skore::float8 AS shoda_skore, raw, stav`;

export async function listOutcomeCandidates(tenderId: string): Promise<OutcomeKandidat[]> {
  if (!getPool()) return [];
  try { return (await query<OutcomeKandidat>(`SELECT ${COLS} FROM outcome_kandidati WHERE tender_id=$1 ORDER BY nalezeno_at DESC`, [tenderId])).rows; }
  catch { return []; }
}

export async function getOutcomeCandidate(tenderId: string, id: string): Promise<OutcomeKandidat | null> {
  if (!getPool()) return null;
  try { return await queryOne<OutcomeKandidat>(`SELECT ${COLS} FROM outcome_kandidati WHERE tender_id=$1 AND id=$2::int`, [tenderId, id]); }
  catch { return null; }
}

export async function rejectOutcomeCandidate(tenderId: string, id: string, duvod: string): Promise<OutcomeKandidat | null> {
  if (!getPool()) throw new Error('db_unavailable');
  return queryOne<OutcomeKandidat>(`UPDATE outcome_kandidati SET stav='zamitnuto', raw=COALESCE(raw,'{}'::jsonb)||jsonb_build_object('duvod_zamitnuti',$3) WHERE tender_id=$1 AND id=$2::int RETURNING ${COLS}`, [tenderId, id, duvod]);
}

export async function markOutcomeCandidateConfirmed(tenderId: string, id: string): Promise<void> {
  if (!getPool()) throw new Error('db_unavailable');
  await query(`UPDATE outcome_kandidati SET stav='potvrzeno' WHERE tender_id=$1 AND id=$2::int AND stav='navrh'`, [tenderId, id]);
}

export function candidatePrefill(candidate: OutcomeKandidat) {
  return { vysledek: 'prohra' as const, vitezna_cena_bez_dph: candidate.vitezna_cena_bez_dph, pocet_uchazecu: candidate.pocet_uchazecu, vitez_nazev: candidate.vitez_nazev, kandidat_id: candidate.id };
}

export async function listWatchableTenders(): Promise<TenderProSledovani[]> {
  if (!getPool()) return [];
  try { return (await query<TenderProSledovani>(`SELECT s.tender_id, m.zdroj_id, m.nazev, m.zadavatel, m.url FROM crm_tender_status s JOIN monitoring_zakazky m ON m.tender_id=s.tender_id AND m.zdroj='nen' LEFT JOIN crm_vysledky o ON o.tender_id=s.tender_id WHERE s.status='odeslana' AND o.tender_id IS NULL AND m.url IS NOT NULL`)).rows; }
  catch { return []; }
}

export async function saveOutcomeCandidate(item: OutcomeCandidateInput): Promise<boolean> {
  if (!getPool()) throw new Error('db_unavailable');
  const row = await queryOne<{ inserted: boolean }>(`INSERT INTO outcome_kandidati (tender_id,zdroj,zdroj_id,vitez_nazev,vitez_ico,vitezna_cena_bez_dph,pocet_uchazecu,url,shoda_skore,raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tender_id,zdroj,zdroj_id) DO NOTHING RETURNING true AS inserted`, [item.tender_id,item.zdroj,item.zdroj_id,item.vitez_nazev,item.vitez_ico,item.vitezna_cena_bez_dph,item.pocet_uchazecu,item.url,item.shoda_skore,JSON.stringify(item.raw)]);
  return !!row?.inserted;
}
