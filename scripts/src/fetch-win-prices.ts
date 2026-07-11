/**
 * CLI: stažení a import historických cen do win_prices.
 *
 * Prototyp podporuje zdroj `registr_smluv` — denní XML dumpy z data.smlouvy.gov.cz.
 * Stáhne index.xml, vybere denní dumpy v daném rozsahu, naparsuje záznamy
 * (strany smlouvy, předmět, cena, datum), heuristicky kategorizuje komoditu
 * a idempotentně upsertne do DB.
 *
 * POZOR: role stran (zadavatel vs. dodavatel/vítěz) NENÍ v Registru smluv dána
 * pořadím — určuje se heuristikou (resolvePartyRoles), viz „Známá omezení"
 * v docs/win-price-design.md.
 *
 * NEVOLÁ žádné AI API — kategorizace je čistě klíčovými slovy.
 *
 * Použití:
 *   npx tsx src/fetch-win-prices.ts --source=registr_smluv --from=2026-07-01 --to=2026-07-05 [--limit=N]
 *   npx tsx src/fetch-win-prices.ts                      # default: poslední ~3 denní dumpy
 */
import { load } from 'cheerio';
import { config } from 'dotenv';
import { runMigrations } from './lib/db-migrate.js';
import { closePool } from './lib/db.js';
import {
  upsertWinPrices,
  categorizeCommodity,
  resolvePartyRoles,
  getWinPriceStats,
  type WinPriceRecord,
} from './lib/winprice-store.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const RS_INDEX = 'https://data.smlouvy.gov.cz/index.xml';

// ------------------------------------------------------------
// CLI args
// ------------------------------------------------------------
function getArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

// ------------------------------------------------------------
// HTTP
// ------------------------------------------------------------
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'vz-winprice-prototype/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// ------------------------------------------------------------
// Registr smluv — výběr denních dumpů z indexu
// ------------------------------------------------------------
interface DumpEntry {
  datum: string; // YYYY-MM-DD (u denního dumpu), nebo YYYY-MM-01 u měsíčního
  url: string;
  denni: boolean;
}

/** Parsuje index.xml a vrátí denní dumpy seřazené dle data. */
function parseIndex(xml: string): DumpEntry[] {
  const $ = load(xml, { xml: true });
  const out: DumpEntry[] = [];
  $('dump').each((_, el) => {
    const url = $(el).find('odkaz').first().text().trim();
    if (!url) return;
    // dump_2026_07_03.xml (denní) vs dump_2026_07.xml (měsíční)
    const m = url.match(/dump_(\d{4})_(\d{2})(?:_(\d{2}))?\.xml$/);
    if (!m) return;
    const [, y, mo, d] = m;
    if (d) {
      out.push({ datum: `${y}-${mo}-${d}`, url, denni: true });
    } else {
      out.push({ datum: `${y}-${mo}-01`, url, denni: false });
    }
  });
  out.sort((a, b) => a.datum.localeCompare(b.datum));
  return out;
}

// ------------------------------------------------------------
// Parsování jednoho dumpu → WinPriceRecord[]
// ------------------------------------------------------------
function parseNumber(s: string): number | null {
  const t = s.trim().replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseDump(xml: string, limit: number, collected: number): WinPriceRecord[] {
  const $ = load(xml, { xml: true });
  const records: WinPriceRecord[] = [];

  $('zaznam').each((_, el) => {
    if (collected + records.length >= limit) return false; // stop iterace
    const z = $(el);

    // platné záznamy (znepřístupněné mají platnyZaznam=0)
    const platny = z.find('platnyZaznam').first().text().trim();
    if (platny === '0') return;

    const idVerze = z.find('identifikator idVerze').first().text().trim();
    const idSmlouvy = z.find('identifikator idSmlouvy').first().text().trim();
    if (!idVerze) return;

    const predmet = z.find('smlouva > predmet').first().text().trim();
    if (!predmet) return; // bez předmětu je záznam pro win-price bezcenný

    // POZOR: role stran NENÍ dána pořadím. `<subjekt>` = ten, kdo má uveřejňovací
    // povinnost a smlouvu publikoval — často je to DODAVATEL, ne kupující (ověřeno
    // na reálném dumpu). Role proto určujeme heuristikou (resolvePartyRoles), ne
    // natvrdo subjekt→zadavatel. Viz docs/win-price-design.md „Známá omezení".
    const subjekt = z.find('smlouva > subjekt').first();
    const subjektParty = {
      nazev: subjekt.find('nazev').first().text().trim() || null,
      ico: subjekt.find('ico').first().text().trim() || null,
    };
    const strana = z.find('smlouva > smluvniStrana').first();
    const stranaParty = {
      nazev: strana.find('nazev').first().text().trim() || null,
      ico: strana.find('ico').first().text().trim() || null,
    };
    const role = resolvePartyRoles(subjektParty, stranaParty);
    const { zadavatel, dodavatel } = role;
    const zadavatel_nazev = zadavatel.nazev;
    const zadavatel_ico = zadavatel.ico;
    const dodavatel_nazev = dodavatel.nazev;
    const dodavatel_ico = dodavatel.ico;

    // datum: uzavření smlouvy, fallback zveřejnění
    let datum: string | null = z.find('smlouva > datumUzavreni').first().text().trim() || null;
    if (!datum) {
      const cas = z.find('casZverejneni').first().text().trim();
      datum = cas ? cas.slice(0, 10) : null;
    }
    // Sanitizace: Registr smluv obsahuje i nesmyslná data (0001-01-01, budoucí roky).
    // Mimo rozsah [2015-01-01, dnešek] nebo mimo ISO formát → NULL (cena zůstává,
    // zahazuje se jen nedůvěryhodné datum). Stejné pravidlo řeší migrace 012 pro už
    // importovaná data.
    if (datum) {
      const dnes = new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || datum < '2015-01-01' || datum > dnes) {
        datum = null;
      }
    }

    // cena: CZK pole, nebo cizí měna
    const cena_bez_dph = parseNumber(z.find('smlouva > hodnotaBezDph').first().text());
    let cena_s_dph = parseNumber(z.find('smlouva > hodnotaVcetneDph').first().text());
    let mena = 'CZK';
    const ciziMena = z.find('smlouva > ciziMena').first();
    if (ciziMena.length) {
      const m = ciziMena.find('mena').first().text().trim();
      if (m) mena = m;
      const h = parseNumber(ciziMena.find('hodnota').first().text());
      if (h !== null && cena_s_dph === null) cena_s_dph = h;
    }

    const url = z.find('odkaz').first().text().trim() || null;
    const evidencniCislo = z.find('smlouva > evidencniCisloZakazky').first().text().trim() || null;

    records.push({
      zdroj: 'registr_smluv',
      zdroj_id: idVerze,
      datum,
      zadavatel_ico,
      zadavatel_nazev,
      dodavatel_ico,
      dodavatel_nazev,
      predmet,
      komodita_kategorie: categorizeCommodity(predmet),
      cena_bez_dph,
      cena_s_dph,
      mena,
      pocet_uchazecu: null, // Registr smluv počet nabídek neobsahuje
      url,
      raw: {
        idSmlouvy: idSmlouvy || null,
        evidencniCisloZakazky: evidencniCislo,
        casZverejneni: z.find('casZverejneni').first().text().trim() || null,
        // Audit role stran: true = heuristika roli jednoznačně určila (právě jedna
        // strana je veřejný zadavatel); false = nespolehlivé, zachováno pořadí subjekt→zadavatel.
        role_spolehliva: role.spolehlive,
        subjekt_ico: subjektParty.ico,
        smluvni_strana_ico: stranaParty.ico,
      },
    });
  });

  return records;
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main(): Promise<void> {
  const source = getArg('source') ?? 'registr_smluv';
  const from = getArg('from'); // YYYY-MM-DD
  const to = getArg('to');
  const limit = Number(getArg('limit') ?? '5000');

  if (source !== 'registr_smluv') {
    console.error(`Nepodporovaný zdroj: ${source} (prototyp umí jen registr_smluv)`);
    process.exit(1);
  }

  console.log(`\nWin-price fetch — zdroj=${source} from=${from ?? '-'} to=${to ?? '-'} limit=${limit}`);

  await runMigrations();

  console.log('Stahuji index dumpů…');
  const index = parseIndex(await fetchText(RS_INDEX));
  const daily = index.filter((d) => d.denni);

  let selected: DumpEntry[];
  if (from || to) {
    const lo = from ?? '0000-00-00';
    const hi = to ?? '9999-99-99';
    selected = daily.filter((d) => d.datum >= lo && d.datum <= hi);
  } else {
    // default: poslední 3 denní dumpy
    selected = daily.slice(-3);
  }

  if (selected.length === 0) {
    console.log('Žádné denní dumpy v zadaném rozsahu.');
    await closePool();
    return;
  }

  console.log(`Vybráno ${selected.length} denních dumpů: ${selected.map((s) => s.datum).join(', ')}`);

  let totalUpserted = 0;
  let collected = 0;
  for (const dump of selected) {
    if (collected >= limit) break;
    process.stdout.write(`  ${dump.datum} … `);
    try {
      const xml = await fetchText(dump.url);
      const records = parseDump(xml, limit, collected);
      collected += records.length;
      const { affected } = await upsertWinPrices(records);
      totalUpserted += affected;
      console.log(`${records.length} záznamů → upsert ${affected}`);
    } catch (err) {
      console.log(`CHYBA: ${(err as Error).message}`);
    }
  }

  const stats = await getWinPriceStats();
  console.log(`\nHotovo. Upsertnuto ${totalUpserted} záznamů z tohoto běhu.`);
  console.log(
    `DB celkem: ${stats.total} záznamů (${stats.s_cenou} s cenou), rozsah ${stats.min_datum}..${stats.max_datum}`,
  );
  console.log('Podle kategorie:', stats.podle_kategorie.map((k) => `${k.kategorie}=${k.pocet}`).join(', '));

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
