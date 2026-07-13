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
