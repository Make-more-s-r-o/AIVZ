import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNenListing, parseCzechDate, fetchNenTenders, type NenTenderCandidate } from '../src/lib/monitoring/nen-client.js';
import {
  toNenFeedInput, toHlidacFeedInput, toIsoDate,
  listFeed, countFeed, getFeedItem, upsertFeed, setFeedStav, normalizeFeedRow,
  buildListFeedQuery, buildCountFeedQuery, summarizeFeedCut,
} from '../src/lib/monitoring/monitoring-store.js';
import { collectMonitoringInputs } from '../src/lib/monitoring/monitoring-sync.js';
import { closePool } from '../src/lib/db.js';
import { scoreFeedItem, slugifyTender } from '../src/lib/monitoring/monitoring-score.js';
import type { HlidacTenderCandidate } from '../src/lib/monitoring/hlidac-client.js';
import type { MonitoringConfig } from '../src/lib/monitoring/monitoring-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'nen-listing.html'), 'utf-8');
const CPV_MIGRATION = readFileSync(join(__dirname, '..', 'migrations', '024_monitoring_cpv.sql'), 'utf-8');
const SERVE_API_SOURCE = readFileSync(join(__dirname, '..', 'src', 'serve-api.ts'), 'utf-8');

test('migrace 024 přidává prvotřídní CPV pole a GIN index', () => {
  assert.match(CPV_MIGRATION, /ADD COLUMN IF NOT EXISTS cpv TEXT\[\] NOT NULL DEFAULT '\{\}'::TEXT\[\]/i);
  assert.match(CPV_MIGRATION, /USING GIN \(cpv\)/i);
});

// --- NEN parser (fixture z reálné odpovědi) ---

test('parseNenListing vytáhne všechny řádky z reálné NEN fixture', () => {
  const rows = parseNenListing(FIXTURE);
  assert.equal(rows.length, 6);
  const first = rows[0];
  assert.equal(first.zdroj_id, 'N006/26/V00018492');
  assert.ok(first.nazev.length > 0, 'název není prázdný');
  assert.ok(first.url.startsWith('https://nen.nipez.cz/'), 'url je absolutní');
  assert.equal(first.lhuta_nabidek, '2026-07-08', 'lhůta se převede na ISO datum');
});

test('parseNenListing čte buňky podle data-title, ne podle pořadí', () => {
  const rows = parseNenListing(FIXTURE);
  // Ve fixture je právě jeden „Neukončen" (otevřený) — ostatní jsou Zadán/Zrušen.
  const open = rows.filter((r) => r.stav === 'Neukončen');
  assert.equal(open.length, 1);
  assert.equal(open[0].zdroj_id, 'N006/26/V00018492');
  assert.ok(rows.every((r) => r.zadavatel && r.zadavatel.length > 0), 'zadavatel se naparsuje');
});

test('parseNenListing na prázdném/nevalidním HTML vrací prázdno (žádný pád)', () => {
  assert.deepEqual(parseNenListing(''), []);
  assert.deepEqual(parseNenListing('<html><body>nic</body></html>'), []);
});

test('parseCzechDate převádí český formát a odmítá nesmysl', () => {
  assert.equal(parseCzechDate('21. 07. 2026 09:00'), '2026-07-21');
  assert.equal(parseCzechDate('8. 7. 2026'), '2026-07-08');
  assert.equal(parseCzechDate(null), null);
  assert.equal(parseCzechDate(''), null);
  assert.equal(parseCzechDate('bez data'), null);
  assert.equal(parseCzechDate('30. 13. 2026'), null); // neplatný měsíc
});

// --- Sync s nedostupným zdrojem → prázdno, žádný pád ---

test('fetchNenTenders při selhání fetch vrací ok=false (žádný pád)', async () => {
  const result = await fetchNenTenders('cokoliv', {
    fetchFn: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
  });
  assert.deepEqual(result, {
    items: [], ok: false, health: 'error', requests: 1, pages: 0, truncated: false,
    warning: 'NEN není dostupný (ECONNREFUSED) — monitoring použije dostupná data.',
  });
});

test('fetchNenTenders při HTTP chybě zdroje vrací ok=false', async () => {
  const result = await fetchNenTenders('', {
    fetchFn: (async () => new Response('nope', { status: 503 })) as typeof fetch,
  });
  assert.deepEqual(result, {
    items: [], ok: false, health: 'error', requests: 1, pages: 0, truncated: false,
    warning: 'NEN vrátil HTTP 503 — monitoring použije dostupná data.',
  });
});

test('fetchNenTenders stránkuje přes ověřené p:vz:page=N, deduplikuje a skončí na maximu', async () => {
  const urls: string[] = [];
  const waits: number[] = [];
  const result = await fetchNenTenders('', {
    maxPages: 2,
    fetchFn: (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(FIXTURE, { status: 200 });
    }) as typeof fetch,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.health, 'partial');
  assert.equal(result.requests, 2);
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.items.length, 1, 'stejné zdroj_id z druhé stránky se neduplikuje');
  assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith('/verejne-zakazky/p:vz:page=2'));
  assert.deepEqual(waits, [300]);
});

test('fetchNenTenders skončí bez další pauzy, když stránka nevrátí řádky', async () => {
  let calls = 0;
  let sleeps = 0;
  const result = await fetchNenTenders('', {
    maxPages: 5,
    fetchFn: (async () => {
      calls += 1;
      return new Response('<html><body>bez řádků</body></html>', { status: 200 });
    }) as typeof fetch,
    sleep: async () => { sleeps += 1; },
  });
  assert.deepEqual(result, {
    items: [], ok: true, health: 'ok', requests: 1, pages: 1, truncated: false,
  });
  assert.equal(calls, 1);
  assert.equal(sleeps, 0);
});

// --- Normalizace záznamů zdroje (čisté funkce) ---

test('toNenFeedInput normalizuje NEN kandidáta', () => {
  const candidate: NenTenderCandidate = {
    zdroj_id: 'N006/26/V00018492',
    nazev: 'Dodávka notebooků',
    zadavatel: 'Krajská nemocnice',
    stav: 'Neukončen',
    lhuta_nabidek: '2026-07-21',
    url: 'https://nen.nipez.cz/verejne-zakazky/detail-zakazky/N006-26-V00018492',
  };
  const input = toNenFeedInput(candidate);
  assert.equal(input.zdroj, 'nen');
  assert.equal(input.zdroj_id, 'N006/26/V00018492');
  assert.equal(input.nazev, 'Dodávka notebooků');
  assert.equal(input.zadavatel, 'Krajská nemocnice');
  assert.deepEqual(input.cpv, []);
  assert.equal(input.kategorie, 'it_av', 'zakázka bez CPV se dál kategorizuje podle názvu');
  assert.equal(input.predpokladana_hodnota, null); // v seznamu NEN není
  assert.equal(input.lhuta_nabidek, '2026-07-21');
  assert.deepEqual(input.raw, candidate);
});

test('toHlidacFeedInput normalizuje Hlídač kandidáta a převede lhůtu na ISO', () => {
  const candidate: HlidacTenderCandidate = {
    id: 'abc-123',
    nazev: 'Nákup serverů',
    zadavatel: 'Ministerstvo',
    budget: 4_500_000,
    lhuta: '2026-08-15T10:00:00.000Z',
    stavVZ: 'zadavani',
    url: 'https://www.hlidacstatu.cz/verejnezakazky/zakazka/abc-123',
    dokumenty: [],
    cpv: [],
  };
  const input = toHlidacFeedInput(candidate);
  assert.equal(input.zdroj, 'hlidac');
  assert.equal(input.zdroj_id, 'abc-123');
  assert.equal(input.predpokladana_hodnota, 4_500_000);
  assert.equal(input.lhuta_nabidek, '2026-08-15');
  assert.deepEqual(input.cpv, []);
});

test('toHlidacFeedInput zachová a normalizuje CPV a použije ho před obecným názvem', () => {
  const input = toHlidacFeedInput({
    id: 'cpv-4451', nazev: 'Rámcová dohoda na dodávky', zadavatel: 'Město', budget: null,
    lhuta: null, stavVZ: 'zadavani', url: 'https://h/cpv-4451', dokumenty: [],
    cpv: [{ Kod: '44510000-8' }, '44510000'],
  });
  assert.deepEqual(input.cpv, ['44510000']);
  assert.equal(input.kategorie, 'naradi_dilna');
});

test('toHlidacFeedInput bez CPV zachová kategorizaci podle názvu jako fallback', () => {
  const input = toHlidacFeedInput({
    id: 'title-fallback', nazev: 'Dodávka dílenského nářadí', zadavatel: null, budget: null,
    lhuta: null, stavVZ: null, url: 'https://h/title-fallback', dokumenty: [], cpv: [],
  });
  assert.deepEqual(input.cpv, []);
  assert.equal(input.kategorie, 'naradi_dilna');
});

test('toHlidacFeedInput s prázdným zadavatelem/lhůtou nepadá', () => {
  const input = toHlidacFeedInput({
    id: 'x', nazev: 'Z', zadavatel: '', budget: null, lhuta: null,
    stavVZ: null, url: 'https://h/x', dokumenty: [], cpv: [],
  });
  assert.equal(input.zadavatel, null);
  assert.equal(input.lhuta_nabidek, null);
  assert.equal(input.predpokladana_hodnota, null);
});

test('toIsoDate zvládá ISO, datetime i nevalidní vstup', () => {
  assert.equal(toIsoDate('2026-07-21'), '2026-07-21');
  assert.equal(toIsoDate('2026-07-21T09:00:00Z'), '2026-07-21');
  assert.equal(toIsoDate(null), null);
  assert.equal(toIsoDate('nesmysl'), null);
});

test('collectMonitoringInputs: selhání NEN s tokenem zavolá Hlídač jako fallback', async () => {
  let hlidacCalls = 0;
  const result = await collectMonitoringInputs('nen', 'server', true, {
    fetchNen: async () => ({ items: [], ok: false }),
    fetchHlidac: async () => {
      hlidacCalls += 1;
      return {
        items: [{
          id: 'fallback-1', nazev: 'Dodávka serverů', zadavatel: 'Město', budget: 1000,
          lhuta: null, stavVZ: 'zadavani', url: 'https://h/fallback-1', dokumenty: [], cpv: [],
        }],
        health: 'ok', requests: 1, pages: 1, total: 1, truncated: false,
      };
    },
  });
  assert.equal(hlidacCalls, 1);
  assert.deepEqual(result.zdroje_pouzite, ['nen', 'hlidac']);
  assert.equal(result.inputs.length, 1);
  assert.equal(result.inputs[0].zdroj, 'hlidac');
  assert.ok(result.varovani?.includes('NEN se nepodařilo'));
});

test('collectMonitoringInputs deduplikuje zdroj_id napříč více fulltextovými dotazy', async () => {
  const calls: string[] = [];
  const candidate = (id: string, nazev: string): NenTenderCandidate => ({
    zdroj_id: id, nazev, zadavatel: 'Město', stav: 'Neukončen', lhuta_nabidek: null, url: `https://nen/${id}`,
  });
  const result = await collectMonitoringInputs('nen', ['notebooky', 'servery'], false, {
    fetchNen: async (query) => {
      calls.push(query);
      return {
        ok: true,
        items: query === 'notebooky'
          ? [candidate('N1', 'Notebooky'), candidate('N-SHARED', 'IT technika')]
          : [candidate('N-SHARED', 'IT technika'), candidate('N2', 'Servery')],
      };
    },
    fetchHlidac: async () => ({
      items: [], health: 'ok', requests: 1, pages: 1, total: 0, truncated: false,
    }),
  });
  assert.deepEqual(calls, ['notebooky', 'servery']);
  assert.deepEqual(result.inputs.map((item) => item.zdroj_id), ['N1', 'N-SHARED', 'N2']);
});

test('normalizeFeedRow převádí NUMERIC string na number', () => {
  const row = normalizeFeedRow({
    id: '1', zdroj: 'nen', zdroj_id: 'N1', nazev: 'Zakázka', zadavatel: null,
    predpokladana_hodnota: '12345.67', lhuta_nabidek: null, url: null, raw: null,
    stav: 'nova', tender_id: null, created_at: '2026-07-11T00:00:00Z',
  });
  assert.equal(row.predpokladana_hodnota, 12345.67);
  assert.equal(typeof row.predpokladana_hodnota, 'number');
  assert.equal(row.kategorie, 'ostatni');
  assert.deepEqual(row.cpv, []);
});

test('normalizeFeedRow líně dopočítá chybějící kategorii ze starého řádku', () => {
  const row = normalizeFeedRow({
    id: '2', zdroj: 'nen', zdroj_id: 'N2', nazev: 'Dodávka notebooků a serverů', zadavatel: null,
    predpokladana_hodnota: null, lhuta_nabidek: null, url: null, raw: null,
    stav: 'nova', tender_id: null, created_at: '2026-07-11T00:00:00Z', kategorie: null,
  });
  assert.equal(row.kategorie, 'it_av');
});

test('normalizeFeedRow nechá CPV přebít i starší platnou kategorii odvozenou z názvu', () => {
  const row = normalizeFeedRow({
    id: '3', zdroj: 'hlidac', zdroj_id: 'H3', nazev: 'Obecná dodávka', zadavatel: null,
    predpokladana_hodnota: null, lhuta_nabidek: null, url: null, raw: null,
    stav: 'nova', tender_id: null, created_at: '2026-07-11T00:00:00Z',
    kategorie: 'ostatni', cpv: ['44510000-8'],
  });
  assert.deepEqual(row.cpv, ['44510000']);
  assert.equal(row.kategorie, 'naradi_dilna');
});

test('feed SQL aplikuje stav a kategorii před interním LIMIT 1000', () => {
  const built = buildListFeedQuery('nova', 1000, { category: 'it_av' });
  assert.deepEqual(built.params, ['nova', 'it_av', 1000]);
  assert.match(built.sql, /WHERE stav = \$1 AND kategorie = \$2 AND/);
  assert.match(built.sql, /LIMIT \$3/);
  assert.ok(built.sql.indexOf('kategorie = $2') < built.sql.indexOf('LIMIT $3'));
  assert.match(built.sql, /kategorie, cpv,/);
});

test('feed COUNT používá stejné filtry jako omezený seznam a nemá LIMIT', () => {
  const built = buildCountFeedQuery('nova', { category: 'it_av' });
  assert.deepEqual(built.params, ['nova', 'it_av']);
  assert.match(built.sql, /WHERE stav = \$1 AND kategorie = \$2 AND/);
  assert.doesNotMatch(built.sql, /LIMIT/i);
});

test('metadata obou řezů uvádějí total, returned, discarded a truncated', () => {
  assert.deepEqual(summarizeFeedCut(1_275, 1_000, 1_000), {
    limit: 1_000, total: 1_275, returned: 1_000, discarded: 275, truncated: true,
  });
  assert.deepEqual(summarizeFeedCut(743, 200, 200), {
    limit: 200, total: 743, returned: 200, discarded: 543, truncated: true,
  });
  assert.deepEqual(summarizeFeedCut(37, 37, 200), {
    limit: 200, total: 37, returned: 37, discarded: 0, truncated: false,
  });
});

test('monitoring feed publikuje metadata obou řezů a zachová kompatibilní výchozí pole', () => {
  for (const cut of ['Database', 'Response']) {
    for (const metric of ['Total', 'Returned', 'Discarded', 'Truncated']) {
      assert.ok(SERVE_API_SOURCE.includes(`X-Monitoring-${cut}-${metric}`));
    }
  }
  assert.match(SERVE_API_SOURCE, /Access-Control-Expose-Headers/);
  assert.match(SERVE_API_SOURCE, /req\.query\.meta === '1'/);
  assert.match(SERVE_API_SOURCE, /res\.json\(responseItems\)/);
});

// --- Quick go/no-go skóre feed položky ---

const NOW = new Date('2026-07-01T00:00:00.000Z');

test('scoreFeedItem počítá skóre z dostupných polí bez pádu', () => {
  const result = scoreFeedItem(
    { nazev: 'Dodávka notebooků a serverů', zadavatel: 'Kraj', predpokladana_hodnota: 3_000_000, lhuta_nabidek: '2026-08-01' },
    { obory: ['IT'], keyword_filters: { IT: ['notebook', 'server'] } },
    NOW,
  );
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(['GO', 'ZVAZIT', 'NOGO'].includes(result.doporuceni));
  assert.ok(result.duvody.length > 0);
});

test('scoreFeedItem bez jakéhokoli signálu vrací neutrální skóre (nesestřelí se)', () => {
  const result = scoreFeedItem(
    { nazev: 'Zakázka bez údajů', zadavatel: null, predpokladana_hodnota: null, lhuta_nabidek: null },
    undefined,
    NOW,
  );
  // Bez firemního profilu, hodnoty i lhůty zůstane jen neutrální fallback.
  assert.equal(result.score, 50);
  assert.equal(result.doporuceni, 'ZVAZIT');
});

test('scoreFeedItem: krátká lhůta sráží skóre oproti komfortní', () => {
  const base = { nazev: 'X', zadavatel: null, predpokladana_hodnota: 1_000_000 as number | null };
  const comfortable = scoreFeedItem({ ...base, lhuta_nabidek: '2026-08-01' }, undefined, NOW);
  const critical = scoreFeedItem({ ...base, lhuta_nabidek: '2026-07-02' }, undefined, NOW);
  assert.ok(comfortable.score > critical.score, 'delší lhůta = vyšší skóre');
});

const MONITORING_CONFIG: MonitoringConfig = {
  kategorie_zajmu: ['it_av'],
  klicova_slova: [],
  vyloucena_slova: [],
  min_hodnota: null,
  max_hodnota: null,
  auto_spustit_pipeline: true,
};

test('scoreFeedItem výrazně zvýhodní kategorii zájmu a srazí kategorii mimo zájem', () => {
  const base = { zadavatel: null, predpokladana_hodnota: null, lhuta_nabidek: null };
  const matching = scoreFeedItem({ ...base, nazev: 'Dodávka notebooků', kategorie: 'it_av' }, undefined, NOW, MONITORING_CONFIG);
  const outside = scoreFeedItem({ ...base, nazev: 'Dodávka kancelářských židlí', kategorie: 'nabytek' }, undefined, NOW, MONITORING_CONFIG);
  assert.ok(matching.score >= outside.score + 50, `${matching.score} vs ${outside.score}`);
  assert.equal(outside.doporuceni, 'NOGO');
});

test('scoreFeedItem zohlední CPV i proti starší kategorii odvozené jen z názvu', () => {
  const config: MonitoringConfig = { ...MONITORING_CONFIG, kategorie_zajmu: ['naradi_dilna'] };
  const base = {
    nazev: 'Rámcová dohoda na dodávky', kategorie: 'ostatni' as const, zadavatel: null,
    predpokladana_hodnota: null, lhuta_nabidek: null,
  };
  const accordingToCpv = scoreFeedItem({ ...base, cpv: ['44510000-8'] }, undefined, NOW, config);
  const withoutCpv = scoreFeedItem(base, undefined, NOW, config);
  assert.ok(accordingToCpv.score >= withoutCpv.score + 50, `${accordingToCpv.score} vs ${withoutCpv.score}`);
  assert.ok(accordingToCpv.duvody.some((reason) => reason.includes('odpovídá nastavenému zájmu')));
});

test('scoreFeedItem zohlední CPV v sektorovém skóre i bez filtru kategorie_zajmu', () => {
  const base = {
    nazev: 'Rámcová dohoda na dodávky', zadavatel: null,
    predpokladana_hodnota: null, lhuta_nabidek: null,
  };
  const accordingToCpv = scoreFeedItem(
    { ...base, cpv: ['44510000-8'] },
    { obory: ['naradi_dilna'] },
    NOW,
  );
  const withoutCpv = scoreFeedItem(base, { obory: ['naradi_dilna'] }, NOW);
  assert.ok(accordingToCpv.score > withoutCpv.score, `${accordingToCpv.score} vs ${withoutCpv.score}`);
  assert.ok(accordingToCpv.duvody.some((reason) => reason.includes('odpovídá oborům firmy')));
});

test('scoreFeedItem bez hodnoty skládá důvody rozpočtu, sektoru, lhůty a kategorie', () => {
  const result = scoreFeedItem(
    {
      nazev: 'Dodávka notebooků',
      kategorie: 'it_av',
      zadavatel: 'Kraj',
      predpokladana_hodnota: null,
      lhuta_nabidek: '2026-08-01',
    },
    { obory: ['IT'], keyword_filters: { IT: ['notebook'] } },
    NOW,
    MONITORING_CONFIG,
  );
  assert.ok(result.duvody.includes('Zadavatel neuvedl předpokládanou hodnotu — rozpočtový faktor nezapočítán'));
  assert.ok(result.duvody.some((reason) => reason.includes('odpovídá oborům firmy')));
  assert.ok(result.duvody.some((reason) => reason.includes('Na přípravu zbývá')));
  assert.ok(result.duvody.some((reason) => reason.includes('Kategorie zakázky odpovídá')));
});

test('scoreFeedItem nastaví NOGO při vyloučeném slovu v názvu', () => {
  const result = scoreFeedItem(
    { nazev: 'Pronájem notebooků', kategorie: 'it_av', zadavatel: null, predpokladana_hodnota: null, lhuta_nabidek: null },
    undefined,
    NOW,
    { ...MONITORING_CONFIG, vyloucena_slova: ['pronájem'] },
  );
  assert.equal(result.score, 0);
  assert.equal(result.doporuceni, 'NOGO');
});

test('scoreFeedItem srazí skóre při hodnotě mimo nastavený rozsah', () => {
  const item = { nazev: 'Dodávka notebooků', kategorie: 'it_av' as const, zadavatel: null, predpokladana_hodnota: 3_000_000, lhuta_nabidek: null };
  const inside = scoreFeedItem(item, undefined, NOW, { ...MONITORING_CONFIG, max_hodnota: 5_000_000 });
  const outside = scoreFeedItem(item, undefined, NOW, { ...MONITORING_CONFIG, max_hodnota: 2_000_000 });
  assert.equal(inside.score - outside.score, 20);
  assert.ok(outside.duvody.some((reason) => reason.includes('maximum')));
});

// --- slugify ---

// --- Store graceful degradace bez DB ---

test('store bez DATABASE_URL degraduje gracefully (čtení prázdno, zápis vyhazuje)', async () => {
  const orig = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  await closePool(); // zahodí případný cachovaný pool → getPool() vrátí null
  try {
    assert.deepEqual(await listFeed('nova'), []);
    assert.equal(await countFeed('nova'), 0);
    assert.equal(await getFeedItem('1'), null);
    await assert.rejects(
      () => upsertFeed([{ zdroj: 'nen', zdroj_id: 'x', nazev: 'X', kategorie: 'ostatni', cpv: [], zadavatel: null, predpokladana_hodnota: null, lhuta_nabidek: null, url: 'https://h', raw: null }]),
      /db_unavailable/,
    );
    await assert.rejects(() => setFeedStav('1', 'ignorovana'), /db_unavailable/);
  } finally {
    if (orig === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = orig;
    await closePool(); // reset, ať si další getPool postaví pool z obnoveného env
  }
});

test('slugifyTender očistí diakritiku a nebezpečné znaky', () => {
  assert.equal(slugifyTender('Dodávka notebooků / 2026', 'fallback'), 'dodavka-notebooku-2026');
  assert.equal(slugifyTender('N006/26/V00018492', 'fallback'), 'n006-26-v00018492');
  assert.equal(slugifyTender('...', 'fallback-id'), 'fallback-id');
  assert.equal(slugifyTender('', 'zakazka-5'), 'zakazka-5');
  const slug = slugifyTender('Ěščřžýáíé velmi dlouhý název '.repeat(5), 'fb');
  assert.ok(!slug.includes('/') && !slug.includes('..'), 'bezpečný pro cestu');
  assert.ok(slug.length <= 60);
});
