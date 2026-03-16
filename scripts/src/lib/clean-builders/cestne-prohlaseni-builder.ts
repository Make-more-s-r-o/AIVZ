/**
 * CleanBuilder: Čestné prohlášení
 * Deterministické generování — DocumentData → DOCX Buffer.
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx';
import type { DocumentData } from '../data-resolver.js';

const DOC_STYLES = {
  default: {
    document: { run: { font: 'Calibri', size: 22 } },
    heading1: { run: { font: 'Calibri', size: 32, bold: true } },
  },
};

const PROHLASENI_BODY = [
  'a) nebyl v zemi svého sídla v posledních 5 letech před zahájením zadávacího řízení pravomocně odsouzen pro trestný čin uvedený v příloze č. 3 k ZZVZ, nebo došlo k zahlazení odsouzení za takový trestný čin;',
  'b) nemá v České republice nebo v zemi svého sídla v evidenci daní zachycen splatný daňový nedoplatek;',
  'c) nemá v České republice nebo v zemi svého sídla splatný nedoplatek na pojistném nebo na penále na veřejné zdravotní pojištění;',
  'd) nemá v České republice nebo v zemi svého sídla splatný nedoplatek na pojistném nebo na penále na sociální zabezpečení a příspěvku na státní politiku zaměstnanosti;',
  'e) není v likvidaci, nebylo proti němu vydáno rozhodnutí o úpadku, nebyla vůči němu nařízena nucená správa nebo není v podobné situaci podle právního řádu země sídla dodavatele;',
  'f) je zapsán v obchodním rejstříku nebo jiné obdobné evidenci, je-li takový zápis vyžadován právním řádem země sídla dodavatele;',
  'g) je oprávněn podnikat v rozsahu odpovídajícím předmětu veřejné zakázky.',
];

export async function buildCestneProhlaseni(data: DocumentData): Promise<Buffer> {
  const children = [
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
    new Paragraph({
      children: [new TextRun({ text: data.nazev_zakazky, bold: true })],
      spacing: { after: 200 },
    }),
    new Paragraph({ text: '' }),

    // Identifikace — inline s daty
    new Paragraph({
      children: [
        new TextRun('Já, níže podepsaný/á '),
        new TextRun({ text: data.jednajici_osoba, bold: true }),
        new TextRun(', jednající jménem společnosti '),
        new TextRun({ text: data.nazev, bold: true }),
        new TextRun(', IČO: '),
        new TextRun({ text: data.ico, bold: true }),
        new TextRun(', se sídlem '),
        new TextRun({ text: data.sidlo, bold: true }),
        new TextRun(','),
      ],
      spacing: { after: 100 },
    }),
    new Paragraph({ text: '' }),

    new Paragraph({ text: 'čestně prohlašuji, že výše uvedený dodavatel:' }),
    new Paragraph({ text: '' }),

    // Body prohlášení
    ...PROHLASENI_BODY.map(text => new Paragraph({
      children: [new TextRun(text)],
      bullet: { level: 0 },
      spacing: { before: 80, after: 80 },
    })),

    new Paragraph({ text: '' }),

    new Paragraph({
      text: `Toto čestné prohlášení vydávám ${data.misto} dne ${data.datum}.`,
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
