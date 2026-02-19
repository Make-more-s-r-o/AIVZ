import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { ProductMatchSchema, type TenderAnalysis, type ProductCandidate } from './lib/types.js';
import { PRODUCT_MATCH_SYSTEM, buildProductMatchUserMessage, buildServicePricingMessage, type MatchableItem } from './prompts/product-match.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

// Service keywords — fixed-price services, no product matching needed
const SERVICE_KEYWORDS = [
  'doprava', 'transport', 'doručení', 'dodání',
  'instalace', 'montáž', 'zapojení', 'zprovoznění',
  'záruka', 'záruční', 'servis', 'údržba', 'podpora',
  'dokumentace', 'návod', 'manuál', 'příručka',
  'školení', 'zaškolení', 'instruktáž',
  'pojištění', 'likvidace', 'recyklace',
];

// Accessory keywords — simple products with straightforward pricing
const ACCESSORY_KEYWORDS = [
  'myš', 'myši', 'mouse',
  'brašna', 'brašny', 'taška', 'tašky', 'obal', 'pouzdro', 'batoh',
  'klávesnice', 'keyboard',
  'kabel', 'kabely', 'adaptér', 'redukce',
  'podložka', 'stojánek', 'stojan',
  'sluchátka', 'headset', 'reproduktor',
  'webkamera', 'webcam',
  'usb hub', 'dokovací stanice', 'dock',
  'toner', 'cartridge', 'náplň', 'inkoust',
  'papír', 'obálka', 'obálky',
];

type ItemCategory = 'produkt' | 'prislusenstvi' | 'sluzba';

function categorizeItem(item: { nazev: string; specifikace: string }): ItemCategory {
  const text = `${item.nazev} ${item.specifikace}`.toLowerCase();

  // Check services first (most restrictive)
  if (SERVICE_KEYWORDS.some(kw => text.startsWith(kw) || text.includes(`pouze ${kw}`))) {
    return 'sluzba';
  }

  // Check accessories
  if (ACCESSORY_KEYWORDS.some(kw => text.includes(kw))) {
    return 'prislusenstvi';
  }

  return 'produkt';
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

  // Categorize ALL items from analysis
  const categorized = analysis.polozky.map((item, idx) => ({
    ...item,
    originalIndex: idx,
    category: categorizeItem(item),
  }));

  const products = categorized.filter(i => i.category === 'produkt');
  const accessories = categorized.filter(i => i.category === 'prislusenstvi');
  const services = categorized.filter(i => i.category === 'sluzba');

  console.log(`\nItems from analysis: ${analysis.polozky.length} total`);
  console.log(`  Products (AI matching): ${products.length} — ${products.map(i => i.nazev).join(', ') || 'none'}`);
  console.log(`  Accessories (simple matching): ${accessories.length} — ${accessories.map(i => i.nazev).join(', ') || 'none'}`);
  console.log(`  Services (fixed price): ${services.length} — ${services.map(i => i.nazev).join(', ') || 'none'}`);

  // Build MatchableItem list for products + accessories (both need AI matching)
  const matchableItems = [...products, ...accessories];
  const items: MatchableItem[] = matchableItems.map(item => ({
    nazev: item.nazev,
    mnozstvi: item.mnozstvi,
    jednotka: item.jednotka,
    specifikace: item.specifikace,
    technicke_pozadavky: requirements,
    typ: item.category as 'produkt' | 'prislusenstvi',
  }));

  // Fallback: if no matchable items, create a single item from the tender subject
  if (items.length === 0 && services.length === 0) {
    console.log('  No items found — using tender subject as single item');
    items.push({
      nazev: analysis.zakazka.predmet,
      specifikace: analysis.zakazka.predmet,
      technicke_pozadavky: requirements,
    });
  }

  let polozkyMatch: any[] = [];

  // Step 1: Match products + accessories via AI
  if (items.length > 0) {
    console.log(`\nMatching ${items.length} product/accessory item(s) with ${requirements.length} technical requirements...`);

    const maxTokens = Math.min(32768, 8192 + items.length * 4000);

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
      // Convert legacy single-product to polozky_match format
      polozkyMatch.push({
        polozka_nazev: items[0].nazev,
        polozka_index: 0,
        mnozstvi: items[0].mnozstvi || 1,
        jednotka: items[0].jednotka,
        typ: items[0].typ || 'produkt',
        kandidati: parsed.kandidati,
        vybrany_index: parsed.vybrany_index,
        oduvodneni_vyberu: parsed.oduvodneni_vyberu,
      });
    }
    if (parsed.polozky_match) {
      for (const pm of parsed.polozky_match) {
        for (const candidate of pm.kandidati) {
          enrichWithFallbackUrls(candidate);
        }
        // Attach category type
        const matchableIdx = pm.polozka_index;
        pm.typ = items[matchableIdx]?.typ || 'produkt';
      }
      polozkyMatch.push(...parsed.polozky_match);
    }

    console.log(`  AI cost: ${result.costCZK.toFixed(2)} CZK`);
  }

  // Step 2: Price services via AI (simple pricing, no candidates)
  if (services.length > 0) {
    console.log(`\nPricing ${services.length} service item(s)...`);

    const serviceResult = await callClaude(
      PRODUCT_MATCH_SYSTEM,
      buildServicePricingMessage(
        services.map(s => ({
          nazev: s.nazev,
          mnozstvi: s.mnozstvi,
          jednotka: s.jednotka,
          specifikace: s.specifikace,
        })),
        analysis.zakazka.nazev,
        analysis.zakazka.predpokladana_hodnota,
      ),
      { maxTokens: 4096, temperature: 0.3 }
    );

    let jsonStr = serviceResult.content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const serviceParsed = JSON.parse(jsonStr);
    const serviceItems = serviceParsed.sluzby || [];

    for (const svc of serviceItems) {
      polozkyMatch.push({
        polozka_nazev: svc.nazev,
        polozka_index: polozkyMatch.length,
        mnozstvi: svc.mnozstvi || 1,
        jednotka: svc.jednotka,
        typ: 'sluzba',
        kandidati: [{
          vyrobce: '-',
          model: svc.nazev,
          popis: svc.popis || svc.nazev,
          parametry: {},
          shoda_s_pozadavky: [],
          cena_bez_dph: svc.cena_bez_dph,
          cena_s_dph: svc.cena_s_dph,
          cena_spolehlivost: svc.cena_spolehlivost || 'stredni',
          cena_komentar: svc.cena_komentar || 'Odhad ceny služby',
          dodavatele: [],
          dostupnost: 'dle dohody',
        }],
        vybrany_index: 0,
        oduvodneni_vyberu: svc.oduvodneni || 'Standardní služba',
      });
    }

    console.log(`  AI cost: ${serviceResult.costCZK.toFixed(2)} CZK`);
  }

  // Renumber polozka_index sequentially
  polozkyMatch.forEach((pm, idx) => { pm.polozka_index = idx; });

  // Build final ProductMatch object — always use polozky_match format now
  const productMatch = ProductMatchSchema.parse({
    tenderId,
    matchedAt: new Date().toISOString(),
    polozky_match: polozkyMatch,
  });

  const outputPath = join(outputDir, 'product-match.json');
  await writeFile(outputPath, JSON.stringify(productMatch, null, 2), 'utf-8');

  // Summary logging
  console.log(`\nMatching complete — ${polozkyMatch.length} items:`);
  for (const pm of productMatch.polozky_match || []) {
    const selected = pm.kandidati[pm.vybrany_index];
    const typeLabel = (pm as any).typ === 'sluzba' ? ' [služba]' : (pm as any).typ === 'prislusenstvi' ? ' [přísl.]' : '';
    console.log(`  ${pm.polozka_nazev}${typeLabel}:`);
    console.log(`    Candidates: ${pm.kandidati.length}`);
    console.log(`    Selected: ${selected.vyrobce} ${selected.model}`);
    console.log(`    Price (bez DPH): ${selected.cena_bez_dph.toLocaleString('cs-CZ')} Kč`);
  }

  console.log(`\nOutput: ${outputPath}`);
  console.log(`\nReview product-match.json and adjust prices before generating documents!`);
}

main().catch((err) => {
  console.error('Product matching failed:', err);
  process.exit(1);
});
