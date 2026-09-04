import { readFile, writeFile, mkdir } from 'fs/promises';
import { basename, join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { logCost } from './lib/cost-tracker.js';
import { ExtractedTextSchema, mergeDetectedCastiDetails, TenderAnalysisSchema, type Cast } from './lib/types.js';
import { ANALYZE_TENDER_SYSTEM, buildAnalyzeUserMessage } from './prompts/analyze-tender.js';
import { extractCastIdFromFilename, parseSoupis, type SoupisResult } from './parse-soupis.js';
import { scoreGoNoGo } from './lib/go-no-go.js';
import { getCompany, getTenderCompanyId } from './lib/company-store.js';
import { priceBandForSubject, type PriceBand } from './lib/winprice-query.js';
import { closePool } from './lib/db.js';
import { enrichPolozkySpecifikace } from './lib/polozka-desc-enricher.js';
import { discoverInputFiles } from './lib/input-discovery.js';
import { createSingleSheetSoupisSnapshot, inspectSoupisWorkbook } from './lib/document-parser.js';
import {
  UplnostError,
  analyzovatelnyPocetZnaku,
  analyzeMinimumCharacters,
  formatUplnostError,
  nactiUplnostZakazky,
  ulozUplnostKroku,
  vytvorUplnostAnalyzy,
} from './lib/uplnost.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = process.env.VZ_ROOT_DIR || new URL('../../', import.meta.url).pathname;

function parseAnalysisResponse(content: string) {
  let json = content.trim();
  if (json.startsWith('```')) {
    json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return TenderAnalysisSchema.parse(JSON.parse(json));
}

/**
 * AI schema umí ověřit tvar částí, ne jejich vzájemnou referenční integritu.
 * Bez této kontroly by analýza mohla být zelená s duplicitní částí nebo s
 * položkou ukazující na neexistující část a problém by se projevil až v matchi.
 */
function normalizeAndValidatePartIdentity(analysis: ReturnType<typeof parseAnalysisResponse>): void {
  const partIds = new Map<string, string>();
  for (const part of analysis.casti) {
    const normalized = part.id.trim().toUpperCase();
    if (!normalized) throw new Error('Analýza obsahuje část bez ID.');
    if (partIds.has(normalized)) {
      throw new Error(`Analýza obsahuje duplicitní ID části ${part.id}.`);
    }
    partIds.set(normalized, part.id);
  }
  for (const item of analysis.polozky) {
    if (!item.cast_id) continue;
    const canonical = partIds.get(item.cast_id.trim().toUpperCase());
    if (!canonical) {
      throw new Error(
        `Položka „${item.nazev}“ odkazuje na neexistující část ${item.cast_id}.`,
      );
    }
    // Další kroky používají stabilní přesné ID; běžnou změnu velikosti písmen
    // proto kanonizujeme k deklaraci části místo pozdějšího false-red výsledku.
    item.cast_id = canonical;
  }
}

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
  const extracted = ExtractedTextSchema.parse(JSON.parse(
    await readFile(extractedPath, 'utf-8')
  ));
  if (extracted.tenderId !== tenderId) {
    const kontrola = vytvorUplnostAnalyzy(0, analyzeMinimumCharacters(), false);
    kontrola.chybi = [`extracted-text.json pro zakázku ${tenderId}`];
    kontrola.zprava = `Analýzu nelze spustit: extracted-text.json patří zakázce ${extracted.tenderId}.`;
    kontrola.naprava = 'Spusťte extrakci znovu pro tuto zakázku.';
    await ulozUplnostKroku(outputDir, tenderId, kontrola);
    throw new UplnostError(kontrola);
  }

  // Jakmile zakázka používá nový kontrakt, analýza vyžaduje čerstvě dokončený extract.
  // Nový ingest automaticky starý extract zneplatní v ulozUplnostKroku().
  const upstream = await nactiUplnostZakazky(outputDir);
  if (upstream
    && (upstream.kroky.ingest !== undefined || upstream.kroky.extract !== undefined)
    && upstream.kroky.extract?.stav !== 'uplne') {
    const kontrola = vytvorUplnostAnalyzy(0, analyzeMinimumCharacters(), false);
    kontrola.chybi = ['úplný a aktuální krok extract'];
    kontrola.zprava = 'Analýzu nelze spustit, protože extrakce není potvrzena jako úplná.';
    kontrola.naprava = 'Spusťte nejprve extrakci nad kompletní zadávací dokumentací.';
    await ulozUplnostKroku(outputDir, tenderId, kontrola);
    throw new UplnostError(kontrola);
  }

  const excelSoupisDocuments = extracted.documents.filter((document) =>
    document.isSoupis && (document.type === 'xlsx' || document.type === 'xls'));
  const nonExcelSoupisDocuments = extracted.documents.filter((document) =>
    document.isSoupis && document.type !== 'xlsx' && document.type !== 'xls');
  const allSoupisDocuments = [...excelSoupisDocuments, ...nonExcelSoupisDocuments];
  // Neexcelový soupis neumí deterministický parser; jeho text proto musí dostat AI,
  // jinak by byl z obou větví tiše vyřazen.
  const analysisDocuments = extracted.documents.filter((document) =>
    !document.isTemplate && (!document.isSoupis || !excelSoupisDocuments.includes(document)));
  const analysisText = analysisDocuments
    .map((d) => `=== ${d.filename} ===\n${d.text}`)
    .join('\n\n');

  // Hlavička s názvem souboru nesmí z prázdného dokumentu vyrobit zdánlivě neprázdný
  // prompt. Práh proto měří jen normalizovaný obsah analyzovatelných dokumentů.
  const meaningfulCharacters = analyzovatelnyPocetZnaku(extracted.documents);
  const minimumCharacters = analyzeMinimumCharacters();
  const inputIncomplete = meaningfulCharacters < minimumCharacters;
  const vstupniKontrola = vytvorUplnostAnalyzy(
    meaningfulCharacters,
    minimumCharacters,
    false,
    {
      ocekavano: allSoupisDocuments.length,
      zpracovano: 0,
      chybi: allSoupisDocuments.map((document) => document.filename),
    },
  );
  await ulozUplnostKroku(outputDir, tenderId, vstupniKontrola);
  if (inputIncomplete) throw new UplnostError(vstupniKontrola);

  console.log(`\nAnalyzing ${analysisText.length} characters...`);

  // Call Claude — velké zakázky (72k+ znaků, stovky položek) potřebují víc output tokenů;
  // 16384 se u nich useklo uprostřed JSON (prod tendery 1779109774773, 1782811562056).
  const result = await callClaude(
    ANALYZE_TENDER_SYSTEM,
    buildAnalyzeUserMessage(analysisText),
    { maxTokens: 32768, temperature: 0.1 }
  );

  // Useknutá odpověď = garantovaně rozbitý JSON — jasná chyba místo SyntaxError změti.
  if (result.stopReason === 'max_tokens') {
    throw new Error(
      `Analýza překročila limit výstupu (${result.outputTokens} tokenů) — zakázka je příliš rozsáhlá na jeden průchod. ` +
      `Zvažte rozdělení dokumentace nebo navýšení limitu (analyze maxTokens).`,
    );
  }

  // Parse and validate JSON response
  const analysis = parseAnalysisResponse(result.content);

  await logCost(tenderId, 'analyze', result.modelId, result.inputTokens, result.outputTokens, result.costCZK);

  // Globální AI odpověď neobsahuje per-source provenienci. Každý PDF/DOC soupis
  // proto ověříme samostatným strukturovaným průchodem; jediná položka z dokumentu A
  // pak nemůže vydávat N soupisů za zpracované. Tyto autoritativní položky níže
  // nahradí obecný seznam stejně jako deterministicky parsované Excelové soupisy.
  const parsedNonExcelSoupisy: Array<{
    filename: string;
    sourcePartId?: string;
    polozky: typeof analysis.polozky;
  }> = [];
  const missingNonExcelSoupisy: string[] = [];
  let parsedNonExcelSoupisCount = 0;
  for (const document of nonExcelSoupisDocuments) {
    try {
      const sourceResult = await callClaude(
        ANALYZE_TENDER_SYSTEM,
        buildAnalyzeUserMessage(`=== ${document.filename} ===\n${document.text}`),
        { maxTokens: 32768, temperature: 0.1 },
      );
      await logCost(
        tenderId,
        'analyze-soupis',
        sourceResult.modelId,
        sourceResult.inputTokens,
        sourceResult.outputTokens,
        sourceResult.costCZK,
      );
      if (sourceResult.stopReason === 'max_tokens') {
        throw new Error(`výstup byl useknut po ${sourceResult.outputTokens} tokenech`);
      }
      const sourceAnalysis = parseAnalysisResponse(sourceResult.content);
      if (sourceAnalysis.polozky.length === 0) {
        throw new Error('AI z tohoto soupisu nevrátila žádnou položku');
      }
      const sourcePartId = extractCastIdFromFilename(document.filename);
      const sourceItems = sourceAnalysis.polozky.map((item) => {
        if (sourcePartId && item.cast_id
          && item.cast_id.toUpperCase() !== sourcePartId.toUpperCase()) {
          throw new Error(`AI přiřadila položku „${item.nazev}“ části ${item.cast_id}, zdrojový soubor ale patří části ${sourcePartId}`);
        }
        return sourcePartId ? { ...item, cast_id: sourcePartId } : item;
      });
      parsedNonExcelSoupisy.push({
        filename: document.filename,
        sourcePartId,
        polozky: sourceItems,
      });
    } catch (error) {
      console.log(`  Warning: Failed to analyze soupis ${document.filename}: ${error}`);
      missingNonExcelSoupisy.push(document.filename);
    }
  }

  // Check for soupis files and merge their items
  const soupisDocs = excelSoupisDocuments;
  let parsedSoupisCount = 0;
  const missingSoupisy: string[] = [];
  const soupisPolozky: typeof analysis.polozky = [];
  if (soupisDocs.length > 0) {
    console.log(`\nFound ${soupisDocs.length} soupis file(s) — parsing items...`);

    const parsedSoupis: SoupisResult[] = [];

    // Discovery se opakuje deterministicky: obnoví ZIP pracovní strom a dá nám
    // skutečné absPath i pro vnořený soupis místo chybného join(inputDir, filename).
    const { files: discoveredSoupisFiles } = await discoverInputFiles(inputDir);
    const byDisplayName = new Map(discoveredSoupisFiles.map((file) => [file.name, file.absPath]));
    const basenameCounts = new Map<string, number>();
    for (const file of discoveredSoupisFiles) {
      const name = basename(file.relPath);
      basenameCounts.set(name, (basenameCounts.get(name) ?? 0) + 1);
    }

    for (const doc of soupisDocs) {
      try {
        const fallback = basenameCounts.get(doc.filename) === 1
          ? discoveredSoupisFiles.find((file) => basename(file.relPath) === doc.filename)?.absPath
          : undefined;
        const filePath = byDisplayName.get(doc.filename) ?? fallback;
        if (!filePath) throw new Error('zdrojový soubor po discovery nebyl nalezen');
        let parsePath = filePath;
        let cleanupSnapshot: (() => Promise<void>) | undefined;
        if (doc.type === 'xlsx' || doc.type === 'xls') {
          const inspection = await inspectSoupisWorkbook(filePath);
          if (inspection.dataSheetNames.length > 1) {
            throw new Error(
              `soupis obsahuje více datových listů (${inspection.dataSheetNames.join(', ')}), ale parser umí bezpečně zpracovat jen jeden`,
            );
          }
          if (inspection.unsupportedNumberedRows.length > 0) {
            throw new Error(
              `soupis obsahuje nepodporovaně číslované položky, které parser neumí bezpečně zpracovat: ${inspection.unsupportedNumberedRows.join(', ')}`,
            );
          }
          if (inspection.dataSheetNames.length === 1) {
            const snapshot = await createSingleSheetSoupisSnapshot(filePath, inspection.dataSheetNames[0]);
            parsePath = snapshot.path;
            cleanupSnapshot = snapshot.cleanup;
          }
        }
        let soupisResult: SoupisResult;
        try {
          soupisResult = await parseSoupis(parsePath);
        } finally {
          await cleanupSnapshot?.().catch(() => {});
        }
        if (soupisResult.polozky.length === 0) throw new Error('soupis neobsahuje žádné položky');
        parsedSoupis.push(soupisResult);
        parsedSoupisCount += 1;

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
            cast_id: soupisResult.cast_id,
          });
        }
      } catch (err) {
        console.log(`  Warning: Failed to parse soupis ${doc.filename}: ${err}`);
        missingSoupisy.push(doc.filename);
      }
    }

    // Části sloučíme společně s per-source PDF/DOC soupisy níže. Jediný
    // pojmenovaný soupis je také deklarovaná část: jinak by jeho položky nesly
    // orphan cast_id a až následující krok by neprávem spadl.
    const detectedById = new Map<string, Cast>();
    for (const parsed of parsedSoupis.filter((entry) => entry.cast_id)) {
      const id = parsed.cast_id!;
      const key = id.toUpperCase();
      const previous = detectedById.get(key);
      detectedById.set(key, {
        id,
        nazev: `Část ${id}`,
        pocet_polozek: (previous?.pocet_polozek ?? 0) + parsed.polozky.length,
        soupis_filename: previous?.soupis_filename ?? parsed.filename,
      });
    }
    for (const parsed of parsedNonExcelSoupisy.filter((entry) => entry.sourcePartId)) {
      const id = parsed.sourcePartId!;
      const key = id.toUpperCase();
      const previous = detectedById.get(key);
      detectedById.set(key, {
        id,
        nazev: `Část ${id}`,
        pocet_polozek: (previous?.pocet_polozek ?? 0) + parsed.polozky.length,
        soupis_filename: previous?.soupis_filename ?? parsed.filename,
      });
    }
    if (detectedById.size > 0) {
      const casti = mergeDetectedCastiDetails(analysis.casti, [...detectedById.values()]);
      analysis.casti = casti;
      console.log(`  Tender parts detected: ${casti.length} (${casti.map(c => c.id).join(', ')})`);
    }
  }

  // I zakázka bez Excel soupisu může mít pojmenované PDF/DOC soupisy.
  if (soupisDocs.length === 0) {
    const detectedById = new Map<string, Cast>();
    for (const parsed of parsedNonExcelSoupisy.filter((entry) => entry.sourcePartId)) {
      const id = parsed.sourcePartId!;
      const key = id.toUpperCase();
      const previous = detectedById.get(key);
      detectedById.set(key, {
        id,
        nazev: `Část ${id}`,
        pocet_polozek: (previous?.pocet_polozek ?? 0) + parsed.polozky.length,
        soupis_filename: previous?.soupis_filename ?? parsed.filename,
      });
    }
    if (detectedById.size > 0) {
      analysis.casti = mergeDetectedCastiDetails(analysis.casti, [...detectedById.values()]);
      console.log(
        `  Tender parts detected: ${analysis.casti.length} (${analysis.casti.map(c => c.id).join(', ')})`,
      );
    }
  }

  const finalPartIds = new Set(analysis.casti.map((part) => part.id.toUpperCase()));
  for (const parsedSource of parsedNonExcelSoupisy) {
    const sourcePartUnknown = parsedSource.sourcePartId && finalPartIds.size > 0
      && !finalPartIds.has(parsedSource.sourcePartId.toUpperCase());
    const ambiguousItems = finalPartIds.size > 1 && parsedSource.polozky.some((item) =>
      !item.cast_id || !finalPartIds.has(item.cast_id.toUpperCase()));
    if (sourcePartUnknown || ambiguousItems) {
      missingNonExcelSoupisy.push(parsedSource.filename);
      console.log(
        `  Warning: Soupis ${parsedSource.filename} nelze jednoznačně přiřadit k existující části zakázky.`,
      );
      continue;
    }
    soupisPolozky.push(...parsedSource.polozky);
    parsedNonExcelSoupisCount += 1;
  }

  if (soupisPolozky.length > 0) {
    // Soupisy jsou autoritativní seznam položek. Per-source AI položky z PDF/DOC
    // a deterministické Excel položky se zachovají společně i u smíšeného vstupu.
    const aiItemCount = analysis.polozky.length;
    console.log(`  Replacing ${aiItemCount} general AI items with ${soupisPolozky.length} source-bound soupis items`);
    analysis.polozky = soupisPolozky;
  }

  normalizeAndValidatePartIdentity(analysis);

  const enrichedItemCount = enrichPolozkySpecifikace(
    analysis.polozky,
    extracted.documents.map((document) => document.text || ''),
  );
  console.log(`  Desc enrichment: ${enrichedItemCount} item(s) enriched from 'Položka č.' blocks`);

  // Scorer zůstává čistý: firemní profil, čas extrakce a historie cen se načtou zde
  // a předají se mu jako vstup. Nedostupná DB pouze vynechá win-price signál.
  const companyId = await getTenderCompanyId(tenderId);
  const company = (companyId ? await getCompany(companyId) : null) ?? await getCompany('default');
  let winBand: PriceBand | undefined;
  try {
    winBand = await priceBandForSubject(analysis.zakazka.predmet);
  } catch {
    console.warn('  Win-price historie není dostupná — skóre ji vynechá.');
  }
  analysis.go_no_go = scoreGoNoGo({
    ...analysis,
    extractedAt: extracted.extractedAt,
    obory: company?.obory,
    keyword_filters: company?.keyword_filters,
  }, undefined, winBand);

  const outputPath = join(outputDir, 'analysis.json');
  await writeFile(outputPath, JSON.stringify({ tenderId, ...analysis }, null, 2), 'utf-8');

  const finalniKontrola = vytvorUplnostAnalyzy(
    meaningfulCharacters,
    minimumCharacters,
    true,
    {
      ocekavano: allSoupisDocuments.length,
      zpracovano: parsedSoupisCount + parsedNonExcelSoupisCount,
      chybi: [
        ...missingSoupisy,
        ...missingNonExcelSoupisy,
      ],
    },
  );
  await ulozUplnostKroku(
    outputDir,
    tenderId,
    finalniKontrola,
  );
  if (finalniKontrola.stav !== 'uplne') throw new UplnostError(finalniKontrola);

  // Write/update tender-meta.json with display name from analysis
  const metaPath = join(outputDir, 'tender-meta.json');
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(await readFile(metaPath, 'utf-8')); } catch {}
  meta.name = analysis.zakazka.nazev;
  if (!meta.created_at) meta.created_at = new Date().toISOString();
  await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

  console.log(`\nAnalysis complete:`);
  console.log(`  Tender: ${analysis.zakazka.nazev}`);
  console.log(`  Type: ${analysis.zakazka.typ_zakazky}`);
  console.log(`  Qualification criteria: ${analysis.kvalifikace.length}`);
  console.log(`  Evaluation criteria: ${analysis.hodnotici_kriteria.length}`);
  console.log(`  Items: ${analysis.polozky.length}`);
  if (analysis.casti.length > 0) {
    console.log(`  Parts: ${analysis.casti.length} (${analysis.casti.map(c => `${c.id}: ${c.pocet_polozek} items`).join(', ')})`);
  }
  console.log(`  Technical requirements: ${analysis.technicke_pozadavky.length}`);
  console.log(`  Risks: ${analysis.rizika.length}`);
  console.log(`  Decision: ${analysis.doporuceni.rozhodnuti}`);
  console.log(`  Go/no-go score: ${analysis.go_no_go.score}/100 (${analysis.go_no_go.doporuceni})`);
  console.log(`  AI cost: ${result.costCZK.toFixed(2)} CZK`);
  console.log(`Output: ${outputPath}`);
}

main()
  .then(async () => {
    // Win-price lookup (priceBandForSubject) otevře pooled DB spojení; bez zavření pool drží
    // event loop ~30 s (idleTimeoutMillis) → analyze krok by v produkci končil o 30 s později.
    await closePool();
  })
  .catch(async (err) => {
    if (err instanceof UplnostError) console.error(formatUplnostError(err));
    else console.error('Analysis failed:', err);
    await closePool().catch(() => {});
    process.exit(1);
  });
