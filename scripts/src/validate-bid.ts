import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { logCost } from './lib/cost-tracker.js';
import { ValidationReportSchema, type TenderAnalysis, type ProductMatch } from './lib/types.js';
import { loadCompany, resolveDocumentData, type GenerationMeta } from './lib/data-resolver.js';
import { validateAllDocuments } from './lib/doc-validator.js';
import { computeSubmitGate } from './lib/submit-gate.js';
import {
  buildDocumentsPromptSection,
  loadGeneratedDocumentTexts,
  runDeterministicValidation,
  runSpecComplianceChecks,
} from './lib/validation-deterministic.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

const VALIDATE_SYSTEM = `Jsi expert na věcnou kontrolu nabídek do veřejných zakázek v České republice. Dostaneš skutečné texty vygenerovaných nabídkových dokumentů, ne jen názvy souborů.

Zkontroluj:
1. Kompletnost dokumentace (všechny požadované přílohy)
2. Soulad technických parametrů s požadavky
3. Věcná rizika v nabízeném plnění a formulacích dokumentů
4. Formální a kvalifikační rizika, která vyplývají z reálného textu dokumentů
5. Splnění hodnotících kritérií

NEKONTROLUJ aritmetiku cen, DPH, výskyt IČO/DIČ/názvu firmy ani tvrdé placeholdery. Tyto věci kontroluje deterministická vrstva mimo AI. Pokud reálný text dokumentu hodnotu obsahuje, nesmíš tvrdit, že chybí.

AI nálezy jsou pouze advisory. Nikdy nerozhodují o blokaci podání.

Pro každou kontrolu uveď:
- Kategorii (kompletnost/technicka_shoda/cenova_spravnost/formalni/kvalifikace)
- Konkrétní kontrolu
- Status: pass/fail/warning
- Detail
- zdroj: vždy "ai"

Na konci uveď:
- Celkové skóre 1-10
- ready_to_submit: vždy true (blokaci řídí deterministický gate mimo AI)
- Kritické problémy ponech prázdné; rizika dej do checks nebo doporučení
- Doporučení

Odpověz POUZE validním JSON.`;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';
  const deterministicOnly = process.argv.includes('--deterministic-only') || process.env.VALIDATE_DETERMINISTIC_ONLY === '1';

  console.log(`\n=== Step 5: Validate Bid ===`);
  console.log(`Tender ID: ${tenderId}`);

  const outputDir = join(ROOT, 'output', tenderId);
  await mkdir(outputDir, { recursive: true });

  // Načíst analýzu a product-match.
  const analysis: TenderAnalysis = JSON.parse(
    await readFile(join(outputDir, 'analysis.json'), 'utf-8')
  );
  const productMatch: ProductMatch = JSON.parse(
    await readFile(join(outputDir, 'product-match.json'), 'utf-8')
  );

  // Načíst vygenerované DOCX pro deterministické kontroly i AI kontext.
  const generatedDocuments = await loadGeneratedDocumentTexts(outputDir);
  const docxFiles = generatedDocuments.map((doc) => doc.filename);

  // Vypsat kvalifikační přílohy.
  let attachments: string[] = [];
  try {
    const prilohyDir = join(outputDir, 'prilohy');
    attachments = await readdir(prilohyDir);
    attachments = attachments.filter(f => !f.startsWith('.'));
  } catch {}

  console.log(`\nFound ${docxFiles.length} DOCX documents to validate`);
  if (docxFiles.length > 0) {
    console.log(`  Documents: ${docxFiles.join(', ')}`);
  }
  if (attachments.length > 0) {
    console.log(`Found ${attachments.length} qualification attachments: ${attachments.join(', ')}`);
  }

  // Načíst výběr částí pro filtrování.
  let selectedPartIds: Set<string> | null = null;
  const hasParts = analysis.casti && analysis.casti.length > 1;
  if (hasParts) {
    try {
      const sel = JSON.parse(await readFile(join(outputDir, 'parts-selection.json'), 'utf-8'));
      selectedPartIds = new Set(sel.selected_parts || []);
    } catch {
      selectedPartIds = new Set(analysis.casti.map((c: any) => c.id));
    }
  }

  // Připravit vybrané produkty pro single i multi-product cestu.
  let productsSection: string;
  if (productMatch.polozky_match) {
    // Filtrovat podle vybraných částí.
    let filteredMatch = productMatch.polozky_match;
    if (selectedPartIds) {
      filteredMatch = filteredMatch.filter(pm => {
        const castId = (pm as any).cast_id;
        return !castId || selectedPartIds!.has(castId);
      });
    }
    productsSection = filteredMatch.map((pm) => {
      const product = pm.kandidati[pm.vybrany_index];
      return `Položka: ${pm.polozka_nazev}
Nabízený produkt: ${product.vyrobce} ${product.model}
Cena bez DPH: ${product.cena_bez_dph} Kč
Cena s DPH: ${product.cena_s_dph} Kč
Shoda parametrů:
${product.shoda_s_pozadavky.map((s: any) => `- ${s.pozadavek}: ${s.splneno ? 'OK' : 'NESPLNĚNO'} (${s.hodnota})`).join('\n')}`;
    }).join('\n\n');
  } else {
    const selectedProduct = productMatch.kandidati![productMatch.vybrany_index!];
    productsSection = `Nabízený produkt: ${selectedProduct.vyrobce} ${selectedProduct.model}
Cena bez DPH: ${selectedProduct.cena_bez_dph} Kč
Cena s DPH: ${selectedProduct.cena_s_dph} Kč
Shoda parametrů:
${selectedProduct.shoda_s_pozadavky.map((s: any) => `- ${s.pozadavek}: ${s.splneno ? 'OK' : 'NESPLNĚNO'} (${s.hodnota})`).join('\n')}`;
  }

  // Deterministické kontroly běží před AI a jako jediné mohou později blokovat podání.
  // loadCompany může vyhodit (chybí tender-meta/company.json); to NESMÍ shodit celý krok
  // Validace ještě před zápisem reportu — degradujeme na prázdnou identitu (kontrola pak fail).
  let company: Awaited<ReturnType<typeof loadCompany>> | null = null;
  try {
    company = await loadCompany(tenderId);
  } catch (err) {
    console.warn(`  ⚠ Firemní údaje nelze načíst (${err instanceof Error ? err.message : String(err)}) — identita se nezkontroluje.`);
  }
  const deterministicChecks = runDeterministicValidation({
    company: company ?? { nazev: '', ico: '', dic: '' },
    productMatch,
    documents: generatedDocuments,
    selectedPartIds,
  });
  const deterministicFailCount = deterministicChecks.filter((c) => c.status === 'fail').length;
  console.log(`\n--- Deterministic validation ---`);
  for (const check of deterministicChecks) {
    console.log(`  [${check.status.toUpperCase()}] ${check.kontrola}: ${check.detail}`);
  }

  // Shoda se specifikací (advisory) — kontroluje, zda vybraní kandidáti splňují povinné
  // technické požadavky. Čistě informativní pro operátora: NEpřidává se do blockingProblems
  // (splneno je noisy AI sebe-hodnocení), takže nikdy nepřepíše ready_to_submit ani submit-gate.
  const specComplianceChecks = runSpecComplianceChecks({
    technicalRequirements: analysis.technicke_pozadavky,
    productMatch,
    selectedPartIds,
  });
  const specFailCount = specComplianceChecks.filter((c) => c.status === 'fail').length;
  console.log(`\n--- Spec-compliance validation (advisory, neblokuje podání) ---`);
  if (specComplianceChecks.length === 0) {
    console.log(`  Žádné neshody se specifikací (nebo shoda nebyla vyhodnocena).`);
  }
  for (const check of specComplianceChecks) {
    console.log(`  [${check.status.toUpperCase()}] ${check.kontrola}: ${check.detail}`);
  }

  const documentsSection = buildDocumentsPromptSection(generatedDocuments);

  const userMessage = `Zadávací dokumentace požaduje:

Zakázka: ${analysis.zakazka.nazev}
Typ: ${analysis.zakazka.typ_zakazky}
Zadavatel: ${analysis.zakazka.zadavatel.nazev}

Kvalifikace:
${analysis.kvalifikace.map((k) => `- [${k.typ}] ${k.popis} (splnitelné: ${k.splnitelne})`).join('\n')}

Hodnotící kritéria:
${analysis.hodnotici_kriteria.map((k) => `- ${k.nazev} (${k.vaha_procent}%): ${k.popis}`).join('\n')}

Technické požadavky:
${analysis.technicke_pozadavky.map((r) => `- ${r.parametr}: ${r.pozadovana_hodnota}`).join('\n')}

${productsSection}

Skutečné texty vygenerovaných dokumentů (každý dokument je oříznutý na rozumný limit, prioritně krycí list, cenová nabídka a čestné prohlášení):
${documentsSection}
${attachments.length > 0 ? `\nKvalifikační přílohy (nahrané uživatelem):\n${attachments.map((f) => `- ${f}`).join('\n')}` : '\nKvalifikační přílohy: ŽÁDNÉ (uživatel zatím nenahrál výpis z OR, reference apod.)'}

Odpověz ve formátu:
{
  "overall_score": 8,
  "ready_to_submit": true,
  "checks": [
    {"kategorie": "kompletnost", "kontrola": "...", "status": "pass", "detail": "...", "zdroj": "ai"}
  ],
  "kriticke_problemy": [],
  "doporuceni": ["..."]
}`;

  let aiRecovered = false;
  let parsed: any = {
    overall_score: deterministicFailCount === 0 ? 10 : 5,
    ready_to_submit: true,
    checks: [],
    kriticke_problemy: [],
    doporuceni: ['AI posouzení bylo přeskočeno; report obsahuje pouze deterministické kontroly a submit-gate.'],
  };
  let aiCostCZK = 0;

  if (deterministicOnly) {
    console.log(`\nAI validation skipped (--deterministic-only).`);
  } else {
    try {
      // Škálování pro multi-item zakázky; limit nezvyšovat nad původní hodnotu.
      const itemCount = productMatch.polozky_match?.length ?? 1;
      const maxTokens = Math.min(4096 + itemCount * 1500, 16384);

      const result = await callClaude(VALIDATE_SYSTEM, userMessage, {
        maxTokens,
        temperature: 0.1,
      });
      aiCostCZK = result.costCZK;

      let jsonStr = result.content.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }

      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        // Zkusit obnovit uříznuté JSON.
        console.log(`  Warning: JSON parse failed, attempting recovery...`);
        // Najít poslední kompletní objekt.
        const lastBrace = jsonStr.lastIndexOf('}');
        if (lastBrace > 0) {
          // Zkusit dovřít pole/objekty.
          let recovered = jsonStr.substring(0, lastBrace + 1);
          // Dovřít checks pole, pokud zůstalo otevřené.
          if (recovered.includes('"checks"') && !recovered.match(/\]\s*,?\s*"kriticke_problemy"/)) {
            recovered += ']';
          }
          // Doplnit povinná pole a zavřít objekt.
          if (!recovered.includes('"kriticke_problemy"')) {
            recovered += ', "kriticke_problemy": [], "doporuceni": []}';
          } else if (!recovered.includes('"doporuceni"')) {
            const lastBracket = recovered.lastIndexOf(']');
            recovered = recovered.substring(0, lastBracket + 1) + ', "doporuceni": []}';
          }
          try {
            parsed = JSON.parse(recovered);
            console.log(`  Recovery successful!`);
            aiRecovered = true;
          } catch {
            // Poslední pokus: vypiš začátek odpovědi pro diagnostiku.
            throw new Error(`JSON recovery failed. First 500 chars: ${jsonStr.substring(0, 500)}`);
          }
        } else {
          throw e;
        }
      }

      await logCost(tenderId, 'validate', result.modelId, result.inputTokens, result.outputTokens, result.costCZK);
    } catch (err) {
      const detail = `AI posouzení se nepodařilo provést: ${err instanceof Error ? err.message : String(err)}`;
      parsed.doporuceni = [detail];
      console.log(`  ${detail}`);
    }
  }

  const aiReport = ValidationReportSchema.parse({
    tenderId,
    validatedAt: new Date().toISOString(),
    ...parsed,
    checks: Array.isArray(parsed.checks)
      ? parsed.checks.map((check: any) => ({ ...check, zdroj: 'ai' }))
      : [],
  });
  const report = ValidationReportSchema.parse({
    tenderId,
    validatedAt: aiReport.validatedAt,
    overall_score: aiReport.overall_score,
    ready_to_submit: true,
    // specComplianceChecks jsou advisory (zdroj 'deterministic' kvůli zobrazení), ale
    // ZÁMĚRNĚ se NEpropisují do blockingProblems níže — proto jen do checks, ne do gate.
    checks: [...deterministicChecks, ...specComplianceChecks, ...aiReport.checks],
    kriticke_problemy: [],
    doporuceni: [
      ...(specFailCount > 0 ? [`Shoda se specifikací: ${specFailCount} povinných požadavků označeno jako nesplněné (advisory dle AI hodnocení — ověřte ručně, podání to neblokuje).`] : []),
      ...(aiRecovered ? ['AI posouzení bylo obnoveno z neúplné JSON odpovědi; advisory část zkontrolujte ručně.'] : []),
      ...aiReport.kriticke_problemy.map((p) => `AI upozornění: ${p}`),
      ...aiReport.doporuceni,
    ],
  });

  const outputPath = join(outputDir, 'validation-report.json');

  // Programatická field-by-field validace.
  console.log(`\n--- Programmatic field validation ---`);
  try {
    const docData = await resolveDocumentData(tenderId);
    let genMeta: GenerationMeta = {};
    const genMetaPath = join(outputDir, 'generation-meta.json');
    if (existsSync(genMetaPath)) {
      genMeta = JSON.parse(await readFile(genMetaPath, 'utf-8'));
    }

    const fieldResults = await validateAllDocuments(outputDir, docData, genMeta);

    // Uložit výsledky programatické validace.
    const fieldValidationPath = join(outputDir, 'field-validation.json');
    await writeFile(fieldValidationPath, JSON.stringify(fieldResults, null, 2), 'utf-8');

    // Souhrn do konzole.
    for (const r of fieldResults) {
      const passCount = r.checks.filter(c => c.status === 'pass').length;
      const failCount = r.checks.filter(c => c.status === 'fail').length;
      const warnCount = r.checks.filter(c => c.status === 'warning').length;
      const icon = r.overall === 'pass' ? 'OK' : 'FAIL';
      console.log(`  [${icon}] ${r.document} (${r.mode}): ${passCount} pass, ${failCount} fail, ${warnCount} warn — confidence ${r.confidence}%`);
    }

    const allPass = fieldResults.every(r => r.overall === 'pass');
    console.log(`  Overall: ${allPass ? 'ALL PASS' : 'HAS FAILURES'}`);
    console.log(`  Field validation: ${fieldValidationPath}`);
  } catch (err) {
    console.log(`  Programmatic validation skipped: ${err}`);
  }

  // --- Deterministický submit-gate: ready_to_submit na reálných kontrolách (cenový strop,
  // úplnost nacenění, field-validace, zbytkové placeholdery). AI je jen advisory.
  // Sdílená logika s POST /finalize (lib/submit-gate.ts). ---
  const blockingProblems = deterministicChecks
    .filter((check) => check.status === 'fail')
    .map((check) => `${check.kontrola}: ${check.detail}`);
  try {
    const gate = await computeSubmitGate(outputDir);
    const gateProblems = [...gate.problems];
    console.log(`\n--- Submit gate ---`);
    if (gate.warnings.length) {
      report.checks.push({
        kategorie: 'kompletnost',
        kontrola: 'Neblokující varování submit-gate',
        status: 'warning',
        detail: gate.warnings.join(' | '),
        zdroj: 'deterministic',
      });
      for (const warning of gate.warnings) report.doporuceni.push(warning);
      console.log(`  Varování:`);
      gate.warnings.forEach((warning) => console.log(`    - ${warning}`));
    }
    if (gateProblems.length) {
      blockingProblems.push(...gateProblems);
      report.checks.push({ kategorie: 'kompletnost', kontrola: 'Deterministický submit-gate', status: 'fail', detail: gateProblems.join(' | '), zdroj: 'deterministic' });
      gateProblems.forEach((gp) => console.log(`    - ${gp}`));
    } else {
      report.checks.push({ kategorie: 'kompletnost', kontrola: 'Deterministický submit-gate', status: 'pass', detail: 'Strop dodržen, vše oceněno, field-validace prošla a dokumenty neobsahují zbytkové placeholdery.', zdroj: 'deterministic' });
      console.log(`  Gate OK (strop dodržen, vše oceněno, žádné placeholdery).`);
    }
    await writeFile(join(outputDir, 'validation-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  } catch (err) {
    const detail = `Submit-gate nelze vyhodnotit: ${err}`;
    blockingProblems.push(detail);
    report.checks.push({ kategorie: 'kompletnost', kontrola: 'Deterministický submit-gate', status: 'fail', detail, zdroj: 'deterministic' });
    console.log(`  ${detail}`);
  }

  report.ready_to_submit = blockingProblems.length === 0;
  report.kriticke_problemy = blockingProblems;
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\nValidation complete:`);
  console.log(`  Overall score: ${report.overall_score}/10`);
  console.log(`  Ready to submit: ${report.ready_to_submit ? 'YES' : 'NO'}`);
  console.log(`  Checks: ${report.checks.filter((c) => c.status === 'pass').length} pass, ${report.checks.filter((c) => c.status === 'fail').length} fail, ${report.checks.filter((c) => c.status === 'warning').length} warnings`);
  if (report.kriticke_problemy.length > 0) {
    console.log(`  Critical issues:`);
    report.kriticke_problemy.forEach((p) => console.log(`    - ${p}`));
  }
  console.log(`  AI cost: ${aiCostCZK.toFixed(2)} CZK`);
  console.log(`Output: ${outputPath}`);
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
