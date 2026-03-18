/**
 * OpenAI Embedding service pro pgvector sémantické vyhledávání.
 * Model: text-embedding-3-small (1536 dims, ~$0.02/1M tokens)
 */
import { query } from './db.js';

const OPENAI_API_URL = 'https://api.openai.com/v1/embeddings';
const MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 100; // OpenAI limit: 2048 inputs per request

/**
 * Vygeneruje embedding pro jeden text.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: text.slice(0, 8000), // Max ~8K tokens
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${err}`);
  }

  const data = await response.json() as any;
  return data.data[0].embedding;
}

/**
 * Batch embedding — zpracuje více textů najednou (efektivnější).
 */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map((t) => t.slice(0, 8000));

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        input: batch,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${err}`);
    }

    const data = await response.json() as any;
    const embeddings = data.data
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding);
    results.push(...embeddings);
  }

  return results;
}

/**
 * Uloží embedding pro produkt do DB.
 */
export async function saveProductEmbedding(productId: string, embedding: number[]): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`;
  await query(
    'UPDATE products SET embedding = $1::vector WHERE id = $2',
    [vectorStr, productId],
  );
}

/**
 * Vygeneruje a uloží embeddingy pro produkty bez embeddingu.
 * Vrací počet zpracovaných produktů.
 */
export async function generateMissingEmbeddings(limit = 500): Promise<number> {
  const { rows } = await query<{ id: string; text: string }>(
    `SELECT id,
            coalesce(manufacturer,'') || ' ' || coalesce(model,'') || ' ' ||
            coalesce(part_number,'') || ' ' || coalesce(description,'') as text
     FROM products
     WHERE embedding IS NULL AND is_active = true
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );

  if (rows.length === 0) return 0;

  console.log(`Embedding: generating for ${rows.length} products...`);

  const texts = rows.map((r) => r.text);
  const embeddings = await generateEmbeddings(texts);

  for (let i = 0; i < rows.length; i++) {
    await saveProductEmbedding(rows[i].id, embeddings[i]);
  }

  console.log(`Embedding: done (${rows.length} products)`);
  return rows.length;
}

/**
 * Vygeneruje embedding pro vyhledávací dotaz.
 */
export async function embedQuery(queryText: string): Promise<number[]> {
  return generateEmbedding(queryText);
}
