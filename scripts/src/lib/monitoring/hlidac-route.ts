import type { Request, Response } from 'express';
import { fetchNewTenders, type HlidacFetchResult } from './hlidac-client.js';

export type MonitoringHlidacFetcher = (query: string) => Promise<HlidacFetchResult>;

/** Factory umožní smoke test se stubem; výsledný Express handler má pouze `(req, res)`. */
export function createMonitoringHlidacHandler(
  fetchHlidac: MonitoringHlidacFetcher = fetchNewTenders,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response): Promise<void> => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(await fetchHlidac(query));
  };
}

/** Samostatný handler usnadňuje smoke test bez spouštění celého Express serveru. */
export const monitoringHlidacHandler = createMonitoringHlidacHandler();
