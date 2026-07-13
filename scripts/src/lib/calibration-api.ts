/** Tenký read-only handler kalibračních dat s injektovatelným store pro testy. */
import type { RequestHandler } from 'express';
import { getCalibrationPairs } from './outcomes-store.js';

export function createCalibrationHandler(
  load: typeof getCalibrationPairs = getCalibrationPairs,
): RequestHandler {
  return async (_req, res) => {
    try {
      res.json(await load());
    } catch {
      res.json([]);
    }
  };
}
