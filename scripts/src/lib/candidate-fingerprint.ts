import type { ProductCandidate } from './types.js';

/** Stabilní identita vybraného kandidáta používaná při dlouhém webovém ověřování. */
export function candidateFingerprint(
  candidate: Pick<ProductCandidate, 'vyrobce' | 'model'>,
  selectedIndex: number,
): string {
  return `${candidate.vyrobce.trim()}|${candidate.model.trim()}|${selectedIndex}`;
}
