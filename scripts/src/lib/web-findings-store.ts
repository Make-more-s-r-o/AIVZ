/**
 * Samostatný sklad nákupních nálezů z webového ověření. Tato data se vědomě
 * nezapojují do warehouse matchingu; slouží jako nákupní znalost po výhře.
 */
import { getPool, query } from './db.js';

export interface WebFindingInput {
  tender_id: string;
  polozka_index: number;
  polozka_nazev: string;
  produkt?: string | null;
  dodavatel?: string | null;
  url: string;
  cena_bez_dph?: number | null;
  cena_s_dph?: number | null;
  dostupnost?: string | null;
  zdroj?: string;
}

export interface WebFindingRow {
  id: number;
  tender_id: string;
  polozka_index: number;
  polozka_nazev: string;
  produkt: string | null;
  dodavatel: string | null;
  url: string;
  cena_bez_dph: number | null;
  cena_s_dph: number | null;
  dostupnost: string | null;
  zdroj: string;
  found_at: string;
}

const FINDING_COLUMNS = `id, tender_id, polozka_index, polozka_nazev, produkt, dodavatel, url,
  cena_bez_dph::float8 AS cena_bez_dph, cena_s_dph::float8 AS cena_s_dph,
  dostupnost, zdroj, found_at::text AS found_at`;

/**
 * Idempotentně uloží všechny nálezy. Bez DATABASE_URL jde o úspěšný no-op;
 * skutečnou DB chybu nechá probublat, aby ji volající mohl zalogovat jako warning.
 */
export async function upsertFindings(findings: WebFindingInput[]): Promise<number> {
  if (findings.length === 0 || getPool() === null) return 0;

  let stored = 0;
  for (const finding of findings) {
    await query(
      `INSERT INTO warehouse_web_findings
         (tender_id, polozka_index, polozka_nazev, produkt, dodavatel, url,
          cena_bez_dph, cena_s_dph, dostupnost, zdroj)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (tender_id, polozka_index, url) DO UPDATE SET
         polozka_nazev = EXCLUDED.polozka_nazev,
         produkt = EXCLUDED.produkt,
         dodavatel = EXCLUDED.dodavatel,
         cena_bez_dph = EXCLUDED.cena_bez_dph,
         cena_s_dph = EXCLUDED.cena_s_dph,
         dostupnost = EXCLUDED.dostupnost,
         zdroj = EXCLUDED.zdroj,
         found_at = NOW()`,
      [
        finding.tender_id,
        finding.polozka_index,
        finding.polozka_nazev,
        finding.produkt ?? null,
        finding.dodavatel ?? null,
        finding.url,
        finding.cena_bez_dph ?? null,
        finding.cena_s_dph ?? null,
        finding.dostupnost ?? null,
        finding.zdroj ?? 'web_verify',
      ],
    );
    stored++;
  }
  return stored;
}

/** Bez DB nebo při chybě čtení vrací prázdný seznam (graceful degradace). */
export async function listFindings(tenderId: string): Promise<WebFindingRow[]> {
  if (getPool() === null) return [];
  try {
    const result = await query<WebFindingRow>(
      `SELECT ${FINDING_COLUMNS}
       FROM warehouse_web_findings
       WHERE tender_id = $1
       ORDER BY polozka_index, cena_s_dph NULLS LAST, cena_bez_dph NULLS LAST, found_at DESC`,
      [tenderId],
    );
    return result.rows;
  } catch {
    return [];
  }
}
