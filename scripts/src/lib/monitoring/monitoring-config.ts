/**
 * Per-instance nastavení monitoringu. Soubor žije v config volume vedle company.json,
 * ale není svázaný s konkrétní firmou.
 */
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { z } from 'zod';
import { KOMODITA_KATEGORIE_VALUES } from '../winprice-store.js';

const ROOT = new URL('../../../../', import.meta.url).pathname;
export const MONITORING_CONFIG_PATH = join(ROOT, 'config', 'monitoring.json');

const categorySchema = z.enum(KOMODITA_KATEGORIE_VALUES as [string, ...string[]]);

export const MonitoringConfigSchema = z.object({
  kategorie_zajmu: z.array(categorySchema).default([]),
  klicova_slova: z.array(z.string().trim().min(1)).default([]),
  vyloucena_slova: z.array(z.string().trim().min(1)).default([]),
  min_hodnota: z.number().finite().nonnegative().nullable().default(null),
  max_hodnota: z.number().finite().nonnegative().nullable().default(null),
}).strict().superRefine((value, ctx) => {
  if (value.min_hodnota != null && value.max_hodnota != null && value.min_hodnota > value.max_hodnota) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['max_hodnota'],
      message: 'Maximální hodnota nesmí být nižší než minimální.',
    });
  }
});

export type MonitoringConfig = z.infer<typeof MonitoringConfigSchema>;

export const DEFAULT_MONITORING_CONFIG: MonitoringConfig = Object.freeze({
  kategorie_zajmu: [],
  klicova_slova: [],
  vyloucena_slova: [],
  min_hodnota: null,
  max_hodnota: null,
});

/** Načte konfiguraci; chybějící soubor znamená bezpečné výchozí nastavení. */
export async function getMonitoringConfig(path = MONITORING_CONFIG_PATH): Promise<MonitoringConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    return MonitoringConfigSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ...DEFAULT_MONITORING_CONFIG,
        kategorie_zajmu: [],
        klicova_slova: [],
        vyloucena_slova: [],
      };
    }
    throw error;
  }
}

/** Validuje a atomicky uloží konfiguraci, aby po pádu nezůstal napůl zapsaný JSON. */
export async function saveMonitoringConfig(
  input: unknown,
  path = MONITORING_CONFIG_PATH,
): Promise<MonitoringConfig> {
  const config = MonitoringConfigSchema.parse(input);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  await rename(tempPath, path);
  return config;
}
