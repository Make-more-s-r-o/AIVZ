import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtemp, mkdir, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeInboxEntry, needsAction, buildInbox, readInboxJson, type InboxTenderInput } from '../src/lib/inbox.js';

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
  const out = buildInbox(inputs);
  assert.equal(out.length, 3); // 'clean' vypadne
  assert.equal(out[0].tender_id, 'hard'); // hard flag nejvýš
  assert.equal(out[1].tender_id, 'fails'); // pak fails
  assert.equal(out[2].tender_id, 'ceny');
});
