export interface QueryInvalidator {
  invalidateQueries(options: { queryKey: readonly unknown[] }): Promise<unknown>;
}

/** Všechny cache odvozené od ceny nebo vybraného kandidáta jedné zakázky. */
export const priceDerivedQueryKeys = (tenderId: string): readonly (readonly unknown[])[] => [
  ['product-match', tenderId],
  ['tender-status', tenderId],
  ['bid-score', tenderId],
  ['validation', tenderId],
  ['inbox'],
];

export async function invalidatePriceDerivedQueries(
  queryClient: QueryInvalidator,
  tenderId: string,
): Promise<void> {
  await Promise.all(
    priceDerivedQueryKeys(tenderId).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
