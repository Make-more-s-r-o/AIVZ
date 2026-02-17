import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { ProductMatchSchema, type TenderAnalysis } from './lib/types.js';
import { PRODUCT_MATCH_SYSTEM, buildProductMatchUserMessage } from './prompts/product-match.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  console.log(`\n=== Step 3: Product Matching ===`);
  console.log(`Tender ID: ${tenderId}`);

  const outputDir = join(ROOT, 'output', tenderId);
  await mkdir(outputDir, { recursive: true });

  // Read analysis
  const analysisPath = join(outputDir, 'analysis.json');
  const analysis: TenderAnalysis = JSON.parse(
    await readFile(analysisPath, 'utf-8')
  );

  const requirements = analysis.technicke_pozadavky;
  if (requirements.length === 0) {
    console.log('Warning: No technical requirements found in analysis. Using items instead.');
  }

  console.log(`\nMatching products for ${requirements.length} technical requirements...`);

  // Call Claude for product matching
  const result = await callClaude(
    PRODUCT_MATCH_SYSTEM,
    buildProductMatchUserMessage(
      requirements,
      analysis.zakazka.nazev,
      analysis.zakazka.predmet
    ),
    { maxTokens: 8192, temperature: 0.3 }
  );

  // Parse and validate JSON response
  let jsonStr = result.content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);
  const productMatch = ProductMatchSchema.parse({
    tenderId,
    matchedAt: new Date().toISOString(),
    ...parsed,
  });

  const outputPath = join(outputDir, 'product-match.json');
  await writeFile(outputPath, JSON.stringify(productMatch, null, 2), 'utf-8');

  const selected = productMatch.kandidati[productMatch.vybrany_index];
  console.log(`\nProduct matching complete:`);
  console.log(`  Candidates: ${productMatch.kandidati.length}`);
  console.log(`  Selected: ${selected.vyrobce} ${selected.model}`);
  console.log(`  Price (bez DPH): ${selected.cena_bez_dph.toLocaleString('cs-CZ')} Kč`);
  console.log(`  Price (s DPH): ${selected.cena_s_dph.toLocaleString('cs-CZ')} Kč`);
  console.log(`  Reason: ${productMatch.oduvodneni_vyberu}`);
  console.log(`  AI cost: ${result.costCZK.toFixed(2)} CZK`);
  console.log(`\nOutput: ${outputPath}`);
  console.log(`\nReview product-match.json and adjust prices before generating documents!`);
}

main().catch((err) => {
  console.error('Product matching failed:', err);
  process.exit(1);
});
