/**
 * Jednorázová migrace cenové provenience v product-match.json souborech pod output/.
 *
 * Bez přepínače je VŽDY pouze dry-run. Zápis je povolen jen explicitním `--apply`:
 *   npx tsx src/tools/migrace-provenience.ts
 *   npx tsx src/tools/migrace-provenience.ts --apply
 *
 * Migrace nikdy nedohledává ani neskládá URL z názvu dodavatele. Legacy modelová
 * cena proto zůstane informační. Na doloženou ji lze povýšit jen z již uloženého,
 * úplného a fingerprintem svázaného záznamu overeni_ceny.zdroje[].
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { candidateFingerprint } from '../lib/candidate-fingerprint.js';
import { PriceProvenanceSchema, isConcreteProductUrl } from '../lib/types.js';

type JsonObject = Record<string, unknown>;

export interface ProvenanceMigrationReport {
  dryRun: boolean;
  souboruCelkem: number;
  souboruZmeneno: number;
  kandidatuCelkem: number;
  legacyKandidatu: number;
  prevedeno: number;
  prevedenoNaOvereny: number;
  zustavaInformacni: number;
  chyba: number;
  preskocenoExistujici: number;
  vyrobenychUrl: 0;
  chyby: string[];
}

export interface ProvenanceMigrationOptions {
  outputDir?: string;
  apply?: boolean;
}

export interface DocumentMigrationResult {
  document: unknown;
  changed: boolean;
  report: Pick<ProvenanceMigrationReport,
    'kandidatuCelkem' | 'legacyKandidatu' | 'prevedeno' | 'prevedenoNaOvereny'
    | 'zustavaInformacni' | 'chyba' | 'preskocenoExistujici' | 'vyrobenychUrl' | 'chyby'>;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function positiveNumber(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function validDateTime(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function selectedIndex(container: JsonObject, candidates: unknown[]): number {
  const value = finiteNumber(container.vybrany_index);
  return value !== null && Number.isInteger(value) && value >= 0 && value < candidates.length
    ? value
    : 0;
}

function vatRate(net: number, gross: number, explicit?: unknown): number {
  const supplied = finiteNumber(explicit);
  if (supplied !== null && supplied >= 0 && supplied <= 100) return supplied;
  if (net > 0 && gross >= net) {
    const inferred = Number((((gross / net) - 1) * 100).toFixed(2));
    if (inferred >= 0 && inferred <= 100) return inferred;
  }
  return 21;
}

function fingerprintFor(candidate: JsonObject, index: number): string | null {
  if (typeof candidate.vyrobce !== 'string' || typeof candidate.model !== 'string') return null;
  return candidateFingerprint({ vyrobce: candidate.vyrobce, model: candidate.model }, index);
}

/** Najde pouze již existující, úplný doklad pro právě vybraného kandidáta. */
function verifiedLegacyProvenance(
  candidate: JsonObject,
  index: number,
  verificationValue: unknown,
): unknown | null {
  const verification = object(verificationValue);
  const fingerprint = fingerprintFor(candidate, index);
  if (!verification || !fingerprint || verification.kandidat_fingerprint !== fingerprint) return null;
  if (verification.stav !== 'nalezeno' && verification.stav !== 'ekvivalent') return null;
  if (!validDateTime(verification.overeno_at) || !Array.isArray(verification.zdroje)) return null;

  for (const sourceValue of verification.zdroje) {
    const source = object(sourceValue);
    if (!source || source.orientacni === true || typeof source.url !== 'string') continue;
    if (!isConcreteProductUrl(source.url)) continue;
    const net = positiveNumber(source.cena_bez_dph);
    const gross = positiveNumber(source.cena_baleni_s_dph) ?? positiveNumber(source.cena_s_dph);
    const rate = positiveNumber(source.sazba_dph);
    const packageSize = positiveNumber(source.baleni_ks);
    if (
      net === null || gross === null || rate === null || packageSize === null
      || !Number.isInteger(packageSize)
      || (source.mena !== undefined && source.mena !== 'CZK')
    ) continue;

    const provenance = {
      verze: 1 as const,
      typ: 'overeny_eshop' as const,
      stav: 'dolozena' as const,
      url: source.url,
      zjisteno_at: verification.overeno_at,
      cena_v_okamziku: {
        bez_dph: net,
        s_dph: gross,
        mena: 'CZK' as const,
        sazba_dph: rate,
        baleni_ks: packageSize,
      },
      zjistil: {
        typ: 'web_agent' as const,
        id: 'legacy-overeni-ceny',
      },
      ...(typeof source.dodavatel === 'string' && source.dodavatel.trim()
        ? { dodavatel: source.dodavatel.trim() }
        : {}),
      kandidat_fingerprint: fingerprint,
      ...(typeof candidate.zdroj_ceny === 'string' && candidate.zdroj_ceny.trim()
        ? { poznamka: candidate.zdroj_ceny }
        : {}),
    };
    const parsed = PriceProvenanceSchema.safeParse(provenance);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function informationalLegacyProvenance(
  candidate: JsonObject,
  index: number,
  matchedAt: unknown,
): unknown {
  const fingerprint = fingerprintFor(candidate, index);
  const net = finiteNumber(candidate.cena_bez_dph);
  const gross = finiteNumber(candidate.cena_s_dph);
  if (!fingerprint) throw new Error('kandidát nemá textového výrobce a model');
  if (net === null || gross === null) throw new Error('kandidát nemá číselnou cenu bez DPH a s DPH');
  if (!validDateTime(matchedAt)) throw new Error('product-match nemá platný matchedAt');

  return PriceProvenanceSchema.parse({
    verze: 1,
    typ: 'odhad_modelu',
    stav: 'informacni',
    // Záměrné null: jméno dodavatele ani starý search link nejsou cenový doklad.
    url: null,
    zjisteno_at: matchedAt,
    cena_v_okamziku: {
      bez_dph: net,
      s_dph: gross,
      mena: 'CZK',
      sazba_dph: vatRate(net, gross),
      baleni_ks: 1,
    },
    zjistil: {
      typ: 'model',
      id: 'legacy-migration',
      model: 'legacy-unknown',
    },
    kandidat_fingerprint: fingerprint,
    ...(typeof candidate.zdroj_ceny === 'string' && candidate.zdroj_ceny.trim()
      ? { poznamka: candidate.zdroj_ceny }
      : {}),
  });
}

function emptyDocumentReport(): DocumentMigrationResult['report'] {
  return {
    kandidatuCelkem: 0,
    legacyKandidatu: 0,
    prevedeno: 0,
    prevedenoNaOvereny: 0,
    zustavaInformacni: 0,
    chyba: 0,
    preskocenoExistujici: 0,
    vyrobenychUrl: 0,
    chyby: [],
  };
}

/**
 * Čistá migrace jednoho dokumentu. Vstup nemutuje, aby dry-run mohl garantovat nulový zápis
 * a testy mohly porovnat původní obsah byte-for-byte.
 */
export function migrateProductMatchDocument(input: unknown): DocumentMigrationResult {
  const document = structuredClone(input);
  const root = object(document);
  const report = emptyDocumentReport();
  if (!root) {
    report.chyba += 1;
    report.chyby.push('kořen product-match.json není objekt');
    return { document, changed: false, report };
  }

  const containers: Array<{ value: JsonObject; label: string }> = [];
  if (Array.isArray(root.polozky_match)) {
    root.polozky_match.forEach((value, position) => {
      const item = object(value);
      if (item) containers.push({ value: item, label: `polozky_match[${position}]` });
    });
  } else if (Array.isArray(root.kandidati)) {
    containers.push({ value: root, label: 'root' });
  }

  let changed = false;
  for (const { value: container, label } of containers) {
    if (!Array.isArray(container.kandidati)) continue;
    const selected = selectedIndex(container, container.kandidati);
    container.kandidati.forEach((candidateValue, index) => {
      report.kandidatuCelkem += 1;
      const candidate = object(candidateValue);
      if (!candidate) {
        report.chyba += 1;
        report.chyby.push(`${label}.kandidati[${index}]: kandidát není objekt`);
        return;
      }
      if (candidate.price_provenance !== undefined) {
        report.preskocenoExistujici += 1;
        return;
      }
      report.legacyKandidatu += 1;

      try {
        const verified = index === selected
          ? verifiedLegacyProvenance(candidate, index, container.overeni_ceny)
          : null;
        candidate.price_provenance = verified
          ?? informationalLegacyProvenance(candidate, index, root.matchedAt);
        report.prevedeno += 1;
        if (verified) report.prevedenoNaOvereny += 1;
        else report.zustavaInformacni += 1;
        changed = true;
      } catch (error) {
        report.chyba += 1;
        report.chyby.push(
          `${label}.kandidati[${index}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  }

  return { document, changed, report };
}

function addDocumentReport(target: ProvenanceMigrationReport, source: DocumentMigrationResult['report']): void {
  target.kandidatuCelkem += source.kandidatuCelkem;
  target.legacyKandidatu += source.legacyKandidatu;
  target.prevedeno += source.prevedeno;
  target.prevedenoNaOvereny += source.prevedenoNaOvereny;
  target.zustavaInformacni += source.zustavaInformacni;
  target.chyba += source.chyba;
  target.preskocenoExistujici += source.preskocenoExistujici;
  target.chyby.push(...source.chyby);
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Projde korpus; bez options.apply=true nikdy nezapisuje. */
export async function migratePriceProvenance(
  options: ProvenanceMigrationOptions = {},
): Promise<ProvenanceMigrationReport> {
  const outputDir = options.outputDir
    ?? join(fileURLToPath(new URL('../../../', import.meta.url)), 'output');
  const apply = options.apply === true;
  const report: ProvenanceMigrationReport = {
    dryRun: !apply,
    souboruCelkem: 0,
    souboruZmeneno: 0,
    kandidatuCelkem: 0,
    legacyKandidatu: 0,
    prevedeno: 0,
    prevedenoNaOvereny: 0,
    zustavaInformacni: 0,
    chyba: 0,
    preskocenoExistujici: 0,
    vyrobenychUrl: 0,
    chyby: [],
  };

  const entries = await readdir(outputDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'cs'))) {
    if (!entry.isDirectory()) continue;
    const path = join(outputDir, entry.name, 'product-match.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      report.souboruCelkem += 1;
      report.chyba += 1;
      report.chyby.push(`${entry.name}/product-match.json: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    report.souboruCelkem += 1;
    const migrated = migrateProductMatchDocument(parsed);
    addDocumentReport(report, migrated.report);
    if (!migrated.changed) continue;
    report.souboruZmeneno += 1;
    if (apply) await writeJsonAtomically(path, migrated.document);
  }

  return report;
}

export function migrationApplies(argv: string[]): boolean {
  return argv.includes('--apply');
}

async function main(): Promise<void> {
  const apply = migrationApplies(process.argv.slice(2));
  const outputArg = process.argv.slice(2).find((arg) => arg.startsWith('--output-dir='));
  const outputDir = outputArg?.slice('--output-dir='.length);
  const report = await migratePriceProvenance({ outputDir, apply });
  console.log(apply ? 'REŽIM: APPLY' : 'REŽIM: DRY-RUN (bez zápisu; pro ostrý běh použijte --apply)');
  console.log(JSON.stringify(report, null, 2));
  if (report.chyba > 0) process.exitCode = 1;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
