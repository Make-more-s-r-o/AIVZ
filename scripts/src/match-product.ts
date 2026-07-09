import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude, AICallTimeoutError, getMatchCallDeadlineMs } from './lib/ai-client.js';
import { logCost } from './lib/cost-tracker.js';
import { ProductMatchSchema, type TenderAnalysis } from './lib/types.js';
import { PRODUCT_MATCH_SYSTEM, buildProductMatchUserMessage, buildServicePricingMessage, type MatchableItem } from './prompts/product-match.js';
import { searchWarehouse, warehouseMatchToCandidate, type MatchRequest, type WarehouseMatch } from './lib/warehouse-matcher.js';

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

  // Generický fallback pro ne-IT zakázky (nábytek, nářadí…), kde žádná IT kategorie nesedí.
  // NEposílej všech N požadavků do promptu (nafoukne vstup i výstup → pomalá generace) —
  // vyber max HARD_CAP nejrelevantnějších podle překryvu klíčových slov požadavku s texty
  // položek. Když se nic nepřekrývá, vezmi prvních HARD_CAP.
  const HARD_CAP = 12;
  if (allRequirements.length <= HARD_CAP) return allRequirements;

  // Tokenizuj texty položek na slova délky ≥ 4 (odfiltruje spojky/předložky).
  const itemTokens = new Set(
    itemText.split(/[^a-záčďéěíňóřšťúůýž0-9]+/i).filter(w => w.length >= 4),
  );

  const scored = allRequirements.map(req => {
    const reqText = `${req.parametr} ${req.pozadovana_hodnota}`.toLowerCase();
    const reqTokens = reqText.split(/[^a-záčďéěíňóřšťúůýž0-9]+/i).filter(w => w.length >= 4);
    const overlap = reqTokens.reduce((n, t) => n + (itemTokens.has(t) ? 1 : 0), 0);
    return { req, overlap };
  });

  const withOverlap = scored.filter(s => s.overlap > 0);
  if (withOverlap.length >= minRequirements) {
    // Seřaď dle překryvu sestupně, vezmi prvních HARD_CAP (zachovej původní pořadí uvnitř).
    return withOverlap
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, HARD_CAP)
      .map(s => s.req);
  }

  // Žádný smysluplný překryv → prvních HARD_CAP požadavků.
  return allRequirements.slice(0, HARD_CAP);
}

/**
 * Parse per-item hard price caps from tender spec text, e.g.
 *   "Položka č. 8 ... Cena za kus nesmí přesáhnout částku 39.999,- Kč s DPH."
 * Returns Map<itemNumber, capInclVat>. Czech thousands separator is '.' or space.
 */
function parsePriceCaps(text: string): Map<number, number> {
  const caps = new Map<number, number>();
  if (!text) return caps;
  const blockRe = /Polo[žz]ka\s*č\.?\s*(\d+)([\s\S]*?)(?=Polo[žz]ka\s*č\.?\s*\d+|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    const capM = m[2].match(/nesm[ií]\s*p[řr]es[áa]hnout[^\d]*([\d][\d\s. ]*)[\s,.\-]*K[čc]/i);
    if (capM) {
      const amount = parseFloat(capM[1].replace(/[\s .]/g, '').replace(',', '.'));
      if (!isNaN(amount) && amount > 0) caps.set(num, amount);
    }
  }
  return caps;
}

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  const candidateCountArg = process.argv.find((a) => a.startsWith('--candidates='));
  const candidateCount = candidateCountArg ? parseInt(candidateCountArg.split('=')[1], 10) : 2;

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

  // C3: parse per-item hard price caps ("nesmí přesáhnout X Kč s DPH"). The soupis spec
  // blocks are excluded from AI analysis, so read them straight from extracted-text.json.
  let priceCaps = new Map<number, number>();
  try {
    const ext = JSON.parse(await readFile(join(outputDir, 'extracted-text.json'), 'utf-8'));
    const capText = (ext.documents || []).map((d: any) => d.text || '').join('\n');
    priceCaps = parsePriceCaps(capText);
    if (priceCaps.size > 0) {
      console.log(`  Parsed ${priceCaps.size} per-item price cap(s): ${[...priceCaps.entries()].map(([n, c]) => `#${n}≤${c}`).join(', ')}`);
    }
  } catch { /* no extracted text — skip caps */ }

  // Read parts selection if multi-part tender
  let selectedParts: string[] | null = null;
  const hasParts = analysis.casti && analysis.casti.length > 1;
  if (hasParts) {
    const partsSelPath = join(outputDir, 'parts-selection.json');
    if (existsSync(partsSelPath)) {
      try {
        const partsSelection = JSON.parse(await readFile(partsSelPath, 'utf-8'));
        selectedParts = partsSelection.selected_parts || null;
        console.log(`  Parts selection: ${selectedParts?.join(', ') || 'all'}`);
      } catch {}
    }
    if (!selectedParts) {
      selectedParts = analysis.casti.map((c: any) => c.id);
      console.log(`  No parts selection — using all parts: ${selectedParts!.join(', ')}`);
    }
  }

  // Filter polozky by selected parts
  let filteredPolozky = analysis.polozky;
  if (selectedParts) {
    const selectedSet = new Set(selectedParts);
    filteredPolozky = analysis.polozky.filter(p => !p.cast_id || selectedSet.has(p.cast_id));
    if (filteredPolozky.length < analysis.polozky.length) {
      console.log(`  Filtered to ${filteredPolozky.length}/${analysis.polozky.length} items from selected parts`);
    }
  }

  // Categorize ALL items from filtered polozky
  const categorized = filteredPolozky.map((item, idx) => ({
    ...item,
    originalIndex: idx,
    category: categorizeItem(item),
    cast_id: item.cast_id,
  }));

  const products = categorized.filter(i => i.category === 'produkt');
  const accessories = categorized.filter(i => i.category === 'prislusenstvi');
  const services = categorized.filter(i => i.category === 'sluzba');

  console.log(`\nItems${hasParts ? ' (after part filter)' : ''}: ${filteredPolozky.length} total`);
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
      const kept = matchableItems.filter((item, idx) => {
        const sector = (sectorMap.get(idx) || 'ostatni').toLowerCase();
        const accepted = acceptedSectors.has(sector) || sector === 'it'; // always accept IT
        if (!accepted) skipped.push(`${item.nazev} [${sector}]`);
        return accepted;
      });

      // C2: NEVER empty a binding offer. If the sector filter would drop every item
      // (e.g. an IT/AV company bidding a workshop-tools tender), keep them all and price them
      // — a domain mismatch is a human go/no-go decision, not a silent drop.
      if (kept.length === 0) {
        console.log(`  ⚠ Sector filter would drop ALL ${matchableItems.length} items (none in ${companyObory.join('/')}). Keeping all — every item in a binding offer must be priced.`);
      } else {
        if (skipped.length > 0) {
          console.log(`  Skipped ${skipped.length} items outside company sectors (${companyObory.join(', ')}):`);
          for (const s of skipped) console.log(`    - ${s}`);
        }
        matchableItems = kept;
        console.log(`  Items after sector filter: ${matchableItems.length}`);
      }
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

  // Step 0: Warehouse search — hledej produkty ve skladu PŘED AI
  const warehouseResults = new Map<number, any[]>(); // index → warehouse candidates
  const warehouseContext: string[] = []; // pro AI prompt kontext

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const request: MatchRequest = {
      nazev: item.nazev,
      specifikace: item.specifikace,
      technicke_pozadavky: item.technicke_pozadavky,
      limit: 3,
    };

    const result = await searchWarehouse(request);
    if (result && result.matches.length > 0) {
      const candidates = result.matches.map(warehouseMatchToCandidate);
      warehouseResults.set(i, candidates);

      // Kontext pro AI — ať nenavrhuje stejné produkty
      for (const m of result.matches) {
        warehouseContext.push(
          `  - ${m.manufacturer} ${m.model} (${m.part_number || m.ean || 'bez P/N'})` +
          (m.price_bez_dph ? `, ${Number(m.price_bez_dph).toLocaleString('cs-CZ')} Kč` : '') +
          ` [${m.match_tier}, score: ${Number(m.match_score).toFixed(2)}]`,
        );
      }

      console.log(`  Warehouse: "${item.nazev}" → ${result.matches.length} match(es) via ${result.tier_used} (${result.search_time_ms}ms)`);
    }
  }

  if (warehouseResults.size > 0) {
    console.log(`\nWarehouse found matches for ${warehouseResults.size}/${items.length} items`);
  } else if (items.length > 0) {
    console.log(`\nWarehouse: no matches found (${items.length > 0 ? 'empty warehouse or DB unavailable' : 'no items'})`);
  }

  // Step 1: Match products + accessories via AI (in batches of BATCH_SIZE)
  // BATCH_SIZE 8 (dřív 15) — menší dávka = ohraničenější délka jednoho AI volání.
  const BATCH_SIZE = 8;
  // Wall-clock deadline JEDNOHO batch volání. Musí být pohodlně POD idle-watchdogem rodiče
  // v serve-api (300s), aby při vypršení stihl doběhnout graceful retry (rozpůlení dávky)
  // dřív, než rodič pošle SIGTERM. Jen match tento deadline zapíná (opt-in přes deadlineMs).
  const MATCH_DEADLINE_MS = getMatchCallDeadlineMs();
  if (items.length > 0) {
    const totalBatches = Math.ceil(items.length / BATCH_SIZE);
    console.log(`\nMatching ${items.length} product/accessory item(s) with ${requirements.length} technical requirements...`);
    if (totalBatches > 1) console.log(`  Splitting into ${totalBatches} batches of max ${BATCH_SIZE} items`);

    let totalCost = 0;

    // Zpracuje souvislý úsek položek (globální index globalOffset..) jedním AI voláním.
    // Při wall-clock timeoutu (AICallTimeoutError) zkusí JEDNOU rozpůlit dávku a zpracovat
    // obě poloviny; už rozpůlená dávka (allowRetry=false), která znovu timeoutne, selže
    // s jasnou hláškou. Globální index = globalOffset + lokální index z odpovědi AI.
    const processSlice = async (
      sliceItems: MatchableItem[],
      globalOffset: number,
      allowRetry: boolean,
      label: string,
    ): Promise<void> => {
      if (sliceItems.length === 0) return;

      // Phase 6: Deduplicate requirements — only send requirements relevant to this slice
      const relevantReqs = filterRelevantRequirements(sliceItems, requirements);
      if (relevantReqs.length < requirements.length) {
        console.log(`    Req dedup: ${requirements.length} → ${relevantReqs.length} requirements`);
      }
      const sliceItemsWithReqs = sliceItems.map(item => ({ ...item, technicke_pozadavky: relevantReqs }));

      // Střízlivý strop output tokenů, tvrdý cap 16384 (dřív až 65536 → generace přes 600s).
      const maxTokens = Math.min(16384, 4096 + sliceItems.length * candidateCount * 400);

      // Přidej warehouse kontext do AI promptu
      let userMessage = buildProductMatchUserMessage(
        sliceItemsWithReqs,
        analysis.zakazka.nazev,
        analysis.zakazka.predmet,
        analysis.zakazka.predpokladana_hodnota,
        candidateCount,
      );

      if (warehouseContext.length > 0) {
        userMessage += `\n\nINTERNÍ KATALOG — nalezeno:\n${warehouseContext.join('\n')}\n\nINSTRUKCE: Produkty z katalogu NENAVRHUJ znovu jako kandidáty. Navrhni ALTERNATIVY nebo jiné modely.`;
      }

      let result;
      try {
        result = await callClaude(
          PRODUCT_MATCH_SYSTEM,
          userMessage,
          { maxTokens, temperature: 0.3, deadlineMs: MATCH_DEADLINE_MS }
        );
      } catch (err) {
        // Zaúčtuj náklady abortovaného pokusu (Anthropic účtuje i tokeny do abortu),
        // ať reportovaná cena kroku neklame — token counts nese sama chyba.
        if (err instanceof AICallTimeoutError && (err.inputTokens > 0 || err.outputTokens > 0)) {
          await logCost(tenderId, `match-batch-${label}-timeout`, err.modelId, err.inputTokens, err.outputTokens, err.costCZK);
          totalCost += err.costCZK;
        }
        if (err instanceof AICallTimeoutError && allowRetry && sliceItems.length > 1) {
          const mid = Math.ceil(sliceItems.length / 2);
          console.warn(`  ⚠ AI timeout u dávky ${label} — zkouším znovu s poloviční dávkou (${sliceItems.length} → ${mid}+${sliceItems.length - mid})`);
          await processSlice(sliceItems.slice(0, mid), globalOffset, false, `${label}a`);
          await processSlice(sliceItems.slice(mid), globalOffset + mid, false, `${label}b`);
          return;
        }
        if (err instanceof AICallTimeoutError) {
          throw new Error(`AI matching překročilo časový limit i po zmenšení dávky (dávka ${label}, ${sliceItems.length} položek). Zkuste krok spustit znovu nebo zakázku rozdělit.`);
        }
        throw new Error(`AI matching selhalo (dávka ${label}): ${err instanceof Error ? err.message : String(err)}`);
      }

      await logCost(tenderId, `match-batch-${label}`, result.modelId, result.inputTokens, result.outputTokens, result.costCZK);
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
              const got = parsed.polozky_match?.length ?? (parsed.kandidati ? 1 : 0);
              console.log(`  Recovery successful — parsed ${got} items`);
              if (got < sliceItems.length) {
                console.warn(`  ⚠ Recovery DROPPED ${sliceItems.length - got} item(s) (got ${got}/${sliceItems.length}) — bid would be incomplete; rerun match or lower BATCH_SIZE.`);
              }
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

      // Enrich and collect results from this slice
      if (parsed.kandidati) {
        const srcItem = matchableItems[globalOffset];
        polozkyMatch.push({
          polozka_nazev: sliceItems[0].nazev,
          polozka_index: srcItem?.originalIndex ?? globalOffset,
          mnozstvi: sliceItems[0].mnozstvi || 1,
          jednotka: sliceItems[0].jednotka,
          typ: sliceItems[0].typ || 'produkt',
          cast_id: srcItem?.cast_id,
          kandidati: parsed.kandidati,
          vybrany_index: parsed.vybrany_index,
          oduvodneni_vyberu: parsed.oduvodneni_vyberu,
        });
      }
      if (parsed.polozky_match) {
        for (const pm of parsed.polozky_match) {
          // Map slice-local index to global index
          const localIdx = pm.polozka_index;
          const srcItem = matchableItems[globalOffset + localIdx];
          pm.typ = sliceItems[localIdx]?.typ || 'produkt';
          pm.cast_id = srcItem?.cast_id;
          // Use the ORIGINAL soupis position (P.č. - 1) so prices map to the right rows even
          // though products/accessories were reordered for matching. (M2/C3)
          pm.polozka_index = srcItem?.originalIndex ?? (globalOffset + localIdx);
        }
        polozkyMatch.push(...parsed.polozky_match);
      }
    };

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batchItems = items.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);
      if (totalBatches > 1) console.log(`\n  Batch ${batchIdx + 1}/${totalBatches}: ${batchItems.length} items`);
      await processSlice(batchItems, batchIdx * BATCH_SIZE, true, `${batchIdx + 1}`);
    }

    console.log(`  Total AI cost: ${totalCost.toFixed(2)} CZK`);

    // H2: every matchable item must produce a match — warn on silent drops/truncation.
    if (polozkyMatch.length < items.length) {
      console.warn(`  ⚠ Matching produced ${polozkyMatch.length}/${items.length} items — ${items.length - polozkyMatch.length} missing. Bid would be incomplete.`);
    }
  }

  // Step 1.5: Merge warehouse candidates into polozky_match
  // Warehouse kandidáti se přidají na ZAČÁTEK seznamu kandidátů (vyšší spolehlivost)
  if (warehouseResults.size > 0) {
    for (const pm of polozkyMatch) {
      const whCandidates = warehouseResults.get(pm.polozka_index);
      if (whCandidates && whCandidates.length > 0) {
        // Přidej warehouse kandidáty na začátek
        pm.kandidati = [...whCandidates, ...pm.kandidati];
        // Warehouse kandidát na indexu 0 = nejlepší match
        pm.vybrany_index = 0;
        pm.oduvodneni_vyberu = `Produkt nalezen v cenovém skladu (reálná cena). ${pm.oduvodneni_vyberu || ''}`.trim();
        console.log(`  Merged warehouse candidates for "${pm.polozka_nazev}": +${whCandidates.length} candidates`);
      }
    }
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

    for (let si = 0; si < serviceItems.length; si++) {
      const svc = serviceItems[si];
      polozkyMatch.push({
        polozka_nazev: svc.nazev,
        polozka_index: services[si]?.originalIndex ?? polozkyMatch.length,
        mnozstvi: svc.mnozstvi || 1,
        jednotka: svc.jednotka,
        typ: 'sluzba',
        cast_id: services[si]?.cast_id,
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

  // NOTE: polozka_index now carries the original soupis position (P.č. - 1) from matching,
  // so we deliberately do NOT renumber it sequentially here (that previously broke price↔row mapping).

  // C3: attach per-item price caps by item number (= polozka_index + 1).
  if (priceCaps.size > 0) {
    let capped = 0;
    for (const pm of polozkyMatch) {
      const cap = priceCaps.get(pm.polozka_index + 1);
      if (cap != null) { pm.cena_max_s_dph = cap; capped++; }
    }
    console.log(`  Price caps applied to ${capped} item(s).`);
  }

  // Pre-fill prices from the AI-recommended candidate. Margin is configurable
  // (company.default_marze_procent, default 0 %). potvrzeno=false ON PURPOSE — a binding price
  // must be reviewed/confirmed by the user before submission (H3). Items breaching the hard
  // cap are flagged in poznamka and warned (C3).
  const defaultMarze = Number(company.default_marze_procent) || 0;
  for (const pm of polozkyMatch) {
    const selected = pm.kandidati?.[pm.vybrany_index];
    if (selected && !pm.cenova_uprava) {
      const bez = selected.cena_bez_dph || 0;
      const nabBez = Math.round(bez * (1 + defaultMarze / 100) * 100) / 100;
      const nabS = Math.round(nabBez * 1.21 * 100) / 100;
      const cap = pm.cena_max_s_dph;
      const overCap = cap != null && nabS > cap;
      pm.cenova_uprava = {
        nakupni_cena_bez_dph: bez,
        nakupni_cena_s_dph: Math.round(bez * 1.21 * 100) / 100,
        marze_procent: defaultMarze,
        nabidkova_cena_bez_dph: nabBez,
        nabidkova_cena_s_dph: nabS,
        potvrzeno: false,
        poznamka: overCap
          ? `⚠ PŘEKRAČUJE STROP ${cap} Kč s DPH — uprav cenu. Cena z AI odhadu, nutné potvrzení.`
          : 'Cena z AI odhadu — zkontrolujte a potvrďte před podáním.',
      };
      if (overCap) console.warn(`  ⚠ Cap exceeded: "${pm.polozka_nazev}" ${nabS} Kč s DPH > limit ${cap} Kč`);
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
