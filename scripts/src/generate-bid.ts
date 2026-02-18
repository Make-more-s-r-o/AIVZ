import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import {
  fillTemplateWithAI,
  discoverTemplates,
  generateCenovaNabidka,
  generateTechnickyNavrh,
} from './lib/template-engine.js';
import { fillExcelWithAI } from './lib/xls-filler.js';
import { TECHNICAL_PROPOSAL_SYSTEM, buildTechnicalProposalUserMessage } from './prompts/technical-proposal.js';
import type { TenderAnalysis, ProductMatch } from './lib/types.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

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

  const selectedProduct = productMatch.kandidati[productMatch.vybrany_index];
  const priceOverride = productMatch.cenova_uprava;
  const bidPriceBezDph = priceOverride?.nabidkova_cena_bez_dph ?? selectedProduct.cena_bez_dph;
  const bidPriceSdph = priceOverride?.nabidkova_cena_s_dph ?? selectedProduct.cena_s_dph;
  let totalCostCZK = 0;

  if (priceOverride?.potvrzeno) {
    console.log(`  Using confirmed prices: ${bidPriceBezDph.toLocaleString('cs-CZ')} Kč bez DPH`);
  } else {
    console.log(`  Warning: Using AI-estimated prices (not confirmed by user)`);
  }

  // DPH rate from analysis or default 21%
  const dphRate = 21;
  const dphAmount = bidPriceSdph - bidPriceBezDph;

  // Shared data for template filling
  const tenderData = {
    nazev_zakazky: analysis.zakazka.nazev,
    evidencni_cislo: analysis.zakazka.evidencni_cislo || undefined,
    zadavatel: analysis.zakazka.zadavatel.nazev,
    zadavatel_ico: analysis.zakazka.zadavatel.ico || undefined,
    zadavatel_kontakt: analysis.zakazka.zadavatel.kontakt || undefined,
    cena_bez_dph: bidPriceBezDph.toLocaleString('cs-CZ'),
    cena_s_dph: bidPriceSdph.toLocaleString('cs-CZ'),
    dph: dphAmount.toLocaleString('cs-CZ'),
    dph_sazba: `${dphRate}`,
    datum: new Date().toLocaleDateString('cs-CZ'),
    // Contract-specific fields
    doba_plneni_od: analysis.terminy.doba_plneni_od || undefined,
    doba_plneni_do: analysis.terminy.doba_plneni_do || undefined,
    lhuta_nabidek: analysis.terminy.lhuta_nabidek || undefined,
    produkt_nazev: `${selectedProduct.vyrobce} ${selectedProduct.model}`,
    produkt_popis: selectedProduct.popis,
  };

  // 4A: Generate technical proposal content with AI
  console.log('\n4A: Generating technical proposal with AI...');
  const technicalResult = await callClaude(
    TECHNICAL_PROPOSAL_SYSTEM,
    buildTechnicalProposalUserMessage(
      analysis.zakazka.nazev,
      analysis.zakazka.predmet,
      analysis.technicke_pozadavky,
      selectedProduct,
      company
    ),
    { maxTokens: 8192, temperature: 0.3 }
  );
  totalCostCZK += technicalResult.costCZK;

  // 4B: Generate documents
  console.log('\n4B: Generating DOCX documents...');

  // 1. Technický návrh (AI-generated from scratch)
  console.log('  - technicky_navrh.docx');
  const techNavrh = await generateTechnickyNavrh(
    analysis, selectedProduct, company, technicalResult.content
  );
  await writeFile(join(outputDir, 'technicky_navrh.docx'), techNavrh);

  // 2. Cenová nabídka (generated from scratch)
  console.log('  - cenova_nabidka.docx');
  const cenovaNabidka = await generateCenovaNabidka(analysis, selectedProduct, company, bidPriceBezDph, bidPriceSdph);
  await writeFile(join(outputDir, 'cenova_nabidka.docx'), cenovaNabidka);

  // 3. Template-based documents (krycí list, čestné prohlášení, seznam poddodavatelů)
  console.log('\n4C: Discovering and filling templates...');
  const templates = await discoverTemplates(inputDir);
  console.log(`  Found ${templates.length} template(s): ${templates.map((t) => t.type).join(', ')}`);

  const OUTPUT_NAMES: Record<string, string> = {
    kryci_list: 'kryci_list',
    cestne_prohlaseni: 'cestne_prohlaseni',
    seznam_poddodavatelu: 'seznam_poddodavatelu',
    kupni_smlouva: 'kupni_smlouva',
    technicka_specifikace: 'technicka_specifikace',
  };

  const typeCounters = new Map<string, number>();

  for (const template of templates) {
    // Handle duplicate types (e.g. 2× cestne_prohlaseni)
    const count = typeCounters.get(template.type) || 0;
    typeCounters.set(template.type, count + 1);

    const baseName = OUTPUT_NAMES[template.type] || template.type;
    const suffix = count > 0 ? `_${count + 1}` : '';
    const isExcel = template.filename.toLowerCase().endsWith('.xls') || template.filename.toLowerCase().endsWith('.xlsx');
    const ext = isExcel ? '.xlsx' : '.docx';
    const outputName = `${baseName}${suffix}${ext}`;

    console.log(`  - ${outputName} (from: ${template.filename})`);

    try {
      if (isExcel) {
        // Use Excel filler for XLS/XLSX templates
        const result = await fillExcelWithAI(template.path, company, tenderData);
        await writeFile(join(outputDir, outputName), result.buffer);
        totalCostCZK += result.costCZK;

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
        // Use DOCX filler for DOCX templates
        const result = await fillTemplateWithAI(template.path, company, tenderData);
        await writeFile(join(outputDir, outputName), result.buffer);
        totalCostCZK += result.costCZK;

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
  console.log(`  AI cost: ${totalCostCZK.toFixed(2)} CZK`);
  console.log(`  Output: ${outputDir}/`);
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
