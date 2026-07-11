import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reserveMonitoringTender } from '../src/lib/monitoring/tender-allocation.js';

test('atomická alokace stejného názvu vytvoří dvě ID a nic nepřepíše', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vz-monitoring-allocation-'));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  await mkdir(inputDir);
  try {
    const first = await reserveMonitoringTender(inputDir, outputDir, 'stejny-nazev', '101', { source: 'first' });
    const firstMetaPath = join(outputDir, first, 'tender-meta.json');
    const firstMetaBefore = await readFile(firstMetaPath, 'utf-8');

    // Druhé převzetí přichází až poté, co první atomicky vytvořilo svou složku.
    const second = await reserveMonitoringTender(inputDir, outputDir, 'stejny-nazev', '202', { source: 'second' });
    assert.notEqual(second, first);
    assert.equal(first, 'stejny-nazev');
    assert.equal(second, 'stejny-nazev-202');
    assert.equal(await readFile(firstMetaPath, 'utf-8'), firstMetaBefore);
    assert.deepEqual(JSON.parse(await readFile(join(outputDir, second, 'tender-meta.json'), 'utf-8')), { source: 'second' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existující cizí tender-meta.json v outputu se nepřepíše', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vz-monitoring-foreign-meta-'));
  const inputDir = join(root, 'input');
  const outputDir = join(root, 'output');
  await mkdir(inputDir);
  await mkdir(join(outputDir, 'kolize'), { recursive: true });
  await mkdir(join(inputDir, 'kolize-55'));
  const foreignMeta = join(outputDir, 'kolize', 'tender-meta.json');
  await writeFile(foreignMeta, '{"owner":"foreign"}', 'utf-8');
  try {
    const allocated = await reserveMonitoringTender(inputDir, outputDir, 'kolize', '55', { owner: 'ours' });
    assert.equal(allocated, 'kolize-55-2');
    assert.equal(await readFile(foreignMeta, 'utf-8'), '{"owner":"foreign"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
