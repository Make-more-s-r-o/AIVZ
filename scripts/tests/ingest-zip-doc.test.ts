/**
 * Deterministický regresní test: `.doc` šablona (kupní smlouva) doručená UVNITŘ ZIPu
 * musí přežít až do fáze generování (discoverTemplates) a být klasifikovaná.
 *
 * REGRESE, kterou hlídá:
 *   extract krok konvertoval zipovaný .doc → .docx do input/<tender>/.extracted/.
 *   generate krok (discoverTemplates → discoverInputFiles) ale na začátku maže
 *   .extracted/ a ZIP rozbaluje znovu → konvertovaný .docx zmizel a zůstal jen
 *   originální .doc. discoverTemplates uměl jen .docx/.xls/.xlsx (žádná .doc konverze),
 *   takže smlouvu tiše přeskočil. A protože kupni_smlouva NEMÁ global fallback
 *   (generate-bid.ts), smlouva se NIKDY nevygenerovala. Fix: discoverTemplates teď
 *   sám konvertuje objevené .doc přes sdílené document-parser.convertDocToDocx.
 *
 * Test potřebuje LibreOffice (soffice) — bez něj se přeskočí (žádné selhání), protože
 * .doc→.docx konverze na něm stojí. Produkční Docker image soffice obsahuje.
 *
 * Spuštění (z adresáře scripts/):
 *   npx tsx tests/ingest-zip-doc.test.ts
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, readFile, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';

import { findSoffice, convertDocToDocx } from '../src/lib/document-parser.js';
import { discoverTemplates } from '../src/lib/template-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/tests → worktree root
const REPO_ROOT = join(__dirname, '..', '..');
const SRC_TEMPLATE_DOCX = join(REPO_ROOT, 'templates', 'kryci_list.docx');

const tempDirs: string[] = [];
let passed = 0;
let failed = 0;
let skipped = 0;

class SkipTest extends Error {}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    if (err instanceof SkipTest) {
      skipped++;
      console.log(`↷ ${name} — ${err.message}`);
      return;
    }
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${err instanceof Error ? err.stack : err}`);
  }
}

/** Vytvoří dočasný adresář a zaregistruje ho k úklidu. */
async function mkTemp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vz-ingest-doc-'));
  tempDirs.push(d);
  return d;
}

/**
 * Vyrobí skutečný binární `.doc` soubor konverzí existující .docx šablony přes soffice.
 * Vrací cestu k .doc, nebo null když konverze selže.
 */
function buildDocFixture(soffice: string, workDir: string, docxSource: string, docBaseName: string): string | null {
  const srcCopy = join(workDir, `${docBaseName}.docx`);
  try {
    execFileSync('cp', [docxSource, srcCopy]);
    // .docx → .doc (legacy binární formát) přes LibreOffice
    execFileSync(
      soffice,
      ['--headless', '--convert-to', 'doc', srcCopy, '--outdir', workDir],
      { timeout: 60000, env: { ...process.env, HOME: workDir } }
    );
  } catch (err) {
    console.error(`  [fixture] soffice .docx→.doc selhalo: ${err}`);
    return null;
  }
  const docPath = join(workDir, `${docBaseName}.doc`);
  return docPath;
}

async function main(): Promise<void> {
  const soffice = findSoffice();
  if (!soffice) {
    console.log('⚠ LibreOffice (soffice) nenalezen — .doc konverzní testy přeskočeny.');
    skipped++;
  } else {
    await test('zipovaná .doc kupní smlouva se konvertuje a klasifikuje v discoverTemplates', async () => {
      const workDir = await mkTemp();
      const docPath = buildDocFixture(soffice, workDir, SRC_TEMPLATE_DOCX, 'kupni_smlouva');
      if (!docPath) {
        throw new SkipTest('LibreOffice v tomto prostředí nemůže vytvořit testovací .doc');
      }
      const docBytes = await readFile(docPath);
      assert.ok(docBytes.length > 0, 'fixture .doc je prázdný');

      // Zabal .doc do ZIPu (uvnitř podsložky, jako reálné "ZD komplet.zip").
      const zip = new PizZip();
      zip.file('ZD komplet/kupni_smlouva.doc', docBytes);
      const zipBuf: Buffer = zip.generate({ type: 'nodebuffer' });

      const inputDir = await mkTemp();
      await writeFile(join(inputDir, 'ZD komplet.zip'), zipBuf);

      const templates = await discoverTemplates(inputDir);
      const smlouva = templates.find((t) => t.type === 'kupni_smlouva');
      assert.ok(
        smlouva,
        `kupní smlouva ze zipovaného .doc nebyla objevena (nalezené typy: ${templates.map((t) => t.type).join(', ') || 'žádné'})`
      );
      // Výstup musí být konvertovaný .docx, ne původní .doc.
      assert.ok(
        smlouva!.filename.toLowerCase().endsWith('.docx'),
        `objevená smlouva není .docx: ${smlouva!.filename}`
      );
    });

    await test('convertDocToDocx je idempotentní (druhé volání nekonvertuje znovu)', async () => {
      const workDir = await mkTemp();
      const docPath = buildDocFixture(soffice, workDir, SRC_TEMPLATE_DOCX, 'smlouva2');
      if (!docPath) throw new SkipTest('LibreOffice v tomto prostředí nemůže vytvořit testovací .doc');
      const first = convertDocToDocx(docPath);
      assert.ok(first, 'první konverze selhala');
      const firstBytes = await readFile(first!);
      const second = convertDocToDocx(docPath);
      assert.equal(second, first, 'idempotence: druhé volání vrátilo jinou cestu');
      const secondBytes = await readFile(second!);
      assert.equal(secondBytes.length, firstBytes.length, 'idempotence: soubor se změnil (rekonverze)');
    });
  }

  // Úklid
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
