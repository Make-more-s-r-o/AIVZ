/**
 * Doménové váhy go/no-go skóre. Konfigurace je oddělená od provozních
 * governance kill-switchů a při jakékoli chybě bezpečně použije původní váhy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../../', import.meta.url).pathname;

export const GO_NO_GO_CONFIG_PATH = join(ROOT, 'config', 'go-no-go.json');

export const GO_NO_GO_WEIGHT_NAMES = [
  'sector',
  'budget',
  'priced_items',
  'win_price',
  'deadline',
] as const;

export type GoNoGoWeightName = typeof GO_NO_GO_WEIGHT_NAMES[number];
export type GoNoGoWeights = Readonly<Record<GoNoGoWeightName, number>>;

export const DEFAULT_GO_NO_GO_WEIGHTS: GoNoGoWeights = Object.freeze({
  sector: 20,
  budget: 20,
  priced_items: 25,
  win_price: 20,
  deadline: 15,
});

type Warn = (message: string) => void;

/** Validuje každou váhu samostatně; chybná hodnota neovlivní ostatní váhy. */
export function resolveGoNoGoWeights(input: unknown, warn: Warn = console.warn): GoNoGoWeights {
  const configured = input && typeof input === 'object'
    ? (input as { weights?: unknown }).weights
    : undefined;
  const weights = configured && typeof configured === 'object'
    ? configured as Record<string, unknown>
    : {};

  return Object.freeze(Object.fromEntries(GO_NO_GO_WEIGHT_NAMES.map((name) => {
    const value = weights[name];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return [name, value];
    }
    warn(`[go-no-go] Neplatná váha "${name}"; používám výchozí hodnotu ${DEFAULT_GO_NO_GO_WEIGHTS[name]}.`);
    return [name, DEFAULT_GO_NO_GO_WEIGHTS[name]];
  })) as Record<GoNoGoWeightName, number>);
}

/** Načtení configu nikdy neshodí scoring; nečitelný JSON znamená kompletní fallback. */
export function loadGoNoGoWeights(
  path = GO_NO_GO_CONFIG_PATH,
  warn: Warn = console.warn,
): GoNoGoWeights {
  try {
    return resolveGoNoGoWeights(JSON.parse(readFileSync(path, 'utf-8')), warn);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`[go-no-go] Konfiguraci vah nelze načíst (${detail}); používám výchozí váhy.`);
    return DEFAULT_GO_NO_GO_WEIGHTS;
  }
}

/** Aktivní instance-wide váhy; po ruční změně souboru je potřeba restart procesu. */
export const GO_NO_GO_WEIGHTS = loadGoNoGoWeights();
