import type { Request, Response } from 'express';
import { fetchNewTenders } from './hlidac-client.js';

/** Samostatný handler usnadňuje smoke test bez spouštění celého Express serveru. */
export async function monitoringHlidacHandler(req: Request, res: Response): Promise<void> {
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  res.json(await fetchNewTenders(query));
}
