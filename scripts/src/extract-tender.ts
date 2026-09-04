import { writeFile, mkdir } from 'fs/promises';
import { basename, extname, join } from 'path';
import { classifyDocumentFilename, extractDocumentsWithReport } from './lib/document-parser.js';
import { ExtractedTextSchema } from './lib/types.js';
import {
  UplnostError,
  formatUplnostError,
  nactiUplnostZakazky,
  pocetUplnosti,
  ulozUplnostKroku,
  vytvorUplnostKroku,
} from './lib/uplnost.js';

const ROOT = process.env.VZ_ROOT_DIR || new URL('../../', import.meta.url).pathname;

async function main() {
  const tenderIdArg = process.argv.find((a) => a.startsWith('--tender-id='));
  const tenderId = tenderIdArg?.split('=')[1] || '3d-tiskarna';

  console.log(`\n=== Step 1: Extract tender documents ===`);
  console.log(`Tender ID: ${tenderId}`);

  const inputDir = join(ROOT, 'input', tenderId);
  const outputDir = join(ROOT, 'output', tenderId);

  await mkdir(outputDir, { recursive: true });

  console.log(`\nExtracting from: ${inputDir}`);
  const extraction = await extractDocumentsWithReport(inputDir);
  const { documents } = extraction;

  // Ingest zná počet dokumentů na zdroji. Lokální discovery jej může pouze zvýšit
  // (např. po ručním doplnění), nikdy snížit na počet, který se zrovna podařilo stáhnout.
  const existingUplnost = await nactiUplnostZakazky(outputDir);
  const ingest = existingUplnost?.kroky.ingest;
  const ingestExpected = pocetUplnosti(ingest, 'ocekavano', 'dokumenty') ?? 0;
  const ingestReceived = pocetUplnosti(ingest, 'dostano', 'dokumenty') ?? 0;
  const ingestDeficit = Math.max(0, ingestExpected - ingestReceived);
  const canonicalName = (name: string) => {
    const base = basename(name);
    return base.slice(0, base.length - extname(base).length).normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  };
  // Extract nemá snapshot původně stažených source příloh, proto nesmí sám hádat,
  // že stejně pojmenovaný soubor na disku uzdravil starý ingest deficit. To smí
  // udělat jen nový dokončený upload/download, který ingest kontrakt přepíše.
  const unresolvedIngestMissing = [...(ingest?.chybi ?? [])];
  // ZIP je jedna stažená příloha, ale může vytvořit mnoho dokumentů. Proto se chybějící
  // zdrojové přílohy přičtou explicitně; pouhé max(raw přílohy, rozbalené dokumenty)
  // by dovolilo obsahu ZIPu početně zamaskovat jinou nedodanou přílohu.
  const expectedDocuments = Math.max(
    ingestExpected,
    extraction.expectedDocumentNames.length + ingestDeficit,
  );
  const missing = [
    ...extraction.missingDocumentNames,
    ...extraction.warnings.map((warning) => `discovery: ${warning}`),
  ];
  const extractionMissingCounts = new Map<string, number>();
  for (const name of missing) {
    extractionMissingCounts.set(name, (extractionMissingCounts.get(name) ?? 0) + 1);
  }
  const seenIngestMissingCounts = new Map<string, number>();
  for (const name of unresolvedIngestMissing) {
    const seen = (seenIngestMissingCounts.get(name) ?? 0) + 1;
    seenIngestMissingCounts.set(name, seen);
    // Multisetové sjednocení: tentýž fyzický parse failure nehlásíme dvakrát,
    // ale dvě různé source přílohy se shodným názvem musí zůstat dvěma deficity.
    if (seen > (extractionMissingCounts.get(name) ?? 0)) missing.push(name);
  }
  if (documents.length < expectedDocuments && missing.length === 0) {
    missing.push(`chybí ${expectedDocuments - documents.length} dokumentů ze zdrojové sady`);
  }

  const actualTemplates = documents.filter((document) => document.isTemplate).length;
  const missingTemplateNames = new Set([
    ...extraction.missingDocumentNames,
    ...unresolvedIngestMissing,
  ].filter((name) => classifyDocumentFilename(name).isTemplate).map(canonicalName));
  const expectedTemplates = actualTemplates + missingTemplateNames.size;
  const zeroInput = expectedDocuments === 0 || documents.length === 0;
  const inputMetrics = [
    { nazev: 'dokumenty', jednotka: 'dokumenty' as const, ocekavano: expectedDocuments, dostano: documents.length },
    { nazev: 'sablony', jednotka: 'sablony' as const, ocekavano: expectedTemplates, dostano: actualTemplates },
  ];
  const kontrola = vytvorUplnostKroku({
    krok: 'extract',
    metriky: inputMetrics,
    chybi: missing,
    vedomeIgnorovano: extraction.ignoredDocumentNames,
    selhalo: zeroInput,
    zprava: zeroInput
      ? 'Extrakci nelze spustit: nejsou k dispozici žádné podporované a čitelné dokumenty.'
      : documents.length < expectedDocuments
        ? `Extrakci nelze dokončit: získáno ${documents.length} z ${expectedDocuments} očekávaných dokumentů.`
        : missing.length > 0
          ? 'Extrakci nelze dokončit: některé vstupy nebylo možné bezpečně zpracovat.'
        : undefined,
    naprava: documents.length >= expectedDocuments && missing.length === 0 && !zeroInput
      ? ''
      : 'Nahrajte nebo znovu stáhněte kompletní zadávací dokumentaci a spusťte extrakci znovu.',
  });
  if (kontrola.stav !== 'uplne') {
    await ulozUplnostKroku(outputDir, tenderId, kontrola);
    throw new UplnostError(kontrola);
  }

  // Před přepsáním artefaktu nejdřív zneplatníme starý extract i downstream. Pád mezi
  // writeFile a finálním kontraktem tak nikdy nenechá nový soubor vypadat zeleně.
  await ulozUplnostKroku(outputDir, tenderId, vytvorUplnostKroku({
    krok: 'extract',
    metriky: [
      ...inputMetrics,
      { nazev: 'extracted_text_json', jednotka: 'vystupy', ocekavano: 1, dostano: 0 },
    ],
    chybi: ['extracted-text.json (nový výstup extrakce dosud nevznikl)'],
    vedomeIgnorovano: extraction.ignoredDocumentNames,
    zprava: 'Extrakce vstupů skončila; ukládá se nový extracted-text.json.',
    naprava: 'Pokud se zápis nedokončí, spusťte extrakci znovu.',
  }));

  const result = ExtractedTextSchema.parse({
    tenderId,
    extractedAt: new Date().toISOString(),
    documents,
    totalCharacters: documents.reduce((sum, d) => sum + d.text.length, 0),
  });

  const outputPath = join(outputDir, 'extracted-text.json');
  await writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');
  // Zelený kontrakt až po úspěšném zápisu artefaktu.
  await ulozUplnostKroku(outputDir, tenderId, vytvorUplnostKroku({
    krok: 'extract',
    metriky: [
      ...inputMetrics,
      { nazev: 'extracted_text_json', jednotka: 'vystupy', ocekavano: 1, dostano: 1 },
    ],
    vedomeIgnorovano: extraction.ignoredDocumentNames,
  }));

  console.log(`\nExtracted ${documents.length} documents`);
  console.log(`Total characters: ${result.totalCharacters}`);
  console.log(`Templates (skipped for analysis): ${documents.filter((d) => d.isTemplate).length}`);
  console.log(`Output: ${outputPath}`);
}

main().catch((err) => {
  if (err instanceof UplnostError) console.error(formatUplnostError(err));
  else console.error('Extract failed:', err);
  process.exit(1);
});
