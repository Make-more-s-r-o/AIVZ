import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNenListing, parseCzechDate, fetchNenTenders, type NenTenderCandidate } from '../src/lib/monitoring/nen-client.js';
import {
  toNenFeedInput, toHlidacFeedInput, toIsoDate,
  listFeed, getFeedItem, upsertFeed, setFeedStav,
} from '../src/lib/monitoring/monitoring-store.js';
import { closePool } from '../src/lib/db.js';
import { scoreFeedItem, slugifyTender } from '../src/lib/monitoring/monitoring-score.js';
import type { HlidacTenderCandidate } from '../src/lib/monitoring/hlidac-client.js';

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

test('fetchNenTenders při selhání fetch vrací prázdno (žádný pád)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
  try {
    assert.deepEqual(await fetchNenTenders('cokoliv'), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchNenTenders při HTTP chybě zdroje vrací prázdno', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
  try {
    assert.deepEqual(await fetchNenTenders(''), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
      () => upsertFeed([{ zdroj: 'nen', zdroj_id: 'x', nazev: 'X', zadavatel: null, predpokladana_hodnota: null, lhuta_nabidek: null, url: 'https://h', raw: null }]),
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
