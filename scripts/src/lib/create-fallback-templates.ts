/**
 * Creates generic fallback DOCX templates for Czech public procurement.
 * These are used when a tender doesn't include its own template files.
 * Templates use {{}} placeholders filled by docxtemplater (zero AI cost).
 *
 * Run: npx tsx scripts/src/lib/create-fallback-templates.ts
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeadingLevel,
  AlignmentType,
  BorderStyle,
  ShadingType,
} from 'docx';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const ROOT = new URL('../../../', import.meta.url).pathname;
const TEMPLATES_DIR = join(ROOT, 'templates');

const thinBorder = { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA' };
const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
const headerShading = { type: ShadingType.SOLID, color: 'F0F0F0', fill: 'F0F0F0' };

function labelRow(label: string, placeholder: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })], spacing: { before: 60, after: 60 } })],
        width: { size: 40, type: WidthType.PERCENTAGE },
        shading: headerShading,
        borders,
      }),
      new TableCell({
        children: [new Paragraph({ text: `{{${placeholder}}}`, spacing: { before: 60, after: 60 } })],
        width: { size: 60, type: WidthType.PERCENTAGE },
        borders,
      }),
    ],
  });
}

async function createKryciList(): Promise<Buffer> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          text: 'KRYCÍ LIST NABÍDKY',
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({ text: '' }),

        // Tender identification
        new Paragraph({ children: [new TextRun({ text: 'A. IDENTIFIKACE VEŘEJNÉ ZAKÁZKY', bold: true })], spacing: { before: 200, after: 100 } }),
        new Table({
          rows: [
            labelRow('Název veřejné zakázky', 'nazev_zakazky'),
            labelRow('Evidenční číslo zakázky', 'evidencni_cislo'),
            labelRow('Zadavatel', 'zadavatel'),
            labelRow('IČO zadavatele', 'zadavatel_ico'),
          ],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
        new Paragraph({ text: '' }),

        // Supplier identification
        new Paragraph({ children: [new TextRun({ text: 'B. IDENTIFIKACE UCHAZEČE / DODAVATELE', bold: true })], spacing: { before: 200, after: 100 } }),
        new Table({
          rows: [
            labelRow('Obchodní firma / název', 'nazev'),
            labelRow('IČO', 'ico'),
            labelRow('DIČ', 'dic'),
            labelRow('Sídlo / místo podnikání', 'sidlo'),
            labelRow('Datová schránka', 'datova_schranka'),
            labelRow('Zápis v rejstříku', 'rejstrik'),
            labelRow('Osoba oprávněná jednat', 'jednajici_osoba'),
            labelRow('Telefon', 'telefon'),
            labelRow('E-mail', 'email'),
          ],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
        new Paragraph({ text: '' }),

        // Price
        new Paragraph({ children: [new TextRun({ text: 'C. NABÍDKOVÁ CENA', bold: true })], spacing: { before: 200, after: 100 } }),
        new Table({
          rows: [
            labelRow('Nabídková cena bez DPH (Kč)', 'cena_bez_dph'),
            labelRow('DPH 21 % (Kč)', 'dph'),
            labelRow('Nabídková cena s DPH (Kč)', 'cena_s_dph'),
          ],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),
        new Paragraph({ text: '' }),

        // Signature
        new Paragraph({ text: 'Uchazeč tímto prohlašuje, že nabídková cena odpovídá podmínkám zadávací dokumentace a je závazná po celou dobu zadávacího řízení.', spacing: { before: 100, after: 100 } }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: 'V Praze dne {{datum}}', spacing: { before: 200, after: 200 } }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun('___________________________')] }),
        new Paragraph({ text: '{{jednajici_osoba}}' }),
        new Paragraph({ text: 'jednatel' }),
        new Paragraph({ text: '{{nazev}}' }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function createCestneProhlaseni(): Promise<Buffer> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          text: 'ČESTNÉ PROHLÁŠENÍ',
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({
          text: 'o splnění základní způsobilosti a profesní způsobilosti',
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        }),
        new Paragraph({ text: '' }),

        new Paragraph({ text: 'k veřejné zakázce:' }),
        new Paragraph({ children: [new TextRun({ text: '{{nazev_zakazky}}', bold: true })], spacing: { after: 200 } }),
        new Paragraph({ text: '' }),

        new Paragraph({
          children: [
            new TextRun('Já, níže podepsaný/á '),
            new TextRun({ text: '{{jednajici_osoba}}', bold: true }),
            new TextRun(', jednající jménem společnosti '),
            new TextRun({ text: '{{nazev}}', bold: true }),
            new TextRun(', IČO: '),
            new TextRun({ text: '{{ico}}', bold: true }),
            new TextRun(', se sídlem '),
            new TextRun({ text: '{{sidlo}}', bold: true }),
            new TextRun(','),
          ],
          spacing: { after: 100 },
        }),
        new Paragraph({ text: '' }),

        new Paragraph({ text: 'čestně prohlašuji, že výše uvedený dodavatel:' }),
        new Paragraph({ text: '' }),

        new Paragraph({
          children: [new TextRun('a) nebyl v zemi svého sídla v posledních 5 letech před zahájením zadávacího řízení pravomocně odsouzen pro trestný čin uvedený v příloze č. 3 k ZZVZ, nebo došlo k zahlazení odsouzení za takový trestný čin;')],
          bullet: { level: 0 },
          spacing: { before: 80, after: 80 },
        }),
        new Paragraph({
          children: [new TextRun('b) nemá v České republice nebo v zemi svého sídla v evidenci daní zachycen splatný daňový nedoplatek;')],
          bullet: { level: 0 },
          spacing: { before: 80, after: 80 },
        }),
        new Paragraph({
          children: [new TextRun('c) nemá v České republice nebo v zemi svého sídla splatný nedoplatek na pojistném nebo na penále na veřejné zdravotní pojištění;')],
          bullet: { level: 0 },
          spacing: { before: 80, after: 80 },
        }),
        new Paragraph({
          children: [new TextRun('d) nemá v České republice nebo v zemi svého sídla splatný nedoplatek na pojistném nebo na penále na sociální zabezpečení a příspěvku na státní politiku zaměstnanosti;')],
          bullet: { level: 0 },
          spacing: { before: 80, after: 80 },
        }),
        new Paragraph({
          children: [new TextRun('e) není v likvidaci, nebylo proti němu vydáno rozhodnutí o úpadku, nebyla vůči němu nařízena nucená správa nebo není v podobné situaci podle právního řádu země sídla dodavatele;')],
          bullet: { level: 0 },
          spacing: { before: 80, after: 80 },
        }),
        new Paragraph({
          children: [new TextRun('f) je zapsán v obchodním rejstříku nebo jiné obdobné evidenci, je-li takový zápis vyžadován právním řádem země sídla dodavatele;')],
          bullet: { level: 0 },
          spacing: { before: 80, after: 80 },
        }),
        new Paragraph({
          children: [new TextRun('g) je oprávněn podnikat v rozsahu odpovídajícím předmětu veřejné zakázky.')],
          bullet: { level: 0 },
          spacing: { before: 80, after: 80 },
        }),
        new Paragraph({ text: '' }),

        new Paragraph({ text: 'Toto čestné prohlášení vydávám v {{datum}}.', spacing: { before: 200, after: 200 } }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun('___________________________')] }),
        new Paragraph({ text: '{{jednajici_osoba}}' }),
        new Paragraph({ text: 'jednatel' }),
        new Paragraph({ text: '{{nazev}}' }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function createSeznamPoddodavatelu(): Promise<Buffer> {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          text: 'SEZNAM PODDODAVATELŮ',
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({
          text: 'dle § 105 zákona č. 134/2016 Sb., o zadávání veřejných zakázek (ZZVZ)',
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        }),
        new Paragraph({ text: '' }),

        new Paragraph({ text: 'k veřejné zakázce:' }),
        new Paragraph({ children: [new TextRun({ text: '{{nazev_zakazky}}', bold: true })], spacing: { after: 200 } }),
        new Paragraph({ text: '' }),

        new Paragraph({
          children: [
            new TextRun('Dodavatel '),
            new TextRun({ text: '{{nazev}}', bold: true }),
            new TextRun(', IČO: '),
            new TextRun({ text: '{{ico}}', bold: true }),
            new TextRun(', čestně prohlašuje:'),
          ],
          spacing: { after: 200 },
        }),
        new Paragraph({ text: '' }),

        new Paragraph({
          children: [new TextRun({ text: 'Veřejnou zakázku budeme plnit vlastními silami bez zapojení poddodavatelů.', bold: true })],
          spacing: { after: 200 },
        }),
        new Paragraph({ text: '' }),

        new Paragraph({ text: 'Pokud jsou zapojeni poddodavatelé, uveďte jejich seznam v následující tabulce:', spacing: { after: 100 } }),
        new Paragraph({ text: '' }),

        new Table({
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: 'Obchodní firma poddodavatele', bold: true })], spacing: { before: 60, after: 60 } })],
                  width: { size: 35, type: WidthType.PERCENTAGE },
                  shading: headerShading,
                  borders,
                }),
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: 'IČO', bold: true })], spacing: { before: 60, after: 60 } })],
                  width: { size: 15, type: WidthType.PERCENTAGE },
                  shading: headerShading,
                  borders,
                }),
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: 'Část plnění (popis)', bold: true })], spacing: { before: 60, after: 60 } })],
                  width: { size: 35, type: WidthType.PERCENTAGE },
                  shading: headerShading,
                  borders,
                }),
                new TableCell({
                  children: [new Paragraph({ children: [new TextRun({ text: 'Podíl (%)', bold: true })], spacing: { before: 60, after: 60 } })],
                  width: { size: 15, type: WidthType.PERCENTAGE },
                  shading: headerShading,
                  borders,
                }),
              ],
            }),
            // Empty data row
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
                new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
                new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
                new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
              ],
            }),
          ],
          width: { size: 100, type: WidthType.PERCENTAGE },
        }),

        new Paragraph({ text: '' }),
        new Paragraph({ text: 'V Praze dne {{datum}}', spacing: { before: 200, after: 200 } }),
        new Paragraph({ text: '' }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun('___________________________')] }),
        new Paragraph({ text: '{{jednajici_osoba}}' }),
        new Paragraph({ text: 'jednatel' }),
        new Paragraph({ text: '{{nazev}}' }),
      ],
    }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function main() {
  await mkdir(TEMPLATES_DIR, { recursive: true });

  console.log('Creating fallback templates...');

  const kryciList = await createKryciList();
  await writeFile(join(TEMPLATES_DIR, 'kryci_list.docx'), kryciList);
  console.log('  ✓ kryci_list.docx');

  const cestneProhlaseni = await createCestneProhlaseni();
  await writeFile(join(TEMPLATES_DIR, 'cestne_prohlaseni.docx'), cestneProhlaseni);
  console.log('  ✓ cestne_prohlaseni.docx');

  const seznamPoddodavatelu = await createSeznamPoddodavatelu();
  await writeFile(join(TEMPLATES_DIR, 'seznam_poddodavatelu.docx'), seznamPoddodavatelu);
  console.log('  ✓ seznam_poddodavatelu.docx');

  console.log(`\nAll templates created in: ${TEMPLATES_DIR}`);
}

main().catch(err => {
  console.error('Failed to create templates:', err);
  process.exit(1);
});
