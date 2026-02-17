import { execSync } from 'child_process';
import { join } from 'path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCRIPTS_DIR = join(ROOT, 'scripts', 'src');

const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

console.log(`\n========================================`);
console.log(`  VZ AI Tool — Full Pipeline`);
console.log(`  Tender: ${tenderId}`);
console.log(`========================================\n`);

const steps = [
  { name: 'extract', file: 'extract-tender.ts' },
  { name: 'analyze', file: 'analyze-tender.ts' },
  { name: 'match', file: 'match-product.ts' },
  { name: 'generate', file: 'generate-bid.ts' },
  { name: 'validate', file: 'validate-bid.ts' },
];

const startTime = Date.now();

for (const step of steps) {
  const stepStart = Date.now();
  console.log(`\n--- Running: ${step.name} ---`);

  try {
    execSync(
      `npx tsx "${join(SCRIPTS_DIR, step.file)}" --tender-id=${tenderId}`,
      { stdio: 'inherit', cwd: join(ROOT, 'scripts') }
    );
    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    console.log(`--- ${step.name} completed in ${elapsed}s ---`);
  } catch (err) {
    console.error(`\n!!! Step "${step.name}" failed !!!`);
    process.exit(1);
  }
}

const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n========================================`);
console.log(`  Pipeline complete in ${totalElapsed}s`);
console.log(`  Output: output/${tenderId}/`);
console.log(`========================================\n`);
