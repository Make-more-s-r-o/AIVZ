import type { Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';

import {
  ApplyMarketPricesBodySchema,
  MultiItemProductMatchRequiredError,
  UnknownMarketPriceItemError,
  applyMarketPrices,
} from './market-price-application.js';
import type { ProductMatch } from './types.js';

export interface MarketPriceApiDeps {
  loadProductMatch: (tenderId: string) => Promise<ProductMatch>;
  saveProductMatch: (tenderId: string, productMatch: ProductMatch) => Promise<void>;
  resolveDefaultMargin: (tenderId: string) => Promise<number>;
  now?: () => string;
}

/** Handler je oddělený kvůli testu endpointového kontraktu bez startování API serveru. */
export function createApplyMarketPricesHandler(deps: MarketPriceApiDeps): RequestHandler {
  return async (request: Request, response: Response) => {
    try {
      const body = ApplyMarketPricesBodySchema.parse(request.body ?? {});
      const tenderId = String(request.params.id);
      const defaultMargin = await deps.resolveDefaultMargin(tenderId);
      // Soubor čti až po získání defaultu, aby okno pro souběžnou ruční změnu ceny
      // mezi načtením a atomickým zápisem bylo co nejkratší.
      const productMatch = await deps.loadProductMatch(tenderId);
      const result = applyMarketPrices(productMatch, defaultMargin, body.polozka_indexy);
      (productMatch as ProductMatch & { prices_updated_at?: string }).prices_updated_at =
        deps.now?.() ?? new Date().toISOString();
      await deps.saveProductMatch(tenderId, productMatch);
      response.json({ success: true, ...result });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        response.status(404).json({ error: 'product-match.json not found — run match step first' });
        return;
      }
      if (error instanceof ZodError
        || error instanceof UnknownMarketPriceItemError
        || error instanceof MultiItemProductMatchRequiredError) {
        response.status(400).json({ error: error.message });
        return;
      }
      response.status(500).json({ error: `Reálné ceny se nepodařilo použít: ${error instanceof Error ? error.message : String(error)}` });
    }
  };
}
