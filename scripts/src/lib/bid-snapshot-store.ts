/** PostgreSQL úložiště snapshotů; čtení bez DB vždy degraduje na prázdný výsledek. */
import { getPool, query, queryOne } from './db.js';
import type { BidSnapshot } from './bid-snapshot.js';

export interface StoredBidSnapshot extends BidSnapshot { id: string; }

const COLUMNS = ['tender_id','snapshot_at','zadavatel_nazev','zadavatel_ico','kategorie','zdroj','evidencni_cislo','predpokladana_hodnota','lhuta_nabidek','pocet_polozek','nase_cena_bez_dph','nase_cena_s_dph','nakupni_naklad_bez_dph','marze_procent','zisk_kc','go_no_go_score','bid_score','winprice_median','winprice_p25','winprice_p75','winprice_n','podil_overenych_cen','podil_orientacnich','pocet_hard_flagu','pocet_warn_flagu','pocet_kandidat_neexistuje','validation_fails','ai_naklad_czk','cas_zpracovani_min','raw'] as const;
const SELECT = `id::text, tender_id, snapshot_at, zadavatel_nazev, zadavatel_ico, kategorie, zdroj, evidencni_cislo,
 predpokladana_hodnota::float8, to_char(lhuta_nabidek, 'YYYY-MM-DD') AS lhuta_nabidek, pocet_polozek,
 nase_cena_bez_dph::float8, nase_cena_s_dph::float8, nakupni_naklad_bez_dph::float8, marze_procent::float8, zisk_kc::float8,
 go_no_go_score, bid_score, winprice_median::float8, winprice_p25::float8, winprice_p75::float8, winprice_n,
 podil_overenych_cen::float8, podil_orientacnich::float8, pocet_hard_flagu, pocet_warn_flagu,
 pocet_kandidat_neexistuje, validation_fails, ai_naklad_czk::float8, cas_zpracovani_min::float8, raw`;

export async function insertSnapshot(snapshot: BidSnapshot): Promise<StoredBidSnapshot | null> {
  if (!getPool()) return null;
  const values = COLUMNS.map((column) => snapshot[column]);
  return queryOne<StoredBidSnapshot>(`INSERT INTO bid_snapshots (${COLUMNS.join(',')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(',')}) RETURNING ${SELECT}`, values);
}

export async function listSnapshots(tenderId: string): Promise<StoredBidSnapshot[]> {
  if (!getPool()) return [];
  try { return (await query<StoredBidSnapshot>(`SELECT ${SELECT} FROM bid_snapshots WHERE tender_id=$1 ORDER BY snapshot_at DESC, id DESC`, [tenderId])).rows; } catch { return []; }
}

export async function getLatest(tenderId: string): Promise<StoredBidSnapshot | null> {
  if (!getPool()) return null;
  try { return await queryOne<StoredBidSnapshot>(`SELECT ${SELECT} FROM bid_snapshots WHERE tender_id=$1 ORDER BY snapshot_at DESC, id DESC LIMIT 1`, [tenderId]); } catch { return null; }
}
