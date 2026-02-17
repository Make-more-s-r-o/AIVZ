import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import { callClaude } from './lib/ai-client.js';
import { fillTemplate, generateCenovaNabidka, generateTechnickyNavrh } from './lib/template-engine.js';
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
  let totalCostCZK = 0;

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

  // 1. Technický návrh (generated from scratch)
  console.log('  - technicky_navrh.docx');
  const techNavrh = await generateTechnickyNavrh(
    analysis, selectedProduct, company, technicalResult.content
  );
  await writeFile(join(outputDir, 'technicky_navrh.docx'), techNavrh);

  // 2. Cenová nabídka (generated from scratch)
  console.log('  - cenova_nabidka.docx');
  const cenovaNabidka = await generateCenovaNabidka(analysis, selectedProduct, company);
  await writeFile(join(outputDir, 'cenova_nabidka.docx'), cenovaNabidka);

  // 3. Krycí list (fill template if available)
  const kryciListPath = join(inputDir, 'Příloha č. 3 Krycí list nabídky.docx');
  try {
    console.log('  - kryci_list.docx (from template)');
    const kryciList = await fillTemplate(kryciListPath, {
      nazev_zakazky: analysis.zakazka.nazev,
      nazev_uchazeče: company.nazev,
      nazev_uchazece: company.nazev,
      ico: company.ico,
      dic: company.dic,
      sidlo: company.sidlo,
      telefon: company.telefon,
      email: company.email,
      jednajici_osoba: company.jednajici_osoba,
      nabidkova_cena_bez_dph: selectedProduct.cena_bez_dph.toLocaleString('cs-CZ'),
      nabidkova_cena_s_dph: selectedProduct.cena_s_dph.toLocaleString('cs-CZ'),
      dph: (selectedProduct.cena_s_dph - selectedProduct.cena_bez_dph).toLocaleString('cs-CZ'),
      datum: new Date().toLocaleDateString('cs-CZ'),
    });
    await writeFile(join(outputDir, 'kryci_list.docx'), kryciList);
  } catch (err) {
    console.log('    Template not found or error — skipping (convert .doc to .docx first)');
  }

  // 4. Čestné prohlášení (fill template if available)
  const cestneProhlaseniPath = join(inputDir, 'Příloha č. 4 Vzor čestného prohlášení.docx');
  try {
    console.log('  - cestne_prohlaseni.docx (from template)');
    const cestneProhlaseni = await fillTemplate(cestneProhlaseniPath, {
      nazev_uchazece: company.nazev,
      ico: company.ico,
      dic: company.dic,
      sidlo: company.sidlo,
      jednajici_osoba: company.jednajici_osoba,
      nazev_zakazky: analysis.zakazka.nazev,
      datum: new Date().toLocaleDateString('cs-CZ'),
    });
    await writeFile(join(outputDir, 'cestne_prohlaseni.docx'), cestneProhlaseni);
  } catch (err) {
    console.log('    Template not found or error — skipping (convert .doc to .docx first)');
  }

  // 5. Seznam poddodavatelů (fill template if available)
  const poddodavatelePath = join(inputDir, 'Příloha č. 5 Seznam poddodavatelů.docx');
  try {
    console.log('  - seznam_poddodavatelu.docx (from template)');
    const poddodavatele = await fillTemplate(poddodavatelePath, {
      nazev_uchazece: company.nazev,
      ico: company.ico,
      sidlo: company.sidlo,
      jednajici_osoba: company.jednajici_osoba,
      nazev_zakazky: analysis.zakazka.nazev,
      datum: new Date().toLocaleDateString('cs-CZ'),
      poddodavatele: 'Uchazeč nehodlá plnit veřejnou zakázku prostřednictvím poddodavatele.',
    });
    await writeFile(join(outputDir, 'seznam_poddodavatelu.docx'), poddodavatele);
  } catch (err) {
    console.log('    Template not found or error — skipping (convert .doc to .docx first)');
  }

  console.log(`\nGeneration complete!`);
  console.log(`  AI cost: ${totalCostCZK.toFixed(2)} CZK`);
  console.log(`  Output: ${outputDir}/`);
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
