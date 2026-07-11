import { PriceOverrideSchema, type PriceOverride } from './types.js';

export interface ReviewIdentity {
  sub?: string;
  name?: string;
}

/** Auditní údaje jsou výhradně serverové; stejnojmenná pole klienta se zahodí. */
export function validatePriceWrite(
  body: unknown,
  identity: ReviewIdentity | undefined,
  reviewedAt = new Date().toISOString(),
): PriceOverride {
  const input = { ...(body as Record<string, unknown>) };
  delete input.zkontrolovano_at;
  delete input.zkontrolovano_kym;
  if (input.potvrzeno === true) {
    input.zkontrolovano_at = reviewedAt;
    input.zkontrolovano_kym = identity?.name?.trim() || identity?.sub?.trim() || 'lokální operátor';
  }
  return PriceOverrideSchema.parse(input);
}

export interface BulkPriceInput {
  itemIndex?: unknown;
  attestace?: unknown;
  cenova_uprava?: unknown;
}

/** Do potvrzení pustí jen řádky s explicitní attestací operátora. */
export function validateBulkPriceWrites(
  items: BulkPriceInput[],
  identity: ReviewIdentity | undefined,
  reviewedAt = new Date().toISOString(),
): { validated: Array<{ idx: number; cenova_uprava: PriceOverride }>; preskoceno: number[] } {
  const validated: Array<{ idx: number; cenova_uprava: PriceOverride }> = [];
  const preskoceno: number[] = [];
  items.forEach((item, position) => {
    const idx = Number(item?.itemIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(`items[${position}].itemIndex musí být nezáporné celé číslo`);
    }
    if (item.attestace !== true) {
      preskoceno.push(idx);
      return;
    }
    validated.push({ idx, cenova_uprava: validatePriceWrite(item.cenova_uprava, identity, reviewedAt) });
  });
  return { validated, preskoceno };
}

/** Zruší lidské potvrzení, ale zachová rozepsanou cenovou kalkulaci. */
export function invalidatePriceReview(override: PriceOverride | undefined): boolean {
  if (!override) return false;
  const wasReviewed = override.potvrzeno || Boolean(override.zkontrolovano_at || override.zkontrolovano_kym);
  override.potvrzeno = false;
  delete override.zkontrolovano_at;
  delete override.zkontrolovano_kym;
  return wasReviewed;
}

/** Kandidát a jeho cena tvoří jeden celek; po změně produktu starou kalkulaci zahodíme. */
export function clearPriceForProductChange(target: { cenova_uprava?: unknown }): boolean {
  const previous = target.cenova_uprava as Partial<PriceOverride> | undefined;
  const reviewWasInvalidated = previous?.potvrzeno === true
    || Boolean(previous?.zkontrolovano_at || previous?.zkontrolovano_kym);
  delete target.cenova_uprava;
  return reviewWasInvalidated;
}
