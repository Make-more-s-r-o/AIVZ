import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNenListing, parseCzechDate, fetchNenTenders, type NenTenderCandidate } from '../src/lib/monitoring/nen-client.js';
import {
  toNenFeedInput, toHlidacFeedInput, toIsoDate,
  listFeed, getFeedItem, upsertFeed, setFeedStav, normalizeFeedRow, buildListFeedQuery,
} from '../src/lib/monitoring/monitoring-store.js';
import { collectMonitoringInputs } from '../src/lib/monitoring/monitoring-sync.js';
import { closePool } from '../src/lib/db.js';
import { scoreFeedItem, slugifyTender } from '../src/lib/monitoring/monitoring-score.js';
import type { HlidacTenderCandidate } from '../src/lib/monitoring/hlidac-client.js';
import type { MonitoringConfig } from '../src/lib/monitoring/monitoring-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'nen-listing.html'), 'utf-8');

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
  assert.deepEqual(result, { items: [], ok: false });
});

test('fetchNenTenders při HTTP chybě zdroje vrací ok=false', async () => {
  const result = await fetchNenTenders('', {
    fetchFn: (async () => new Response('nope', { status: 503 })) as typeof fetch,
  });
  assert.deepEqual(result, { items: [], ok: false });
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
  assert.deepEqual(result, { items: [], ok: true });
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
      return [{
        id: 'fallback-1', nazev: 'Dodávka serverů', zadavatel: 'Město', budget: 1000,
        lhuta: null, stavVZ: 'zadavani', url: 'https://h/fallback-1', dokumenty: [], cpv: [],
      }];
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
    fetchHlidac: async () => [],
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
});

test('normalizeFeedRow líně dopočítá chybějící kategorii ze starého řádku', () => {
  const row = normalizeFeedRow({
    id: '2', zdroj: 'nen', zdroj_id: 'N2', nazev: 'Dodávka notebooků a serverů', zadavatel: null,
    predpokladana_hodnota: null, lhuta_nabidek: null, url: null, raw: null,
    stav: 'nova', tender_id: null, created_at: '2026-07-11T00:00:00Z', kategorie: null,
  });
  assert.equal(row.kategorie, 'it_av');
});

test('feed SQL aplikuje stav a kategorii před interním LIMIT 1000', () => {
  const built = buildListFeedQuery('nova', 1000, { category: 'it_av' });
  assert.deepEqual(built.params, ['nova', 'it_av', 1000]);
  assert.match(built.sql, /WHERE stav = \$1 AND kategorie = \$2 AND/);
  assert.match(built.sql, /LIMIT \$3/);
  assert.ok(built.sql.indexOf('kategorie = $2') < built.sql.indexOf('LIMIT $3'));
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
};

test('scoreFeedItem výrazně zvýhodní kategorii zájmu a srazí kategorii mimo zájem', () => {
  const base = { zadavatel: null, predpokladana_hodnota: null, lhuta_nabidek: null };
  const matching = scoreFeedItem({ ...base, nazev: 'Dodávka notebooků', kategorie: 'it_av' }, undefined, NOW, MONITORING_CONFIG);
  const outside = scoreFeedItem({ ...base, nazev: 'Dodávka kancelářských židlí', kategorie: 'nabytek' }, undefined, NOW, MONITORING_CONFIG);
  assert.ok(matching.score >= outside.score + 50, `${matching.score} vs ${outside.score}`);
  assert.equal(outside.doporuceni, 'NOGO');
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
    assert.equal(await getFeedItem('1'), null);
    await assert.rejects(
      () => upsertFeed([{ zdroj: 'nen', zdroj_id: 'x', nazev: 'X', kategorie: 'ostatni', zadavatel: null, predpokladana_hodnota: null, lhuta_nabidek: null, url: 'https://h', raw: null }]),
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
