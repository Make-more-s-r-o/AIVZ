/**
 * CLI orchestrátor pro scraping.
 *
 * Použití:
 *   npx tsx scripts/src/scrapers/orchestrator.ts --shop prusa --test
 *   npx tsx scripts/src/scrapers/orchestrator.ts --shop prusa
 *   npx tsx scripts/src/scrapers/orchestrator.ts --shop prusa --category "Filamenty"
 *   npx tsx scripts/src/scrapers/orchestrator.ts --dry-run
 */
import 'dotenv/config';
import { getScraper, getRegisteredShops } from './registry.js';
import { importProducts } from './importer.js';
import type { ScrapeRunResult, ScrapeSummary } from './types.js';
import { isDbAvailable, closePool } from '../lib/db.js';

// ============================================================
// CLI argument parsing
// ============================================================

function parseArgs(): {
  shop?: string;
  category?: string;
  test: boolean;
  dryRun: boolean;
  limit?: number;
} {
  const args = process.argv.slice(2);
  const result: ReturnType<typeof parseArgs> = { test: false, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--shop':
        result.shop = args[++i];
        break;
      case '--category':
        result.category = args[++i];
        break;
      case '--test':
        result.test = true;
        result.limit = 5;
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--limit':
        result.limit = parseInt(args[++i]);
        break;
    }
  }

  return result;
}

// ============================================================
// Summary tabulka
// ============================================================

function printSummary(summary: ScrapeSummary): void {
  console.log('\n' + '='.repeat(70));
  console.log(`SOUHRN: ${summary.shop}`);
  console.log('='.repeat(70));
  console.log(
    `${'Kategorie'.padEnd(25)} ${'Staženo'.padStart(8)} ${'Nových'.padStart(8)} ${'Aktual.'.padStart(8)} ${'Chyb'.padStart(6)} ${'Čas'.padStart(8)}`,
  );
  console.log('-'.repeat(70));

  for (const run of summary.runs) {
    const time = `${(run.durationMs / 1000).toFixed(1)}s`;
    console.log(
      `${run.category.padEnd(25)} ${String(run.itemsScraped).padStart(8)} ${String(run.itemsCreated).padStart(8)} ${String(run.itemsUpdated).padStart(8)} ${String(run.errors.length).padStart(6)} ${time.padStart(8)}`,
    );
  }

  console.log('-'.repeat(70));
  const totalTime = `${(summary.totalDurationMs / 1000).toFixed(1)}s`;
  console.log(
    `${'CELKEM'.padEnd(25)} ${String(summary.totalScraped).padStart(8)} ${String(summary.totalCreated).padStart(8)} ${String(summary.totalUpdated).padStart(8)} ${String(summary.totalErrors).padStart(6)} ${totalTime.padStart(8)}`,
  );
  console.log('='.repeat(70));
}

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const opts = parseArgs();
  const shops = getRegisteredShops();

  // --dry-run bez --shop → vypíše registrované shopy
  if (!opts.shop) {
    console.log('Registrované shopy:');
    for (const shopId of shops) {
      const scraper = await getScraper(shopId);
      if (scraper) {
        console.log(`\n  ${scraper.config.name} (--shop ${shopId})`);
        console.log(`  URL: ${scraper.config.url}`);
        console.log(`  Kategorie:`);
        for (const cat of scraper.config.categories) {
          console.log(`    - ${cat.name} (${cat.slug})`);
        }
      }
    }
    process.exit(0);
  }

  // Načti scraper
  const scraper = await getScraper(opts.shop);
  if (!scraper) {
    console.error(`Neznámý shop: ${opts.shop}`);
    console.error(`Dostupné: ${shops.join(', ')}`);
    process.exit(1);
  }

  // Kontrola DB
  if (!opts.dryRun) {
    const dbOk = await isDbAvailable();
    if (!dbOk) {
      console.error('Database není dostupná. Nastav DATABASE_URL nebo použij --dry-run.');
      process.exit(1);
    }
  }

  console.log(`\nScraping: ${scraper.config.name}`);
  if (opts.test) console.log('  Režim: TEST (max 5 produktů)');
  if (opts.dryRun) console.log('  Režim: DRY RUN (bez zápisu do DB)');
  if (opts.category) console.log(`  Filtr: kategorie "${opts.category}"`);

  // Inicializace (login, token refresh...)
  await scraper.init();

  // Vyber kategorie
  const categories = scraper.getCategories(opts);
  if (categories.length === 0) {
    console.error(`Žádné kategorie neodpovídají filtru "${opts.category}"`);
    await scraper.cleanup();
    process.exit(1);
  }

  console.log(`  Kategorie: ${categories.map((c) => c.name).join(', ')}\n`);

  // Spusť scraping po kategoriích
  const runs: ScrapeRunResult[] = [];
  const totalStart = Date.now();

  for (const category of categories) {
    console.log(`--- ${category.name} ---`);

    const generator = scraper.scrape([category], {
      limit: opts.limit,
      dryRun: opts.dryRun,
    });

    const result = await importProducts(
      generator,
      scraper.config.id,
      category.name,
      scraper.config.source_id,
      opts.dryRun,
    );

    runs.push(result);
    console.log(
      `  Hotovo: ${result.itemsScraped} staženo, ${result.itemsCreated} nových, ${result.itemsUpdated} aktualizováno, ${result.errors.length} chyb`,
    );
  }

  // Cleanup
  await scraper.cleanup();

  // Souhrn
  const summary: ScrapeSummary = {
    shop: scraper.config.name,
    runs,
    totalScraped: runs.reduce((s, r) => s + r.itemsScraped, 0),
    totalCreated: runs.reduce((s, r) => s + r.itemsCreated, 0),
    totalUpdated: runs.reduce((s, r) => s + r.itemsUpdated, 0),
    totalErrors: runs.reduce((s, r) => s + r.errors.length, 0),
    totalDurationMs: Date.now() - totalStart,
  };

  printSummary(summary);

  // Cleanup DB pool
  await closePool();
}

main().catch((err) => {
  console.error('Fatální chyba:', err);
  process.exit(1);
});
