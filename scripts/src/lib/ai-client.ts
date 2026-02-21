import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

config({ path: new URL('../../../.env', import.meta.url).pathname });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 10 * 60 * 1000, // 10 minutes for large multi-item requests
});

export interface AICallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCZK: number;
  modelId: string;
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
  } = {},
): Promise<AICallResult> {
  const { maxTokens = 8192, temperature = 0.2, retries = 4, model: modelOption } = options;

  const modelId = resolveModelId(modelOption);
  const pricing = getModelPricing(modelId);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

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

      return { content, inputTokens, outputTokens, costCZK, modelId };
    } catch (error) {
      lastError = error as Error;
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
    }
  }

  throw lastError;
}
