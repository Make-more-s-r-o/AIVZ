import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

config({ path: new URL('../../../.env', import.meta.url).pathname });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface AICallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCZK: number;
}

// Claude Sonnet 4.5 pricing: $3/M input, $15/M output
// At ~24 CZK/USD
const PRICE_INPUT_PER_TOKEN = (3 / 1_000_000) * 24;
const PRICE_OUTPUT_PER_TOKEN = (15 / 1_000_000) * 24;

export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  options: {
    maxTokens?: number;
    temperature?: number;
    retries?: number;
  } = {}
): Promise<AICallResult> {
  const { maxTokens = 8192, temperature = 0.2, retries = 2 } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model: process.env.AI_MODEL || 'claude-sonnet-4-5-20250929',
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
      const costCZK =
        inputTokens * PRICE_INPUT_PER_TOKEN +
        outputTokens * PRICE_OUTPUT_PER_TOKEN;

      console.log(
        `  AI call: ${inputTokens} in / ${outputTokens} out tokens, cost: ${costCZK.toFixed(2)} CZK`
      );

      return { content, inputTokens, outputTokens, costCZK };
    } catch (error) {
      lastError = error as Error;
      if (attempt < retries) {
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`  Retry ${attempt + 1}/${retries} in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
