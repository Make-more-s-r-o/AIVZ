import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { extractDocuments } from './lib/document-parser.js';
import { ExtractedTextSchema } from './lib/types.js';

const ROOT = new URL('../../', import.meta.url).pathname;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  console.log(`\n=== Step 1: Extract tender documents ===`);
  console.log(`Tender ID: ${tenderId}`);

  const inputDir = join(ROOT, 'input', tenderId);
  const outputDir = join(ROOT, 'output', tenderId);

  await mkdir(outputDir, { recursive: true });

  console.log(`\nExtracting from: ${inputDir}`);
  const documents = await extractDocuments(inputDir);

  const result = ExtractedTextSchema.parse({
    tenderId,
    extractedAt: new Date().toISOString(),
    documents,
    totalCharacters: documents.reduce((sum, d) => sum + d.text.length, 0),
  });

  const outputPath = join(outputDir, 'extracted-text.json');
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log(`\nExtracted ${documents.length} documents`);
  console.log(`Total characters: ${result.totalCharacters}`);
  console.log(`Templates (skipped for analysis): ${documents.filter((d) => d.isTemplate).length}`);
  console.log(`Output: ${outputPath}`);
}

main().catch((err) => {
  console.error('Extract failed:', err);
  process.exit(1);
});
