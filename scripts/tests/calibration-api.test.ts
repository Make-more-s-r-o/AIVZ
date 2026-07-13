import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalibrationHandler } from '../src/lib/calibration-api.js';

test('kalibrační endpoint vrací poslední feature vektor, když existuje', async () => {
  const featureVector = { typ: 'bid', skore: 78, doporuceni: 'GO', faktory: [{ nazev: 'margin' }] };
  const rows = [{
    tender_id: 'T-1', vysledek: 'vyhra' as const, nase_cena: 100, vitezna_cena: 100,
    odchylka_procent: 0, go_no_go_score: 80, bid_score: 78, winprice_median: 100,
    podil_overenych_cen: 1, snapshot_id: '1', snapshot_at: '2026-07-13T10:00:00Z',
    feature_vector: featureVector,
  }];
  const handler = createCalibrationHandler(async () => rows);
  let body: unknown;
  await handler({} as any, { json: (value: unknown) => { body = value; } } as any, () => undefined);
  assert.deepEqual((body as typeof rows)[0]?.feature_vector, featureVector);
});
