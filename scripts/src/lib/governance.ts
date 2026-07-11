/**
 * Instance-wide governance a kill-switch. Konfigurace je záměrně v souboru,
 * aby stopky fungovaly i při výpadku databáze.
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { z } from 'zod';

const ROOT = new URL('../../../', import.meta.url).pathname;
export const GOVERNANCE_PATH = join(ROOT, 'config', 'governance.json');
const CACHE_TTL_MS = 5_000;

const switches = {
  ingest_enabled: z.boolean(),
  ai_jobs_enabled: z.boolean(),
  generate_enabled: z.boolean(),
  finalize_enabled: z.boolean(),
  submission_enabled: z.boolean(),
};

export const GovernanceSchema = z.object({
  ...switches,
  denni_ai_limit_czk: z.number().finite().nonnegative().nullable(),
  poznamka: z.string().trim().max(2_000).nullable(),
  zmeneno_at: z.string().datetime().nullable(),
  zmeneno_kym: z.string().trim().min(1).nullable(),
}).strict();

// Výchozí hodnoty jsou zároveň bezpečný fallback pro první spuštění bez souboru.
export const DEFAULT_GOVERNANCE: Readonly<Governance> = Object.freeze({
  ingest_enabled: true,
  ai_jobs_enabled: true,
  generate_enabled: true,
  finalize_enabled: true,
  submission_enabled: true,
  denni_ai_limit_czk: 2_000,
  poznamka: null,
  zmeneno_at: null,
  zmeneno_kym: null,
});

export const GovernancePatchSchema = z.object({
  ...Object.fromEntries(Object.entries(switches).map(([key, schema]) => [key, schema.optional()])),
  denni_ai_limit_czk: z.number().finite().nonnegative().nullable().optional(),
  poznamka: z.string().trim().max(2_000).nullable().optional(),
});

export type Governance = z.infer<typeof GovernanceSchema>;
export type GovernancePatch = z.infer<typeof GovernancePatchSchema>;
export type GovernanceSwitch = keyof typeof switches;

let cache: { path: string; value: Governance; expiresAt: number } | null = null;

function freshDefault(): Governance {
  return { ...DEFAULT_GOVERNANCE };
}

/** Načte konfiguraci s krátkou cache; chybějící soubor nesmí vyřadit kill-switch API. */
export async function getGovernance(path = GOVERNANCE_PATH): Promise<Governance> {
  if (cache?.path === path && cache.expiresAt > Date.now()) return { ...cache.value };
  let value: Governance;
  try {
    value = GovernanceSchema.parse(JSON.parse(await readFile(path, 'utf-8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    value = freshDefault();
  }
  cache = { path, value, expiresAt: Date.now() + CACHE_TTL_MS };
  return { ...value };
}

/** Validuje pouze klientem měnitelná pole a serverově doplní identitu a čas. */
export async function setGovernance(
  input: unknown,
  identity: string,
  path = GOVERNANCE_PATH,
): Promise<Governance> {
  const patch = GovernancePatchSchema.parse(input);
  const current = await getGovernance(path);
  const value = GovernanceSchema.parse({
    ...current,
    ...patch,
    zmeneno_at: new Date().toISOString(),
    zmeneno_kym: identity,
  });
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  await rename(tempPath, path);
  cache = { path, value, expiresAt: Date.now() + CACHE_TTL_MS };
  return { ...value };
}

const SWITCH_LABELS: Record<GovernanceSwitch, string> = {
  ingest_enabled: 'Příjem a převzetí zakázek',
  ai_jobs_enabled: 'AI joby',
  generate_enabled: 'Generování',
  finalize_enabled: 'Finalizace',
  submission_enabled: 'Evidence podání',
};

/** Čistý guard přepínače; null znamená průchod. */
export function governanceSwitchBlock(config: Governance, key: GovernanceSwitch): string | null {
  return config[key] ? null : `${SWITCH_LABELS[key]} jsou vypnuté (governance: ${key}).`;
}

/** Čistý guard denního limitu; rovnost s limitem již blokuje další placenou práci. */
export function dailyAiLimitBlock(config: Governance, todayCzk: number): string | null {
  const limit = config.denni_ai_limit_czk;
  if (limit == null || todayCzk < limit) return null;
  return `Dosažen denní limit AI nákladů (${todayCzk}/${limit} Kč). Zvyšte limit v Governance nebo počkejte do zítřka.`;
}

export function isGovernanceRestricted(config: Governance): boolean {
  return (Object.keys(switches) as GovernanceSwitch[]).some((key) => !config[key]);
}
