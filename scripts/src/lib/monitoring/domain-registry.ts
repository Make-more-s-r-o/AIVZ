/**
 * Jediný autoritativní registr oborů používaný monitoringem, win-price,
 * go/no-go skórováním i sektorovým filtrem matcheru.
 *
 * Pravidla jsou verzovaná, aby změna klasifikace byla dohledatelná. CPV má při
 * kategorizaci přednost před textem; název je bezpečný fallback pro zdroje bez CPV.
 */

export const DOMAIN_REGISTRY_VERSION = 1;

export type DomainCategory =
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

export interface DomainWeights {
  /** Priorita textové kategorie při kolizi obecných kořenů. */
  title: number;
  /** Priorita doloženého CPV pravidla; CPV jako celek má přednost před názvem. */
  cpv: number;
  /** Výslovné řešení známých kolizí bez zavedení čtvrtého seznamu pravidel. */
  keywordBoosts?: Readonly<Record<string, number>>;
}

export interface DomainDefinition {
  category: DomainCategory;
  label: string;
  aliases: readonly string[];
  /** Normalizované textové kořeny; mezery kolem krátkého slova vymezují celé slovo. */
  keywords: readonly string[];
  /** Prefixy kratší než 8 číslic by byly prefixové; 8 číslic se porovnává pouze přesně. */
  cpvPrefixes: readonly string[];
  weights: DomainWeights;
}

const domains: DomainDefinition[] = [
  {
    category: 'it_av',
    label: 'IT a audiovizuální technika',
    aliases: ['IT', 'AV', 'IT/AV', 'IT-AV', 'ICT'],
    keywords: [
      'server', 'notebook', 'laptop', 'ultrabook', 'pocitac', 'desktop', 'thin client',
      'monitor', 'display', 'projektor', 'dataprojektor', 'projekcn', 'platno',
      'tiskarn', 'kopirk', 'multifunkcni zarizeni', 'multifunkce', 'plotr', 'plotter',
      'switch', 'router', 'firewall', 'kamer', 'cctv', 'nvr', 'dvr', 'software',
      'licenc', 'operacni system', ' windows ', 'sitov', 'vypocetni technik',
      'datove uloziste', 'uloziste dat', ' storage ', 'ssd', 'harddisk', 'pevny disk',
      'procesor', 'tablet', 'mobilni telefon', 'chytry telefon', 'skener', 'scanner',
      'ozvucen', 'audio', 'mikrofon', 'reproduktor', 'sluchatk', 'zesilovac', ' mixer ',
      'video technik', 'interaktivni tabul', 'smartboard', 'interaktivni displej',
      'workstation', 'pracovni stanic', 'diskove pole', 'uloziste', 'zalozni zdroj',
      ' ups ', 'informacni system', 'wifi', 'wi-fi', 'access point', ' ict ', ' it ',
      'hardware', 'telefonni ustredn', 'pobockova ustredn', 'videokonferenc', 'webkamer',
      ' nas ', ' rack ', 'cloudov', 'dokovaci stanic', ' dock ', 'led panel',
      'display panel', 'digital signage',
    ],
    cpvPrefixes: [],
    weights: { title: 1_000, cpv: 10_000 },
  },
  {
    category: 'naradi_dilna',
    label: 'Nářadí a dílenské vybavení',
    aliases: ['naradi', 'nářadí', 'dilna', 'dílna', 'dilenske vybaveni'],
    keywords: [
      'naradi', 'vrtack', 'brusk', 'pil', 'svarec', 'svarov', 'kompresor', 'frezk',
      'soustruh', 'dilensk', 'elektrocentral', 'generator', 'sroubovak', 'kladivo',
      ' aku ', 'akumulatorov', 'obrabec', ' lis ', 'vakuov', 'laser', '3d tisk', 'cnc',
      'hoblovk', 'paskova bruska', 'michack', 'sbijeck', 'ohyback', 'strihacka plechu',
      'dilenske vybaveni', 'stavebni stroj',
    ],
    // Zadání dokládá právě tento osmimístný kód. Záměrně z něj neděláme širší 4451 prefix.
    cpvPrefixes: ['44510000'],
    weights: { title: 990, cpv: 10_000, keywordBoosts: { '3d tisk': 100 } },
  },
  {
    category: 'zdravotnicke',
    label: 'Zdravotnická technika',
    aliases: ['zdravotnictvi', 'zdravotnictví', 'medical'],
    keywords: [
      'zdravotnick', 'rentgen', 'ultrazvuk', 'sonograf', 'defibrilator', 'ventilator',
      'monitor pacient', 'operacni stul', 'operacni sal', 'nemocnicni luzko',
      'sanitni vozidl', 'sanitk', 'ambulantni vozidl', 'laboratorni pristroj',
      'diagnosticky pristroj', 'ct pristroj', 'magneticka rezonance',
      'stomatologicka souprava', 'zubarske kreslo', 'infuzni pumpa', 'sterilizator',
      'autoklav', 'lekarsk pristroj',
    ],
    cpvPrefixes: [],
    weights: {
      title: 980,
      cpv: 10_000,
      keywordBoosts: {
        'monitor pacient': 100,
        'operacni stul': 100,
        'operacni sal': 100,
        'nemocnicni luzko': 100,
        'sanitni vozidl': 100,
        sanitk: 100,
        'ambulantni vozidl': 100,
      },
    },
  },
  {
    category: 'vozidla',
    label: 'Vozidla',
    aliases: ['automobily', 'automotive'],
    keywords: [
      'automobil', 'vozidl', 'autobus', 'traktor', 'privesn vozik', 'motocykl', 'skutr',
      'elektromobil', 'hybridni vozidl', 'uzitkove vozidl', 'terenni vozidl',
      'vozovy park', 'nakladni vuz', 'dodavkov automobil',
    ],
    cpvPrefixes: [],
    weights: { title: 970, cpv: 10_000 },
  },
  {
    category: 'stavebni_prace',
    label: 'Stavební práce',
    aliases: ['stavebnictvi', 'stavebnictví', 'stavby'],
    keywords: [
      'stavebni prace', 'stavebni uprav', 'rekonstrukc', 'vystavba', 'novostavb',
      'oprava strech', ' strech', 'fasad', 'zatepleni', 'hydroizolac', 'kanalizac',
      'vodovodn', 'elektroinstalac', 'zemni prace', 'oprava komunikace', 'chodnik',
      'silnice', 'mostni konstrukc', 'demolice', 'sanace budov', 'malirsk prace',
      'zednick prace', 'pokladka', 'asfaltov', 'zateplovaci system',
    ],
    cpvPrefixes: [],
    weights: { title: 960, cpv: 10_000 },
  },
  {
    category: 'potraviny',
    label: 'Potraviny',
    aliases: ['jidlo', 'jídlo', 'food'],
    keywords: [
      'potravin', 'peciv', 'mlecn', 'maso', 'masn', 'ovoce', 'zelenin', 'napoje',
      'skolni strav', 'lahudk', 'pekaren',
    ],
    cpvPrefixes: [],
    weights: { title: 950, cpv: 10_000 },
  },
  {
    category: 'energie',
    label: 'Energie a paliva',
    aliases: ['energy', 'paliva'],
    keywords: [
      'elektricka energie', 'dodavka elektriny', 'elektrin', 'zemni plyn', ' plyn',
      'pohonne hmoty', 'nafta', 'benzin', 'palivo', 'tepelna energie', ' teplo ',
      'uhli', 'biomasa',
    ],
    cpvPrefixes: [],
    weights: { title: 940, cpv: 10_000 },
  },
  {
    category: 'nabytek',
    label: 'Nábytek',
    aliases: ['nábytek', 'furniture'],
    keywords: [
      'nabytek', 'zidl', ' stul', ' stoly', 'skrin', 'regal', 'pohovk', 'kreslo',
      'postel', 'skrink', 'sedaci soupravu', 'konferencni stolek', 'psaci stul',
      'pracovni stul', 'skolni lavice', 'lavice', 'matrace', 'kancelarsky nabytek',
      'sedack', 'kontejner', 'recepc',
    ],
    // Bez ověřeného číselníku zůstává nábytek úmyslně bez CPV pravidla.
    cpvPrefixes: [],
    weights: { title: 930, cpv: 10_000 },
  },
  {
    category: 'kancelar',
    label: 'Kancelářské potřeby',
    aliases: ['kancelarsky', 'kancelářský', 'kancelarske potreby', 'office'],
    keywords: [
      'kancelarsk potreb', 'kancelarske potreby', 'papir', 'toner', 'cartridge',
      'napln', 'inkoust', 'psaci potreb', 'sesivac', 'desky na dokumenty', 'obalk',
      'skartova', 'kalkulack', 'razitk', 'kancelar', ' slozka', 'sanon', 'poradac',
      ' pero ', ' tuzka ', ' fix ', ' a4 ', ' a3 ',
    ],
    cpvPrefixes: [],
    weights: { title: 920, cpv: 10_000 },
  },
  {
    category: 'sluzby',
    label: 'Služby',
    aliases: ['sluzba', 'služba', 'services'],
    keywords: [
      'uklidov sluzb', ' uklid ', 'uklidove sluzby', 'ostraha', 'bezpecnostni sluzb',
      'pravni sluzb', 'pravni poradenstvi', 'ucetni sluzb', 'audit sluzb',
      'preklad sluzb', 'tlumocnick sluzb', 'poradensk sluzb', 'poradenstv',
      'konzultacn sluzb', 'prepravni sluzb', 'doprava osob', 'stehovaci sluzb',
      'stravovaci sluzb', 'pojistovaci sluzb', 'marketingov sluzb', ' sluzby', ' sluzeb',
    ],
    cpvPrefixes: [],
    weights: { title: 910, cpv: 10_000 },
  },
  {
    category: 'ostatni',
    label: 'Ostatní',
    aliases: ['ostatní', 'other', 'nezname', 'neznámé'],
    keywords: [],
    cpvPrefixes: [],
    weights: { title: 0, cpv: 0 },
  },
];

/** Veřejný seznam je odvozen přímo z definic, takže nemůže vzniknout druhá taxonomie. */
export const DOMAIN_CATEGORY_VALUES: DomainCategory[] = domains.map((domain) => domain.category);

export const DOMAIN_REGISTRY: Readonly<{
  version: number;
  domains: readonly DomainDefinition[];
  notes: readonly string[];
}> = {
  version: DOMAIN_REGISTRY_VERSION,
  domains,
  notes: [
    '3D tisk je naradi_dilna: jde o dílenské/výukové výrobní zařízení; starý matcher jej řadil do IT.',
    'CPV 44510000 je doložené zadáním pouze jako přesný osmimístný kód pro naradi_dilna; širší prefix není použit.',
    'Nábytek nemá bez ověřeného CPV číselníku žádný CPV prefix.',
  ],
};

function normalizeAlias(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeForKeywordMatch(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return ` ${normalized} `;
}

const DOMAIN_BY_ALIAS = new Map<string, DomainCategory>();
for (const domain of DOMAIN_REGISTRY.domains) {
  for (const value of [domain.category, ...domain.aliases]) {
    const alias = normalizeAlias(value);
    const existing = DOMAIN_BY_ALIAS.get(alias);
    if (existing && existing !== domain.category) {
      throw new Error(`Domain registry v${DOMAIN_REGISTRY.version}: alias "${value}" koliduje mezi ${existing} a ${domain.category}`);
    }
    DOMAIN_BY_ALIAS.set(alias, domain.category);
  }
}

/** Převede veřejný slug i legacy názvy (IT, AV, kancelarsky) na kanonickou kategorii. */
export function resolveDomainCategory(value: unknown): DomainCategory | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return DOMAIN_BY_ALIAS.get(normalizeAlias(value)) ?? null;
}

/** Kanonizuje seznam oborů a odstraní duplicity vzniklé např. aliasy IT + AV. */
export function normalizeDomainCategories(values: readonly unknown[] | null | undefined): DomainCategory[] {
  const normalized = (values ?? []).flatMap((value) => {
    const category = resolveDomainCategory(value);
    return category ? [category] : [];
  });
  return [...new Set(normalized)];
}

/** Ověří kategorii/alias proti seznamu oborů firmy se zachováním legacy aliasů. */
export function domainMatches(
  categoryOrAlias: unknown,
  acceptedDomains: readonly unknown[] | null | undefined,
): boolean {
  const category = resolveDomainCategory(categoryOrAlias);
  return category !== null && normalizeDomainCategories(acceptedDomains).includes(category);
}

function collectCpvCodes(value: unknown, target: Set<string>, seen: Set<object>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(/(?:^|\D)(\d{8})(?:-\d)?(?=\D|$)/g)) {
      target.add(match[1]);
    }
    return;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    const code = String(value);
    if (/^\d{8}$/.test(code)) target.add(code);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCpvCodes(item, target, seen);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectCpvCodes(nested, target, seen);
  }
}

/** Normalizuje běžné Hlídač CPV tvary, včetně `44510000-8` a objektů s polem kódu. */
export function normalizeCpvCodes(value: unknown): string[] {
  const codes = new Set<string>();
  collectCpvCodes(value, codes, new Set<object>());
  return [...codes];
}

function matchingCpvCategory(cpv: unknown): DomainCategory | null {
  const codes = normalizeCpvCodes(cpv);
  let best: { category: DomainCategory; score: number } | null = null;

  for (const domain of DOMAIN_REGISTRY.domains) {
    for (const prefix of domain.cpvPrefixes) {
      const matched = codes.some((code) => prefix.length === 8 ? code === prefix : code.startsWith(prefix));
      if (!matched) continue;
      const score = domain.weights.cpv + prefix.length;
      if (!best || score > best.score) best = { category: domain.category, score };
    }
  }
  return best?.category ?? null;
}

function matchingTitleCategory(title: string): DomainCategory {
  const normalized = normalizeForKeywordMatch(title);
  let best: { category: DomainCategory; score: number } | null = null;

  for (const domain of DOMAIN_REGISTRY.domains) {
    for (const keyword of domain.keywords) {
      if (!normalized.includes(keyword)) continue;
      const boost = domain.weights.keywordBoosts?.[keyword] ?? 0;
      const score = domain.weights.title + boost;
      if (!best || score > best.score) best = { category: domain.category, score };
    }
  }
  return best?.category ?? 'ostatni';
}

/** CPV-first kategorizace zakázky; název slouží jako fallback. */
export function categorizeTender(title: string, cpv?: unknown): DomainCategory {
  return matchingCpvCategory(cpv) ?? matchingTitleCategory(title);
}

/** Legacy jednovstupový název používaný win-price importem. */
export function categorizeCommodity(title: string): DomainCategory {
  return categorizeTender(title);
}

/** Prompt matcheru je sestaven přímo z registru, ne z další ruční taxonomie. */
export function buildDomainClassificationPrompt(): string {
  const lines = DOMAIN_REGISTRY.domains.map((domain) => {
    const examples = domain.keywords
      .slice(0, 10)
      .map((keyword) => keyword.trim())
      .filter(Boolean)
      .join(', ');
    return `- ${domain.category}: ${domain.label}${examples ? ` (např. ${examples})` : ''}`;
  });
  return [
    'Klasifikuj každou položku do právě jednoho kanonického sektoru.',
    `Použij pouze tyto sektory registru v${DOMAIN_REGISTRY.version}:`,
    ...lines,
    'Odpověz POUZE JSON polem ve tvaru [{"index":0,"sektor":"it_av"}].',
  ].join('\n');
}
