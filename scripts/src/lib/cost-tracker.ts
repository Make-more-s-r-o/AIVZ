/**
 * Cost tracker for AI API calls.
 * Logs per-step token usage and CZK costs to output/{tender}/cost-log.json.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
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
