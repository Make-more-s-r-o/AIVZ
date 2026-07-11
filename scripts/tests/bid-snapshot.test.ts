import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBidSnapshot, persistSnapshotBestEffort } from '../src/lib/bid-snapshot.js';
import { getLatest, listSnapshots, insertSnapshot } from '../src/lib/bid-snapshot-store.js';

const source = (orientacni = false) => ({
  cena_bez_dph: 800, cena_s_dph: 968, orientacni,
});

test('buildBidSnapshot sestaví kompletní ekonomiku, signály a podíly', () => {
  const snapshot = buildBidSnapshot({
    tenderId: 'T-1', snapshotAt: '2026-07-11T10:00:00.000Z',
    analysis: { zakazka: { zadavatel: { nazev: 'Město', ico: '123' }, typ_zakazky: 'dodávky', predpokladana_hodnota: 50_000 }, terminy: { lhuta_nabidek: '2026-08-01' }, polozky: [{}, {}], go_no_go: { score: 81 } },
    productMatch: { bid_score: { score: 73, marze_procent: 25, zisk_kc: 400 }, polozky_match: [
      { mnozstvi: 2, vybrany_index: 0, kandidati: [{ cena_bez_dph: 1000, cena_s_dph: 1210 }], cenova_uprava: { nakupni_cena_bez_dph: 800, nabidkova_cena_bez_dph: 1000, nabidkova_cena_s_dph: 1210 }, sanity_flags: [{ level: 'hard' }], overeni_ceny: { stav: 'nalezeno', zdroje: [source(false)] } },
      { mnozstvi: 1, vybrany_index: 0, kandidati: [{ cena_bez_dph: 500, cena_s_dph: 605 }], cenova_uprava: { nakupni_cena_bez_dph: 400, nabidkova_cena_bez_dph: 500, nabidkova_cena_s_dph: 605 }, sanity_flags: [{ level: 'warn' }], overeni_ceny: { stav: 'orientacni', kandidat_neexistuje: true, zdroje: [source(true)] } },
    ] },
    validationReport: { checks: [{ status: 'fail' }, { status: 'pass' }] },
    costLog: [{ timestamp: '2026-07-11T09:00:00Z', costCZK: 2.5 }, { timestamp: '2026-07-11T09:30:00Z', costCZK: 3.5 }],
    winPriceBand: { median: 3000, p25: 2500, p75: 3500, n: 8 },
    monitoringItem: { zdroj: 'NEN', zdroj_id: 'E-1' },
  });
  assert.equal(snapshot.nase_cena_bez_dph, 2500);
  assert.equal(snapshot.lhuta_nabidek, '2026-08-01');
  assert.equal(snapshot.nase_cena_s_dph, 3025);
  assert.equal(snapshot.nakupni_naklad_bez_dph, 2000);
  assert.equal(snapshot.podil_overenych_cen, 0.5);
  assert.equal(snapshot.podil_orientacnich, 0.5);
  assert.equal(snapshot.pocet_hard_flagu, 1);
  assert.equal(snapshot.pocet_warn_flagu, 1);
  assert.equal(snapshot.pocet_kandidat_neexistuje, 1);
  assert.equal(snapshot.validation_fails, 1);
  assert.equal(snapshot.ai_naklad_czk, 6);
  assert.equal(snapshot.cas_zpracovani_min, 30);
});

test('buildBidSnapshot nikdy nevyhodí a chybějící data mapuje na null', () => {
  const snapshot = buildBidSnapshot({ tenderId: 'empty', analysis: null, productMatch: 'vadné' });
  assert.equal(snapshot.tender_id, 'empty');
  assert.equal(snapshot.nase_cena_bez_dph, null);
  assert.equal(snapshot.podil_overenych_cen, null);
  assert.equal(snapshot.validation_fails, null);
});

test('legacy product-match bez overeni_ceny není započten jako ověřený ani orientační', () => {
  const snapshot = buildBidSnapshot({ tenderId: 'legacy', productMatch: {
    kandidati: [{ cena_bez_dph: 100, cena_s_dph: 121 }], vybrany_index: 0,
  } });
  assert.equal(snapshot.podil_overenych_cen, 0);
  assert.equal(snapshot.podil_orientacnich, 0);
});

test('stav nalezeno bez oceněného neorientačního zdroje se nepovažuje za ověřený', () => {
  const snapshot = buildBidSnapshot({ tenderId: 'quality', productMatch: { polozky_match: [
    { overeni_ceny: { stav: 'nalezeno', zdroje: [source(true)] } },
    { overeni_ceny: { stav: 'ekvivalent', zdroje: [source(false)] } },
  ] } });
  assert.equal(snapshot.podil_overenych_cen, 0.5);
  assert.equal(snapshot.podil_orientacnich, 0.5);
});

test('snapshot store bez DATABASE_URL degraduje graceful', async (t) => {
  if (process.env.DATABASE_URL) return t.skip('Test vyžaduje prostředí bez DB.');
  const snapshot = buildBidSnapshot({ tenderId: 'offline' });
  assert.equal(await insertSnapshot(snapshot), null);
  assert.deepEqual(await listSnapshots('offline'), []);
  assert.equal(await getLatest('offline'), null);
});

test('finalize best-effort: chyba snapshotu nesrazí hlavní tok', async () => {
  const warnings: unknown[][] = [];
  const ok = await persistSnapshotBestEffort(async () => { throw new Error('DB down'); }, (...args) => warnings.push(args));
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
});
