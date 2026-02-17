import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { TenderAnalysisSchema, type ExtractedText } from './lib/types.js';
import { ANALYZE_TENDER_SYSTEM, buildAnalyzeUserMessage } from './prompts/analyze-tender.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  console.log(`\n=== Step 2: AI Analysis ===`);
  console.log(`Tender ID: ${tenderId}`);

  const outputDir = join(ROOT, 'output', tenderId);
  await mkdir(outputDir, { recursive: true });

  // Read extracted text
  const extractedPath = join(outputDir, 'extracted-text.json');
  const extracted: ExtractedText = JSON.parse(
    await readFile(extractedPath, 'utf-8')
  );

  // Combine non-template documents for analysis
  const analysisText = extracted.documents
    .filter((d) => !d.isTemplate)
    .map((d) => `=== ${d.filename} ===\n${d.text}`)
    .join('\n\n');

  console.log(`\nAnalyzing ${analysisText.length} characters...`);

  // Call Claude
  const result = await callClaude(
    ANALYZE_TENDER_SYSTEM,
    buildAnalyzeUserMessage(analysisText),
    { maxTokens: 8192, temperature: 0.1 }
  );

  // Parse and validate JSON response
  let jsonStr = result.content.trim();
  // Handle potential markdown code block wrapper
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(jsonStr);
  const analysis = TenderAnalysisSchema.parse(parsed);

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
