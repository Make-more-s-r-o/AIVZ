import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { logCost } from './lib/cost-tracker.js';
import { TenderAnalysisSchema, type ExtractedText } from './lib/types.js';
import { ANALYZE_TENDER_SYSTEM, buildAnalyzeUserMessage } from './prompts/analyze-tender.js';
import { parseSoupis } from './parse-soupis.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  console.log(`\n=== Step 2: AI Analysis ===`);
  console.log(`Tender ID: ${tenderId}`);

  const inputDir = join(ROOT, 'input', tenderId);
  const outputDir = join(ROOT, 'output', tenderId);
  await mkdir(outputDir, { recursive: true });

  // Read extracted text
  const extractedPath = join(outputDir, 'extracted-text.json');
  const extracted: ExtractedText = JSON.parse(
    await readFile(extractedPath, 'utf-8')
  );

  // Combine non-template, non-soupis documents for analysis
  const analysisText = extracted.documents
    .filter((d) => !d.isTemplate && !d.isSoupis)
    .map((d) => `=== ${d.filename} ===\n${d.text}`)
    .join('\n\n');

  console.log(`\nAnalyzing ${analysisText.length} characters...`);

  // Call Claude
  const result = await callClaude(
    ANALYZE_TENDER_SYSTEM,
    buildAnalyzeUserMessage(analysisText),
    { maxTokens: 16384, temperature: 0.1 }
  );

  // Parse and validate JSON response
  let jsonStr = result.content.trim();
  // Handle potential markdown code block wrapper
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);
  const analysis = TenderAnalysisSchema.parse(parsed);

  await logCost(tenderId, 'analyze', result.modelId, result.inputTokens, result.outputTokens, result.costCZK);

  // Check for soupis files and merge their items
  const soupisDocs = extracted.documents.filter(d => d.isSoupis);
  if (soupisDocs.length > 0) {
    console.log(`\nFound ${soupisDocs.length} soupis file(s) — parsing items...`);

    let soupisItemCount = 0;
    const soupisPolozky: typeof analysis.polozky = [];

    for (const doc of soupisDocs) {
      const ext = doc.filename.toLowerCase().split('.').pop();
      if (ext !== 'xlsx' && ext !== 'xls') {
        console.log(`  Skipping non-Excel soupis: ${doc.filename}`);
        continue;
      }

      try {
        const filePath = join(inputDir, doc.filename);
        const soupisResult = await parseSoupis(filePath);

        for (const item of soupisResult.polozky) {
          soupisPolozky.push({
            nazev: item.nazev,
            mnozstvi: item.mnozstvi,
            jednotka: item.jednotka || 'ks',
            specifikace: [
              item.specifikace,
              item.kategorie ? `Kategorie: ${item.kategorie}` : '',
              item.umisteni ? `Umístění: ${item.umisteni}` : '',
            ].filter(Boolean).join('. '),
          });
          soupisItemCount++;
        }
      } catch (err) {
        console.log(`  Warning: Failed to parse soupis ${doc.filename}: ${err}`);
      }
    }

    if (soupisPolozky.length > 0) {
      // Replace abstract part-level items with concrete soupis items
      const aiItemCount = analysis.polozky.length;
      console.log(`  Replacing ${aiItemCount} AI items with ${soupisPolozky.length} soupis items`);
      analysis.polozky = soupisPolozky;
    }
  }

  const outputPath = join(outputDir, 'analysis.json');
  await writeFile(outputPath, JSON.stringify(analysis, null, 2), 'utf-8');

  console.log(`\nAnalysis complete:`);
  console.log(`  Tender: ${analysis.zakazka.nazev}`);
  console.log(`  Type: ${analysis.zakazka.typ_zakazky}`);
  console.log(`  Qualification criteria: ${analysis.kvalifikace.length}`);
  console.log(`  Evaluation criteria: ${analysis.hodnotici_kriteria.length}`);
  console.log(`  Items: ${analysis.polozky.length}`);
  console.log(`  Technical requirements: ${analysis.technicke_pozadavky.length}`);
  console.log(`  Risks: ${analysis.rizika.length}`);
  console.log(`  Decision: ${analysis.doporuceni.rozhodnuti}`);
  console.log(`  AI cost: ${result.costCZK.toFixed(2)} CZK`);
  console.log(`Output: ${outputPath}`);
}

main().catch((err) => {
  console.error('Analysis failed:', err);
  process.exit(1);
});
