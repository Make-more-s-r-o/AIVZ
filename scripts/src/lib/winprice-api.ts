import type { Request, RequestHandler, Response } from 'express';

import {
  findSimilarWins,
  getWinPriceStats,
  priceBandForSubject,
  type PriceBand,
  type SimilarWin,
  type WinPriceStats,
} from './winprice-query.js';
import type { KomoditaKategorie } from './winprice-store.js';

const WIN_PRICE_CATEGORIES = new Set<KomoditaKategorie>([
  'it_av',
  'naradi_dilna',
  'kancelar',
  'ostatni',
]);

export interface WinPriceSample {
  predmet: string;
  cena_bez_dph: number;
  dodavatel_nazev: string | null;
  datum: string | null;
  url: string | null;
}

export interface WinPriceBandResponse {
  n: number;
  median_bez_dph?: number;
  p25?: number;
  p75?: number;
  min?: number;
  max?: number;
  samples?: WinPriceSample[];
}

interface WinPriceDependencies {
  priceBandForSubject: (predmet: string, options?: { kategorie?: KomoditaKategorie }) => Promise<PriceBand>;
  findSimilarWins: (
    predmet: string,
    options?: { kategorie?: KomoditaKategorie; limit?: number },
  ) => Promise<SimilarWin[]>;
  getWinPriceStats: () => Promise<WinPriceStats>;
}

const defaultDependencies: WinPriceDependencies = {
  priceBandForSubject,
  findSimilarWins,
  getWinPriceStats,
};

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyBand(res: Response): Response {
  return res.status(200).json({ n: 0 });
}

/** Handler je exportovaný samostatně, aby šel kontrakt ověřit bez spuštění serveru. */
export function createWinPriceBandHandler(
  dependencies: WinPriceDependencies = defaultDependencies,
): RequestHandler {
  return async (req: Request, res: Response) => {
    const subject = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!subject) return res.status(400).json({ error: 'Query parameter q is required' });

    const categoryRaw = typeof req.query.kategorie === 'string' ? req.query.kategorie : undefined;
    if (categoryRaw && !WIN_PRICE_CATEGORIES.has(categoryRaw as KomoditaKategorie)) {
      return res.status(400).json({ error: 'Invalid kategorie' });
    }
    const options = categoryRaw ? { kategorie: categoryRaw as KomoditaKategorie } : {};

    try {
      const [band, wins] = await Promise.all([
        dependencies.priceBandForSubject(subject, options),
        dependencies.findSimilarWins(subject, { ...options, limit: 20 }),
      ]);
      const median = optionalNumber(band.median);
      const p25 = optionalNumber(band.p25);
      const p75 = optionalNumber(band.p75);
      const min = optionalNumber(band.min);
      const max = optionalNumber(band.max);
      const n = optionalNumber(band.pocet) ?? 0;
      if (n <= 0 || median === undefined || p25 === undefined || p75 === undefined || min === undefined || max === undefined) {
        return emptyBand(res);
      }

      const samples = wins
        .map((win): WinPriceSample | null => {
          const price = optionalNumber(win.cena_bez_dph);
          if (price === undefined || price <= 0) return null;
          return {
            predmet: win.predmet,
            cena_bez_dph: price,
            dodavatel_nazev: win.dodavatel_nazev,
            datum: win.datum,
            url: win.url,
          };
        })
        .filter((sample): sample is WinPriceSample => sample !== null)
        .slice(0, 5);

      return res.status(200).json({
        n,
        median_bez_dph: median,
        p25,
        p75,
        min,
        max,
        samples,
      } satisfies WinPriceBandResponse);
    } catch {
      // Bez DB, bez migrace nebo při dočasném výpadku zůstává informační vrstva prázdná.
      return emptyBand(res);
    }
  };
}

/** Statistiky rovněž degradují na prázdný stav, aby výpadek DB neshodil Ocenění. */
export function createWinPriceStatsHandler(
  dependencies: Pick<WinPriceDependencies, 'getWinPriceStats'> = defaultDependencies,
): RequestHandler {
  return async (_req: Request, res: Response) => {
    try {
      const stats = await dependencies.getWinPriceStats();
      return res.status(200).json({
        count: optionalNumber(stats.count) ?? 0,
        last_date: stats.last_date ?? null,
      });
    } catch {
      return res.status(200).json({ count: 0, last_date: null });
    }
  };
}

export const winPriceBandHandler = createWinPriceBandHandler();
export const winPriceStatsHandler = createWinPriceStatsHandler();
