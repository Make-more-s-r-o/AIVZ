/**
 * Persistovaný nákupní seznam zakázky. Stejně jako crm-store degraduje bez DB:
 * čtení vrací prázdný seznam, zápisy hlásí `db_unavailable` pro překlad na HTTP 503.
 */
import { getPool, query, queryOne } from './db.js';

export interface NakupItemInput {
  polozka_index: number;
  polozka_nazev: string | null;
  mnozstvi: number | null;
  jednotka: string | null;
  nakupni_cena_bez_dph: number | null;
  dodavatel: string | null;
  url: string | null;
}

export interface NakupRow extends NakupItemInput {
  id: number;
  tender_id: string;
  objednano: boolean;
  objednano_at: string | null;
  poznamka: string | null;
  created_at: string;
  updated_at: string;
}

const NAKUP_COLUMNS = `id, tender_id, polozka_index, polozka_nazev,
  mnozstvi::float8 AS mnozstvi, jednotka,
  nakupni_cena_bez_dph::float8 AS nakupni_cena_bez_dph,
  dodavatel, url, objednano, objednano_at, poznamka, created_at, updated_at`;

function dbReady(): boolean {
  return getPool() !== null;
}

/** Pole řízená seedem; operátorský stav objednání, čas a poznámka v seznamu záměrně nejsou. */
export const NAKUP_SEED_OWNED_FIELDS = [
  'polozka_nazev',
  'mnozstvi',
  'jednotka',
  'nakupni_cena_bez_dph',
  'dodavatel',
  'url',
] as const satisfies ReadonlyArray<keyof NakupItemInput>;

/**
 * Vloží nové a opraví změněná pole vlastněná seedem. `objednano`, `objednano_at`
 * ani ruční `poznamka` nejsou v UPDATE větvi, takže zůstávají vždy zachované.
 */
export async function upsertNakupy(tenderId: string, items: NakupItemInput[]): Promise<number> {
  if (!dbReady()) throw new Error('db_unavailable');
  if (items.length === 0) return 0;

  const values: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const item of items) {
    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      tenderId,
      item.polozka_index,
      item.polozka_nazev,
      item.mnozstvi,
      item.jednotka,
      item.nakupni_cena_bez_dph,
      item.dodavatel,
      item.url,
    );
  }

  const updateAssignments = NAKUP_SEED_OWNED_FIELDS
    .map((field) => `${field} = EXCLUDED.${field}`)
    .join(', ');
  const currentTuple = NAKUP_SEED_OWNED_FIELDS.map((field) => `crm_nakupy.${field}`).join(', ');
  const incomingTuple = NAKUP_SEED_OWNED_FIELDS.map((field) => `EXCLUDED.${field}`).join(', ');

  const result = await query(
    `INSERT INTO crm_nakupy
       (tender_id, polozka_index, polozka_nazev, mnozstvi, jednotka,
        nakupni_cena_bez_dph, dodavatel, url)
     VALUES ${values.join(', ')}
     ON CONFLICT (tender_id, polozka_index) DO UPDATE SET
       ${updateAssignments}, updated_at = NOW()
     WHERE (${currentTuple}) IS DISTINCT FROM (${incomingTuple})`,
    params,
  );
  return result.rowCount ?? 0;
}

/** Bez DB nebo při chybě čtení vrací prázdný seznam. */
export async function listNakupy(tenderId: string): Promise<NakupRow[]> {
  if (!dbReady()) return [];
  try {
    const result = await query<NakupRow>(
      `SELECT ${NAKUP_COLUMNS}
       FROM crm_nakupy
       WHERE tender_id = $1
       ORDER BY polozka_index`,
      [tenderId],
    );
    return result.rows;
  } catch {
    return [];
  }
}

/**
 * Změní stav objednání a volitelně poznámku. Čas prvního objednání se při
 * opakovaném zaškrtnutí zachová; odškrtnutí jej vynuluje.
 */
export async function setObjednano(
  tenderId: string,
  polozkaIndex: number,
  objednano: boolean,
  poznamka?: string | null,
): Promise<NakupRow | null> {
  if (!dbReady()) throw new Error('db_unavailable');
  return queryOne<NakupRow>(
    `UPDATE crm_nakupy SET
       objednano = $3,
       objednano_at = CASE WHEN $3 THEN COALESCE(objednano_at, NOW()) ELSE NULL END,
       poznamka = CASE WHEN $4::boolean THEN $5 ELSE poznamka END,
       updated_at = NOW()
     WHERE tender_id = $1 AND polozka_index = $2
     RETURNING ${NAKUP_COLUMNS}`,
    [tenderId, polozkaIndex, objednano, poznamka !== undefined, poznamka ?? null],
  );
}
