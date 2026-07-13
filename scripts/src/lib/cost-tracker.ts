/**
 * Cost tracker for AI API calls.
 * Logs per-step token usage and CZK costs to output/{tender}/cost-log.json.
 */
import { access, readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';

const ROOT = new URL('../../../', import.meta.url).pathname;

export interface CostEntry {
  timestamp: string;
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCZK: number;
}

export interface CostSummary {
  entries: CostEntry[];
  totalCZK: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byStep: Record<string, { costCZK: number; inputTokens: number; outputTokens: number; calls: number }>;
}

export async function logCost(
  tenderId: string,
  step: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  costCZK: number,
): Promise<void> {
  const outputDir = join(ROOT, 'output', tenderId);
  await mkdir(outputDir, { recursive: true });
  const logPath = join(outputDir, 'cost-log.json');

  let entries: CostEntry[] = [];
  try {
    entries = JSON.parse(await readFile(logPath, 'utf-8'));
  } catch {
    // File doesn't exist yet — start fresh
  }

  entries.push({
    timestamp: new Date().toISOString(),
    step,
    model,
    inputTokens,
    outputTokens,
    costCZK,
  });

  await writeFile(logPath, JSON.stringify(entries, null, 2), 'utf-8');
}

export async function getCostSummary(tenderId: string): Promise<CostSummary> {
  const logPath = join(ROOT, 'output', tenderId, 'cost-log.json');
  try {
    const entries: CostEntry[] = JSON.parse(await readFile(logPath, 'utf-8'));

    const totalCZK = entries.reduce((s, e) => s + e.costCZK, 0);
    const totalInputTokens = entries.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutputTokens = entries.reduce((s, e) => s + e.outputTokens, 0);

    const byStep = entries.reduce(
      (acc, e) => {
        if (!acc[e.step]) acc[e.step] = { costCZK: 0, inputTokens: 0, outputTokens: 0, calls: 0 };
        acc[e.step].costCZK += e.costCZK;
        acc[e.step].inputTokens += e.inputTokens;
        acc[e.step].outputTokens += e.outputTokens;
        acc[e.step].calls += 1;
        return acc;
      },
      {} as Record<string, { costCZK: number; inputTokens: number; outputTokens: number; calls: number }>,
    );

    return { entries, totalCZK, totalInputTokens, totalOutputTokens, byStep };
  } catch {
    return { entries: [], totalCZK: 0, totalInputTokens: 0, totalOutputTokens: 0, byStep: {} };
  }
}

// ============================================================
// Agregovaný přehled nákladů napříč VŠEMI zakázkami (cost observabilita).
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;
/** Kolik dní zpět (včetně dneška) se počítá "týden"/"měsíc" — rolling okno, ne kalendářní. */
const WEEK_DAYS = 7;
const MONTH_DAYS = 30;
/** Délka časové řady po_dnech. */
const CHART_DAYS = 14;

export interface CostsAggregateTenderInput {
  tenderId: string;
  /** Zobrazovaný název zakázky (z tender-meta.json), null když neznámý. */
  name?: string | null;
  /** Generate úspěšně vytvořil kanonický artefakt cenova_nabidka.docx. */
  hasGeneratedOffer?: boolean;
  entries: CostEntry[];
}

export interface CostsAggregate {
  dnes_czk: number;
  /** Posledních 7 dní (rolling), včetně dneška. */
  tyden_czk: number;
  /** Posledních 30 dní (rolling), včetně dneška. */
  mesic_czk: number;
  celkem_czk: number;
  /** Průměrné celkové AI náklady na jednu vygenerovanou cenovou nabídku. */
  kc_na_cn: number | null;
  top_zakazky: Array<{ tender_id: string; nazev: string | null; celkem_czk: number }>;
  /** Posledních 14 dní, chronologicky, nulami doplněné dny bez záznamu. */
  po_dnech: Array<{ den: string; czk: number }>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** YYYY-MM-DD z ISO timestampu (UTC kalendářní den). null u neparsovatelného data. */
function dayKey(timestamp: string): string | null {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Čistý výpočet agregace nákladů — exportováno kvůli unit testům (bez FS).
 * Defenzivní: záznam bez validního costCZK nebo timestamp se tiše přeskočí
 * (vadný JSON záznam nesmí spadnout celou agregaci).
 */
export function computeCostsAggregate(
  tenders: CostsAggregateTenderInput[],
  now: Date = new Date(),
): CostsAggregate {
  const todayKey = now.toISOString().slice(0, 10);
  const weekCutoff = now.getTime() - WEEK_DAYS * DAY_MS;
  const monthCutoff = now.getTime() - MONTH_DAYS * DAY_MS;

  let dnes = 0;
  let tyden = 0;
  let mesic = 0;
  let celkem = 0;
  let generatedOffers = 0;
  const perTender = new Map<string, { nazev: string | null; czk: number }>();
  const perDay = new Map<string, number>();

  for (const t of tenders) {
    if (t.hasGeneratedOffer) generatedOffers += 1;
    let tenderCzk = 0;
    for (const e of t.entries) {
      if (!e || typeof e.costCZK !== 'number' || Number.isNaN(e.costCZK)) continue;
      if (typeof e.timestamp !== 'string') continue;
      const key = dayKey(e.timestamp);
      if (!key) continue;
      const ts = new Date(e.timestamp).getTime();

      celkem += e.costCZK;
      tenderCzk += e.costCZK;
      if (key === todayKey) dnes += e.costCZK;
      if (ts >= weekCutoff) tyden += e.costCZK;
      if (ts >= monthCutoff) mesic += e.costCZK;
      perDay.set(key, (perDay.get(key) ?? 0) + e.costCZK);
    }
    if (tenderCzk > 0) {
      const prev = perTender.get(t.tenderId);
      perTender.set(t.tenderId, {
        nazev: t.name ?? prev?.nazev ?? null,
        czk: (prev?.czk ?? 0) + tenderCzk,
      });
    }
  }

  const top_zakazky = [...perTender.entries()]
    .map(([tender_id, v]) => ({ tender_id, nazev: v.nazev, celkem_czk: round2(v.czk) }))
    .sort((a, b) => b.celkem_czk - a.celkem_czk)
    .slice(0, 10);

  const po_dnech: Array<{ den: string; czk: number }> = [];
  for (let i = CHART_DAYS - 1; i >= 0; i--) {
    const key = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    po_dnech.push({ den: key, czk: round2(perDay.get(key) ?? 0) });
  }

  return {
    dnes_czk: round2(dnes),
    tyden_czk: round2(tyden),
    mesic_czk: round2(mesic),
    celkem_czk: round2(celkem),
    kc_na_cn: generatedOffers > 0 ? round2(celkem / generatedOffers) : null,
    top_zakazky,
    po_dnech,
  };
}

/**
 * Načte cost-log.json ze VŠECH zakázek v output/ a spočítá agregovaný přehled.
 * Čte defenzivně: chybějící/vadný cost-log.json nebo tender-meta.json danou
 * zakázku jen vynechá z detailu (jméno/náklady), nikdy nespadne celý endpoint.
 */
export async function getCostsOverview(now: Date = new Date()): Promise<CostsAggregate> {
  const outputRoot = join(ROOT, 'output');
  let dirs: string[] = [];
  try {
    dirs = (await readdir(outputRoot)).filter((d) => !d.startsWith('.'));
  } catch {
    return computeCostsAggregate([], now);
  }

  const tenders: CostsAggregateTenderInput[] = await Promise.all(
    dirs.map(async (tenderId) => {
      let entries: CostEntry[] = [];
      try {
        const raw = JSON.parse(await readFile(join(outputRoot, tenderId, 'cost-log.json'), 'utf-8'));
        if (Array.isArray(raw)) entries = raw;
      } catch {
        // chybějící nebo poškozený cost-log.json — zakázka bez nákladů
      }
      let name: string | null = null;
      try {
        const meta = JSON.parse(await readFile(join(outputRoot, tenderId, 'tender-meta.json'), 'utf-8'));
        if (typeof meta?.name === 'string') name = meta.name;
      } catch {
        // bez meta jména — top_zakazky ukáže jen tender_id
      }
      // Kanonický výstup generate je spolehlivější než job historie: .jobs.json
      // drží jen posledních 100 jobů a nemusí existovat po migraci/starším CLI běhu.
      // Soubor vzniká až v generate pipeline a přežije restart serveru.
      let hasGeneratedOffer = false;
      try {
        await access(join(outputRoot, tenderId, 'cenova_nabidka.docx'));
        hasGeneratedOffer = true;
      } catch {
        // Bez kanonické CN se zakázka do jmenovatele nepočítá.
      }
      return { tenderId, name, entries, hasGeneratedOffer };
    }),
  );

  return computeCostsAggregate(tenders, now);
}
