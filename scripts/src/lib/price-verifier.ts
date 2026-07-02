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
import type { ProductMatch, ProductCandidate, PolozkaMatch } from './types.js';

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
export interface OvereniCeny {
  stav: 'nalezeno' | 'nenalezeno' | 'chyba';
  web_cena_bez_dph?: number;
  web_cena_s_dph?: number;
  mena?: string;
  zdroj_url?: string;
  dodavatel?: string;
  dostupnost?: string;
  poznamka?: string;
  overeno_at: string; // ISO
  // true, pokud web_cena_s_dph > cena_max_s_dph položky (cenový strop)
  prekracuje_strop?: boolean;
}

export interface VerifyInput {
  vyrobce: string;
  model: string;
  nazev?: string;
  specifikace?: string;
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
const PRICE_VERIFY_SYSTEM = `Jsi asistent nákupčího ve veřejných zakázkách. Tvým úkolem je pomocí web search dohledat AKTUÁLNÍ tržní cenu konkrétního produktu v českých e-shopech.

Pravidla:
- Hledej výhradně v českých e-shopech (ceny v Kč, doména .cz).
- Najdi konkrétní produkt podle výrobce a modelu. Pokud přesný model nenajdeš, vrať nalezeno=false (neodhaduj cenu jiného produktu).
- Preferuj e-shop, kde je produkt skladem a s jasně uvedenou cenou.
- Uveď cenu bez DPH i s DPH, pokud to jde (české e-shopy běžně uvádějí obojí; sazba DPH je 21 %).
- Vrať přímý odkaz na konkrétní produktovou stránku (zdroj_url), ne odkaz na výsledky vyhledávání.

Odpověz VÝHRADNĚ jedním JSON objektem jako ÚPLNĚ POSLEDNÍ blok textu, bez jakéhokoli komentáře za ním, přesně v tomto tvaru:
{"nalezeno": true|false, "cena_bez_dph": číslo|null, "cena_s_dph": číslo|null, "mena": "CZK", "zdroj_url": "https://...", "dodavatel": "název e-shopu", "dostupnost": "skladem|na dotaz|není skladem|neznámá", "poznamka": "krátká poznámka"}
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
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Robustní parsování odpovědi
// ----------------------------------------------------------------------------

// Lenient schéma — čísla/booleany přijímáme i jako string, dočistíme níže
const RawWebPriceSchema = z
  .object({
    nalezeno: z.union([z.boolean(), z.string()]).optional(),
    cena_bez_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    cena_s_dph: z.union([z.number(), z.string(), z.null()]).optional(),
    mena: z.union([z.string(), z.null()]).optional(),
    zdroj_url: z.union([z.string(), z.null()]).optional(),
    dodavatel: z.union([z.string(), z.null()]).optional(),
    dostupnost: z.union([z.string(), z.null()]).optional(),
    poznamka: z.union([z.string(), z.null()]).optional(),
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

    if (resp.stop_reason === 'pause_turn') {
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

    const jsonStr = extractJsonObject(text);
    if (!jsonStr) {
      return { ...base, overeni: { stav: 'nenalezeno', poznamka: 'AI nevrátila strukturovanou odpověď', overeno_at: now() } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return { ...base, overeni: { stav: 'nenalezeno', poznamka: 'Odpověď AI nešla naparsovat jako JSON', overeno_at: now() } };
    }

    const valid = RawWebPriceSchema.safeParse(parsed);
    if (!valid.success) {
      return { ...base, overeni: { stav: 'nenalezeno', poznamka: 'Odpověď AI neodpovídá očekávanému tvaru', overeno_at: now() } };
    }

    const r = valid.data;
    const nalezeno = coerceBool(r.nalezeno);
    const bez = coerceNumber(r.cena_bez_dph);
    let sdph = coerceNumber(r.cena_s_dph);
    let poznamka = cleanStr(r.poznamka);

    // Dopočet ceny s DPH z ceny bez DPH (sazba 21 %), když chybí — pro porovnání se stropem
    if (sdph === undefined && bez !== undefined) {
      sdph = Math.round(bez * 1.21);
      poznamka = [poznamka, 'cena s DPH dopočtena z ceny bez DPH (DPH 21 %)'].filter(Boolean).join(' | ');
    }

    if (!nalezeno || (bez === undefined && sdph === undefined)) {
      return {
        ...base,
        overeni: {
          stav: 'nenalezeno',
          mena: cleanStr(r.mena),
          zdroj_url: cleanStr(r.zdroj_url),
          poznamka: poznamka ?? 'Cena nenalezena',
          overeno_at: now(),
        },
      };
    }

    const strop = input.cena_max_s_dph;
    const prekracuje_strop =
      typeof strop === 'number' && strop > 0 && sdph !== undefined ? sdph > strop : undefined;

    return {
      ...base,
      overeni: {
        stav: 'nalezeno',
        web_cena_bez_dph: bez,
        web_cena_s_dph: sdph,
        mena: cleanStr(r.mena) ?? 'CZK',
        zdroj_url: cleanStr(r.zdroj_url),
        dodavatel: cleanStr(r.dodavatel),
        dostupnost: cleanStr(r.dostupnost),
        poznamka,
        overeno_at: now(),
        prekracuje_strop,
      },
    };
  } catch (err) {
    // Per-item chyba nesmí shodit celek
    return {
      overeni: { stav: 'chyba', poznamka: `Chyba ověření: ${(err as Error).message}`, overeno_at: now() },
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
          cena_max_s_dph: null,
        },
      });
    }
  }

  return targets;
}

function formatPrice(ov: OvereniCeny): string {
  if (ov.stav !== 'nalezeno') return ov.stav + (ov.poznamka ? ` (${ov.poznamka})` : '');
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
    nalezeno: results.filter((r) => r.overeni_ceny.stav === 'nalezeno').length,
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
