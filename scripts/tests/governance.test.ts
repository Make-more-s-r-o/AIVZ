import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_GOVERNANCE,
  GovernancePatchSchema,
  dailyAiLimitBlock,
  getGovernance,
  governanceSwitchBlock,
  setGovernance,
} from '../src/lib/governance.js';

test('governance vrátí fallback, když soubor chybí', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vz-governance-'));
  try {
    assert.deepEqual(await getGovernance(join(dir, 'missing.json')), DEFAULT_GOVERNANCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('guard přepínače blokuje vypnuto a propouští zapnuto', () => {
  const enabled = { ...DEFAULT_GOVERNANCE };
  assert.equal(governanceSwitchBlock(enabled, 'finalize_enabled'), null);
  assert.match(governanceSwitchBlock({ ...enabled, finalize_enabled: false }, 'finalize_enabled') ?? '', /finalize_enabled/);
});

test('denní AI limit blokuje dosažený limit, ale ne nižší útratu ani null', () => {
  const config = { ...DEFAULT_GOVERNANCE, denni_ai_limit_czk: 100 };
  assert.equal(dailyAiLimitBlock(config, 99.99), null);
  assert.match(dailyAiLimitBlock(config, 100) ?? '', /100\/100 Kč/);
  assert.equal(dailyAiLimitBlock({ ...config, denni_ai_limit_czk: null }, 999_999), null);
});

test('patch odmítne neplatné hodnoty a ignoruje klientská auditní metadata', async () => {
  assert.equal(GovernancePatchSchema.safeParse({ denni_ai_limit_czk: -1 }).success, false);
  assert.equal(GovernancePatchSchema.safeParse({ ingest_enabled: 'ano' }).success, false);

  const dir = await mkdtemp(join(tmpdir(), 'vz-governance-'));
  const path = join(dir, 'config', 'governance.json');
  try {
    const saved = await setGovernance({
      ai_jobs_enabled: false,
      zmeneno_kym: 'podvržený klient',
      zmeneno_at: '2000-01-01T00:00:00.000Z',
    }, 'Admin z JWT', path);
    assert.equal(saved.ai_jobs_enabled, false);
    assert.equal(saved.zmeneno_kym, 'Admin z JWT');
    assert.notEqual(saved.zmeneno_at, '2000-01-01T00:00:00.000Z');
    assert.deepEqual(JSON.parse(await readFile(path, 'utf-8')), saved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
