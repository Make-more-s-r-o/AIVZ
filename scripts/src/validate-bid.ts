import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { ValidationReportSchema, type TenderAnalysis, type ProductMatch } from './lib/types.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

const VALIDATE_SYSTEM = `Jsi expert na kontrolu nabídek do veřejných zakázek v České republice. Zkontroluj, zda nabídka splňuje všechny požadavky zadávací dokumentace.

Zkontroluj:
1. Kompletnost dokumentace (všechny požadované přílohy)
2. Soulad technických parametrů s požadavky
3. Správnost cenového rozpočtu (cena bez DPH, DPH 21%, cena s DPH)
4. Formální náležitosti (IČO, DIČ, podpis, datum)
5. Soulad s kvalifikačními požadavky
6. Splnění hodnotících kritérií

Pro každou kontrolu uveď:
- Kategorii (kompletnost/technicka_shoda/cenova_spravnost/formalni/kvalifikace)
- Konkrétní kontrolu
- Status: pass/fail/warning
- Detail

Na konci uveď:
- Celkové skóre 1-10
- ready_to_submit: true/false
- Kritické problémy (pokud existují)
- Doporučení

Odpověz POUZE validním JSON.`;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  console.log(`\n=== Step 5: Validate Bid ===`);
  console.log(`Tender ID: ${tenderId}`);

  const outputDir = join(ROOT, 'output', tenderId);
  await mkdir(outputDir, { recursive: true });

  // Read analysis and product match
  const analysis: TenderAnalysis = JSON.parse(
    await readFile(join(outputDir, 'analysis.json'), 'utf-8')
  );
  const productMatch: ProductMatch = JSON.parse(
    await readFile(join(outputDir, 'product-match.json'), 'utf-8')
  );

  // List generated documents
  const files = await readdir(outputDir);
  const docxFiles = files.filter((f) => f.endsWith('.docx'));

  // List qualification attachments
  let attachments: string[] = [];
  try {
    const prilohyDir = join(outputDir, 'prilohy');
    attachments = await readdir(prilohyDir);
    attachments = attachments.filter(f => !f.startsWith('.'));
  } catch {}

  console.log(`\nFound ${docxFiles.length} DOCX documents to validate`);
  if (attachments.length > 0) {
    console.log(`Found ${attachments.length} qualification attachments: ${attachments.join(', ')}`);
  }

  // Read parts selection for filtering
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

  // Resolve selected products for both single and multi-product paths
  let productsSection: string;
  if (productMatch.polozky_match) {
    // Filter by selected parts
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

Vygenerované dokumenty:
${docxFiles.map((f) => `- ${f}`).join('\n')}
${attachments.length > 0 ? `\nKvalifikační přílohy (nahrané uživatelem):\n${attachments.map((f) => `- ${f}`).join('\n')}` : '\nKvalifikační přílohy: ŽÁDNÉ (uživatel zatím nenahrál výpis z OR, reference apod.)'}

Odpověz ve formátu:
{
  "overall_score": 8,
  "ready_to_submit": true,
  "checks": [
    {"kategorie": "kompletnost", "kontrola": "...", "status": "pass", "detail": "..."}
  ],
  "kriticke_problemy": [],
  "doporuceni": ["..."]
}`;

  // Scale maxTokens for multi-item tenders (more checks = longer response)
  const itemCount = productMatch.polozky_match?.length ?? 1;
  const maxTokens = Math.min(4096 + itemCount * 1500, 16384);

  const result = await callClaude(VALIDATE_SYSTEM, userMessage, {
    maxTokens,
    temperature: 0.1,
  });

  let jsonStr = result.content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    // Try to recover truncated JSON
    console.log(`  Warning: JSON parse failed, attempting recovery...`);
    // Find last complete "checks" array entry
    const lastBrace = jsonStr.lastIndexOf('}');
    if (lastBrace > 0) {
      // Try closing arrays/objects
      let recovered = jsonStr.substring(0, lastBrace + 1);
      // Close checks array if open
      if (recovered.includes('"checks"') && !recovered.match(/\]\s*,?\s*"kriticke_problemy"/)) {
        recovered += ']';
      }
      // Add missing fields and close
      if (!recovered.includes('"kriticke_problemy"')) {
        recovered += ', "kriticke_problemy": [], "doporuceni": []}';
      } else if (!recovered.includes('"doporuceni"')) {
        const lastBracket = recovered.lastIndexOf(']');
        recovered = recovered.substring(0, lastBracket + 1) + ', "doporuceni": []}';
      }
      try {
        parsed = JSON.parse(recovered);
        console.log(`  Recovery successful!`);
      } catch {
        // Last resort: extract what we can
        throw new Error(`JSON recovery failed. First 500 chars: ${jsonStr.substring(0, 500)}`);
      }
    } else {
      throw e;
    }
  }
  const report = ValidationReportSchema.parse({
    tenderId,
    validatedAt: new Date().toISOString(),
    ...parsed,
  });

  const outputPath = join(outputDir, 'validation-report.json');
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\nValidation complete:`);
  console.log(`  Overall score: ${report.overall_score}/10`);
  console.log(`  Ready to submit: ${report.ready_to_submit ? 'YES' : 'NO'}`);
  console.log(`  Checks: ${report.checks.filter((c) => c.status === 'pass').length} pass, ${report.checks.filter((c) => c.status === 'fail').length} fail, ${report.checks.filter((c) => c.status === 'warning').length} warnings`);
  if (report.kriticke_problemy.length > 0) {
    console.log(`  Critical issues:`);
    report.kriticke_problemy.forEach((p) => console.log(`    - ${p}`));
  }
  console.log(`  AI cost: ${result.costCZK.toFixed(2)} CZK`);
  console.log(`Output: ${outputPath}`);
}

main().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
