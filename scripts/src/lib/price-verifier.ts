/**
 * Ověřování cen web-searchem.
 *
 * Pro vybraného kandidáta (výrobce + model) každé položky dohledá REÁLNOU aktuální
 * cenu a dostupnost v českých e-shopech přes Anthropic web search tool a vrátí ji
 * jako NÁVRH v poli `overeni_ceny`.
 *
 * DŮLEŽITÉ: tento modul NIKDY nesahá na `cenova_uprava` — tu potvrzuje uživatel
 * v UI (money-path). `overeni_ceny` je pouze podklad pro rozhodnutí.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { z } from 'zod';
import { resolveModelId, getModelPricing } from './ai-client.js';
import { logCost } from './cost-tracker.js';
import { compareAiVsMarket } from './price-reality.js';
import type {
  ProductMatch,
  ProductCandidate,
  PolozkaMatch,
  TenderAnalysis,
  OvereniCeny as StoredOvereniCeny,
  WebPriceSource,
} from './types.js';

config({ path: new URL('../../../.env', import.meta.url).pathname });

// Stejný kurz jako v ai-client.ts (USD → CZK) — použit pro cenu web searchů
const USD_TO_CZK = 24;
// Web search je účtován $10 za 1000 requestů (tokeny se počítají zvlášť)
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;
// Každá fáze dostává vlastní wall-clock rozpočet; fallback tedy nedědí vyčerpaný čas fáze 1.
export const WEB_SEARCH_PHASE_TIMEOUT_MS = 4 * 60 * 1000;
export const EQUIVALENT_MAX_SEARCHES = 3;
export const ANTHROPIC_CREDIT_ERROR_MESSAGE = 'Došel kredit Anthropic API — ověřování zastaveno, žádná data nebyla přepsána.';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Server-side web search může být pomalý; stejný strop hlídáme i wall-clock deadlinem fáze.
  timeout: WEB_SEARCH_PHASE_TIMEOUT_MS,
  // Vlastní retry loop níže (createWithRetry) — SDK retry vypnut kvůli kontrole nad 429/5xx
  maxRetries: 0,
});

// ----------------------------------------------------------------------------
// Veřejný kontrakt uloženého návrhu (FE na tomto poli staví)
// ----------------------------------------------------------------------------
export type OvereniCeny = StoredOvereniCeny;
export type { WebPriceSource };

export interface VerifyInput {
  vyrobce: string;
  model: string;
  nazev?: string;
  specifikace?: string;
  mnozstvi?: number;
  jednotka?: string;
  /** AI odhad jednotkové ceny bez DPH, pouze pro porovnání s reálným trhem. */
  ai_cena_bez_dph?: number | null;
  // Cenový strop položky (s DPH) — pro výpočet prekracuje_strop
  cena_max_s_dph?: number | null;
}

export interface VerifyItemOptions {
  /** 'sonnet' | 'haiku' | 'opus' | explicitní model ID. Default 'sonnet'. */
  model?: string;
  /** Max počet web searchů na položku. Default 3. */
  maxSearches?: number;
  /** Injekce klienta pro deterministické testy bez síťového volání. */
  aiClient?: PriceVerifierAiClient;
}

export interface PriceVerifierAiClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<Anthropic.Message>;
  };
}

export interface VerifyAllOptions extends VerifyItemOptions {
  tenderId: string;
  /** Autoritativní zadání z analysis.json; bez něj se ekvivalenty nepovolují. */
  analysis?: TenderAnalysis;
  /** Ověř jen prvních N položek (v pořadí). */
  limit?: number;
  /** Ověř jen položku s tímto polozka_index. */
  onlyIndex?: number;
  /** Max souběžně ověřovaných položek. Default 3. */
  concurrency?: number;
  /** Callback pro průběžné logování (např. do konzole). */
  onProgress?: (msg: string) => void;
}

export interface ItemVerification {
  polozka_index: number; // -1 = single-product root
  polozka_nazev: string;
  overeni_ceny: OvereniCeny;
}

export interface VerifyAllResult {
  results: ItemVerification[];
  summary: {
    total: number;
    nalezeno: number;
    nenalezeno: number;
    orientacni: number;
    chyba: number;
    prekracuje_strop: number;
    faze1_nalezeno: number;
    faze2_nalezeno: number;
    realny_nakup_vyssi_nez_ai: number;
    prumerny_narust_procent: number | null;
    searches: number;
    inputTokens: number;
    outputTokens: number;
    costCZK: number;
    modelId: string;
    preruseno_kvuli_kreditu: boolean;
  };
}

// ----------------------------------------------------------------------------
// Prompty jednotlivých fází
// ----------------------------------------------------------------------------
function exactPriceVerifySystem(): string {
  return `Jsi asistent nákupčího ve veřejných zakázkách. Tvým úkolem je pomocí web search dohledat AKTUÁLNÍ tržní cenu zboží v českých e-shopech.

Pravidla:
- Hledej výhradně v českých e-shopech (ceny v Kč, doména .cz).
- Hledej pouze přesný produkt podle uvedeného výrobce a modelu. Nalezené zdroje označ shoda_typ="presny".
- Výrobce a model níže jsou NEZÁVAZNÝ ODHAD AI, ne požadavek zadavatele.
- V této fázi nenabízej jinou značku ani náhradní produkt. Pokud přesný produkt nenajdeš, vrať nalezeno=false.
- Pokud ověříš, že model neexistuje nebo má proti zadání jiné parametry, napiš tento závěr výslovně a konkrétně do poznamka. Samotné „nenalezeno“ není důkaz neexistence.
- U každého zdroje zjisti skutečný počet kusů v prodávaném balení (baleni_ks) a cenu celého balení s DPH (cena_baleni_s_dph). Nic nepřepočítávej na fiktivní jednotlivý kus. Pokud e-shop jasně prodává po jednom kusu, nastav baleni_ks=1 a prodava_po_kusech=true. Když počet kusů nelze ověřit, nastav baleni_ks=null a prodava_po_kusech=false.
- Najdi až 3 různé nákupní zdroje. Preferuj e-shopy, kde je produkt skladem a s jasně uvedenou cenou.
- Uveď cenu celého balení bez DPH i s DPH. Uveď sazba_dph=21, jen když je známá nebo jde o běžné zboží s typickou sazbou; jinak sazba_dph=null.
- U každého zdroje vrať přímý odkaz na konkrétní produktovou stránku, ne odkaz na výsledky vyhledávání.
- U každého zdroje vrať v nazev_produktu skutečný název produktu z produktové stránky.
- Zdroje seřaď od nejlevnějšího podle ceny s DPH. Neopakuj stejnou URL.

Odpověz VÝHRADNĚ jedním JSON objektem jako ÚPLNĚ POSLEDNÍ blok textu, bez jakéhokoli komentáře za ním, přesně v tomto tvaru:
{"nalezeno": true|false, "shoda_typ": "presny", "mena": "CZK", "zdroje": [{"url": "https://...", "dodavatel": "název e-shopu", "nazev_produktu": "skutečný název nalezeného produktu", "mena": "CZK", "cena_bez_dph": číslo|null, "cena_s_dph": číslo|null, "cena_baleni_s_dph": číslo|null, "baleni_ks": číslo|null, "prodava_po_kusech": true|false, "sazba_dph": 21|null, "dostupnost": "skladem|na dotaz|není skladem|neznámá", "splnuje_specifikaci": true|false, "shoda_parametru": ["ověřený parametr"], "poznamka": "krátká poznámka"}], "poznamka": "volitelná souhrnná poznámka"}
Když přesný produkt nenajdeš, vrať {"nalezeno": false, "shoda_typ": "presny", "mena": "CZK", "zdroje": [], "poznamka": "důvod"}.
Ceny uváděj jako čistá čísla bez měny a mezer (např. 3509, ne "3 509 Kč").`;
}

function equivalentPriceVerifySystem(): string {
  return `Jsi asistent nákupčího ve veřejných zakázkách. Pomocí web search dohledáváš aktuální tržní ceny komoditního zboží v českých e-shopech.

Zadavatel nepředepisuje značku. Najdi v českých e-shopech konkrétní produkty, které splňují VŠECHNA závazná kritéria. Vrať až 3 nejlevnější reálné nákupní zdroje.

Pravidla:
- Hledej výhradně v českých e-shopech (ceny v Kč, doména .cz).
- Každý zdroj označ shoda_typ="ekvivalent".
- U KAŽDÉHO zdroje je POVINNÉ vyplnit nazev_produktu (přesný název z e-shopu) a shoda_parametru (které parametry jsi ověřil).
- Pokud si u některého parametru NEJSI jistý, uveď splnuje_specifikaci=false, ale zdroj i tak vrať — operátor si ho ověří sám.
- splnuje_specifikaci=true použij pouze tehdy, když jsou na produktové stránce doložena všechna závazná kritéria.
- U každého zdroje zjisti skutečný počet kusů v prodávaném balení (baleni_ks) a cenu celého balení s DPH (cena_baleni_s_dph). Nic nepřepočítávej na fiktivní jednotlivý kus. Pokud e-shop jasně prodává po jednom kusu, nastav baleni_ks=1 a prodava_po_kusech=true. Když počet kusů nelze ověřit, nastav baleni_ks=null a prodava_po_kusech=false.
- Preferuj zboží skladem s jasně uvedenou cenou. Uveď cenu celého balení bez DPH i s DPH. Uveď sazba_dph=21, jen když je známá nebo jde o běžné zboží s typickou sazbou; jinak sazba_dph=null.
- Vrať přímý HTTPS odkaz na konkrétní produktovou stránku, nikdy na výsledky vyhledávání, a skutečný název z této stránky.
- Zdroje seřaď od nejlevnějšího podle ceny s DPH a neopakuj stejnou URL.

Odpověz VÝHRADNĚ jedním JSON objektem jako ÚPLNĚ POSLEDNÍ blok textu, bez jakéhokoli komentáře za ním, přesně v tomto tvaru:
{"nalezeno": true|false, "shoda_typ": "ekvivalent", "mena": "CZK", "zdroje": [{"url": "https://...", "dodavatel": "název e-shopu", "nazev_produktu": "skutečný název nalezeného produktu", "mena": "CZK", "cena_bez_dph": číslo|null, "cena_s_dph": číslo|null, "cena_baleni_s_dph": číslo|null, "baleni_ks": číslo|null, "prodava_po_kusech": true|false, "sazba_dph": 21|null, "dostupnost": "skladem|na dotaz|není skladem|neznámá", "splnuje_specifikaci": true|false, "shoda_parametru": ["ověřený parametr"], "poznamka": "krátká poznámka"}], "poznamka": "volitelná souhrnná poznámka"}
Když nenajdeš ani orientační produktovou stránku s cenou, vrať {"nalezeno": false, "shoda_typ": "ekvivalent", "mena": "CZK", "zdroje": [], "poznamka": "důvod"}.
Ceny uváděj jako čistá čísla bez měny a mezer (např. 3509, ne "3 509 Kč").`;
}

function buildExactUserMessage(input: VerifyInput): string {
  const lines: string[] = [
    'Najdi aktuální cenu tohoto produktu v českých e-shopech:',
    `Výrobce: ${input.vyrobce}`,
    `Model: ${input.model}`,
  ];
  if (input.nazev) lines.push(`Název položky: ${input.nazev}`);
  if (input.specifikace) {
    lines.push('', 'ZÁVAZNÁ KRITÉRIA ZADAVATELE — použij pouze ke kontrole přesného produktu:', input.specifikace);
  } else {
    lines.push('', 'AUTORITATIVNÍ SPECIFIKACE CHYBÍ.');
  }
  lines.push(`Množství v zakázce: ${input.mnozstvi ?? 1}`);
  lines.push(`Jednotka položky: ${input.jednotka?.trim() || 'ks'}`);
  lines.push('Vrať cenu celého skutečně prodávaného balení a počet kusů v balení.');
  return lines.join('\n');
}

/** Druhá fáze vědomě nepřijímá ani nečte AI identitu kandidáta. */
function buildEquivalentUserMessage(input: Pick<VerifyInput, 'nazev' | 'specifikace' | 'mnozstvi' | 'jednotka'>): string {
  return [
    `Název položky ze zadání: ${input.nazev?.trim() || 'Neuveden'}`,
    '',
    'ZÁVAZNÁ KRITÉRIA ZADAVATELE — nalezený produkt musí splnit všechna:',
    input.specifikace?.trim() || '',
    '',
    `Množství v zakázce: ${input.mnozstvi ?? 1}`,
    `Jednotka položky: ${input.jednotka?.trim() || 'ks'}`,
    'Vrať cenu celého skutečně prodávaného balení a počet kusů v balení.',
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Robustní parsování odpovědi
// ----------------------------------------------------------------------------

// Lenient schéma — čísla/booleany přijímáme i jako string, dočistíme níže
const RawWebPriceSourceSchema = z
  .object({
    url: z.union([z.string(), z.null()]).optional(),
    // Tolerujeme i starší pojmenování, pokud ho model navzdory promptu použije.
    zdroj_url: z.union([z.string(), z.null()]).optional(),
    dodavatel: z.union([z.string(), z.null()]).optional(),
    nazev_produktu: z.union([z.string(), z.null()]).optional(),
    cena_bez_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    cena_s_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    cena_baleni_s_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    baleni_ks: z.union([z.number(), z.string(), z.null()]).optional(),
    prodava_po_kusech: z.union([z.boolean(), z.string(), z.null()]).optional(),
    sazba_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    mena: z.union([z.string(), z.null()]).optional(),
    dostupnost: z.union([z.string(), z.null()]).optional(),
    splnuje_specifikaci: z.union([z.boolean(), z.string(), z.null()]).optional(),
    shoda_parametru: z.array(z.string()).optional(),
    poznamka: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const RawWebPriceSchema = z
  .object({
    nalezeno: z.union([z.boolean(), z.string()]).optional(),
    shoda_typ: z.enum(['presny', 'ekvivalent']).optional(),
    cena_bez_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    cena_s_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    mena: z.union([z.string(), z.null()]).optional(),
    zdroj_url: z.union([z.string(), z.null()]).optional(),
    dodavatel: z.union([z.string(), z.null()]).optional(),
    nazev_produktu: z.union([z.string(), z.null()]).optional(),
    dostupnost: z.union([z.string(), z.null()]).optional(),
    poznamka: z.union([z.string(), z.null()]).optional(),
    zdroje: z.array(RawWebPriceSourceSchema).optional(),
  })
  .passthrough();

/** Najde poslední vyvážený JSON objekt v textu (preferuje ```json blok). */
function extractJsonObject(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim().startsWith('{')) {
    return fence[1].trim();
  }
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  let last: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) last = text.slice(start, i + 1);
    }
  }
  return last;
}

/** Převede "3 509,00 Kč" / "3509" / 3509 na číslo. */
function coerceNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') {
    let s = v.replace(/[^\d.,-]/g, '').trim();
    if (!s) return undefined;
    // CZ formát: tečka = tisíce, čárka = desetinná
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function coerceBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^(true|ano|yes|1)$/i.test(v.trim());
  return false;
}

function cleanStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
}

/**
 * Sanitizace URL zdroje ceny u ZDROJE. AI vrací `zdroj_url`, který se v UI renderuje jako
 * `href` a skládá do poznámky → nesmí projít `javascript:`/`data:` schéma (XSS). Povolíme
 * jen absolutní http(s) URL; cokoli jiného → undefined. Frontend sanitizuje ještě jednou
 * (defense-in-depth), ale primární obrana je tady, ať se nebezpečná hodnota vůbec neuloží.
 */
function cleanUrl(v: unknown): string | undefined {
  const s = cleanStr(v);
  if (!s) return undefined;
  try {
    const url = new URL(s);
    if (url.protocol !== 'https:') return undefined;
    const host = url.hostname.toLowerCase();
    if (host === 'google.cz' || host.endsWith('.google.cz') || host === 'google.com' || host.endsWith('.google.com')) return undefined;
    if (host === 'seznam.cz' || host.endsWith('.seznam.cz')) return undefined;
    const searchPath = /(^|\/)(search|hledat|vyhledavani|vysledky)(\/|$)/i.test(url.pathname);
    const searchQuery = [...url.searchParams.keys()].some((key) => /^(q|query|search|keyword|text|h\[.*\])$/i.test(key));
    if (searchPath || searchQuery) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

type RawWebPriceSource = z.infer<typeof RawWebPriceSourceSchema>;

function normalizeAvailability(value: unknown): WebPriceSource['dostupnost'] {
  const normalized = cleanStr(value)?.toLowerCase() ?? '';
  if (/nen[ií]\s+skladem|vyprod[aá]no|nedostup/.test(normalized)) return 'není skladem';
  if (/na\s+dotaz|objedn[aá]vk/.test(normalized)) return 'na dotaz';
  if (/skladem|ihned|k\s+odesl[aá]n/.test(normalized)) return 'skladem';
  return 'neznámá';
}

function addNote(original: unknown, additions: string[]): string | null {
  return [cleanStr(original), ...additions].filter(Boolean).join(' | ') || null;
}

interface SourceContext {
  currency: string | undefined;
  equivalent: boolean;
}

/** Normalizuje jeden AI nález. Bez bezpečné URL nebo bez ceny nejde o nákupní zdroj. */
function normalizeSource(raw: RawWebPriceSource, context: SourceContext): WebPriceSource | null {
  const url = cleanUrl(raw.url ?? raw.zdroj_url);
  const currency = (cleanStr(raw.mena) ?? context.currency)?.toUpperCase();
  const productName = cleanStr(raw.nazev_produktu);
  const meetsSpecification = coerceBool(raw.splnuje_specifikaci);
  const matchedParameters = raw.shoda_parametru?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (!url || currency !== 'CZK') return null;
  const orientational = context.equivalent
    && (!productName || !meetsSpecification || matchedParameters.length === 0);

  let net = coerceNumber(raw.cena_bez_dph);
  let gross = coerceNumber(raw.cena_baleni_s_dph) ?? coerceNumber(raw.cena_s_dph);
  if (net !== undefined && net <= 0) net = undefined;
  if (gross !== undefined && gross <= 0) gross = undefined;
  if (net === undefined && gross === undefined) return null;

  const notes: string[] = [];
  const rawRate = raw.sazba_dph === null ? null : coerceNumber(raw.sazba_dph);
  const taxRate = raw.sazba_dph === null ? null : (rawRate && rawRate > 0 ? rawRate : 21);
  if (net !== undefined && gross !== undefined) {
    const ratio = gross / net;
    if (Math.abs(ratio - 1.21) > 1.21 * 0.03) {
      gross = Math.round(net * 1.21 * 100) / 100;
      notes.push('Nekonzistentní ceny s/bez DPH; cena s DPH byla dopočtena z ceny bez DPH sazbou 21 %.');
    }
  } else if (net !== undefined) {
    gross = Math.round(net * (1 + (taxRate ?? 21) / 100) * 100) / 100;
    notes.push(`Cena s DPH dopočtena z ceny bez DPH (DPH ${taxRate ?? 21} %).`);
  } else if (gross !== undefined && taxRate !== null) {
    net = Math.round((gross / (1 + taxRate / 100)) * 100) / 100;
    notes.push(`Cena bez DPH dopočtena z ceny s DPH (DPH ${taxRate} %).`);
  } else {
    notes.push('Sazba DPH je nejasná; ochrana proti ztrátě použije cenu s DPH jako konzervativní horní odhad.');
  }

  let packageSize = coerceNumber(raw.baleni_ks);
  if (packageSize !== undefined && packageSize <= 0) packageSize = undefined;
  if (packageSize === undefined && coerceBool(raw.prodava_po_kusech)) packageSize = 1;
  if (packageSize === undefined) notes.push('Počet kusů v balení je nejasný; zdroj se do ochrany proti ztrátě nezapočítá.');

  return {
    url,
    dodavatel: cleanStr(raw.dodavatel) ?? null,
    ...(productName ? { nazev_produktu: productName } : {}),
    cena_bez_dph: net ?? null,
    cena_s_dph: gross ?? null,
    cena_baleni_s_dph: gross ?? null,
    baleni_ks: packageSize ?? null,
    mena: 'CZK',
    sazba_dph: taxRate,
    dostupnost: normalizeAvailability(raw.dostupnost),
    poznamka: addNote(raw.poznamka, notes),
    ...(context.equivalent ? {
      splnuje_specifikaci: meetsSpecification,
      shoda_parametru: matchedParameters,
      ...(orientational ? { orientacni: true } : {}),
    } : {}),
  };
}

/** Srovnávací cena s DPH; chybějící protějšek dopočítáme pouze pro řazení. */
function sourceGrossPrice(source: WebPriceSource): number {
  return source.cena_s_dph ?? (source.cena_bez_dph !== null ? source.cena_bez_dph * 1.21 : Number.POSITIVE_INFINITY);
}

/**
 * Čistý parser odpovědi AI, exportovaný pro fixture testy. Podporuje nový seznam
 * `zdroje` i původní top-level kontrakt a vždy naplní legacy top-level pole z
 * nejlevnějšího validního zdroje.
 */
export function parseWebPriceResponse(
  text: string,
  input: Pick<VerifyInput, 'cena_max_s_dph' | 'ai_cena_bez_dph' | 'specifikace' | 'mnozstvi'> = {},
  overenoAt = new Date().toISOString(),
  forcedMatchType?: 'presny' | 'ekvivalent',
): OvereniCeny {
  const quantity = input.mnozstvi ?? 1;
  const emptyReality = compareAiVsMarket(input.ai_cena_bez_dph ?? null, [], quantity);
  const jsonStr = extractJsonObject(text);
  if (!jsonStr) {
    return { stav: 'nenalezeno', poznamka: 'AI nevrátila strukturovanou odpověď', overeno_at: overenoAt, realita: emptyReality };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { stav: 'nenalezeno', poznamka: 'Odpověď AI nešla naparsovat jako JSON', overeno_at: overenoAt, realita: emptyReality };
  }

  const valid = RawWebPriceSchema.safeParse(parsed);
  if (!valid.success) {
    return { stav: 'nenalezeno', poznamka: 'Odpověď AI neodpovídá očekávanému tvaru', overeno_at: overenoAt, realita: emptyReality };
  }

  const raw = valid.data;
  // Interní dvoufázový běh vynucuje typ podle fáze; veřejný parser zůstává
  // zpětně kompatibilní a bez parametru respektuje kontrakt odpovědi.
  const shodaTyp = forcedMatchType ?? raw.shoda_typ ?? 'presny';
  const authoritativeSpecification = cleanStr(input.specifikace);
  if (shodaTyp === 'ekvivalent' && (!authoritativeSpecification || authoritativeSpecification.length < 10)) {
    return {
      stav: 'nenalezeno',
      shoda_typ: 'ekvivalent',
      poznamka: 'bez specifikace zadavatele nelze ověřit ekvivalent',
      overeno_at: overenoAt,
      realita: emptyReality,
    };
  }

  const currency = cleanStr(raw.mena)?.toUpperCase();
  const rawSources = [...(raw.zdroje ?? [])];
  // Starý kontrakt převedeme na stejný interní tvar, takže další logika je společná.
  if (rawSources.length === 0 && (raw.zdroj_url !== undefined || raw.cena_bez_dph !== undefined || raw.cena_s_dph !== undefined)) {
    rawSources.push({
      url: raw.zdroj_url,
      dodavatel: raw.dodavatel,
      nazev_produktu: raw.nazev_produktu,
      cena_bez_dph: raw.cena_bez_dph,
      cena_s_dph: raw.cena_s_dph,
      mena: raw.mena,
      dostupnost: raw.dostupnost,
      poznamka: raw.poznamka,
    });
  }

  const normalized = rawSources
    .map((source) => normalizeSource(source, { currency, equivalent: shodaTyp === 'ekvivalent' }))
    .filter((source): source is WebPriceSource => source !== null)
    .sort((a, b) => sourceGrossPrice(a) - sourceGrossPrice(b));
  const seenUrls = new Set<string>();
  const zdroje = normalized
    .filter((source) => {
      if (seenUrls.has(source.url)) return false;
      seenUrls.add(source.url);
      return true;
    })
    .slice(0, 3);

  const cheapest = zdroje[0];
  let bez = cheapest?.cena_bez_dph ?? undefined;
  let sdph = cheapest?.cena_s_dph ?? undefined;
  if (bez === null) bez = undefined;
  if (sdph === null) sdph = undefined;

  const nalezeno = coerceBool(raw.nalezeno) || zdroje.length > 0;
  if (!nalezeno || (bez === undefined && sdph === undefined)) {
    return {
      stav: 'nenalezeno',
      mena: currency,
      poznamka: currency && currency !== 'CZK'
        ? 'Zdroj byl vyřazen: měna musí být CZK.'
        : cleanStr(raw.poznamka) ?? 'Cena nenalezena nebo zdroj nesplnil validaci.',
      overeno_at: overenoAt,
      ...(zdroje.length > 0 ? { zdroje } : {}),
      realita: compareAiVsMarket(input.ai_cena_bez_dph ?? null, zdroje, quantity),
    };
  }

  const poznamka = cheapest?.poznamka ?? cleanStr(raw.poznamka);
  const strop = input.cena_max_s_dph;
  const prekracujeStrop = typeof strop === 'number' && strop > 0 && sdph !== undefined
    ? sdph > strop
    : undefined;
  const onlyOrientational = zdroje.length > 0 && zdroje.every((source) => source.orientacni === true);
  return {
    stav: onlyOrientational ? 'orientacni' : shodaTyp === 'ekvivalent' ? 'ekvivalent' : 'nalezeno',
    shoda_typ: shodaTyp,
    web_cena_bez_dph: bez,
    web_cena_s_dph: sdph,
    mena: 'CZK',
    zdroj_url: cheapest?.url,
    dodavatel: cheapest?.dodavatel ?? undefined,
    dostupnost: cheapest?.dostupnost,
    poznamka,
    overeno_at: overenoAt,
    prekracuje_strop: prekracujeStrop,
    ...(zdroje.length > 0 ? { zdroje } : {}),
    realita: compareAiVsMarket(input.ai_cena_bez_dph ?? null, zdroje, quantity),
  };
}

// ----------------------------------------------------------------------------
// Volání API s web searchem (+ retry, + pause_turn loop)
// ----------------------------------------------------------------------------

interface WebSearchUsage {
  input: number;
  output: number;
  searches: number;
}

class WebSearchPhaseTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Webové ověření překročilo časový limit ${Math.round(timeoutMs / 60_000)} minuty.`);
    this.name = 'WebSearchPhaseTimeoutError';
  }
}

class AnthropicCreditExhaustedError extends Error {
  constructor() {
    super(ANTHROPIC_CREDIT_ERROR_MESSAGE);
    this.name = 'AnthropicCreditExhaustedError';
  }
}

/** Anthropic může detail vrátit v message i ve vnořeném těle APIError. */
function isAnthropicCreditError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const texts: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 4 || value === null || value === undefined || seen.has(value)) return;
    if (typeof value === 'string') {
      texts.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    if (value instanceof Error) texts.push(value.message);
    for (const nested of Object.values(value as Record<string, unknown>)) collect(nested, depth + 1);
  };
  collect(error, 0);
  return texts.some((text) => /credit balance is too low/i.test(text));
}

async function createWithRetry(
  params: unknown,
  aiClient: PriceVerifierAiClient,
  deadlineAt: number,
  timeoutMs: number,
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new WebSearchPhaseTimeoutError(timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      // params castujeme na any: SDK 0.39 typy neznají web_search tool (server-side tool)
      const request = Promise.resolve(aiClient.messages.create(
        params as Anthropic.MessageCreateParamsNonStreaming,
        { signal: controller.signal },
      ));
      const timeout = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new WebSearchPhaseTimeoutError(timeoutMs)), { once: true });
      });
      return (await Promise.race([request, timeout])) as Anthropic.Message;
    } catch (err) {
      if (err instanceof WebSearchPhaseTimeoutError || controller.signal.aborted || (err as { name?: string })?.name === 'AbortError') {
        throw new WebSearchPhaseTimeoutError(timeoutMs);
      }
      // Vyčerpaný kredit není dočasná chyba; další retry by jen zdržoval fail-fast.
      if (isAnthropicCreditError(err)) throw err;
      const status = (err as { status?: number })?.status;
      // 400/401 = neretryovatelné (chybný request / klíč)
      if (status === 400 || status === 401) throw err;
      lastErr = err;
      if (attempt < 2) {
        const delay = Math.min(Math.pow(2, attempt) * 2000, 15000);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function callWithWebSearch(
  system: string,
  userMsg: string,
  modelId: string,
  maxSearches: number,
  aiClient: PriceVerifierAiClient,
  timeoutMs = WEB_SEARCH_PHASE_TIMEOUT_MS,
): Promise<{ text: string; usage: WebSearchUsage }> {
  // Pozn.: user_location zde nepoužíváme — API kód země "CZ" nepodporuje;
  // omezení na české e-shopy řeší system prompt (doména .cz, ceny v Kč).
  const webSearchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: maxSearches,
  };

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }];
  const usage: WebSearchUsage = { input: 0, output: 0, searches: 0 };
  let combinedText = '';
  const deadlineAt = Date.now() + timeoutMs;

  // Server-side loop: běžně skončí na první odpovědi (end_turn); pause_turn = dlouhý turn
  for (let turn = 0; turn < 4; turn++) {
    const resp = await createWithRetry({
      model: modelId,
      max_tokens: 3000,
      temperature: 0.1,
      system,
      messages,
      tools: [webSearchTool],
    }, aiClient, deadlineAt, timeoutMs);

    usage.input += resp.usage.input_tokens;
    usage.output += resp.usage.output_tokens;
    usage.searches += (resp.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    combinedText += (combinedText ? '\n' : '') + text;

    // SDK 0.39 typ serverového stop_reason ještě neobsahuje hodnotu pause_turn.
    if ((resp.stop_reason as string | null) === 'pause_turn') {
      // Pokračuj: vrať asistentův (částečný) obsah a nech model turn dokončit
      messages.push({ role: 'assistant', content: resp.content as Anthropic.ContentBlockParam[] });
      continue;
    }
    break;
  }

  return { text: combinedText, usage };
}

// ----------------------------------------------------------------------------
// Ověření jedné položky
// ----------------------------------------------------------------------------

interface RawVerifyResult {
  overeni: OvereniCeny;
  hitPhase: 1 | 2 | null;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  costCZK: number;
}

/** Rozliší doložené zamítnutí AI kandidáta od obyčejného „nenalezeno“. */
function candidateWasExplicitlyRejected(note: string | undefined): boolean {
  if (!note) return false;
  const normalized = note.toLocaleLowerCase('cs-CZ');
  return /neexist|neexistující|nevyráb[íi]|výrobce.+neuvádí|jiné parametry|odlišné parametry|parametry.+neodpovíd|rozměry.+neodpovíd|rozměr.+jin[ýé]|does not exist|different (parameters|dimensions)/i.test(normalized);
}

/** Technický důvod převede na srozumitelnou českou zprávu pro uložený výsledek. */
function verificationErrorMessage(error: unknown, phase: 1 | 2): string {
  const prefix = phase === 1 ? 'První fáze ověření' : 'Hledání ekvivalentu';
  if (error instanceof WebSearchPhaseTimeoutError || (error as { name?: string })?.name === 'AbortError') {
    return `${prefix} překročilo časový limit 4 minuty.`;
  }
  const status = (error as { status?: number })?.status;
  if (status === 429) return `${prefix} se nepodařilo dokončit kvůli dočasnému limitu AI služby.`;
  if (status === 401) return `${prefix} se nepodařilo spustit kvůli neplatnému API klíči.`;
  const detail = error instanceof Error && error.message.trim() ? ` Detail: ${error.message.trim()}` : '';
  return `${prefix} selhalo kvůli neočekávané chybě.${detail}`;
}

async function verifyOneInternal(input: VerifyInput, opts: VerifyItemOptions): Promise<RawVerifyResult> {
  const modelId = resolveModelId(opts.model ?? 'sonnet');
  const pricing = getModelPricing(modelId);
  const maxSearches = opts.maxSearches ?? 3;
  const aiClient = opts.aiClient ?? client;
  const now = () => new Date().toISOString();

  let first: Awaited<ReturnType<typeof callWithWebSearch>>;
  try {
    first = await callWithWebSearch(
      exactPriceVerifySystem(),
      buildExactUserMessage(input),
      modelId,
      maxSearches,
      aiClient,
      WEB_SEARCH_PHASE_TIMEOUT_MS,
    );
  } catch (err) {
    if (isAnthropicCreditError(err)) throw new AnthropicCreditExhaustedError();
    return {
      overeni: {
        stav: 'chyba',
        poznamka: verificationErrorMessage(err, 1),
        overeno_at: now(),
        realita: compareAiVsMarket(input.ai_cena_bez_dph ?? null, []),
      },
      hitPhase: null,
      inputTokens: 0,
      outputTokens: 0,
      searches: 0,
      costCZK: 0,
    };
  }

  const firstCost =
    first.usage.input * pricing.input +
    first.usage.output * pricing.output +
    first.usage.searches * WEB_SEARCH_USD_PER_REQUEST * USD_TO_CZK;
  const firstResult = parseWebPriceResponse(first.text, input, now(), 'presny');
  const firstBase = {
    inputTokens: first.usage.input,
    outputTokens: first.usage.output,
    searches: first.usage.searches,
    costCZK: firstCost,
  };

  if (firstResult.stav === 'nalezeno') {
    return { ...firstBase, overeni: firstResult, hitPhase: 1 };
  }

  const specification = input.specifikace?.trim();
  if (firstResult.stav !== 'nenalezeno' || !specification || specification.length < 10) {
    return { ...firstBase, overeni: firstResult, hitPhase: null };
  }

  try {
    const second = await callWithWebSearch(
      equivalentPriceVerifySystem(),
      buildEquivalentUserMessage({
        nazev: input.nazev,
        specifikace: specification,
        mnozstvi: input.mnozstvi,
        jednotka: input.jednotka,
      }),
      modelId,
      Math.min(maxSearches, EQUIVALENT_MAX_SEARCHES),
      aiClient,
      WEB_SEARCH_PHASE_TIMEOUT_MS,
    );
    const secondCost =
      second.usage.input * pricing.input +
      second.usage.output * pricing.output +
      second.usage.searches * WEB_SEARCH_USD_PER_REQUEST * USD_TO_CZK;
    const secondResult = parseWebPriceResponse(second.text, input, now(), 'ekvivalent');
    const combinedBase = {
      inputTokens: firstBase.inputTokens + second.usage.input,
      outputTokens: firstBase.outputTokens + second.usage.output,
      searches: firstBase.searches + second.usage.searches,
      costCZK: firstBase.costCZK + secondCost,
    };

    if (secondResult.stav === 'ekvivalent' || secondResult.stav === 'orientacni') {
      return {
        ...combinedBase,
        overeni: {
          ...secondResult,
          kandidat_neexistuje: candidateWasExplicitlyRejected(firstResult.poznamka),
        },
        hitPhase: 2,
      };
    }

    return {
      ...combinedBase,
      hitPhase: null,
      overeni: {
        ...secondResult,
        stav: 'nenalezeno',
        shoda_typ: 'ekvivalent',
        poznamka: [
          firstResult.poznamka ? `Přesný produkt: ${firstResult.poznamka}` : 'Přesný produkt nebyl nalezen.',
          `Hledán byl i ekvivalent dle závazné specifikace: ${secondResult.poznamka ?? 'bez použitelného nákupního zdroje'}`,
        ].join(' '),
      },
    };
  } catch (err) {
    if (isAnthropicCreditError(err)) throw new AnthropicCreditExhaustedError();
    // Fallback má vlastní chybovou hranici: dokončenou fázi 1 nikdy nepřepíšeme stavem chyba.
    return {
      overeni: {
        ...firstResult,
        poznamka: [
          firstResult.poznamka,
          `${verificationErrorMessage(err, 2)} Výsledek první fáze byl zachován.`,
        ].filter(Boolean).join(' '),
      },
      hitPhase: null,
      ...firstBase,
    };
  }
}

/** Ověří cenu jedné položky. Vrací pouze návrh `overeni_ceny`. */
export async function verifyItemPrice(input: VerifyInput, opts: VerifyItemOptions = {}): Promise<OvereniCeny> {
  const r = await verifyOneInternal(input, opts);
  return r.overeni;
}

// ----------------------------------------------------------------------------
// Souběžné ověření všech položek
// ----------------------------------------------------------------------------

/** Jednoduchý souběžný pool bez externí závislosti. */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await worker(items[i]);
    }
  }
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => run());
  await Promise.all(runners);
  return results;
}

interface Target {
  polozka_index: number;
  polozka_nazev: string;
  kandidat_fingerprint: string;
  input: VerifyInput;
}

function pickCandidate(kandidati: ProductCandidate[] | undefined, vybrany: number | undefined): ProductCandidate | undefined {
  if (!kandidati || kandidati.length === 0) return undefined;
  const idx = typeof vybrany === 'number' && vybrany >= 0 && vybrany < kandidati.length ? vybrany : 0;
  return kandidati[idx];
}

export function candidateFingerprint(candidate: Pick<ProductCandidate, 'vyrobce' | 'model'>, selectedIndex: number): string {
  return `${candidate.vyrobce.trim()}|${candidate.model.trim()}|${selectedIndex}`;
}

function relevantRequirements(
  analysis: TenderAnalysis,
  item: TenderAnalysis['polozky'][number],
): TenderAnalysis['technicke_pozadavky'] {
  if (analysis.polozky.length === 1) return analysis.technicke_pozadavky;
  const itemText = `${item.nazev} ${item.specifikace}`.toLocaleLowerCase('cs-CZ');
  const tokens = new Set(itemText.match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  return analysis.technicke_pozadavky.filter((requirement) => {
    const requirementTokens = `${requirement.parametr} ${requirement.pozadovana_hodnota}`
      .toLocaleLowerCase('cs-CZ')
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    return requirementTokens.some((token) => tokens.has(token));
  });
}

/** Sestaví výhradně autoritativní specifikaci položky z analysis.json. */
export function authoritativeSpecificationForItem(
  analysis: TenderAnalysis | undefined,
  polozkaIndex: number,
): string | undefined {
  const item = analysis?.polozky?.[polozkaIndex];
  if (!analysis || !item) return undefined;
  const parts = [item.specifikace.trim()];
  const requirements = relevantRequirements(analysis, item);
  if (requirements.length > 0) {
    parts.push('Technické požadavky:');
    for (const requirement of requirements) {
      parts.push(`- ${requirement.parametr}: ${requirement.pozadovana_hodnota}${requirement.jednotka ? ` ${requirement.jednotka}` : ''}${requirement.povinny ? ' (povinné)' : ''}`);
    }
  }
  return parts.filter(Boolean).join('\n').trim() || undefined;
}

function buildTargets(matchData: ProductMatch, analysis?: TenderAnalysis): Target[] {
  const targets: Target[] = [];

  if (Array.isArray(matchData.polozky_match)) {
    for (const item of matchData.polozky_match as PolozkaMatch[]) {
      // Služby (doprava, montáž, …) nemají tržní produkt k dohledání — přeskoč
      if (item.typ === 'sluzba') continue;
      const cand = pickCandidate(item.kandidati, item.vybrany_index);
      if (!cand || !cand.vyrobce?.trim() || !cand.model?.trim()) continue;
      const selectedIndex = item.kandidati.indexOf(cand);
      targets.push({
        polozka_index: item.polozka_index,
        polozka_nazev: item.polozka_nazev,
        kandidat_fingerprint: candidateFingerprint(cand, selectedIndex),
        input: {
          vyrobce: cand.vyrobce,
          model: cand.model,
          nazev: item.polozka_nazev,
          specifikace: authoritativeSpecificationForItem(analysis, item.polozka_index),
          mnozstvi: item.mnozstvi,
          jednotka: item.jednotka,
          ai_cena_bez_dph: cand.cena_bez_dph,
          cena_max_s_dph: item.cena_max_s_dph ?? null,
        },
      });
    }
  } else if (Array.isArray(matchData.kandidati)) {
    // Single-product formát — kořenový kandidát
    const cand = pickCandidate(matchData.kandidati, matchData.vybrany_index);
    if (cand && cand.vyrobce?.trim() && cand.model?.trim()) {
      const selectedIndex = matchData.kandidati.indexOf(cand);
      const authoritativeName = analysis?.polozky?.[0]?.nazev?.trim() || undefined;
      targets.push({
        polozka_index: -1,
        polozka_nazev: `${cand.vyrobce} ${cand.model}`,
        kandidat_fingerprint: candidateFingerprint(cand, selectedIndex),
        input: {
          vyrobce: cand.vyrobce,
          model: cand.model,
          // Fallback smí dostat jen název ze zadání, nikdy AI identitu kandidáta.
          nazev: authoritativeName,
          specifikace: authoritativeSpecificationForItem(analysis, 0),
          mnozstvi: 1,
          jednotka: 'ks',
          ai_cena_bez_dph: cand.cena_bez_dph,
          cena_max_s_dph: null,
        },
      });
    }
  }

  return targets;
}

/**
 * Sloučí výsledky ověření do právě načteného product-match objektu a nedotkne se
 * cenova_uprava ani ostatních polí. Volající předává čerstvě načtenou kopii kvůli
 * ochraně před lost-update během dlouhého web search běhu.
 */
export function mergePriceVerifications(matchData: ProductMatch, results: ItemVerification[]): ProductMatch {
  const byIndex = new Map<number, OvereniCeny>(results.map((result) => [result.polozka_index, result.overeni_ceny]));

  if (Array.isArray(matchData.polozky_match)) {
    for (const item of matchData.polozky_match) {
      const overeni = byIndex.get(item.polozka_index);
      if (!overeni) continue;
      const current = pickCandidate(item.kandidati, item.vybrany_index);
      const selectedIndex = current ? item.kandidati.indexOf(current) : -1;
      const currentFingerprint = current ? candidateFingerprint(current, selectedIndex) : null;
      if (!overeni.kandidat_fingerprint || overeni.kandidat_fingerprint !== currentFingerprint) {
        console.warn(`Zahazuji zastaralé ověření ceny položky ${item.polozka_index}: kandidát se během ověřování změnil.`);
        // Smažeme jen prokazatelně zastaralý záznam; souběžné ověření aktuálního kandidáta zachováme.
        if (item.overeni_ceny?.kandidat_fingerprint && item.overeni_ceny.kandidat_fingerprint !== currentFingerprint) {
          delete item.overeni_ceny;
        }
        continue;
      }
      item.overeni_ceny = mergeOnePriceVerification(item.overeni_ceny, overeni);
    }
  } else {
    const overeni = byIndex.get(-1);
    const current = pickCandidate(matchData.kandidati, matchData.vybrany_index);
    const selectedIndex = current && matchData.kandidati ? matchData.kandidati.indexOf(current) : -1;
    const currentFingerprint = current ? candidateFingerprint(current, selectedIndex) : null;
    if (overeni?.kandidat_fingerprint && overeni.kandidat_fingerprint === currentFingerprint) {
      matchData.overeni_ceny = mergeOnePriceVerification(matchData.overeni_ceny, overeni);
    } else if (overeni) {
      console.warn('Zahazuji zastaralé ověření ceny: kořenový kandidát se během ověřování změnil.');
      if (matchData.overeni_ceny?.kandidat_fingerprint && matchData.overeni_ceny.kandidat_fingerprint !== currentFingerprint) {
        delete matchData.overeni_ceny;
      }
    }
  }

  return matchData;
}

function hasFoundSources(overeni: OvereniCeny): boolean {
  if (!['nalezeno', 'ekvivalent', 'orientacni'].includes(overeni.stav)) return false;
  return (overeni.zdroje?.length ?? 0) > 0 || Boolean(overeni.zdroj_url);
}

/** Sloučí jeden výsledek bez ztráty posledního použitelného nákupního nálezu. */
function mergeOnePriceVerification(
  previous: OvereniCeny | undefined,
  incoming: OvereniCeny,
): OvereniCeny {
  const sameCandidate = previous
    && (!previous.kandidat_fingerprint || previous.kandidat_fingerprint === incoming.kandidat_fingerprint);

  if (!sameCandidate) return incoming;

  if (incoming.stav === 'chyba') {
    return {
      ...previous,
      posledni_chyba: {
        zprava: incoming.poznamka?.trim() || 'Ověření ceny selhalo bez bližšího popisu.',
        at: incoming.overeno_at,
      },
    };
  }

  if (incoming.stav === 'nenalezeno' && hasFoundSources(previous)) {
    const previousDate = previous.overeno_at;
    const preservationNote = `poslední běh cenu nenašel; zobrazené zdroje jsou z předchozího ověření (${previousDate})`;
    return {
      ...previous,
      overeno_at: incoming.overeno_at,
      poznamka: [previous.poznamka, preservationNote].filter(Boolean).join(' | '),
    };
  }

  return incoming;
}

function formatPrice(ov: OvereniCeny): string {
  if (ov.stav !== 'nalezeno' && ov.stav !== 'ekvivalent' && ov.stav !== 'orientacni') {
    return ov.stav + (ov.poznamka ? ` (${ov.poznamka})` : '');
  }
  const cena = ov.web_cena_s_dph ?? ov.web_cena_bez_dph;
  const suffix = ov.web_cena_s_dph !== undefined ? ' s DPH' : ' bez DPH';
  const dod = ov.dodavatel ? ` — ${ov.dodavatel}` : '';
  const strop = ov.prekracuje_strop ? ' [PŘEKRAČUJE STROP]' : '';
  return `${cena} ${ov.mena ?? 'CZK'}${suffix}${dod}${strop}`;
}

/**
 * Ověří ceny všech (relevantních) položek v matchData přes web search.
 * Vrací návrhy `overeni_ceny` — merge do souboru řeší volající (CLI).
 * matchData samotné NEMODIFIKUJE.
 */
export async function verifyAllPrices(matchData: ProductMatch, opts: VerifyAllOptions): Promise<VerifyAllResult> {
  const modelId = resolveModelId(opts.model ?? 'sonnet');
  const concurrency = opts.concurrency ?? 3;

  let targets = buildTargets(matchData, opts.analysis);
  if (typeof opts.onlyIndex === 'number') {
    targets = targets.filter((t) => t.polozka_index === opts.onlyIndex);
  }
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    targets = targets.slice(0, opts.limit);
  }

  const total = targets.length;
  opts.onProgress?.(`Položek k ověření: ${total} (model ${modelId}, souběžně ${concurrency})`);

  let done = 0;
  let creditInterrupted = false;
  const verifyTarget = async (target: Target): Promise<{ target: Target; res: RawVerifyResult }> => {
    try {
      const res = await verifyOneInternal(target.input, {
        model: opts.model,
        maxSearches: opts.maxSearches,
        aiClient: opts.aiClient,
      });
      done++;
      opts.onProgress?.(`[${done}/${total}] ${target.polozka_nazev}: ${formatPrice(res.overeni)}`);
      return { target, res };
    } catch (error) {
      if (!(error instanceof AnthropicCreditExhaustedError)) throw error;
      creditInterrupted = true;
      done++;
      const res: RawVerifyResult = {
        overeni: {
          stav: 'chyba',
          poznamka: ANTHROPIC_CREDIT_ERROR_MESSAGE,
          overeno_at: new Date().toISOString(),
          realita: compareAiVsMarket(target.input.ai_cena_bez_dph ?? null, []),
        },
        hitPhase: null,
        inputTokens: 0,
        outputTokens: 0,
        searches: 0,
        costCZK: 0,
      };
      opts.onProgress?.(`[${done}/${total}] ${target.polozka_nazev}: ${ANTHROPIC_CREDIT_ERROR_MESSAGE}`);
      return { target, res };
    }
  };

  const raw: Array<{ target: Target; res: RawVerifyResult }> = [];
  if (targets.length > 0) {
    // První položka je preflight: při už vyčerpaném kreditu nespustíme souběžně další requesty.
    raw.push(await verifyTarget(targets[0]!));
  }
  if (!creditInterrupted && targets.length > 1) {
    const remaining = await runWithConcurrency(targets.slice(1), concurrency, async (target) => {
      if (creditInterrupted) return null;
      return verifyTarget(target);
    });
    raw.push(...remaining.filter((result): result is { target: Target; res: RawVerifyResult } => result !== null));
  }

  const results: ItemVerification[] = raw.map(({ target, res }) => ({
    polozka_index: target.polozka_index,
    polozka_nazev: target.polozka_nazev,
    overeni_ceny: { ...res.overeni, kandidat_fingerprint: target.kandidat_fingerprint },
  }));

  const increases = results
    .map((result) => result.overeni_ceny.realita)
    .filter((reality) => reality?.pod_trhem === true && typeof reality.rozdil_procent === 'number' && reality.rozdil_procent > 0)
    .map((reality) => reality!.rozdil_procent as number);
  const summary = {
    total,
    nalezeno: results.filter((r) => r.overeni_ceny.stav === 'nalezeno' || r.overeni_ceny.stav === 'ekvivalent').length,
    orientacni: results.filter((r) => r.overeni_ceny.stav === 'orientacni').length,
    nenalezeno: results.filter((r) => r.overeni_ceny.stav === 'nenalezeno').length,
    chyba: results.filter((r) => r.overeni_ceny.stav === 'chyba').length,
    prekracuje_strop: results.filter((r) => r.overeni_ceny.prekracuje_strop === true).length,
    faze1_nalezeno: raw.filter((r) => r.res.hitPhase === 1).length,
    faze2_nalezeno: raw.filter((r) => r.res.hitPhase === 2).length,
    realny_nakup_vyssi_nez_ai: increases.length,
    prumerny_narust_procent: increases.length > 0
      ? Math.round((increases.reduce((sum, value) => sum + value, 0) / increases.length) * 10) / 10
      : null,
    searches: raw.reduce((s, x) => s + x.res.searches, 0),
    inputTokens: raw.reduce((s, x) => s + x.res.inputTokens, 0),
    outputTokens: raw.reduce((s, x) => s + x.res.outputTokens, 0),
    costCZK: raw.reduce((s, x) => s + x.res.costCZK, 0),
    modelId,
    preruseno_kvuli_kreditu: creditInterrupted,
  };

  // Zapiš náklady jedním agregovaným záznamem (costCZK už zahrnuje i cenu web searchů)
  if (summary.inputTokens > 0 || summary.outputTokens > 0) {
    await logCost(opts.tenderId, 'verify-prices', modelId, summary.inputTokens, summary.outputTokens, summary.costCZK);
  }

  return { results, summary };
}
