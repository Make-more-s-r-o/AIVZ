import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MONITORING_CONFIG,
  MonitoringConfigSchema,
  getMonitoringConfig,
  saveMonitoringConfig,
} from '../src/lib/monitoring/monitoring-config.js';

test('monitoring config vrátí fallback, když soubor chybí', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-monitoring-config-'));
  try {
    const result = await getMonitoringConfig(join(dir, 'missing.json'));
    assert.deepEqual(result, DEFAULT_MONITORING_CONFIG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitoring config se validuje a uloží do nového adresáře', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-monitoring-config-'));
  const path = join(dir, 'config', 'monitoring.json');
  const input = {
    kategorie_zajmu: ['it_av'],
    klicova_slova: ['notebooky', 'servery'],
    vyloucena_slova: ['pronájem'],
    min_hodnota: 100_000,
    max_hodnota: 5_000_000,
  };
  try {
    assert.deepEqual(await saveMonitoringConfig(input, path), input);
    assert.deepEqual(await getMonitoringConfig(path), input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitoring config odmítne neznámou kategorii a obrácený rozsah', () => {
  const base = { kategorie_zajmu: [], klicova_slova: [], vyloucena_slova: [], min_hodnota: null, max_hodnota: null };
  assert.equal(MonitoringConfigSchema.safeParse({ ...base, kategorie_zajmu: ['neexistuje'] }).success, false);
  assert.equal(MonitoringConfigSchema.safeParse({ ...base, min_hodnota: 10, max_hodnota: 5 }).success, false);
});
