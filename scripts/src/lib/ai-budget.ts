import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

const ROOT = new URL('../../../', import.meta.url).pathname;
export const AI_BUDGET_WARNING_RATIO = 0.8;
export const AI_BUDGET_STATE_DIR = join(ROOT, 'output', '.governance-state', 'ai-budget-warnings');

export interface BudgetWarningInput {
  todayCzk: number;
  limitCzk: number | null;
  now?: Date;
  stateDir?: string;
  send?: (message: string) => Promise<void>;
}

export type BudgetWarningResult = 'below_threshold' | 'disabled' | 'already_sent' | 'sent';

export interface DailyBudgetSnapshot {
  day: string;
  limitCzk: number;
  spentCzk: number;
  remainingCzk: number;
  exhausted: boolean;
}

interface DatedCostEntry {
  timestamp: string;
  costCZK: number;
}

export interface DailyAgentCharge {
  day: string;
  amountCzk: number;
}

/**
 * Náklad agenta je součástí společného cost-logu, ale nesmí čerpat lidský limit.
 * Odečítáme pouze již přiřazené agentní náklady; záporný lidský náklad není možný.
 */
export function humanDailySpendCzk(totalTodayCzk: number, agentTodayCzk: number): number {
  const total = Number.isFinite(totalTodayCzk) ? totalTodayCzk : 0;
  const agent = Number.isFinite(agentTodayCzk) ? agentTodayCzk : 0;
  return Math.max(0, total - agent);
}

/** Jednotná hláška pro HTTP guard i navazující kroky pipeline. */
export function agentDailyLimitBlock(budget: DailyBudgetSnapshot): string | null {
  if (!budget.exhausted && budget.spentCzk < budget.limitCzk) return null;
  return `Agent vyčerpal denní AI limit ${budget.limitCzk.toFixed(2)} Kč; zbývá 0.00 Kč.`;
}

/**
 * Rozdělí nové append-only cost-log záznamy po UTC dnech. Offset se ukládá s jobem,
 * takže po restartu lze stejný job dopočítat idempotentním charge ID.
 */
export function agentChargesSince(
  entries: readonly DatedCostEntry[],
  offset: number,
): DailyAgentCharge[] {
  if (!Number.isInteger(offset) || offset < 0 || offset > entries.length) {
    throw new Error('Neplatný offset agentního cost-logu.');
  }
  const totals = new Map<string, number>();
  for (const entry of entries.slice(offset)) {
    if (!entry || !Number.isFinite(entry.costCZK) || entry.costCZK <= 0) continue;
    const timestamp = new Date(entry.timestamp);
    if (Number.isNaN(timestamp.getTime())) continue;
    const day = timestamp.toISOString().slice(0, 10);
    totals.set(day, (totals.get(day) ?? 0) + entry.costCZK);
  }
  return [...totals.entries()].map(([day, amountCzk]) => ({ day, amountCzk }));
}

/** Odeslání do stejného incoming-webhook cíle, který používá provozní watchdog. */
export async function sendWatchdogSlackWarning(message: string): Promise<void> {
  const webhook = process.env.VZ_WATCHDOG_SLACK_WEBHOOK_URL
    ?? process.env.SLACK_WATCHDOG_WEBHOOK_URL;
  if (!webhook) throw new Error('Watchdog Slack webhook není nakonfigurován.');
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });
  if (!response.ok) throw new Error(`Watchdog Slack webhook vrátil HTTP ${response.status}.`);
}

/**
 * Atomický per-day claim zajišťuje deduplikaci i mezi procesy a přes restart serveru.
 * Claim vznikne těsně před odesláním: alert se zkusí nejvýše jednou za den, takže ani
 * chybující webhook nemůže vyvolat spam po každém dalším AI volání.
 */
export async function maybeSendDailyBudgetWarning(input: BudgetWarningInput): Promise<BudgetWarningResult> {
  const { todayCzk, limitCzk } = input;
  if (limitCzk == null || limitCzk <= 0) return 'disabled';
  if (!Number.isFinite(todayCzk) || todayCzk < limitCzk * AI_BUDGET_WARNING_RATIO) {
    return 'below_threshold';
  }

  const now = input.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  const stateDir = input.stateDir ?? AI_BUDGET_STATE_DIR;
  await mkdir(stateDir, { recursive: true });
  const claimPath = join(stateDir, `${day}.json`);
  try {
    await writeFile(claimPath, JSON.stringify({ day, claimedAt: now.toISOString(), todayCzk, limitCzk }), {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'already_sent';
    throw error;
  }

  const percent = Math.round((todayCzk / limitCzk) * 100);
  const message = `:warning: AI denní rozpočet je na ${percent} % (${todayCzk.toFixed(2)}/${limitCzk.toFixed(2)} Kč). Při dosažení 100 % se nové AI joby zablokují a běžící pipeline se pozastaví na hranici kroku.`;
  await (input.send ?? sendWatchdogSlackWarning)(message);
  return 'sent';
}
