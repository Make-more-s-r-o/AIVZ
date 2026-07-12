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
  katalogove_cislo?: string | null;
  vyrobce?: string | null;
  model?: string | null;
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
  katalogove_cislo: string | null;
  vyrobce: string | null;
  model: string | null;
}

export interface CachedSourceIdentity {
  katalogove_cislo?: string | null;
  vyrobce?: string | null;
  model?: string | null;
  nazev_polozky?: string | null;
}

const FINDING_COLUMNS = `id, tender_id, polozka_index, polozka_nazev, produkt, dodavatel, url,
  cena_bez_dph::float8 AS cena_bez_dph, cena_s_dph::float8 AS cena_s_dph,
  dostupnost, zdroj, found_at::text AS found_at, katalogove_cislo, vyrobce, model`;

/** Normalizace identity shodná pro SQL lookup i testovatelné porovnání. */
export function normalizeFindingIdentity(value: string | null | undefined): string {
  return (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

/** Čistá varianta výběru pro lokální práci a testy pravidel priority/stáří. */
export function selectCachedSources(
  rows: WebFindingRow[],
  identity: CachedSourceIdentity,
  maxStariDnu: number,
  now = new Date(),
): WebFindingRow[] {
  const katalog = normalizeFindingIdentity(identity.katalogove_cislo);
  const vyrobce = normalizeFindingIdentity(identity.vyrobce);
  const model = normalizeFindingIdentity(identity.model);
  const nazev = normalizeFindingIdentity(identity.nazev_polozky);
  const matches = (row: WebFindingRow): boolean => katalog
    ? normalizeFindingIdentity(row.katalogove_cislo) === katalog
    : vyrobce && model
      ? normalizeFindingIdentity(row.vyrobce) === vyrobce && normalizeFindingIdentity(row.model) === model
      : Boolean(nazev) && normalizeFindingIdentity(row.polozka_nazev) === nazev;
  return rows
    .filter((row) => matches(row) && now.getTime() - Date.parse(row.found_at) <= maxStariDnu * 86_400_000)
    .sort((a, b) => (a.cena_s_dph ?? a.cena_bez_dph ?? Infinity) - (b.cena_s_dph ?? b.cena_bez_dph ?? Infinity))
    .slice(0, 3);
}

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
          cena_bez_dph, cena_s_dph, dostupnost, zdroj, katalogove_cislo, vyrobce, model)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (tender_id, polozka_index, url) DO UPDATE SET
         polozka_nazev = EXCLUDED.polozka_nazev,
         produkt = EXCLUDED.produkt,
         dodavatel = EXCLUDED.dodavatel,
         cena_bez_dph = EXCLUDED.cena_bez_dph,
         cena_s_dph = EXCLUDED.cena_s_dph,
         dostupnost = EXCLUDED.dostupnost,
         zdroj = EXCLUDED.zdroj,
         katalogove_cislo = EXCLUDED.katalogove_cislo,
         vyrobce = EXCLUDED.vyrobce,
         model = EXCLUDED.model,
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
        finding.katalogove_cislo ?? null,
        finding.vyrobce ?? null,
        finding.model ?? null,
      ],
    );
    stored++;
  }
  return stored;
}

/**
 * Najde čerstvé nálezy podle nejsilnější dostupné identity. Slabší klíč se
 * použije pouze tehdy, když silnější klíč ve vstupu chybí.
 */
export async function findCachedSources(
  identity: CachedSourceIdentity,
  maxStariDnu: number,
): Promise<WebFindingRow[]> {
  if (getPool() === null || !Number.isFinite(maxStariDnu) || maxStariDnu < 0) return [];
  const katalog = normalizeFindingIdentity(identity.katalogove_cislo);
  const vyrobce = normalizeFindingIdentity(identity.vyrobce);
  const model = normalizeFindingIdentity(identity.model);
  const nazev = normalizeFindingIdentity(identity.nazev_polozky);
  if (!katalog && !(vyrobce && model) && !nazev) return [];
  const normalizedSql = (column: string) =>
    `LOWER(TRANSLATE(BTRIM(${column}), 'áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ', 'acdeeinorstuuyzACDEEINORSTUUYZ'))`;

  let condition: string;
  let params: unknown[];
  if (katalog) {
    condition = `${normalizedSql('katalogove_cislo')} = $1`;
    params = [katalog, maxStariDnu];
  } else if (vyrobce && model) {
    condition = `${normalizedSql('vyrobce')} = $1 AND ${normalizedSql('model')} = $2`;
    params = [vyrobce, model, maxStariDnu];
  } else {
    condition = `${normalizedSql('polozka_nazev')} = $1`;
    params = [nazev, maxStariDnu];
  }
  const ageParam = params.length;
  try {
    const result = await query<WebFindingRow>(
      `SELECT ${FINDING_COLUMNS}
       FROM warehouse_web_findings
       WHERE ${condition}
         AND found_at >= NOW() - ($${ageParam}::double precision * INTERVAL '1 day')
       ORDER BY cena_s_dph NULLS LAST, cena_bez_dph NULLS LAST, found_at DESC
       LIMIT 3`,
      params,
    );
    return result.rows;
  } catch {
    // Chybějící DB nebo migrace nesmí zablokovat placenou cestu.
    return [];
  }
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
