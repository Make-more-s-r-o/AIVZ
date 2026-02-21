import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { logCost } from './lib/cost-tracker.js';
import {
  fillTemplateWithAI,
  discoverTemplates,
  generateCenovaNabidka,
  generateCenovaNabidkaMulti,
  generateTechnickyNavrh,
  type MultiProductItem,
  type DiscoveredTemplate,
} from './lib/template-engine.js';
import { fillExcelWithAI } from './lib/xls-filler.js';
import { TECHNICAL_PROPOSAL_SYSTEM, buildTechnicalProposalUserMessage } from './prompts/technical-proposal.js';
import type { TenderAnalysis, ProductMatch, ProductCandidate } from './lib/types.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

/** Remove diacritics, replace spaces with underscores, strip extension */
function sanitizeFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, '') // remove extension
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[^a-zA-Z0-9_-]/g, '_') // replace non-alphanum
    .replace(/_+/g, '_') // collapse underscores
    .replace(/^_|_$/g, '') // trim
    .toLowerCase();
}

const ROOT = new URL('../../', import.meta.url).pathname;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  console.log(`\n=== Step 4: Generate Bid Documents ===`);
  console.log(`Tender ID: ${tenderId}`);

  const outputDir = join(ROOT, 'output', tenderId);
  const inputDir = join(ROOT, 'input', tenderId);
  await mkdir(outputDir, { recursive: true });

  // Read inputs
  const analysis: TenderAnalysis = JSON.parse(
    await readFile(join(outputDir, 'analysis.json'), 'utf-8')
  );
  const productMatch: ProductMatch = JSON.parse(
    await readFile(join(outputDir, 'product-match.json'), 'utf-8')
  );
  const company = JSON.parse(
    await readFile(join(ROOT, 'config', 'company.json'), 'utf-8')
  );

  let totalCostCZK = 0;
  const isMultiProduct = !!productMatch.polozky_match;

  // Resolve products and prices for both paths
  let selectedProducts: Array<{
    polozka: string;
    mnozstvi: number;
    product: ProductCandidate;
    priceBezDph: number;
    priceSdph: number;
  }>;

  if (isMultiProduct) {
    const itemTypes = productMatch.polozky_match!.reduce((acc, pm) => {
      const t = (pm as any).typ || 'produkt';
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log(`  Multi-product mode: ${productMatch.polozky_match!.length} items (${Object.entries(itemTypes).map(([k,v]) => `${v} ${k}`).join(', ')})`);
    selectedProducts = productMatch.polozky_match!.map(pm => {
      const product = pm.kandidati[pm.vybrany_index];
      const override = pm.cenova_uprava;
      return {
        polozka: pm.polozka_nazev,
        mnozstvi: pm.mnozstvi || 1,
        product,
        priceBezDph: override?.nabidkova_cena_bez_dph ?? product.cena_bez_dph,
        priceSdph: override?.nabidkova_cena_s_dph ?? product.cena_s_dph,
      };
    });
  } else {
    const selectedProduct = productMatch.kandidati![productMatch.vybrany_index!];
    const priceOverride = productMatch.cenova_uprava;
    selectedProducts = [{
      polozka: analysis.zakazka.predmet,
      mnozstvi: 1,
      product: selectedProduct,
      priceBezDph: priceOverride?.nabidkova_cena_bez_dph ?? selectedProduct.cena_bez_dph,
      priceSdph: priceOverride?.nabidkova_cena_s_dph ?? selectedProduct.cena_s_dph,
    }];
  }

  // Total prices
  const totalBezDph = selectedProducts.reduce((s, p) => s + p.priceBezDph * p.mnozstvi, 0);
  const totalSdph = selectedProducts.reduce((s, p) => s + p.priceSdph * p.mnozstvi, 0);
  const dphAmount = totalSdph - totalBezDph;

  const allConfirmed = isMultiProduct
    ? productMatch.polozky_match!.every(pm => pm.cenova_uprava?.potvrzeno)
    : productMatch.cenova_uprava?.potvrzeno;

  if (allConfirmed) {
    console.log(`  Using confirmed prices: ${totalBezDph.toLocaleString('cs-CZ')} Kč bez DPH`);
  } else {
    console.log(`  Warning: Using AI-estimated prices (not confirmed by user)`);
  }

  // Shared tenderData for templates
  const tenderData = {
    nazev_zakazky: analysis.zakazka.nazev,
    evidencni_cislo: analysis.zakazka.evidencni_cislo || undefined,
    zadavatel: analysis.zakazka.zadavatel.nazev,
    zadavatel_ico: analysis.zakazka.zadavatel.ico || undefined,
    zadavatel_kontakt: analysis.zakazka.zadavatel.kontakt || undefined,
    cena_bez_dph: totalBezDph.toLocaleString('cs-CZ'),
    cena_s_dph: totalSdph.toLocaleString('cs-CZ'),
    dph: dphAmount.toLocaleString('cs-CZ'),
    dph_sazba: '21',
    datum: new Date().toLocaleDateString('cs-CZ'),
    doba_plneni_od: analysis.terminy.doba_plneni_od || undefined,
    doba_plneni_do: analysis.terminy.doba_plneni_do || undefined,
    lhuta_nabidek: analysis.terminy.lhuta_nabidek || undefined,
    produkt_nazev: selectedProducts.map(p => `${p.product.vyrobce} ${p.product.model}`).join(', '),
    produkt_popis: selectedProducts.map(p => p.product.popis).join('; '),
  };

  // 4A: Generate technical proposal content with AI
  console.log('\n4A: Generating technical proposal with AI...');

  // For multi-product: generate content for each product, concatenated
  const primaryProduct = selectedProducts[0].product;
  const technicalResult = await callClaude(
    TECHNICAL_PROPOSAL_SYSTEM,
    buildTechnicalProposalUserMessage(
      analysis.zakazka.nazev,
      analysis.zakazka.predmet,
      analysis.technicke_pozadavky,
      isMultiProduct
        ? {
            vyrobce: selectedProducts.map(p => p.product.vyrobce).join(', '),
            model: selectedProducts.map(p => `${p.product.vyrobce} ${p.product.model}`).join('; '),
            popis: selectedProducts.map(p => `${p.polozka}: ${p.product.popis}`).join('\n'),
            parametry: Object.assign({}, ...selectedProducts.map(p => p.product.parametry)),
          }
        : primaryProduct,
      company
    ),
    { maxTokens: isMultiProduct ? 12288 : 8192, temperature: 0.3 }
  );
  totalCostCZK += technicalResult.costCZK;
  await logCost(tenderId, 'generate-technical-proposal', technicalResult.modelId, technicalResult.inputTokens, technicalResult.outputTokens, technicalResult.costCZK);

  // 4B: Generate documents
  console.log('\n4B: Generating DOCX documents...');

  // 1. Technický návrh
  console.log('  - technicky_navrh.docx');
  const techNavrh = await generateTechnickyNavrh(
    analysis, primaryProduct, company, technicalResult.content
  );
  await writeFile(join(outputDir, 'technicky_navrh.docx'), techNavrh);

  // 2. Cenová nabídka
  console.log('  - cenova_nabidka.docx');
  let cenovaNabidka: Buffer;
  if (isMultiProduct) {
    cenovaNabidka = await generateCenovaNabidkaMulti(
      analysis,
      selectedProducts as MultiProductItem[],
      company,
    );
  } else {
    cenovaNabidka = await generateCenovaNabidka(
      analysis, primaryProduct, company, totalBezDph, totalSdph
    );
  }
  await writeFile(join(outputDir, 'cenova_nabidka.docx'), cenovaNabidka);

  // 3. Template-based documents
  console.log('\n4C: Discovering and filling templates...');
  const templates = await discoverTemplates(inputDir);
  console.log(`  Found ${templates.length} tender template(s): ${templates.map((t) => t.type).join(', ') || 'none'}`);

  // Add fallback templates from templates/ for missing types (zero AI cost — uses docxtemplater)
  const FALLBACK_TYPES: DiscoveredTemplate['type'][] = ['kryci_list', 'cestne_prohlaseni', 'seznam_poddodavatelu'];
  const foundTypes = new Set(templates.map((t) => t.type));
  const globalTemplatesDir = join(ROOT, 'templates');
  for (const fallbackType of FALLBACK_TYPES) {
    if (!foundTypes.has(fallbackType)) {
      const fallbackPath = join(globalTemplatesDir, `${fallbackType}.docx`);
      if (existsSync(fallbackPath)) {
        templates.push({ path: fallbackPath, filename: `${fallbackType}.docx`, type: fallbackType });
        console.log(`  Added global fallback: ${fallbackType}.docx`);
      }
    }
  }
  console.log(`  Total templates to fill: ${templates.length}`);

  const OUTPUT_NAMES: Record<string, string> = {
    kryci_list: 'kryci_list',
    cestne_prohlaseni: 'cestne_prohlaseni',
    seznam_poddodavatelu: 'seznam_poddodavatelu',
    kupni_smlouva: 'kupni_smlouva',
    technicka_specifikace: 'technicka_specifikace',
  };

  const typeCounters = new Map<string, number>();

  for (const template of templates) {
    const count = typeCounters.get(template.type) || 0;
    typeCounters.set(template.type, count + 1);

    const baseName = OUTPUT_NAMES[template.type] || sanitizeFilename(template.filename);
    const suffix = count > 0 ? `_${count + 1}` : '';
    const isExcel = template.filename.toLowerCase().endsWith('.xls') || template.filename.toLowerCase().endsWith('.xlsx');
    const ext = isExcel ? '.xlsx' : '.docx';
    const outputName = `${baseName}${suffix}${ext}`;

    console.log(`  - ${outputName} (from: ${template.filename})`);

    try {
      if (isExcel) {
        const result = await fillExcelWithAI(template.path, company, tenderData);
        await writeFile(join(outputDir, outputName), result.buffer);
        totalCostCZK += result.costCZK;
        if (result.costCZK > 0) {
          await logCost(tenderId, `generate-template-${outputName}`, 'excel-ai', 0, 0, result.costCZK);
        }

        if (result.replacements.length > 0) {
          const logName = outputName.replace(ext, '_replacements.json');
          await writeFile(
            join(outputDir, logName),
            JSON.stringify(result.replacements, null, 2),
            'utf-8'
          );
          console.log(`    Saved ${result.replacements.length} replacements to ${logName}`);
        }
      } else {
        const result = await fillTemplateWithAI(template.path, company, tenderData);
        await writeFile(join(outputDir, outputName), result.buffer);
        totalCostCZK += result.costCZK;
        if (result.costCZK > 0) {
          await logCost(tenderId, `generate-template-${outputName}`, 'docx-ai', 0, 0, result.costCZK);
        }

        if (result.replacements.length > 0) {
          const logName = outputName.replace('.docx', '_replacements.json');
          await writeFile(
            join(outputDir, logName),
            JSON.stringify(result.replacements, null, 2),
            'utf-8'
          );
          console.log(`    Saved ${result.replacements.length} replacements to ${logName}`);
        }
      }
    } catch (err) {
      console.log(`    Error filling template: ${err}`);
    }
  }

  console.log(`\nGeneration complete!`);
  console.log(`  Total price: ${totalBezDph.toLocaleString('cs-CZ')} Kč bez DPH / ${totalSdph.toLocaleString('cs-CZ')} Kč s DPH`);
  console.log(`  AI cost: ${totalCostCZK.toFixed(2)} CZK`);
  console.log(`  Output: ${outputDir}/`);
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
