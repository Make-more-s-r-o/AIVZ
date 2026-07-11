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
  OvereniCeny as StoredOvereniCeny,
  WebPriceSource,
} from './types.js';

config({ path: new URL('../../../.env', import.meta.url).pathname });

// Stejný kurz jako v ai-client.ts (USD → CZK) — použit pro cenu web searchů
const USD_TO_CZK = 24;
// Web search je účtován $10 za 1000 requestů (tokeny se počítají zvlášť)
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Server-side web search přidává latenci (běh vyhledávání) — 3 min je bezpečná rezerva
  timeout: 3 * 60 * 1000,
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
}

export interface VerifyAllOptions extends VerifyItemOptions {
  tenderId: string;
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
    chyba: number;
    prekracuje_strop: number;
    searches: number;
    inputTokens: number;
    outputTokens: number;
    costCZK: number;
    modelId: string;
  };
}

// ----------------------------------------------------------------------------
// Prompt
// ----------------------------------------------------------------------------
const PRICE_VERIFY_SYSTEM = `Jsi asistent nákupčího ve veřejných zakázkách. Tvým úkolem je pomocí web search dohledat AKTUÁLNÍ tržní cenu zboží v českých e-shopech.

Pravidla:
- Hledej výhradně v českých e-shopech (ceny v Kč, doména .cz).
- Hledej ve dvou krocích:
  KROK A: nejprve hledej přesný produkt podle výrobce a modelu. Nalezené zdroje označ shoda_typ="presny".
  KROK B: pokud přesný model nenajdeš, hledej EKVIVALENTNÍ zboží splňující SPECIFIKACI položky ze zadání — zejména rozměry, materiál, zrnitost, počet kusů v balení a technické parametry. Nalezené zdroje označ shoda_typ="ekvivalent". Nevyžaduj shodu s modelem, který není podstatnou součástí specifikace.
- U komoditního zboží (např. brusné plátno, řezný kotouč, stahovací pásky nebo těsnicí vlákno) hledej v Kroku B podle požadovaných parametrů, ne podle modelu, který mohl být pouze odhadem.
- NIKDY nenabízej zboží jiného rozsahu/měřítka (např. sadu místo jednoho kusu, balení 100 ks místo 1 ks) — cena musí být za JEDNU JEDNOTKU dle položky (viz množství a jednotka). Pokud e-shop prodává jen balení, přepočti cenu na jednotku a napiš to do poznámky.
- Najdi až 3 různé nákupní zdroje. Preferuj e-shopy, kde je produkt skladem a s jasně uvedenou cenou.
- Uveď cenu bez DPH i s DPH, pokud to jde (české e-shopy běžně uvádějí obojí; sazba DPH je 21 %).
- U každého zdroje vrať přímý odkaz na konkrétní produktovou stránku, ne odkaz na výsledky vyhledávání.
- U každého zdroje vrať v nazev_produktu skutečný název produktu z produktové stránky.
- Zdroje seřaď od nejlevnějšího podle ceny s DPH. Neopakuj stejnou URL.

Odpověz VÝHRADNĚ jedním JSON objektem jako ÚPLNĚ POSLEDNÍ blok textu, bez jakéhokoli komentáře za ním, přesně v tomto tvaru:
{"nalezeno": true|false, "shoda_typ": "presny"|"ekvivalent", "mena": "CZK", "zdroje": [{"url": "https://...", "dodavatel": "název e-shopu", "nazev_produktu": "skutečný název nalezeného produktu", "cena_bez_dph": číslo|null, "cena_s_dph": číslo|null, "dostupnost": "skladem|na dotaz|není skladem|neznámá", "poznamka": "krátká poznámka včetně případného přepočtu balení na jednotku"}], "poznamka": "volitelná souhrnná poznámka"}
Když nenajdeš přesný ani specifikaci splňující ekvivalent, vrať {"nalezeno": false, "shoda_typ": "presny", "mena": "CZK", "zdroje": [], "poznamka": "důvod"}.
Ceny uváděj jako čistá čísla bez měny a mezer (např. 3509, ne "3 509 Kč").`;

function buildUserMessage(input: VerifyInput): string {
  const lines: string[] = [
    'Najdi aktuální cenu tohoto produktu v českých e-shopech:',
    `Výrobce: ${input.vyrobce}`,
    `Model: ${input.model}`,
  ];
  if (input.nazev) lines.push(`Název položky: ${input.nazev}`);
  if (input.specifikace) {
    const spec = input.specifikace.length > 300 ? input.specifikace.slice(0, 300) + '…' : input.specifikace;
    lines.push(`Specifikace: ${spec}`);
  }
  lines.push(`Množství v zakázce: ${input.mnozstvi ?? 1}`);
  lines.push(`Jednotka položky: ${input.jednotka?.trim() || 'ks'}`);
  lines.push('Všechny vrácené ceny musí být přepočtené na jednu uvedenou jednotku.');
  return lines.join('\n');
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
    dostupnost: z.union([z.string(), z.null()]).optional(),
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
  return /^https?:\/\//i.test(s) ? s : undefined;
}

type RawWebPriceSource = z.infer<typeof RawWebPriceSourceSchema>;

/** Normalizuje jeden AI nález. Bez bezpečné URL nebo bez ceny nejde o nákupní zdroj. */
function normalizeSource(raw: RawWebPriceSource): WebPriceSource | null {
  const url = cleanUrl(raw.url ?? raw.zdroj_url);
  const cenaBezDph = coerceNumber(raw.cena_bez_dph);
  const cenaSdph = coerceNumber(raw.cena_s_dph);
  if (!url || (cenaBezDph === undefined && cenaSdph === undefined)) return null;

  return {
    url,
    dodavatel: cleanStr(raw.dodavatel) ?? null,
    ...(cleanStr(raw.nazev_produktu) ? { nazev_produktu: cleanStr(raw.nazev_produktu)! } : {}),
    cena_bez_dph: cenaBezDph ?? null,
    cena_s_dph: cenaSdph ?? null,
    dostupnost: cleanStr(raw.dostupnost) ?? null,
    poznamka: cleanStr(raw.poznamka) ?? null,
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
  input: Pick<VerifyInput, 'cena_max_s_dph' | 'ai_cena_bez_dph'> = {},
  overenoAt = new Date().toISOString(),
): OvereniCeny {
  const emptyReality = compareAiVsMarket(input.ai_cena_bez_dph ?? null, []);
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
  const rawSources = [...(raw.zdroje ?? [])];
  // Starý kontrakt převedeme na stejný interní tvar, takže další logika je společná.
  if (rawSources.length === 0 && (raw.zdroj_url !== undefined || raw.cena_bez_dph !== undefined || raw.cena_s_dph !== undefined)) {
    rawSources.push({
      url: raw.zdroj_url,
      dodavatel: raw.dodavatel,
      nazev_produktu: raw.nazev_produktu,
      cena_bez_dph: raw.cena_bez_dph,
      cena_s_dph: raw.cena_s_dph,
      dostupnost: raw.dostupnost,
      poznamka: raw.poznamka,
    });
  }

  const normalized = rawSources
    .map(normalizeSource)
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
  const legacyBez = coerceNumber(raw.cena_bez_dph);
  const legacySdph = coerceNumber(raw.cena_s_dph);
  // Jakmile máme validní řádkový zdroj, nesmí se jeho chybějící cena doplnit
  // top-level hodnotou jiného obchodu. Legacy hodnoty platí pouze bez zdrojů.
  let bez = cheapest ? cheapest.cena_bez_dph : legacyBez;
  let sdph = cheapest ? cheapest.cena_s_dph : legacySdph;
  if (bez === null) bez = undefined;
  if (sdph === null) sdph = undefined;

  let dopocetPoznamka: string | undefined;
  if (sdph === undefined && bez !== undefined) {
    sdph = Math.round(bez * 1.21 * 100) / 100;
    dopocetPoznamka = 'cena s DPH dopočtena z ceny bez DPH (DPH 21 %)';
  }
  if (bez === undefined && sdph !== undefined) {
    bez = Math.round((sdph / 1.21) * 100) / 100;
    dopocetPoznamka = 'cena bez DPH dopočtena z ceny s DPH (DPH 21 %)';
  }

  const nalezeno = coerceBool(raw.nalezeno) || zdroje.length > 0;
  if (!nalezeno || (bez === undefined && sdph === undefined)) {
    return {
      stav: 'nenalezeno',
      mena: cleanStr(raw.mena),
      zdroj_url: cleanUrl(raw.zdroj_url),
      poznamka: cleanStr(raw.poznamka) ?? 'Cena nenalezena',
      overeno_at: overenoAt,
      ...(zdroje.length > 0 ? { zdroje } : {}),
      realita: compareAiVsMarket(input.ai_cena_bez_dph ?? null, zdroje),
    };
  }

  const poznamka = [cheapest ? cheapest.poznamka ?? undefined : cleanStr(raw.poznamka), dopocetPoznamka]
    .filter(Boolean)
    .join(' | ') || undefined;
  const strop = input.cena_max_s_dph;
  const prekracujeStrop = typeof strop === 'number' && strop > 0 && sdph !== undefined
    ? sdph > strop
    : undefined;
  const shodaTyp = raw.shoda_typ ?? 'presny';

  return {
    stav: shodaTyp === 'ekvivalent' ? 'ekvivalent' : 'nalezeno',
    shoda_typ: shodaTyp,
    web_cena_bez_dph: bez,
    web_cena_s_dph: sdph,
    mena: cleanStr(raw.mena) ?? 'CZK',
    zdroj_url: cheapest ? cheapest.url : cleanUrl(raw.zdroj_url),
    dodavatel: cheapest ? cheapest.dodavatel ?? undefined : cleanStr(raw.dodavatel),
    dostupnost: cheapest ? cheapest.dostupnost ?? undefined : cleanStr(raw.dostupnost),
    poznamka,
    overeno_at: overenoAt,
    prekracuje_strop: prekracujeStrop,
    ...(zdroje.length > 0 ? { zdroje } : {}),
    realita: compareAiVsMarket(input.ai_cena_bez_dph ?? null, zdroje),
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

async function createWithRetry(params: unknown): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      // params castujeme na any: SDK 0.39 typy neznají web_search tool (server-side tool)
      return (await client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming)) as Anthropic.Message;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      // 400/401 = neretryovatelné (chybný request / klíč)
      if (status === 400 || status === 401) throw err;
      lastErr = err;
      if (attempt < 2) {
        const delay = Math.min(Math.pow(2, attempt) * 2000, 15000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function callWithWebSearch(
  system: string,
  userMsg: string,
  modelId: string,
  maxSearches: number,
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

  // Server-side loop: běžně skončí na první odpovědi (end_turn); pause_turn = dlouhý turn
  for (let turn = 0; turn < 4; turn++) {
    const resp = await createWithRetry({
      model: modelId,
      max_tokens: 3000,
      temperature: 0.1,
      system,
      messages,
      tools: [webSearchTool],
    });

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
  inputTokens: number;
  outputTokens: number;
  searches: number;
  costCZK: number;
}

async function verifyOneInternal(input: VerifyInput, opts: VerifyItemOptions): Promise<RawVerifyResult> {
  const modelId = resolveModelId(opts.model ?? 'sonnet');
  const pricing = getModelPricing(modelId);
  const maxSearches = opts.maxSearches ?? 3;
  const now = () => new Date().toISOString();

  try {
    const { text, usage } = await callWithWebSearch(
      PRICE_VERIFY_SYSTEM,
      buildUserMessage(input),
      modelId,
      maxSearches,
    );
    const costCZK =
      usage.input * pricing.input +
      usage.output * pricing.output +
      usage.searches * WEB_SEARCH_USD_PER_REQUEST * USD_TO_CZK;
    const base = { inputTokens: usage.input, outputTokens: usage.output, searches: usage.searches, costCZK };
    return { ...base, overeni: parseWebPriceResponse(text, input, now()) };
  } catch (err) {
    // Per-item chyba nesmí shodit celek
    return {
      overeni: {
        stav: 'chyba',
        poznamka: `Chyba ověření: ${(err as Error).message}`,
        overeno_at: now(),
        realita: compareAiVsMarket(input.ai_cena_bez_dph ?? null, []),
      },
      inputTokens: 0,
      outputTokens: 0,
      searches: 0,
      costCZK: 0,
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
  input: VerifyInput;
}

function pickCandidate(kandidati: ProductCandidate[] | undefined, vybrany: number | undefined): ProductCandidate | undefined {
  if (!kandidati || kandidati.length === 0) return undefined;
  const idx = typeof vybrany === 'number' && vybrany >= 0 && vybrany < kandidati.length ? vybrany : 0;
  return kandidati[idx];
}

function buildTargets(matchData: ProductMatch): Target[] {
  const targets: Target[] = [];

  if (Array.isArray(matchData.polozky_match)) {
    for (const item of matchData.polozky_match as PolozkaMatch[]) {
      // Služby (doprava, montáž, …) nemají tržní produkt k dohledání — přeskoč
      if (item.typ === 'sluzba') continue;
      const cand = pickCandidate(item.kandidati, item.vybrany_index);
      if (!cand || !cand.vyrobce?.trim() || !cand.model?.trim()) continue;
      targets.push({
        polozka_index: item.polozka_index,
        polozka_nazev: item.polozka_nazev,
        input: {
          vyrobce: cand.vyrobce,
          model: cand.model,
          nazev: item.polozka_nazev,
          specifikace: item.specifikace ?? cand.popis,
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
      targets.push({
        polozka_index: -1,
        polozka_nazev: `${cand.vyrobce} ${cand.model}`,
        input: {
          vyrobce: cand.vyrobce,
          model: cand.model,
          nazev: `${cand.vyrobce} ${cand.model}`,
          specifikace: cand.popis,
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
      if (overeni) item.overeni_ceny = overeni;
    }
  } else {
    const overeni = byIndex.get(-1);
    if (overeni) matchData.overeni_ceny = overeni;
  }

  return matchData;
}

function formatPrice(ov: OvereniCeny): string {
  if (ov.stav !== 'nalezeno' && ov.stav !== 'ekvivalent') return ov.stav + (ov.poznamka ? ` (${ov.poznamka})` : '');
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

  let targets = buildTargets(matchData);
  if (typeof opts.onlyIndex === 'number') {
    targets = targets.filter((t) => t.polozka_index === opts.onlyIndex);
  }
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    targets = targets.slice(0, opts.limit);
  }

  const total = targets.length;
  opts.onProgress?.(`Položek k ověření: ${total} (model ${modelId}, souběžně ${concurrency})`);

  let done = 0;
  const raw = await runWithConcurrency(targets, concurrency, async (t) => {
    const r = await verifyOneInternal(t.input, { model: opts.model, maxSearches: opts.maxSearches });
    done++;
    opts.onProgress?.(`[${done}/${total}] ${t.polozka_nazev}: ${formatPrice(r.overeni)}`);
    return { target: t, res: r };
  });

  const results: ItemVerification[] = raw.map(({ target, res }) => ({
    polozka_index: target.polozka_index,
    polozka_nazev: target.polozka_nazev,
    overeni_ceny: res.overeni,
  }));

  const summary = {
    total,
    nalezeno: results.filter((r) => r.overeni_ceny.stav === 'nalezeno' || r.overeni_ceny.stav === 'ekvivalent').length,
    nenalezeno: results.filter((r) => r.overeni_ceny.stav === 'nenalezeno').length,
    chyba: results.filter((r) => r.overeni_ceny.stav === 'chyba').length,
    prekracuje_strop: results.filter((r) => r.overeni_ceny.prekracuje_strop === true).length,
    searches: raw.reduce((s, x) => s + x.res.searches, 0),
    inputTokens: raw.reduce((s, x) => s + x.res.inputTokens, 0),
    outputTokens: raw.reduce((s, x) => s + x.res.outputTokens, 0),
    costCZK: raw.reduce((s, x) => s + x.res.costCZK, 0),
    modelId,
  };

  // Zapiš náklady jedním agregovaným záznamem (costCZK už zahrnuje i cenu web searchů)
  if (summary.inputTokens > 0 || summary.outputTokens > 0) {
    await logCost(opts.tenderId, 'verify-prices', modelId, summary.inputTokens, summary.outputTokens, summary.costCZK);
  }

  return { results, summary };
}
