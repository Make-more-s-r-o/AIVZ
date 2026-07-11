/**
 * Win-price store — perzistence historických vítězných/smluvních cen do tabulky win_prices.
 *
 * Data pochází primárně z Registru smluv (denní XML dumpy). Účel: pozdější
 * inteligence „co za podobné HW/komodity kdy vyhrálo a za kolik".
 *
 * Idempotence: upsert dle (zdroj, zdroj_id) — opakovaný import stejného dumpu
 * záznamy nezduplikuje, jen aktualizuje.
 */
import { getPool } from './db.js';

// ============================================================
// Typy
// ============================================================

/** Heuristické komoditní kategorie (bez AI). */
export type KomoditaKategorie =
  | 'it_av'
  | 'naradi_dilna'
  | 'zdravotnicke'
  | 'vozidla'
  | 'stavebni_prace'
  | 'potraviny'
  | 'energie'
  | 'nabytek'
  | 'kancelar'
  | 'sluzby'
  | 'ostatni';

/** Všechny kategorie kromě fallbacku 'ostatni' — pro validaci vstupů (API, CLI). */
export const KOMODITA_KATEGORIE_VALUES: KomoditaKategorie[] = [
  'it_av',
  'naradi_dilna',
  'zdravotnicke',
  'vozidla',
  'stavebni_prace',
  'potraviny',
  'energie',
  'nabytek',
  'kancelar',
  'sluzby',
  'ostatni',
];

export interface WinPriceRecord {
  zdroj: string; // 'registr_smluv' | 'vvz' | 'ted'
  zdroj_id: string; // unikátní ID záznamu ve zdroji (idVerze u Registru smluv)
  datum: string | null; // YYYY-MM-DD
  zadavatel_ico: string | null;
  zadavatel_nazev: string | null;
  dodavatel_ico: string | null;
  dodavatel_nazev: string | null;
  predmet: string;
  komodita_kategorie: KomoditaKategorie;
  cena_bez_dph: number | null;
  cena_s_dph: number | null;
  mena: string;
  pocet_uchazecu: number | null;
  url: string | null;
  raw: Record<string, unknown> | null;
}

// ============================================================
// Kategorizace komodit — heuristika klíčovými slovy (BEZ AI)
// ============================================================

/**
 * Odstraní diakritiku a sjednotí bílé znaky, text orámuje mezerami. Díky tomu
 * stačí v klíčových slovech níže jediný ascii tvar kořene (žádné duplicitní
 * páry "tiskárn"/"tiskarn") a krátká/generická slova (" it ", " cnc ") lze
 * bezpečně vymezit mezerami, aby nechytala shody uvnitř jiných slov (např.
 * " nas " ⊄ "nástroj").
 */
function normalizeForMatch(text: string): string {
  const stripped = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${stripped} `;
}

/**
 * Vysoce specifické fráze vyhodnocené PŘED obecnými pravidly níže — řeší kolize,
 * kdy obecnější kořen slova z jiné (dříve v pořadí vyhodnocované) kategorie by
 * jinak vyhrál nad specifičtějším případem. Např. "3D tiskárna" by bez tohoto
 * override spadla do it_av přes kořen "tiskarn" (laserová/inkoustová tiskárna),
 * přestože jde o dílenské/výukové zařízení.
 */
const PRIORITY_OVERRIDES: Array<{ kat: KomoditaKategorie; slova: string[] }> = [
  { kat: 'naradi_dilna', slova: ['3d tisk'] },
  {
    kat: 'zdravotnicke',
    slova: [
      'monitor pacient', 'operacni stul', 'operacni sal', 'nemocnicni luzko',
      'sanitni vozidl', 'sanitk', 'ambulantni vozidl',
    ],
  },
];

// Pořadí = priorita mezi kategoriemi. Jakmile předmět matchne kategorii, končíme —
// proto jsou dřív kategorie s významově specifičtějšími/užšími klíčovými slovy
// (zdravotnické, vozidla, ...) a až na konci obecné/průřezové (kancelář, služby).
const CATEGORY_KEYWORDS: Array<{ kat: KomoditaKategorie; slova: string[] }> = [
  {
    kat: 'it_av',
    slova: [
      'server', 'notebook', 'laptop', 'pocitac', 'monitor', 'projektor', 'dataprojektor',
      'tiskarn', 'kopirk', 'multifunkcni zarizeni', 'plotr', 'plotter', 'switch', 'router',
      'firewall', 'kamer', 'cctv', 'software', 'licenc', 'operacni system', 'sitov',
      'vypocetni technik', 'datove uloziste', 'uloziste dat', 'ssd', 'harddisk',
      'pevny disk', 'procesor', 'tablet', 'mobilni telefon', 'chytry telefon', 'skener',
      'scanner', 'ozvucen', 'audio', 'video technik', 'interaktivni tabul',
      'interaktivni displej', 'workstation', 'pracovni stanic', 'diskove pole',
      'uloziste', 'zalozni zdroj', ' ups ', 'informacni system', 'wifi', 'wi-fi',
      'access point', ' ict ', ' it ', 'hardware', 'telefonni ustredn', 'pobockova ustredn',
      'videokonferenc', ' nas ', 'cloudov',
    ],
  },
  {
    kat: 'naradi_dilna',
    slova: [
      'naradi', 'vrtack', 'brusk', 'pil', 'svarec', 'svarov', 'kompresor', 'frezk',
      'soustruh', 'dilensk', 'elektrocentral', 'generator', 'sroubovak', 'kladivo',
      ' aku ', 'akumulatorov', 'obrabec', 'lis ', 'vakuov', 'laser', '3d tisk', 'cnc',
      'hoblovk', 'paskova bruska', 'michack', 'sbijeck', 'ohyback', 'strihacka plechu',
      'dilenske vybaveni', 'stavebni stroj',
    ],
  },
  {
    kat: 'zdravotnicke',
    slova: [
      'zdravotnick', 'rentgen', 'ultrazvuk', 'sonograf', 'defibrilator', 'ventilator',
      'monitor pacient', 'operacni stul', 'operacni sal', 'nemocnicni luzko', 'sanitni vozidl',
      'sanitk', 'ambulantni vozidl', 'laboratorni pristroj', 'diagnosticky pristroj',
      'ct pristroj', 'magneticka rezonance', 'stomatologicka souprava', 'zubarske kreslo',
      'infuzni pumpa', 'sterilizator', 'autoklav', 'lekarsk pristroj',
    ],
  },
  {
    kat: 'vozidla',
    slova: [
      'automobil', 'vozidl', 'autobus', 'traktor', 'privesn vozik', 'motocykl', 'skutr',
      'elektromobil', 'hybridni vozidl', 'uzitkove vozidl', 'terenni vozidl', 'vozovy park',
      'nakladni vuz', 'dodavkov automobil',
    ],
  },
  {
    kat: 'stavebni_prace',
    slova: [
      'stavebni prace', 'stavebni uprav', 'rekonstrukc', 'vystavba', 'novostavb',
      'oprava strech', ' strech', 'fasad', 'zatepleni', 'hydroizolac', 'kanalizac',
      'vodovodn', 'elektroinstalac', 'zemni prace', 'oprava komunikace', 'chodnik',
      'silnice', 'mostni konstrukc', 'demolice', 'sanace budov', 'malirsk prace',
      'zednick prace', 'pokladka', 'asfaltov', 'zateplovaci system',
    ],
  },
  {
    kat: 'potraviny',
    slova: [
      'potravin', 'peciv', 'mlecn', 'maso', 'masn', 'ovoce', 'zelenin', 'napoje',
      'skolni strav', 'lahudk', 'pekaren',
    ],
  },
  {
    kat: 'energie',
    slova: [
      'elektricka energie', 'dodavka elektriny', 'elektrin', 'zemni plyn', ' plyn',
      'pohonne hmoty', 'nafta', 'benzin', 'palivo', 'tepelna energie', ' teplo ', 'uhli',
      'biomasa',
    ],
  },
  {
    kat: 'nabytek',
    slova: [
      'nabytek', 'zidl', ' stul', ' stoly', 'skrin', 'regal', 'pohovk', 'kreslo', 'postel',
      'skrink', 'sedaci soupravu', 'konferencni stolek', 'psaci stul', 'skolni lavice',
      'lavice', 'matrace', 'kancelarsky nabytek',
    ],
  },
  {
    kat: 'kancelar',
    slova: [
      'kancelarsk potreb', 'kancelarske potreby', 'papir', 'toner', 'cartridge',
      'psaci potreb', 'sesivac', 'desky na dokumenty', 'obalk', 'skartova', 'kalkulack',
      'razitk', 'kancelar',
    ],
  },
  {
    kat: 'sluzby',
    slova: [
      'uklidov sluzb', ' uklid ', 'uklidove sluzby', 'ostraha', 'bezpecnostni sluzb',
      'pravni sluzb', 'pravni poradenstvi', 'ucetni sluzb', 'audit sluzb', 'preklad sluzb',
      'tlumocnick sluzb', 'poradensk sluzb', 'poradenstv', 'konzultacn sluzb', 'prepravni sluzb',
      'doprava osob', 'stehovaci sluzb', 'stravovaci sluzb', 'pojistovaci sluzb',
      'marketingov sluzb', ' sluzby', ' sluzeb',
    ],
  },
];

/** Přiřadí komoditní kategorii dle klíčových slov v předmětu (bez AI, bez diakritiky). */
export function categorizeCommodity(predmet: string): KomoditaKategorie {
  const p = normalizeForMatch(predmet);
  for (const { kat, slova } of PRIORITY_OVERRIDES) {
    if (slova.some((s) => p.includes(s))) return kat;
  }
  for (const { kat, slova } of CATEGORY_KEYWORDS) {
    if (slova.some((s) => p.includes(s))) return kat;
  }
  return 'ostatni';
}

// ============================================================
// Určení rolí stran (zadavatel vs. dodavatel) — heuristika
// ============================================================

/**
 * V Registru smluv NENÍ role stran spolehlivě dána pořadím:
 * `<subjekt>` = ten, kdo má uveřejňovací povinnost a smlouvu publikoval —
 * může to být kterákoli strana (často DODAVATEL, ne kupující). Nelze proto
 * natvrdo mapovat subjekt→zadavatel a smluvniStrana→dodavatel (systematicky
 * to invertuje — viz docs/win-price-design.md, „Známá omezení").
 *
 * Heuristika: veřejného zadavatele poznáme podle organizačně-právních klíčových
 * slov v názvu (nemocnice, město, kraj, ministerstvo, úřad, škola, …). Pokud
 * právě JEDNA ze stran vypadá jako veřejný zadavatel, přiřadíme jí roli
 * zadavatele a druhé roli dodavatele. Pokud vypadají obě nebo žádná, roli
 * nelze spolehlivě určit (`spolehlive=false`) a ponecháme vstupní pořadí.
 */
const PUBLIC_AUTHORITY_KEYWORDS = [
  'nemocnice', 'poliklinik', 'zdravotní ústav', 'zdravotni ustav', 'zdravotnická záchranná',
  'statutární město', 'statutarni mesto', 'město ', 'mesto ', 'městská část', 'mestska cast',
  'městský obvod', 'mestsky obvod', 'obec ', 'obecní úřad', 'obecni urad', 'kraj', 'krajský úřad',
  'krajsky urad', 'ministerstvo', 'magistrát', 'magistrat', 'úřad', 'urad', 'základní škola',
  'zakladni skola', 'střední škola', 'stredni skola', 'mateřsk', 'matersk', 'gymnázium', 'gymnazium',
  'univerzit', 'vysoká škola', 'vysoka skola', 'fakult', 'správa', 'sprava', 'ústav', 'ustav',
  'ředitelství', 'reditelstvi', 'státní podnik', 'statni podnik', 's. p.', 's.p.',
  'příspěvková organizace', 'prispevkova organizace', 'česká republika', 'ceska republika',
  'čr -', 'cr -', 'policie', 'hasičsk', 'hasicsk', 'vězeňská', 'vezenska', 'akademie věd',
  'akademie ved', 'domov pro seniory', 'domov mládeže', 'domov mladeze', 'muzeum', 'knihovna',
  'divadlo', 'filharmonie', 'technické služby', 'technicke sluzby', 'dopravní podnik',
  'dopravni podnik', 'povodí', 'povodi', 'lesy české', 'lesy ceske', 'správa železnic',
  'sprava zeleznic', 'sociálních služeb', 'socialnich sluzeb', 'centrum sociálních',
  'ředitelství silnic', 'reditelstvi silnic', 'úřad práce', 'urad prace', 'finanční úřad',
  'financni urad', 'katastrální', 'katastralni', 'zoologická', 'zoologicka', 'botanická',
];

/** Vrátí true, pokud název organizace vypadá jako veřejný zadavatel. */
export function looksLikePublicAuthority(nazev: string | null): boolean {
  if (!nazev) return false;
  const n = nazev.toLowerCase();
  return PUBLIC_AUTHORITY_KEYWORDS.some((k) => n.includes(k));
}

export interface Party {
  nazev: string | null;
  ico: string | null;
}

export interface ResolvedRoles {
  zadavatel: Party;
  dodavatel: Party;
  /** true jen když heuristika roli jednoznačně určila (právě jedna strana je veřejný zadavatel). */
  spolehlive: boolean;
}

/**
 * Určí, která ze dvou stran je zadavatel (kupující) a která dodavatel (vítěz).
 * Nespoléhá na pořadí subjekt/smluvniStrana. `a` je vstupní pořadí subjekt,
 * `b` smluvniStrana — použije se jako fallback, když heuristika neurčí roli.
 */
export function resolvePartyRoles(a: Party, b: Party): ResolvedRoles {
  const aPublic = looksLikePublicAuthority(a.nazev);
  const bPublic = looksLikePublicAuthority(b.nazev);

  if (aPublic && !bPublic) {
    return { zadavatel: a, dodavatel: b, spolehlive: true };
  }
  if (bPublic && !aPublic) {
    return { zadavatel: b, dodavatel: a, spolehlive: true };
  }
  // Obě nebo žádná vypadá jako veřejný zadavatel → roli nelze spolehlivě určit.
  return { zadavatel: a, dodavatel: b, spolehlive: false };
}

// ============================================================
// Upsert
// ============================================================

export interface UpsertResult {
  received: number;
  affected: number; // vloženo nebo aktualizováno
}

/**
 * Idempotentně upsertne dávku záznamů dle (zdroj, zdroj_id).
 * Zapisuje po dávkách (chunk), aby se vešel počet parametrů.
 */
export async function upsertWinPrices(records: WinPriceRecord[]): Promise<UpsertResult> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  if (records.length === 0) return { received: 0, affected: 0 };

  const COLS = 15;
  const CHUNK = Math.floor(60000 / COLS); // pod limit 65535 parametrů PG
  let affected = 0;

  const client = await pool.connect();
  try {
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const rows: string[] = [];
      chunk.forEach((r, idx) => {
        const b = idx * COLS;
        rows.push(
          `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},` +
            `$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14},$${b + 15})`,
        );
        values.push(
          r.zdroj,
          r.zdroj_id,
          r.datum,
          r.zadavatel_ico,
          r.zadavatel_nazev,
          r.dodavatel_ico,
          r.dodavatel_nazev,
          r.predmet,
          r.komodita_kategorie,
          r.cena_bez_dph,
          r.cena_s_dph,
          r.mena,
          r.pocet_uchazecu,
          r.url,
          r.raw ? JSON.stringify(r.raw) : null,
        );
      });

      const sql = `
        INSERT INTO win_prices
          (zdroj, zdroj_id, datum, zadavatel_ico, zadavatel_nazev, dodavatel_ico,
           dodavatel_nazev, predmet, komodita_kategorie, cena_bez_dph, cena_s_dph,
           mena, pocet_uchazecu, url, raw)
        VALUES ${rows.join(',')}
        ON CONFLICT (zdroj, zdroj_id) DO UPDATE SET
          datum = EXCLUDED.datum,
          zadavatel_ico = EXCLUDED.zadavatel_ico,
          zadavatel_nazev = EXCLUDED.zadavatel_nazev,
          dodavatel_ico = EXCLUDED.dodavatel_ico,
          dodavatel_nazev = EXCLUDED.dodavatel_nazev,
          predmet = EXCLUDED.predmet,
          komodita_kategorie = EXCLUDED.komodita_kategorie,
          cena_bez_dph = EXCLUDED.cena_bez_dph,
          cena_s_dph = EXCLUDED.cena_s_dph,
          mena = EXCLUDED.mena,
          pocet_uchazecu = EXCLUDED.pocet_uchazecu,
          url = EXCLUDED.url,
          raw = EXCLUDED.raw
      `;
      const res = await client.query(sql, values);
      affected += res.rowCount ?? 0;
    }
  } finally {
    client.release();
  }

  return { received: records.length, affected };
}

/**
 * Smaže záznam dle (zdroj, zdroj_id). Používá win-rate feedback loop (outcomes):
 * když výsledek zakázky přestane nést vítěznou cenu (změna na 'zruseno' / smazání
 * ceny), odstraní se dřívější feedback řádek se zdrojem 'vlastni_vysledek',
 * aby v učicích datech nezůstala zastaralá cena. Vrací počet smazaných řádků.
 */
export async function deleteWinPrice(zdroj: string, zdrojId: string): Promise<number> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  const res = await pool.query('DELETE FROM win_prices WHERE zdroj = $1 AND zdroj_id = $2', [zdroj, zdrojId]);
  return res.rowCount ?? 0;
}

// ============================================================
// Statistiky
// ============================================================

export interface WinPriceStats {
  total: number;
  s_cenou: number;
  min_datum: string | null;
  max_datum: string | null;
  podle_kategorie: Array<{ kategorie: string; pocet: number }>;
}

export async function getWinPriceStats(): Promise<WinPriceStats> {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const { rows: t } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(cena_bez_dph)::int AS s_cenou,
            MIN(datum)::text AS min_datum,
            MAX(datum)::text AS max_datum
     FROM win_prices`,
  );
  const { rows: k } = await pool.query(
    `SELECT komodita_kategorie AS kategorie, COUNT(*)::int AS pocet
     FROM win_prices GROUP BY komodita_kategorie ORDER BY pocet DESC`,
  );
  return {
    total: t[0].total,
    s_cenou: t[0].s_cenou,
    min_datum: t[0].min_datum,
    max_datum: t[0].max_datum,
    podle_kategorie: k,
  };
}
