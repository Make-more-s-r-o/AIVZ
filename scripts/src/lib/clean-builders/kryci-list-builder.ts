/**
 * CleanBuilder: Krycí list nabídky
 * Deterministické generování — DocumentData → DOCX Buffer.
 * Vzor: generateCenovaNabidka() z template-engine.ts
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
import type { DocumentData } from '../data-resolver.js';

const DOC_STYLES = {
  default: {
    document: { run: { font: 'Calibri', size: 22 } },
    heading1: { run: { font: 'Calibri', size: 32, bold: true } },
    heading2: { run: { font: 'Calibri', size: 28, bold: true } },
  },
};

const thinBorder = { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA' };
const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
const headerShading = { type: ShadingType.SOLID as const, color: 'F0F0F0', fill: 'F0F0F0' };

function labelValueRow(label: string, value: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: label, bold: true })],
          spacing: { before: 60, after: 60 },
        })],
        width: { size: 40, type: WidthType.PERCENTAGE },
        shading: headerShading,
        borders,
      }),
      new TableCell({
        children: [new Paragraph({
          children: [new TextRun(value || '—')],
          spacing: { before: 60, after: 60 },
        })],
        width: { size: 60, type: WidthType.PERCENTAGE },
        borders,
      }),
    ],
  });
}

function formatPrice(n: number): string {
  return n.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function buildKryciList(data: DocumentData): Promise<Buffer> {
  // Sekce A: Identifikace zakázky
  const sectionA: TableRow[] = [
    labelValueRow('Název veřejné zakázky', data.nazev_zakazky),
    labelValueRow('Evidenční číslo zakázky', data.evidencni_cislo),
    labelValueRow('Zadavatel', data.zadavatel_nazev),
  ];
  if (data.zadavatel_ico) {
    sectionA.push(labelValueRow('IČO zadavatele', data.zadavatel_ico));
  }

  // Sekce B: Identifikace uchazeče
  const sectionB: TableRow[] = [
    labelValueRow('Obchodní firma / název', data.nazev),
    labelValueRow('IČO', data.ico),
    labelValueRow('DIČ', data.dic),
    labelValueRow('Sídlo / místo podnikání', data.sidlo),
  ];
  if (data.datova_schranka) {
    sectionB.push(labelValueRow('Datová schránka', data.datova_schranka));
  }
  if (data.rejstrik) {
    sectionB.push(labelValueRow('Zápis v rejstříku', data.rejstrik));
  }
  sectionB.push(
    labelValueRow('Osoba oprávněná jednat', data.jednajici_osoba),
    labelValueRow('Telefon', data.telefon),
    labelValueRow('E-mail', data.email),
  );
  if (data.ucet) {
    sectionB.push(labelValueRow('Bankovní účet', data.ucet));
  }

  // Sekce C: Nabídková cena
  const sectionC: TableRow[] = [
    labelValueRow('Nabídková cena bez DPH (Kč)', formatPrice(data.celkova_cena_bez_dph)),
    labelValueRow(`DPH ${data.dph_sazba} % (Kč)`, formatPrice(data.dph_castka)),
    labelValueRow('Nabídková cena s DPH (Kč)', formatPrice(data.celkova_cena_s_dph)),
  ];

  // Multi-part: doplnit ceny per část
  if (data.casti && data.casti.length > 0) {
    sectionC.push(
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({
              children: [new TextRun({ text: 'Ceny dle částí:', bold: true, italics: true })],
              spacing: { before: 60, after: 60 },
            })],
            width: { size: 100, type: WidthType.PERCENTAGE },
            columnSpan: 2,
            shading: { type: ShadingType.SOLID as const, color: 'E8E8E8', fill: 'E8E8E8' },
            borders,
          }),
        ],
      })
    );
    for (const cast of data.casti) {
      sectionC.push(
        labelValueRow(`${cast.nazev} — bez DPH`, formatPrice(cast.cena_bez_dph)),
        labelValueRow(`${cast.nazev} — s DPH`, formatPrice(cast.cena_s_dph)),
      );
    }
  }

  const children = [
    new Paragraph({
      text: 'KRYCÍ LIST NABÍDKY',
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
    }),
    new Paragraph({ text: '' }),

    // A. Identifikace zakázky
    new Paragraph({
      children: [new TextRun({ text: 'A. IDENTIFIKACE VEŘEJNÉ ZAKÁZKY', bold: true })],
      spacing: { before: 200, after: 100 },
    }),
    new Table({ rows: sectionA, width: { size: 100, type: WidthType.PERCENTAGE } }),
    new Paragraph({ text: '' }),

    // B. Identifikace uchazeče
    new Paragraph({
      children: [new TextRun({ text: 'B. IDENTIFIKACE UCHAZEČE / DODAVATELE', bold: true })],
      spacing: { before: 200, after: 100 },
    }),
    new Table({ rows: sectionB, width: { size: 100, type: WidthType.PERCENTAGE } }),
    new Paragraph({ text: '' }),

    // C. Nabídková cena
    new Paragraph({
      children: [new TextRun({ text: 'C. NABÍDKOVÁ CENA', bold: true })],
      spacing: { before: 200, after: 100 },
    }),
    new Table({ rows: sectionC, width: { size: 100, type: WidthType.PERCENTAGE } }),
    new Paragraph({ text: '' }),

    // Prohlášení
    new Paragraph({
      text: 'Uchazeč tímto prohlašuje, že nabídková cena odpovídá podmínkám zadávací dokumentace a je závazná po celou dobu zadávacího řízení.',
      spacing: { before: 100, after: 100 },
    }),
    new Paragraph({ text: '' }),

    // Podpis
    new Paragraph({
      text: `${data.misto} dne ${data.datum}`,
      spacing: { before: 200, after: 200 },
    }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun('___________________________')] }),
    new Paragraph({ text: data.jednajici_osoba }),
    new Paragraph({ text: 'jednatel' }),
    new Paragraph({ text: data.nazev }),
  ];

  const doc = new Document({
    styles: DOC_STYLES,
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
