/**
 * Submission cockpit — čistá, testovatelná logika balíku podání a evidence.
 *
 * Motivace (oponentní nález): dřívější `finalize` překlopil zakázku rovnou na 'odeslana'
 * bez jakéhokoli důkazu, že podání proběhlo → falešně zelený stav. Nově se rozdělí na:
 *   1) finalize = vytvoří IMMUTABILNÍ balík (ZIP + manifest se sha256) a přepne na 'pripravena',
 *   2) /podano = teprve zápis evidence (portál, čas, evidenční číslo) přepne na 'odeslana'.
 *
 * Tento modul drží jen deterministické výpočty (hash, verzování, cena, validace evidence)
 * bez fs/archiveru — zápis souborů a ZIP dělá endpoint. Díky tomu jde vše otestovat nad
 * prostými objekty a bufery.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface ManifestFileEntry {
  name: string;
  sha256: string;
  size: number;
}

export interface SubmissionManifest {
  version: number;
  /** Deterministický otisk OBSAHU balíku (jen názvy + sha souborů) — nezávislý na čase. */
  content_hash: string;
  /** ISO čas vytvoření balíku. */
  created_at: string;
  /** Název ZIP souboru v adresáři podani/ (verzovaný, immutable). */
  zip_filename: string;
  files: ManifestFileEntry[];
  celkova_cena_s_dph: number | null;
  /** Vybrané části vícečástové zakázky (null = jednočástová). */
  vybrane_casti: string[] | null;
}

/** sha256 hex bufferu nebo stringu. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministický otisk obsahu balíku: seřadí soubory podle jména a zahashuje
 * kanonický řetězec `name:sha\n`. Stejné soubory (bez ohledu na pořadí čtení a čas)
 * → stejný hash. Základ immutability a verzování.
 */
export function computeContentHash(files: Array<{ name: string; sha256: string }>): string {
  const canonical = [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => `${f.name}:${f.sha256}`)
    .join('\n');
  return sha256Hex(canonical);
}

/**
 * Rozhodne verzi balíku a zda lze recyklovat existující.
 * - Beze změny obsahu (shodný content_hash) → recyklace existujícího balíku (reused=true),
 *   žádný nový ZIP, žádná nová verze — balík je immutable.
 * - Při změně obsahu → nová verze (previous.version + 1) a nový ZIP `podani-v{N}.zip`.
 */
export function buildManifest(input: {
  files: ManifestFileEntry[];
  celkovaCena: number | null;
  vybraneCasti: string[] | null;
  previous: SubmissionManifest | null;
  createdAt: string;
}): { manifest: SubmissionManifest; reused: boolean } {
  const contentHash = computeContentHash(input.files);

  if (input.previous && input.previous.content_hash === contentHash) {
    return { manifest: input.previous, reused: true };
  }

  const version = (input.previous?.version ?? 0) + 1;
  const manifest: SubmissionManifest = {
    version,
    content_hash: contentHash,
    created_at: input.createdAt,
    zip_filename: `podani-v${version}.zip`,
    // Soubory řadíme deterministicky, ať manifest.json vypadá stejně napříč běhy.
    files: [...input.files].sort((a, b) => a.name.localeCompare(b.name)),
    celkova_cena_s_dph: input.celkovaCena,
    vybrane_casti: input.vybraneCasti,
  };
  return { manifest, reused: false };
}

/** Nejlepší nabídková cena s DPH za kus položky (potvrzená úprava → kandidát). */
function itemUnitPriceSDph(item: Record<string, any>): number | null {
  const upravaCena = item?.cenova_uprava?.nabidkova_cena_s_dph;
  if (typeof upravaCena === 'number' && Number.isFinite(upravaCena)) return upravaCena;
  const vybrany = item?.kandidati?.[item?.vybrany_index];
  const kandidatCena = vybrany?.cena_s_dph;
  if (typeof kandidatCena === 'number' && Number.isFinite(kandidatCena)) return kandidatCena;
  return null;
}

/**
 * Celková nabídková cena s DPH z product-match dat. Respektuje výběr částí:
 * u vícečástové zakázky se sečtou jen položky vybraných částí. `null` = žádná cena.
 */
export function celkovaCenaZMatch(productMatch: unknown, selectedParts: string[] | null): number | null {
  const match = productMatch && typeof productMatch === 'object' ? (productMatch as Record<string, any>) : null;
  if (!match) return null;
  const selected = selectedParts && selectedParts.length > 0 ? new Set(selectedParts) : null;

  const items: Record<string, any>[] = Array.isArray(match.polozky_match) ? match.polozky_match : [];
  let total = 0;
  let maCenu = false;

  if (items.length > 0) {
    for (const item of items) {
      const castId = item?.cast_id;
      if (selected && castId && !selected.has(castId)) continue;
      const unit = itemUnitPriceSDph(item);
      if (unit == null) continue;
      const mnozstvi = typeof item?.mnozstvi === 'number' && Number.isFinite(item.mnozstvi) ? item.mnozstvi : 1;
      total += unit * mnozstvi;
      maCenu = true;
    }
  } else {
    // Legacy single-product tvar.
    const unit = itemUnitPriceSDph(match);
    if (unit != null) {
      total += unit;
      maCenu = true;
    }
  }

  return maCenu ? Math.round(total) : null;
}

/** Vstupní schéma evidence podání (POST /podano). */
export const evidenceInputSchema = z.object({
  portal: z.string().trim().min(1, 'portal je povinný'),
  cas_podani: z.string().datetime({ offset: true }),
  evidencni_cislo: z.string().trim().min(1).optional(),
  poznamka: z.string().trim().min(1).optional(),
});

export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export interface Evidence extends EvidenceInput {
  /** Serverový čas zápisu evidence (kdy operátor podání zaznamenal v aplikaci). */
  zaznamenano: string;
  /** Vazba na konkrétní immutable balík, který byl podán. */
  manifest_version: number;
  manifest_content_hash: string;
}

/** Sestaví záznam evidence z validovaného vstupu a manifestu podaného balíku. */
export function buildEvidence(input: EvidenceInput, manifest: SubmissionManifest, zaznamenano: string): Evidence {
  return {
    ...input,
    zaznamenano,
    manifest_version: manifest.version,
    manifest_content_hash: manifest.content_hash,
  };
}

/**
 * Idempotence POST /podano: serverové `zaznamenano` se neporovnává, ale uživatelská
 * klíčová pole a vazba na immutable manifest musejí být shodné.
 */
export function evidenceMatchesSubmission(
  existing: Record<string, unknown> | null,
  input: EvidenceInput,
  manifest: SubmissionManifest,
): boolean {
  if (!existing) return false;
  return existing.portal === input.portal
    && existing.cas_podani === input.cas_podani
    && (existing.evidencni_cislo ?? undefined) === input.evidencni_cislo
    && (existing.poznamka ?? undefined) === input.poznamka
    && existing.manifest_version === manifest.version
    && existing.manifest_content_hash === manifest.content_hash;
}

export const ALREADY_SUBMITTED_FINALIZE_MESSAGE =
  'Nabídka už byla podána — nový balík nelze připravit. Pro novou verzi použij novou zakázku/revizi.';

/** Čistý H2 guard před finalizací; null znamená, že lze pokračovat submit-gatem. */
export function finalizeEvidenceConflict(evidenceExists: boolean): string | null {
  return evidenceExists ? ALREADY_SUBMITTED_FINALIZE_MESSAGE : null;
}

export type SubmissionRecordDecision =
  | 'create'
  | 'idempotent'
  | 'different_evidence'
  | 'illegal_stage';

/** One-way rozhodnutí POST /podano bez závislosti na Expressu nebo DB. */
export function decideSubmissionRecord(currentStage: string, sameEvidence: boolean): SubmissionRecordDecision {
  if (currentStage === 'pripravena') return 'create';
  if (currentStage === 'odeslana') return sameEvidence ? 'idempotent' : 'different_evidence';
  return 'illegal_stage';
}

export interface EvidencePersistenceResult {
  ok: boolean;
  writeError?: unknown;
  compensationError?: unknown;
}

/**
 * Vynutí pořadí DB → evidence.json. Když druhý krok selže, provede best-effort
 * kompenzaci DB zpět na Připravená a vrátí obě případné chyby volajícímu.
 */
export async function persistEvidenceAfterStatus(deps: {
  setSubmitted: () => Promise<unknown>;
  writeEvidence: () => Promise<unknown>;
  restorePrepared: () => Promise<unknown>;
}): Promise<EvidencePersistenceResult> {
  await deps.setSubmitted();
  try {
    await deps.writeEvidence();
    return { ok: true };
  } catch (writeError) {
    try {
      await deps.restorePrepared();
      return { ok: false, writeError };
    } catch (compensationError) {
      return { ok: false, writeError, compensationError };
    }
  }
}
