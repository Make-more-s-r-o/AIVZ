import { readFile } from 'fs/promises';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
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
} from 'docx';
import type { TenderAnalysis, ProductCandidate } from './types.js';

interface CompanyProfile {
  nazev: string;
  ico: string;
  dic: string;
  sidlo: string;
  ucet: string;
  iban: string;
  bic: string;
  datova_schranka: string;
  rejstrik: string;
  jednajici_osoba: string;
  telefon: string;
  email: string;
}

export async function fillTemplate(
  templatePath: string,
  data: Record<string, unknown>
): Promise<Buffer> {
  const content = await readFile(templatePath);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: { start: '{{', end: '}}' },
  });

  doc.render(data);

  const buf = doc.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  return buf as Buffer;
}

export async function generateCenovaNabidka(
  analysis: TenderAnalysis,
  product: ProductCandidate,
  company: CompanyProfile
): Promise<Buffer> {
  const rows = [
    new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Položka', bold: true })] })],
          width: { size: 40, type: WidthType.PERCENTAGE },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Množství', bold: true })] })],
          width: { size: 15, type: WidthType.PERCENTAGE },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Cena bez DPH (Kč)', bold: true })] })],
          width: { size: 22, type: WidthType.PERCENTAGE },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Cena s DPH (Kč)', bold: true })] })],
          width: { size: 23, type: WidthType.PERCENTAGE },
        }),
      ],
    }),
    new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph(`${product.vyrobce} ${product.model}`)],
        }),
        new TableCell({
          children: [new Paragraph('1 ks')],
        }),
        new TableCell({
          children: [new Paragraph(product.cena_bez_dph.toLocaleString('cs-CZ'))],
        }),
        new TableCell({
          children: [new Paragraph(product.cena_s_dph.toLocaleString('cs-CZ'))],
        }),
      ],
    }),
  ];

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          text: 'CENOVÁ NABÍDKA',
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({ text: '' }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Veřejná zakázka: ', bold: true }),
            new TextRun(analysis.zakazka.nazev),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Uchazeč: ', bold: true }),
            new TextRun(company.nazev),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'IČO: ', bold: true }),
            new TextRun(company.ico),
          ],
        }),
        new Paragraph({ text: '' }),
        new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }),
        new Paragraph({ text: '' }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Celková nabídková cena bez DPH: ', bold: true }),
            new TextRun(`${product.cena_bez_dph.toLocaleString('cs-CZ')} Kč`),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'DPH 21 %: ', bold: true }),
            new TextRun(`${(product.cena_s_dph - product.cena_bez_dph).toLocaleString('cs-CZ')} Kč`),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Celková nabídková cena s DPH: ', bold: true }),
            new TextRun({ text: `${product.cena_s_dph.toLocaleString('cs-CZ')} Kč`, bold: true }),
          ],
        }),
        new Paragraph({ text: '' }),
        new Paragraph(`V Praze dne ${new Date().toLocaleDateString('cs-CZ')}`),
        new Paragraph({ text: '' }),
        new Paragraph(company.jednajici_osoba),
        new Paragraph(company.nazev),
      ],
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

export async function generateTechnickyNavrh(
  analysis: TenderAnalysis,
  product: ProductCandidate,
  company: CompanyProfile,
  aiContent: string
): Promise<Buffer> {
  const paragraphs = aiContent.split('\n').filter(Boolean).map((text) => {
    if (text.startsWith('# ')) {
      return new Paragraph({
        text: text.replace('# ', ''),
        heading: HeadingLevel.HEADING_1,
      });
    }
    if (text.startsWith('## ')) {
      return new Paragraph({
        text: text.replace('## ', ''),
        heading: HeadingLevel.HEADING_2,
      });
    }
    if (text.startsWith('### ')) {
      return new Paragraph({
        text: text.replace('### ', ''),
        heading: HeadingLevel.HEADING_3,
      });
    }
    if (text.startsWith('- ')) {
      return new Paragraph({
        text: text.replace('- ', ''),
        bullet: { level: 0 },
      });
    }
    return new Paragraph({ text });
  });

  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          text: 'TECHNICKÝ NÁVRH',
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
        }),
        new Paragraph({ text: '' }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Veřejná zakázka: ', bold: true }),
            new TextRun(analysis.zakazka.nazev),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Uchazeč: ', bold: true }),
            new TextRun(company.nazev),
          ],
        }),
        new Paragraph({ text: '' }),
        ...paragraphs,
        new Paragraph({ text: '' }),
        new Paragraph(`V Praze dne ${new Date().toLocaleDateString('cs-CZ')}`),
        new Paragraph(company.jednajici_osoba),
        new Paragraph(company.nazev),
      ],
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
