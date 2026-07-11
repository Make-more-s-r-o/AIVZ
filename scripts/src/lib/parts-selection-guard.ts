import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProductMatch } from './types.js';

export const PARTS_SELECTION_CHANGED_MESSAGE =
  'Výběr částí se změnil od posledního nacenění — spusťte znovu krok Produkty.';

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Načte aktuální výběr částí; chybějící soubor znamená null = všechny části. */
export async function readPartsSelectionSnapshot(outputDir: string): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await readFile(join(outputDir, 'parts-selection.json'), 'utf-8'));
    if (!Array.isArray(parsed?.selected_parts) || !parsed.selected_parts.every((id: unknown) => typeof id === 'string')) {
      throw new Error('parts-selection.json neobsahuje platné pole selected_parts.');
    }
    return parsed.selected_parts;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function normalizedSet(selection: string[] | null, allPartIds: string[]): Set<string> {
  return new Set(selection ?? allPartIds);
}

export function samePartSelection(
  before: string[] | null,
  current: string[] | null,
  allPartIds: string[],
): boolean {
  const left = normalizedSet(before, allPartIds);
  const right = normalizedSet(current, allPartIds);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/** Staré product-match soubory bez snapshotu zůstávají zpětně kompatibilní. */
export function hasPartsSelectionSnapshot(productMatch: ProductMatch): boolean {
  return Object.prototype.hasOwnProperty.call(productMatch, 'selected_parts_snapshot');
}

export function assertPartsSelectionUnchanged(
  productMatch: ProductMatch,
  current: string[] | null,
  allPartIds: string[],
): void {
  if (!hasPartsSelectionSnapshot(productMatch)) return;
  const snapshot = productMatch.selected_parts_snapshot ?? null;
  if (!samePartSelection(snapshot, current, allPartIds)) {
    throw new Error(PARTS_SELECTION_CHANGED_MESSAGE);
  }
}
