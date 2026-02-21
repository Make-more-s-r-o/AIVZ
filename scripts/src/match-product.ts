import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { logCost } from './lib/cost-tracker.js';
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
  const name = item.nazev.toLowerCase();
  const text = `${item.nazev} ${item.specifikace}`.toLowerCase();

  // Check services first — match on item NAME only (not full spec)
  if (SERVICE_KEYWORDS.some(kw => name.startsWith(kw) || name.includes(`pouze ${kw}`))) {
    return 'sluzba';
  }

  // Check accessories — match on item NAME only
  // (specs may mention accessories like "myš" as part of a bigger product description)
  if (ACCESSORY_KEYWORDS.some(kw => name.includes(kw))) {
    return 'prislusenstvi';
  }

  // Double-check: if name looks like a main product category, force 'produkt'
  const productPatterns = ['notebook', 'nb ', 'nb typ', 'pc ', 'pc typ', 'počítač', 'monitor', 'server', 'tiskárna', 'projektor', 'switch', 'nas ', 'laptop', 'workstation', 'desktop'];
  if (productPatterns.some(p => name.includes(p))) {
    return 'produkt';
  }

  return 'produkt';
}

// ---- Haiku sector pre-classification ----

const HAIKU_SECTOR_SYSTEM = `Klasifikuj každou IT/AV položku do sektoru. Odpověz POUZE JSON polem.
Sektory: IT, AV, kancelarsky, nabytek, ostatni
- IT: počítače, servery, monitory, tiskárny, síťové prvky, tablety, software, UPS, kamery IP, 3D tiskárny
- AV: projektory, plátna, interaktivní tabule, audio systémy, videokonference
- kancelarsky: papír, tonery, cartridge, kancelářské potřeby
- nabytek: stoly, židle, skříně, regály, recepce
- ostatni: vše ostatní`;

async function haikuClassifyItems(
  items: Array<{ nazev: string; index: number }>,
  tenderId: string,
): Promise<Map<number, string>> {
  const prompt = `Klasifikuj tyto položky:\n${items.map(i => `${i.index}. ${i.nazev}`).join('\n')}\n\nOdpověz JSON: [{"index": 0, "sektor": "IT"}, ...]`;

  // ~10 tokens per item in response: {"index": N, "sektor": "xxx"},
  const haikuMaxTokens = Math.min(Math.max(items.length * 12, 1024), 8192);
  const result = await callClaude(HAIKU_SECTOR_SYSTEM, prompt, {
    maxTokens: haikuMaxTokens,
    temperature: 0,
    model: 'haiku',
  });

  await logCost(tenderId, 'match-haiku-classify', result.modelId, result.inputTokens, result.outputTokens, result.costCZK);

  const sectorMap = new Map<number, string>();
  try {
    let json = result.content.trim();
    if (json.startsWith('```')) json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const parsed: Array<{ index: number; sektor: string }> = JSON.parse(json);
    for (const entry of parsed) sectorMap.set(entry.index, entry.sektor);
  } catch (err) {
    console.log(`  Haiku classification parse failed: ${err} — using all items`);
  }
  return sectorMap;
}

// ---- Requirements deduplication per batch ----

/**
 * For a batch of items, filter technical requirements to only those
 * likely relevant to the items in the batch. Reduces input tokens.
 * Falls back to all requirements if insufficient matches found.
 */
function filterRelevantRequirements(
  items: MatchableItem[],
  allRequirements: TenderAnalysis['technicke_pozadavky'],
  minRequirements = 5,
): TenderAnalysis['technicke_pozadavky'] {
  if (!allRequirements || allRequirements.length === 0) return allRequirements;
  if (allRequirements.length <= minRequirements) return allRequirements;

  // Build combined keyword set from item names and specs
  const itemText = items
    .map(i => `${i.nazev} ${i.specifikace}`.toLowerCase())
    .join(' ');

  // Category-to-requirement-keyword mapping
  const CATEGORY_REQ_KEYWORDS: Record<string, string[]> = {
    notebook: ['ram', 'procesor', 'cpu', 'ssd', 'hdd', 'baterie', 'displej', 'grafik', 'wifi', 'bluetooth', 'usb', 'hmotnost', 'rozlišení', 'operační systém', 'os'],
    server: ['ram', 'cpu', 'procesor', 'hdd', 'ssd', 'raid', 'síť', 'psu', 'napájení', 'rack', 'ecc'],
    monitor: ['rozlišení', 'velikost', 'uhd', '4k', 'hdmi', 'displayport', 'jas', 'kontrast', 'odezva', 'panel'],
    projektor: ['lumen', 'rozlišení', 'kontrast', 'životnost', 'hdmi', 'bezdrát', 'throw'],
    tiskarna: ['a3', 'a4', 'barevn', 'duplex', 'síť', 'wifi', 'tisk', 'sken', 'kopír', 'dpi', 'rychlost'],
    switch: ['port', 'gigabit', 'poe', 'managed', 'sfp', 'vlan'],
  };

  // Find relevant keywords based on item names
  const relevantKeywords = new Set<string>();
  for (const [category, keywords] of Object.entries(CATEGORY_REQ_KEYWORDS)) {
    if (itemText.includes(category)) {
      for (const kw of keywords) relevantKeywords.add(kw);
    }
  }

  // If we have category keywords, filter requirements
  if (relevantKeywords.size > 0) {
    const filtered = allRequirements.filter(req => {
      const reqText = `${req.parametr} ${req.pozadovana_hodnota}`.toLowerCase();
      return Array.from(relevantKeywords).some(kw => reqText.includes(kw));
    });
    // Only use filtered set if it has enough requirements
    if (filtered.length >= minRequirements) {
      return filtered;
    }
  }

  return allRequirements;
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

  // Read analysis and company config
  const analysisPath = join(outputDir, 'analysis.json');
  const analysis: TenderAnalysis = JSON.parse(
    await readFile(analysisPath, 'utf-8')
  );

  const company = JSON.parse(
    await readFile(join(ROOT, 'config', 'company.json'), 'utf-8')
  );
  const companyObory: string[] = company.obory || [];
  const companyKeywordFilters: Record<string, string[]> = company.keyword_filters || {};

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
  let matchableItems = [...products, ...accessories];

  // ---- Phase 3+4: Haiku pre-classification + company sector filter ----
  // For large tenders (20+ items), use Haiku to classify items by sector and skip
  // items outside the company's areas of expertise (obory).
  const HAIKU_THRESHOLD = 20;
  if (matchableItems.length >= HAIKU_THRESHOLD && companyObory.length > 0) {
    console.log(`\n  Running Haiku sector pre-classification (${matchableItems.length} items, threshold ${HAIKU_THRESHOLD})...`);
    const toClassify = matchableItems.map((item, idx) => ({ nazev: item.nazev, index: idx }));
    const sectorMap = await haikuClassifyItems(toClassify, tenderId);

    if (sectorMap.size > 0) {
      // Build accepted sector set from company obory (case-insensitive)
      const acceptedSectors = new Set(companyObory.map(s => s.toLowerCase()));

      const skipped: string[] = [];
      matchableItems = matchableItems.filter((item, idx) => {
        const sector = (sectorMap.get(idx) || 'ostatni').toLowerCase();
        const accepted = acceptedSectors.has(sector) || sector === 'it'; // always accept IT
        if (!accepted) skipped.push(`${item.nazev} [${sector}]`);
        return accepted;
      });

      if (skipped.length > 0) {
        console.log(`  Skipped ${skipped.length} items outside company sectors (${companyObory.join(', ')}):`);
        for (const s of skipped) console.log(`    - ${s}`);
      }
      console.log(`  Items after sector filter: ${matchableItems.length}`);
    }
  } else if (matchableItems.length > 0 && companyObory.length > 0) {
    // For smaller tenders, do local keyword-based filtering (no AI cost)
    const acceptedKeywords = companyObory.flatMap(obor => companyKeywordFilters[obor] || []);
    if (acceptedKeywords.length > 0) {
      const skipped: string[] = [];
      const filtered = matchableItems.filter(item => {
        const name = item.nazev.toLowerCase();
        const isMatch = acceptedKeywords.some(kw => name.includes(kw.toLowerCase()));
        if (!isMatch) skipped.push(item.nazev);
        return isMatch;
      });
      // Only apply filter if it doesn't remove everything
      if (filtered.length > 0 && skipped.length > 0) {
        console.log(`  Local keyword filter: skipped ${skipped.length} items: ${skipped.join(', ')}`);
        matchableItems = filtered;
      }
    }
  }

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

  // Step 1: Match products + accessories via AI (in batches of BATCH_SIZE)
  const BATCH_SIZE = 15;
  if (items.length > 0) {
    const totalBatches = Math.ceil(items.length / BATCH_SIZE);
    console.log(`\nMatching ${items.length} product/accessory item(s) with ${requirements.length} technical requirements...`);
    if (totalBatches > 1) console.log(`  Splitting into ${totalBatches} batches of max ${BATCH_SIZE} items`);

    let totalCost = 0;

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchItems = items.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
      if (totalBatches > 1) console.log(`\n  Batch ${batchIdx + 1}/${totalBatches}: ${batchItems.length} items`);

      // Phase 6: Deduplicate requirements — only send requirements relevant to this batch
      const batchRelevantReqs = filterRelevantRequirements(batchItems, requirements);
      if (batchRelevantReqs.length < requirements.length) {
        console.log(`    Req dedup: ${requirements.length} → ${batchRelevantReqs.length} requirements`);
      }
      const batchItemsWithReqs = batchItems.map(item => ({ ...item, technicke_pozadavky: batchRelevantReqs }));

      const reqCount = batchRelevantReqs.length || 10;
      const maxTokens = Math.min(65536, 8192 + batchItems.length * candidateCount * Math.max(reqCount * 80, 2000));

      const result = await callClaude(
        PRODUCT_MATCH_SYSTEM,
        buildProductMatchUserMessage(
          batchItemsWithReqs,
          analysis.zakazka.nazev,
          analysis.zakazka.predmet,
          analysis.zakazka.predpokladana_hodnota,
          candidateCount,
        ),
        { maxTokens, temperature: 0.3 }
      );

      await logCost(tenderId, `match-batch-${batchIdx + 1}`, result.modelId, result.inputTokens, result.outputTokens, result.costCZK);
      totalCost += result.costCZK;

      let jsonStr = result.content.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      let parsed: any;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseErr) {
        // Try to recover truncated JSON by finding the last complete polozky_match entry
        console.log(`  Warning: JSON parse failed, attempting recovery...`);
        const lastComplete = jsonStr.lastIndexOf('"oduvodneni_vyberu"');
        if (lastComplete > 0) {
          const afterOduvodneni = jsonStr.indexOf('\n', lastComplete);
          if (afterOduvodneni > 0) {
            const truncated = jsonStr.substring(0, afterOduvodneni).replace(/,\s*$/, '');
            const opens = (truncated.match(/[\[{]/g) || []).length;
            const closes = (truncated.match(/[\]}]/g) || []).length;
            const closers = ']}'.repeat(Math.max(0, opens - closes));
            const fixed = truncated + closers;
            try {
              parsed = JSON.parse(fixed);
              console.log(`  Recovery successful — parsed ${parsed.polozky_match?.length || 0} items`);
            } catch {
              throw parseErr;
            }
          } else {
            throw parseErr;
          }
        } else {
          throw parseErr;
        }
      }

      // Enrich and collect results from this batch
      if (parsed.kandidati) {
        for (const candidate of parsed.kandidati) enrichWithFallbackUrls(candidate);
        polozkyMatch.push({
          polozka_nazev: batchItems[0].nazev,
          polozka_index: batchIdx * BATCH_SIZE,
          mnozstvi: batchItems[0].mnozstvi || 1,
          jednotka: batchItems[0].jednotka,
          typ: batchItems[0].typ || 'produkt',
          kandidati: parsed.kandidati,
          vybrany_index: parsed.vybrany_index,
          oduvodneni_vyberu: parsed.oduvodneni_vyberu,
        });
      }
      if (parsed.polozky_match) {
        for (const pm of parsed.polozky_match) {
          for (const candidate of pm.kandidati) enrichWithFallbackUrls(candidate);
          // Map batch-local index to global index
          const localIdx = pm.polozka_index;
          pm.typ = batchItems[localIdx]?.typ || 'produkt';
          pm.polozka_index = batchIdx * BATCH_SIZE + localIdx;
        }
        polozkyMatch.push(...parsed.polozky_match);
      }
    }

    console.log(`  Total AI cost: ${totalCost.toFixed(2)} CZK`);
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

    await logCost(tenderId, 'match-services', serviceResult.modelId, serviceResult.inputTokens, serviceResult.outputTokens, serviceResult.costCZK);
    console.log(`  AI cost: ${serviceResult.costCZK.toFixed(2)} CZK`);
  }

  // Renumber polozka_index sequentially
  polozkyMatch.forEach((pm, idx) => { pm.polozka_index = idx; });

  // Auto-confirm prices using AI-recommended candidate (can be overridden later in UI)
  for (const pm of polozkyMatch) {
    const selected = pm.kandidati?.[pm.vybrany_index];
    if (selected && !pm.cenova_uprava) {
      const bez = selected.cena_bez_dph || 0;
      pm.cenova_uprava = {
        nakupni_cena_bez_dph: bez,
        nakupni_cena_s_dph: Math.round(bez * 1.21 * 100) / 100,
        marze_procent: 0,
        nabidkova_cena_bez_dph: bez,
        nabidkova_cena_s_dph: Math.round(bez * 1.21 * 100) / 100,
        potvrzeno: true,
        poznamka: 'Automaticky potvrzeno — cena z AI doporučení. Zkontrolujte před podáním.',
      };
    }
  }

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
