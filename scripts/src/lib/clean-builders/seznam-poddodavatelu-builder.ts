/**
 * CleanBuilder: Seznam poddodavatelů
 * Deterministické generování — DocumentData → DOCX Buffer.
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
  },
};

const thinBorder = { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA' };
const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
const headerShading = { type: ShadingType.SOLID as const, color: 'F0F0F0', fill: 'F0F0F0' };

export async function buildSeznamPoddodavatelu(data: DocumentData): Promise<Buffer> {
  const headerRow = new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: 'Obchodní firma poddodavatele', bold: true })],
          spacing: { before: 60, after: 60 },
        })],
        width: { size: 35, type: WidthType.PERCENTAGE },
        shading: headerShading,
        borders,
      }),
      new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: 'IČO', bold: true })],
          spacing: { before: 60, after: 60 },
        })],
        width: { size: 15, type: WidthType.PERCENTAGE },
        shading: headerShading,
        borders,
      }),
      new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: 'Část plnění (popis)', bold: true })],
          spacing: { before: 60, after: 60 },
        })],
        width: { size: 35, type: WidthType.PERCENTAGE },
        shading: headerShading,
        borders,
      }),
      new TableCell({
        children: [new Paragraph({
          children: [new TextRun({ text: 'Podíl (%)', bold: true })],
          spacing: { before: 60, after: 60 },
        })],
        width: { size: 15, type: WidthType.PERCENTAGE },
        shading: headerShading,
        borders,
      }),
    ],
  });

  // Prázdný řádek pro případ, že by poddodavatelé byli
  const emptyRow = new TableRow({
    children: [
      new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
      new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
      new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
      new TableCell({ children: [new Paragraph({ text: ' ', spacing: { before: 100, after: 100 } })], borders }),
    ],
  });

  const children = [
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
    new Paragraph({
      children: [new TextRun({ text: data.nazev_zakazky, bold: true })],
      spacing: { after: 200 },
    }),
    new Paragraph({ text: '' }),

    new Paragraph({
      children: [
        new TextRun('Dodavatel '),
        new TextRun({ text: data.nazev, bold: true }),
        new TextRun(', IČO: '),
        new TextRun({ text: data.ico, bold: true }),
        new TextRun(', čestně prohlašuje:'),
      ],
      spacing: { after: 200 },
    }),
    new Paragraph({ text: '' }),

    new Paragraph({
      children: [new TextRun({
        text: 'Veřejnou zakázku budeme plnit vlastními silami bez zapojení poddodavatelů.',
        bold: true,
      })],
      spacing: { after: 200 },
    }),
    new Paragraph({ text: '' }),

    new Paragraph({
      text: 'Pokud jsou zapojeni poddodavatelé, uveďte jejich seznam v následující tabulce:',
      spacing: { after: 100 },
    }),
    new Paragraph({ text: '' }),

    new Table({
      rows: [headerRow, emptyRow],
      width: { size: 100, type: WidthType.PERCENTAGE },
    }),

    new Paragraph({ text: '' }),
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
