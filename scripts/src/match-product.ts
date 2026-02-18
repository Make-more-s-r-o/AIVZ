import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { ProductMatchSchema, type TenderAnalysis, type ProductCandidate } from './lib/types.js';
import { PRODUCT_MATCH_SYSTEM, buildProductMatchUserMessage, type MatchableItem } from './prompts/product-match.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

// Service/non-matchable item keywords — these don't need product matching
const SERVICE_KEYWORDS = [
  'doprava', 'transport', 'doručení', 'dodání',
  'instalace', 'montáž', 'zapojení', 'zprovoznění',
  'záruka', 'záruční', 'servis', 'údržba', 'podpora',
  'dokumentace', 'návod', 'manuál', 'příručka',
  'školení', 'zaškolení', 'instruktáž',
  'pojištění', 'likvidace', 'recyklace',
];

function isMatchableItem(item: { nazev: string; specifikace: string }): boolean {
  const text = `${item.nazev} ${item.specifikace}`.toLowerCase();
  return !SERVICE_KEYWORDS.some(kw => text.startsWith(kw) || text.includes(`pouze ${kw}`));
}

function enrichWithFallbackUrls(candidate: ProductCandidate): void {
  if (!candidate.reference_urls?.length) {
    const q = encodeURIComponent(`${candidate.vyrobce} ${candidate.model}`);
    candidate.reference_urls = [
      `https://www.alza.cz/search?q=${q}`,
      `https://www.heureka.cz/?h%5Bfraze%5D=${q}`,
      `https://www.czc.cz/hledat?q=${q}`,
    ];
  }
}

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  const candidateCountArg = process.argv.find((a) => a.startsWith('--candidates='));
  const candidateCount = candidateCountArg ? parseInt(candidateCountArg.split('=')[1], 10) : 3;

  console.log(`\n=== Step 3: Product Matching ===`);
  console.log(`Tender ID: ${tenderId}`);
  console.log(`Candidates per item: ${candidateCount}`);

  const outputDir = join(ROOT, 'output', tenderId);
  await mkdir(outputDir, { recursive: true });

  // Read analysis
  const analysisPath = join(outputDir, 'analysis.json');
  const analysis: TenderAnalysis = JSON.parse(
    await readFile(analysisPath, 'utf-8')
  );

  const requirements = analysis.technicke_pozadavky;

  // Detect matchable items from analysis
  const matchableItems = analysis.polozky.filter(item => isMatchableItem(item));
  console.log(`\nItems from analysis: ${analysis.polozky.length} total, ${matchableItems.length} matchable`);
  if (matchableItems.length > 1) {
    console.log(`  Multi-product mode: ${matchableItems.map(i => i.nazev).join(', ')}`);
  }

  // Build MatchableItem list — attach all requirements to each item
  // (AI will sort them by relevance per item)
  const items: MatchableItem[] = matchableItems.map(item => ({
    nazev: item.nazev,
    mnozstvi: item.mnozstvi,
    jednotka: item.jednotka,
    specifikace: item.specifikace,
    technicke_pozadavky: requirements,
  }));

  // Fallback: if no matchable items, create a single item from the tender subject
  if (items.length === 0) {
    console.log('  No matchable items found — using tender subject as single item');
    items.push({
      nazev: analysis.zakazka.predmet,
      specifikace: analysis.zakazka.predmet,
      technicke_pozadavky: requirements,
    });
  }

  console.log(`\nMatching products for ${items.length} item(s) with ${requirements.length} technical requirements...`);

  // Dynamic maxTokens — scale with number of items × candidates
  // Each item+3 candidates ≈ 3000 tokens output
  const maxTokens = Math.min(32768, 8192 + items.length * 4000);

  // Call Claude for product matching
  const result = await callClaude(
    PRODUCT_MATCH_SYSTEM,
    buildProductMatchUserMessage(
      items,
      analysis.zakazka.nazev,
      analysis.zakazka.predmet,
      analysis.zakazka.predpokladana_hodnota,
      candidateCount,
    ),
    { maxTokens, temperature: 0.3 }
  );

  // Parse and validate JSON response
  let jsonStr = result.content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);

  // Enrich candidates with fallback URLs
  if (parsed.kandidati) {
    for (const candidate of parsed.kandidati) {
      enrichWithFallbackUrls(candidate);
    }
  }
  if (parsed.polozky_match) {
    for (const pm of parsed.polozky_match) {
      for (const candidate of pm.kandidati) {
        enrichWithFallbackUrls(candidate);
      }
    }
  }

  const productMatch = ProductMatchSchema.parse({
    tenderId,
    matchedAt: new Date().toISOString(),
    ...parsed,
  });

  const outputPath = join(outputDir, 'product-match.json');
  await writeFile(outputPath, JSON.stringify(productMatch, null, 2), 'utf-8');

  // Summary logging
  if (productMatch.polozky_match) {
    console.log(`\nMulti-product matching complete:`);
    for (const pm of productMatch.polozky_match) {
      const selected = pm.kandidati[pm.vybrany_index];
      console.log(`  ${pm.polozka_nazev}:`);
      console.log(`    Candidates: ${pm.kandidati.length}`);
      console.log(`    Selected: ${selected.vyrobce} ${selected.model}`);
      console.log(`    Price (bez DPH): ${selected.cena_bez_dph.toLocaleString('cs-CZ')} Kč`);
    }
  } else if (productMatch.kandidati) {
    const selected = productMatch.kandidati[productMatch.vybrany_index!];
    console.log(`\nProduct matching complete:`);
    console.log(`  Candidates: ${productMatch.kandidati.length}`);
    console.log(`  Selected: ${selected.vyrobce} ${selected.model}`);
    console.log(`  Price (bez DPH): ${selected.cena_bez_dph.toLocaleString('cs-CZ')} Kč`);
    console.log(`  Price (s DPH): ${selected.cena_s_dph.toLocaleString('cs-CZ')} Kč`);
    console.log(`  Reason: ${productMatch.oduvodneni_vyberu}`);
  }

  console.log(`  AI cost: ${result.costCZK.toFixed(2)} CZK`);
  console.log(`\nOutput: ${outputPath}`);
  console.log(`\nReview product-match.json and adjust prices before generating documents!`);
}

main().catch((err) => {
  console.error('Product matching failed:', err);
  process.exit(1);
});
