import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

config({ path: new URL('../../../.env', import.meta.url).pathname });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Cap per-request time so a stalled or rate-limited connection fails fast and the retry
  // loop in callClaude() can recover, instead of hanging ~10 min on a single request
  // (observed when the account ITPM limit was saturated). 3 min is ample for a 16k-token reply.
  timeout: 3 * 60 * 1000,
  maxRetries: 2,
});

export interface AICallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCZK: number;
  modelId: string;
  /** stop_reason z API — 'max_tokens' znamená useknutou (nekompletní) odpověď */
  stopReason: string | null;
}

// Tvrdý wall-clock deadline na JEDNO volání modelu. Na rozdíl od socket-idle timeoutu
// v SDK (3 min, resetuje se každou přijatou událostí streamu) tenhle limit skutečně
// přeruší i aktivně tekoucí, jen příliš dlouhou generaci (příčina zaseknutého kroku
// „Produkty" — dávka s desítkami tisíc output tokenů generovala > 600s a rodičovský
// watchdog ji zabil). Volající to pozná podle typu chyby (AICallTimeoutError).
//
// POZOR: deadline je OPT-IN přes `options.deadlineMs`. Zapíná ho JEN krok „match"
// (batch matching), kde vypršení spouští graceful rozpůlení dávky. Ostatní kroky
// (analyze/validate/generate/reconstruct/…) mají jedinou velkou generaci (až 16k tokenů),
// která může legitimně trvat i přes 240s a NESMÍ spadnout — jinak by tvrdý globální
// deadline regresně shodil kroky, které dřív pod step-timeoutem doběhly. Ty chrání jen
// absolutní strop kroku v serve-api + socket-idle timeout SDK.
export const DEFAULT_MATCH_CALL_DEADLINE_MS = 240000;

/** Deadline pro match batch volání (env override AI_CALL_DEADLINE_MS, jinak default). */
export function getMatchCallDeadlineMs(): number {
  const raw = Number(process.env.AI_CALL_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MATCH_CALL_DEADLINE_MS;
}

/** Odhad/skutečná spotřeba tokenů z části generace, která proběhla před abortem. */
export interface AICallPartialUsage {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  costCZK: number;
}

/** Volání modelu překročilo tvrdý wall-clock deadline a bylo abortnuto. */
export class AICallTimeoutError extends Error {
  readonly deadlineMs: number;
  // Anthropic účtuje i output tokeny vygenerované do abortu — neseme je s chybou,
  // aby je volající mohl zapsat do cost-logu (jinak reportovaná cena < skutečná).
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costCZK: number;
  constructor(deadlineMs: number, partial?: AICallPartialUsage) {
    super(`AI volání překročilo časový limit ${Math.round(deadlineMs / 1000)}s a bylo přerušeno.`);
    this.name = 'AICallTimeoutError';
    this.deadlineMs = deadlineMs;
    this.modelId = partial?.modelId ?? 'unknown';
    this.inputTokens = partial?.inputTokens ?? 0;
    this.outputTokens = partial?.outputTokens ?? 0;
    this.costCZK = partial?.costCZK ?? 0;
  }
}

// Friendly name → actual model ID
const MODEL_IDS: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
  opus: 'claude-opus-4-6',
};

// Pricing: USD per token → CZK per token (at ~24 CZK/USD)
const USD_TO_CZK = 24;
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': {
    input: (3 / 1_000_000) * USD_TO_CZK,
    output: (15 / 1_000_000) * USD_TO_CZK,
  },
  'claude-haiku-4-5-20251001': {
    input: (0.25 / 1_000_000) * USD_TO_CZK,
    output: (1.25 / 1_000_000) * USD_TO_CZK,
  },
  'claude-opus-4-6': {
    input: (15 / 1_000_000) * USD_TO_CZK,
    output: (75 / 1_000_000) * USD_TO_CZK,
  },
};

// Fallback pricing if model not in table (use Sonnet rates)
const DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6'];

export function resolveModelId(model?: string): string {
  if (!model) return process.env.AI_MODEL || 'claude-sonnet-4-6';
  return MODEL_IDS[model] ?? model;
}

export function getModelPricing(modelId: string) {
  return MODEL_PRICING[modelId] ?? DEFAULT_PRICING;
}

export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    retries?: number;
    /** 'sonnet' | 'haiku' | 'opus' | explicit model ID. Defaults to AI_MODEL env or sonnet. */
    model?: string;
    /**
     * Tvrdý wall-clock deadline JEDNOHO pokusu v ms. Když je nastaven a vyprší, volání se
     * abortuje a vyhodí AICallTimeoutError. OPT-IN — používá ho jen match batch. Bez něj
     * (undefined) žádný wall-clock deadline neplatí (jen SDK socket-idle timeout).
     */
    deadlineMs?: number;
  } = {},
): Promise<AICallResult> {
  const { maxTokens = 8192, temperature = 0.2, retries = 4, model: modelOption, deadlineMs } = options;

  const modelId = resolveModelId(modelOption);
  const pricing = getModelPricing(modelId);
  const hasDeadline = typeof deadlineMs === 'number' && deadlineMs > 0;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Tvrdý wall-clock deadline per pokus — abortne i aktivně tekoucí stream (jen když opt-in).
    const controller = new AbortController();
    const deadlineTimer = hasDeadline ? setTimeout(() => controller.abort(), deadlineMs) : null;
    // Průběžná spotřeba tokenů ze streamu — ať při abortu umíme zaúčtovat i částečnou generaci.
    let partialInputTokens = 0;
    let partialOutputTokens = 0;
    try {
      // Stream the response so long generations (large multi-item JSON) keep the connection
      // alive and don't trip the request timeout; finalMessage() resolves with the full reply.
      const stream = client.messages.stream(
        {
          model: modelId,
          max_tokens: maxTokens,
          temperature,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: controller.signal },
      );
      // message_start nese přesné input_tokens, každý message_delta kumulativní output_tokens —
      // zachytíme je průběžně, aby byla usage k dispozici i když stream skončí abortem.
      // Heartbeat á ~60 s: dlouhá generace (analyze 32k tokenů = jednotky minut) jinak mlčí
      // a idle watchdog job fronty (300 s bez outputu) by živý stream zabil.
      let lastHeartbeat = Date.now();
      stream.on('streamEvent', (event) => {
        if (event.type === 'message_start') {
          partialInputTokens = event.message.usage.input_tokens;
        } else if (event.type === 'message_delta') {
          partialOutputTokens = event.usage.output_tokens;
          if (Date.now() - lastHeartbeat >= 60_000) {
            lastHeartbeat = Date.now();
            console.log(`  … AI stream běží (${partialOutputTokens} output tokenů)`);
          }
        }
      });
      const response = await stream.finalMessage();

      const content = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const costCZK = inputTokens * pricing.input + outputTokens * pricing.output;

      const modelLabel = modelOption || modelId;
      console.log(
        `  AI call [${modelLabel}]: ${inputTokens} in / ${outputTokens} out tokens, cost: ${costCZK.toFixed(2)} CZK`,
      );

      return { content, inputTokens, outputTokens, costCZK, modelId, stopReason: response.stop_reason };
    } catch (error) {
      lastError = error as Error;
      // Wall-clock deadline vypršel → vyhoď typovanou chybu a NEretryuj uvnitř klienta.
      // Retry (např. s poloviční dávkou) je rozhodnutí volajícího — jinak by se dlouhá
      // generace jen několikrát zopakovala a snědla celý rozpočet kroku.
      if (hasDeadline && controller.signal.aborted) {
        const costCZK = partialInputTokens * pricing.input + partialOutputTokens * pricing.output;
        // Anthropic účtuje i tokeny vygenerované do abortu — zaloguj je do konzole a předej
        // volajícímu na chybě, aby je zapsal do cost-logu (jinak reportovaná cena < skutečná).
        console.log(
          `  AI call [${modelOption || modelId}] ABORT (deadline ${Math.round(deadlineMs / 1000)}s): ` +
          `${partialInputTokens} in / ${partialOutputTokens} out tokens, ~${costCZK.toFixed(2)} CZK (účtováno i za abort)`,
        );
        throw new AICallTimeoutError(deadlineMs, {
          modelId,
          inputTokens: partialInputTokens,
          outputTokens: partialOutputTokens,
          costCZK,
        });
      }
      // Don't retry non-retryable errors (credit exhausted, invalid API key, etc.)
      const status = (error as any)?.status;
      const shouldRetry = (error as any)?.headers?.['x-should-retry'];
      const isNonRetryable = status === 400 || status === 401 || shouldRetry === 'false';
      if (isNonRetryable) {
        throw error;
      }
      if (attempt < retries) {
        const delay = Math.min(Math.pow(2, attempt) * 2000, 30000);
        console.log(`  Retry ${attempt + 1}/${retries} in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  throw lastError;
}
