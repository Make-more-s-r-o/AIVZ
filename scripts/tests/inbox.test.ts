import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtemp, mkdir, rm, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeInboxEntry, evaluateBulkCandidate, inboxBulkGovernanceKey, needsAction, buildInbox, readInboxJson,
  type InboxTenderInput,
} from '../src/lib/inbox.js';
import { DEFAULT_GOVERNANCE, governanceSwitchBlock } from '../src/lib/governance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Pomocník: položka product-match s volitelnými poli.
function item(overrides: Record<string, any> = {}) {
  return {
    polozka_nazev: 'Vrtačka',
    polozka_index: 0,
    mnozstvi: 1,
    kandidati: [{ cena_s_dph: 1000 }],
    vybrany_index: 0,
    cenova_uprava: { nabidkova_cena_s_dph: 1210, potvrzeno: true },
    sanity_flags: [],
    ...overrides,
  };
}

test('computeInboxEntry: čistá zakázka bez akce', () => {
  const e = computeInboxEntry({
    tenderId: 't1',
    analysis: { zakazka: { nazev: 'Nákup nářadí' } },
    productMatch: { polozky_match: [item(), item({ polozka_index: 1 })] },
    validation: { ready_to_submit: true, checks: [{ status: 'pass' }] },
    crmStav: 'priprava',
  });
  assert.equal(e.nazev, 'Nákup nářadí');
  assert.equal(e.crm_stav, 'priprava');
  assert.equal(e.nepotvrzene_ceny, 0);
  assert.equal(e.hard_flagy, 0);
  assert.equal(e.validation_fails, 0);
  assert.equal(e.ready_to_submit, true);
  assert.equal(e.celkova_cena_s_dph, 2420); // 1210 * 2
  assert.equal(needsAction(e), false);
});

test('computeInboxEntry: nepotvrzené ceny se počítají', () => {
  const e = computeInboxEntry({
    tenderId: 't2',
    productMatch: {
      polozky_match: [
        item({ cenova_uprava: { nabidkova_cena_s_dph: 1210, potvrzeno: false } }),
        item({ polozka_index: 1, cenova_uprava: undefined }),
        item({ polozka_index: 2 }),
      ],
    },
  });
  assert.equal(e.nepotvrzene_ceny, 2);
  assert.equal(needsAction(e), true);
});

test('computeInboxEntry: počítá jen HARD sanity flagy', () => {
  const e = computeInboxEntry({
    tenderId: 't3',
    productMatch: {
      polozky_match: [
        item({ sanity_flags: [{ level: 'hard', code: 'zero_price' }, { level: 'warn', code: 'bid_share' }] }),
        item({ polozka_index: 1, sanity_flags: [{ level: 'hard', code: 'overcap' }] }),
      ],
    },
  });
  assert.equal(e.hard_flagy, 2);
  assert.equal(needsAction(e), true);
});

test('computeInboxEntry: validation fails a ready_to_submit', () => {
  const e = computeInboxEntry({
    tenderId: 't4',
    validation: {
      ready_to_submit: false,
      checks: [{ status: 'pass' }, { status: 'fail' }, { status: 'warning' }, { status: 'fail' }],
    },
  });
  assert.equal(e.validation_fails, 2);
  assert.equal(e.ready_to_submit, false);
  assert.equal(needsAction(e), true);
});

test('computeInboxEntry: mnozstvi násobí a chybějící cena => null', () => {
  const withQty = computeInboxEntry({
    tenderId: 't5',
    productMatch: { polozky_match: [item({ mnozstvi: 3 })] },
  });
  assert.equal(withQty.celkova_cena_s_dph, 3630); // 1210 * 3

  const noPrice = computeInboxEntry({
    tenderId: 't6',
    productMatch: {
      polozky_match: [item({ cenova_uprava: undefined, kandidati: [], vybrany_index: 0 })],
    },
  });
  assert.equal(noPrice.celkova_cena_s_dph, null);
});

test('computeInboxEntry: fallback ceny z vybraného kandidáta', () => {
  const e = computeInboxEntry({
    tenderId: 't7',
    productMatch: {
      polozky_match: [
        item({ cenova_uprava: { potvrzeno: false }, kandidati: [{ cena_s_dph: 500 }], vybrany_index: 0, mnozstvi: 2 }),
      ],
    },
  });
  assert.equal(e.celkova_cena_s_dph, 1000);
});

test('computeInboxEntry: legacy single-product tvar', () => {
  const e = computeInboxEntry({
    tenderId: 't8',
    productMatch: {
      kandidati: [{ cena_s_dph: 999 }],
      vybrany_index: 0,
      cenova_uprava: { nabidkova_cena_s_dph: 999, potvrzeno: false },
    },
  });
  assert.equal(e.nepotvrzene_ceny, 1);
  assert.equal(e.celkova_cena_s_dph, 999);
});

test('computeInboxEntry: chybějící/vadná data nevyhazují a dávají fallback název', () => {
  const e = computeInboxEntry({ tenderId: 'tender-xyz', analysis: null, productMatch: 'not-json', validation: 42 });
  assert.equal(e.nazev, 'tender-xyz');
  assert.equal(e.nepotvrzene_ceny, 0);
  assert.equal(e.hard_flagy, 0);
  assert.equal(e.validation_fails, 0);
  assert.equal(e.ready_to_submit, false);
  assert.equal(e.celkova_cena_s_dph, null);
  assert.equal(needsAction(e), false);
});

test('corrupt product-match.json zůstane v inboxu jako Vadná data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vz-inbox-corrupt-'));
  const tenderId = 'corrupt-tender';
  await mkdir(join(root, tenderId));
  await copyFile(
    join(__dirname, 'fixtures', 'corrupt-product-match.json'),
    join(root, tenderId, 'product-match.json'),
  );
  try {
    const read = await readInboxJson(root, tenderId, 'product-match.json');
    assert.equal(read.state, 'corrupt');
    if (read.state !== 'corrupt') assert.fail('fixture měla být poškozená');
    assert.equal(read.filename, 'product-match.json');
    const out = buildInbox([{ tenderId, productMatch: null, dataErrors: [read.filename] }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].data_error, true);
    assert.deepEqual(out[0].data_error_files, ['product-match.json']);
    assert.equal(needsAction(out[0]), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Deadline alarm (submission cockpit) ---

const NOW = Date.parse('2026-07-11T12:00:00.000Z');

test('deadline_alarm: připravený nepodaný balík s lhůtou do 48 h', () => {
  const e = computeInboxEntry({
    tenderId: 'alarm1',
    productMatch: { polozky_match: [item()] },
    crmStav: 'pripravena',
    balikExistuje: true,
    evidenceExistuje: false,
    lhutaNabidek: '2026-07-12T12:00:00.000Z', // za 24 h
    nowMs: NOW,
  });
  assert.equal(e.deadline_alarm, true);
  assert.equal(e.hodin_do_lhuty, 24);
  assert.equal(needsAction(e), true);
});

test('deadline_alarm: lhůta dál než 48 h → bez alarmu', () => {
  const e = computeInboxEntry({
    tenderId: 'alarm2',
    productMatch: { polozky_match: [item()] },
    crmStav: 'pripravena',
    balikExistuje: true,
    evidenceExistuje: false,
    lhutaNabidek: '2026-07-20T12:00:00.000Z',
    nowMs: NOW,
  });
  assert.equal(e.deadline_alarm, false);
  assert.equal(needsAction(e), false);
});

test('deadline_alarm: zaznamenané podání (evidence) → bez alarmu', () => {
  const e = computeInboxEntry({
    tenderId: 'alarm3',
    productMatch: { polozky_match: [item()] },
    crmStav: 'odeslana',
    balikExistuje: true,
    evidenceExistuje: true,
    lhutaNabidek: '2026-07-12T00:00:00.000Z',
    nowMs: NOW,
  });
  assert.equal(e.deadline_alarm, false);
});

test('deadline_alarm: osiřelá evidence bez CRM stavu Odeslaná alarm nevypne', () => {
  const e = computeInboxEntry({
    tenderId: 'alarm-orphan',
    productMatch: { polozky_match: [item()] },
    crmStav: 'pripravena',
    balikExistuje: true,
    evidenceExistuje: true,
    lhutaNabidek: '2026-07-12T00:00:00.000Z',
    nowMs: NOW,
  });
  assert.equal(e.deadline_alarm, true);
});

test('deadline_alarm: evidence zůstává platná v pozdějším výsledkovém stavu', () => {
  const e = computeInboxEntry({
    tenderId: 'alarm-result',
    productMatch: { polozky_match: [item()] },
    crmStav: 'vyhrano',
    balikExistuje: true,
    evidenceExistuje: true,
    lhutaNabidek: '2026-07-12T00:00:00.000Z',
    nowMs: NOW,
  });
  assert.equal(e.deadline_alarm, false);
});

test('deadline_alarm: bez balíku → bez alarmu i s blízkou lhůtou', () => {
  const e = computeInboxEntry({
    tenderId: 'alarm4',
    productMatch: { polozky_match: [item()] },
    crmStav: 'pripravena',
    balikExistuje: false,
    evidenceExistuje: false,
    lhutaNabidek: '2026-07-11T18:00:00.000Z',
    nowMs: NOW,
  });
  assert.equal(e.deadline_alarm, false);
});

test('deadline_alarm: po lhůtě (záporné hodiny) stále alarmuje', () => {
  const e = computeInboxEntry({
    tenderId: 'alarm5',
    productMatch: { polozky_match: [item()] },
    crmStav: 'pripravena',
    balikExistuje: true,
    evidenceExistuje: false,
    lhutaNabidek: '2026-07-11T06:00:00.000Z', // 6 h po lhůtě
    nowMs: NOW,
  });
  assert.equal(e.deadline_alarm, true);
  assert.equal(e.hodin_do_lhuty, -6);
});

test('buildInbox: deadline_alarm má přednost v řazení', () => {
  const inputs: InboxTenderInput[] = [
    { tenderId: 'hard', productMatch: { polozky_match: [item({ sanity_flags: [{ level: 'hard' }] })] } },
    {
      tenderId: 'alarm', productMatch: { polozky_match: [item()] },
      crmStav: 'pripravena', balikExistuje: true, evidenceExistuje: false,
      lhutaNabidek: '2026-07-12T00:00:00.000Z', nowMs: NOW,
    },
  ];
  const out = buildInbox(inputs);
  assert.equal(out[0].tender_id, 'alarm');
});

test('buildInbox: filtruje čisté a řadí nejnaléhavější první', () => {
  const inputs: InboxTenderInput[] = [
    { tenderId: 'clean', productMatch: { polozky_match: [item()] }, validation: { ready_to_submit: true, checks: [] } },
    { tenderId: 'ceny', productMatch: { polozky_match: [item({ cenova_uprava: { potvrzeno: false } })] } },
    {
      tenderId: 'hard',
      productMatch: { polozky_match: [item({ sanity_flags: [{ level: 'hard', code: 'overcap' }] })] },
    },
    { tenderId: 'fails', validation: { ready_to_submit: false, checks: [{ status: 'fail' }, { status: 'fail' }] } },
  ];
  const out = buildInbox(inputs, 'urgency');
  assert.equal(out.length, 3); // 'clean' vypadne
  assert.equal(out[0].tender_id, 'hard'); // hard flag nejvýš
  assert.equal(out[1].tender_id, 'fails'); // pak fails
  assert.equal(out[2].tender_id, 'ceny');
});

test('buildInbox: default řadí nejbližší lhůtu první a sekundárně vyšší skóre', () => {
  const inputs: InboxTenderInput[] = [
    { tenderId: 'later', analysis: { terminy: {}, go_no_go: { score: 95 } }, lhutaNabidek: '2026-07-15T12:00:00Z', nowMs: NOW, validation: { checks: [{ status: 'fail' }] } },
    { tenderId: 'same-low', analysis: { go_no_go: { score: 40 } }, lhutaNabidek: '2026-07-12T12:00:00Z', nowMs: NOW, validation: { checks: [{ status: 'fail' }] } },
    { tenderId: 'same-high', analysis: { go_no_go: { score: 80 } }, lhutaNabidek: '2026-07-12T12:00:00Z', nowMs: NOW, validation: { checks: [{ status: 'fail' }] } },
  ];
  assert.deepEqual(buildInbox(inputs).map((entry) => entry.tender_id), ['same-high', 'same-low', 'later']);
  assert.deepEqual(buildInbox(inputs, 'score_deadline').map((entry) => entry.tender_id), ['later', 'same-high', 'same-low']);
});

test('bulk generate gate: plně attestovaná zakázka projde', () => {
  const gate = evaluateBulkCandidate({ polozky_match: [item(), item({ polozka_index: 1 })] } as any);
  assert.deepEqual(gate, { allowed: true });
});

test('bulk generate gate: nepotvrzená položka se vyřadí se strojovým důvodem a seznamem', () => {
  const gate = evaluateBulkCandidate({
    polozky_match: [item(), item({ polozka_index: 1, polozka_nazev: 'Bruska', cenova_uprava: { potvrzeno: false } })],
  } as any);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'unconfirmed_items');
  assert.deepEqual(gate.detail, { count: 1, items: ['Bruska'] });
});

test('bulk generate gate: HARD flag zakázku vyřadí', () => {
  const gate = evaluateBulkCandidate({
    polozky_match: [item({ cenova_uprava: { nabidkova_cena_s_dph: 0, potvrzeno: true } })],
  } as any);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'hard_flag');
  assert.equal((gate.detail as any).count, 1);
});

test('bulk generate gate: potvrzený legacy single-product pod nákupem vyřadí HARD flag', () => {
  const gate = evaluateBulkCandidate({
    kandidati: [{ cena_bez_dph: 1_000, cena_s_dph: 1_210 }],
    vybrany_index: 0,
    cenova_uprava: {
      nabidkova_cena_bez_dph: 900,
      nabidkova_cena_s_dph: 1_089,
      nakupni_cena_bez_dph: 1_000,
      potvrzeno: true,
    },
  } as any);
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'hard_flag');
  assert.equal((gate.detail as any).flags[0].code, 'below_cost');
});

test('regrese PR #53: bulk gate pouze čte a nikdy nezmění potvrzení položek', () => {
  const productMatch = {
    polozky_match: [
      item({ cenova_uprava: { nabidkova_cena_s_dph: 1210, potvrzeno: true, zkontrolovano_at: '2026-07-11T10:00:00Z', zkontrolovano_kym: 'operator-1' } }),
      item({ polozka_index: 1, cenova_uprava: { nabidkova_cena_s_dph: 1000, potvrzeno: false } }),
    ],
  };
  const before = structuredClone(productMatch);
  const gate = evaluateBulkCandidate(productMatch as any);
  assert.equal(gate.reason, 'unconfirmed_items');
  assert.deepEqual(productMatch, before);
  assert.deepEqual(productMatch.polozky_match.map((row) => row.cenova_uprava.potvrzeno), [true, false]);
});

test('governance: vypnutý generate zablokuje bulk generate před spuštěním', () => {
  const key = inboxBulkGovernanceKey('generate');
  const block = governanceSwitchBlock({ ...DEFAULT_GOVERNANCE, generate_enabled: false }, key);
  assert.match(block ?? '', /generate_enabled/);
});

test('governance: klíče bulk akcí vynucují guard pro každou jednotlivou akci', () => {
  const switchedOffMidBatch = { ...DEFAULT_GOVERNANCE, generate_enabled: false, finalize_enabled: false };
  assert.match(governanceSwitchBlock(switchedOffMidBatch, inboxBulkGovernanceKey('generate')) ?? '', /generate_enabled/);
  assert.match(governanceSwitchBlock(switchedOffMidBatch, inboxBulkGovernanceKey('finalize')) ?? '', /finalize_enabled/);
});

test('governance: bulk endpointy kontrolují guard uvnitř iterace bez finalize bypassu', async () => {
  const source = await readFile(join(__dirname, '..', 'src', 'serve-api.ts'), 'utf-8');
  const generateRoute = source.slice(
    source.indexOf("app.post(['/api/inbox/bulk-generate'"),
    source.indexOf("app.post(['/api/inbox/bulk-finalize'"),
  );
  const loop = generateRoute.indexOf('for (const id of ids)');
  const perTenderGuard = generateRoute.indexOf("enforceGovernance(governanceResponse, 'generate_enabled', true)");
  const enqueue = generateRoute.indexOf("enqueueStepJob(id, 'generate')");
  assert.ok(loop >= 0 && perTenderGuard > loop && enqueue > perTenderGuard);

  const finalizeRoute = source.slice(
    source.indexOf("app.post(['/api/inbox/bulk-finalize'"),
    source.indexOf('// GET stav podání zakázky'),
  );
  assert.match(finalizeRoute, /finalizeTenderHandler\(childRequest, captured\)/);
  assert.doesNotMatch(finalizeRoute, /finalizeTenderHandler\(childRequest, captured, true\)/);
});
