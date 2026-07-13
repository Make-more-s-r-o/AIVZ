import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MONITORING_CONFIG,
  MonitoringConfigSchema,
  getMonitoringConfig,
  resolveMonitoringPipelineStart,
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
    auto_spustit_pipeline: false,
  };
  try {
    assert.deepEqual(await saveMonitoringConfig(input, path), input);
    assert.deepEqual(await getMonitoringConfig(path), input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('monitoring config odmítne neznámou kategorii a obrácený rozsah', () => {
  const base = { kategorie_zajmu: [], klicova_slova: [], vyloucena_slova: [], min_hodnota: null, max_hodnota: null, auto_spustit_pipeline: true };
  assert.equal(MonitoringConfigSchema.safeParse({ ...base, kategorie_zajmu: ['neexistuje'] }).success, false);
  assert.equal(MonitoringConfigSchema.safeParse({ ...base, min_hodnota: 10, max_hodnota: 5 }).success, false);
});

test('monitoring config doplní auto-spuštění jako zapnuté i starému souboru', () => {
  const parsed = MonitoringConfigSchema.parse({
    kategorie_zajmu: [], klicova_slova: [], vyloucena_slova: [], min_hodnota: null, max_hodnota: null,
  });
  assert.equal(parsed.auto_spustit_pipeline, true);
});

test('explicitní spustit=false přebije zapnuté auto-spuštění v konfiguraci', () => {
  assert.equal(resolveMonitoringPipelineStart({ spustit: false }, DEFAULT_MONITORING_CONFIG), false);
  assert.equal(resolveMonitoringPipelineStart({}, DEFAULT_MONITORING_CONFIG), true);
});
