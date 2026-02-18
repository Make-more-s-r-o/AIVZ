import { readFile, readdir } from 'fs/promises';
import { basename } from 'path';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { callClaude } from './ai-client.js';
import { TEMPLATE_FILL_SYSTEM, buildTemplateFillUserMessage } from '../prompts/template-fill.js';
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
  LevelFormat,
  convertMillimetersToTwip,
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

// --- Inline formatting helpers ---

/** Parse **bold** markers in text, return TextRun[] */
function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before the bold segment
    if (match.index > lastIndex) {
      runs.push(new TextRun(text.slice(lastIndex, match.index)));
    }
    // Bold segment
    runs.push(new TextRun({ text: match[1], bold: true }));
    lastIndex = regex.lastIndex;
  }
  // Remaining text
  if (lastIndex < text.length) {
    runs.push(new TextRun(text.slice(lastIndex)));
  }
  if (runs.length === 0) {
    runs.push(new TextRun(text));
  }
  return runs;
}

/** Parse consecutive lines starting with | into a Table */
function parseMarkdownTable(lines: string[]): Table {
  // Parse cells from a pipe-delimited line
  const parseCells = (line: string): string[] =>
    line.split('|').slice(1, -1).map((c) => c.trim());

  const headerCells = parseCells(lines[0]);
  // lines[1] is the separator (---|---|---)
  const dataLines = lines.slice(2);

  const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
  const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  const headerRow = new TableRow({
    children: headerCells.map(
      (cell) =>
        new TableCell({
          children: [new Paragraph({ children: parseInlineFormatting(cell), spacing: { before: 40, after: 40 } })],
          shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
          borders,
        })
    ),
  });

  const dataRows = dataLines.map(
    (line) =>
      new TableRow({
        children: parseCells(line).map(
          (cell) =>
            new TableCell({
              children: [new Paragraph({ children: parseInlineFormatting(cell), spacing: { before: 40, after: 40 } })],
              borders,
            })
        ),
      })
  );

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

// --- Document defaults ---

const DOC_STYLES = {
  default: {
    document: {
      run: { font: 'Calibri', size: 22 }, // 11pt
    },
    heading1: {
      run: { font: 'Calibri', size: 32, bold: true }, // 16pt
    },
    heading2: {
      run: { font: 'Calibri', size: 28, bold: true }, // 14pt
    },
    heading3: {
      run: { font: 'Calibri', size: 24, bold: true }, // 12pt
    },
  },
};

const NUMBERING_CONFIG = {
  config: [
    {
      reference: 'numbered-list',
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: convertMillimetersToTwip(10), hanging: convertMillimetersToTwip(5) } } },
        },
      ],
    },
  ],
};

// --- Template filling (docxtemplater) ---

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

// --- AI-powered template filling ---

interface TemplateReplacement {
  original: string;
  replacement: string;
}

interface FillTemplateWithAIResult {
  buffer: Buffer;
  replacements: TemplateReplacement[];
  costCZK: number;
}

/** Strip XML tags to get plain text for AI analysis */
function stripXmlTags(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a flexible regex that matches text even when split across
 * multiple <w:r>...</w:r> XML runs. Each character in the search
 * string can be separated by XML tags.
 */
function buildFlexibleXmlRegex(text: string): RegExp {
  // Between every character, allow optional XML tags (closing + opening runs)
  const chars = [...text].map(escapeRegex);
  const pattern = chars.join('(?:</w:t>(?:\\s*</w:r>\\s*<w:r[^>]*>\\s*(?:<w:rPr>.*?</w:rPr>\\s*)?<w:t[^>]*>)?\\s*)');
  return new RegExp(pattern, 'g');
}

// --- DOCX highlighting helpers ---

// Remaining placeholder patterns that signal "needs manual input"
const UNFILLED_PATTERNS = [
  'doplní účastník', 'doplní uchazeč', 'vyplní účastník', 'vyplní uchazeč',
  '[doplnit]', '[vyplnit]', '[účastník vyplní]',
];
/**
 * Add background shading to the <w:r> run containing the FIRST occurrence
 * of `text` in the XML. Use fillColor as hex (e.g. "FFE0B2" for orange).
 */
function addShadingToRun(xml: string, text: string, fillColor: string): string {
  const idx = xml.indexOf(text);
  if (idx === -1) return xml;

  const shdTag = `<w:shd w:val="clear" w:color="auto" w:fill="${fillColor}"/>`;
  const before = xml.slice(0, idx);

  // Find the closest </w:rPr> before the text (same <w:r>)
  const rprCloseIdx = before.lastIndexOf('</w:rPr>');
  // Find the closest <w:r> opening before the text
  const wrOpenIdx = Math.max(before.lastIndexOf('<w:r>'), before.lastIndexOf('<w:r '));

  if (rprCloseIdx > wrOpenIdx && rprCloseIdx !== -1) {
    // <w:rPr> exists — insert shading before </w:rPr>
    return xml.slice(0, rprCloseIdx) + shdTag + xml.slice(rprCloseIdx);
  } else if (wrOpenIdx !== -1) {
    // No <w:rPr> — create one after <w:r> or <w:r ...>
    const wrEndIdx = xml.indexOf('>', wrOpenIdx) + 1;
    return xml.slice(0, wrEndIdx) + `<w:rPr>${shdTag}</w:rPr>` + xml.slice(wrEndIdx);
  }

  return xml;
}

/**
 * Highlight all AI-filled values (orange) and remaining unfilled placeholders (red).
 */
function applyHighlighting(
  xml: string,
  appliedReplacements: Array<{ replacement: string }>
): string {
  let result = xml;

  // Deduplicate replacement values
  const uniqueReplacements = [...new Set(appliedReplacements.map((r) => r.replacement))];

  // 1. Highlight AI-filled values in orange (#FFE0B2 = light orange)
  for (const replacement of uniqueReplacements) {
    // Safety: skip very short values that could match XML structure
    if (replacement.length < 3) continue;
    const prev = result;
    result = addShadingToRun(result, replacement, 'FFE0B2');
    if (result === prev) continue; // No match found, skip
  }

  // 2. Highlight remaining unfilled placeholders in red (#FFCCCC = light red)
  for (const pattern of UNFILLED_PATTERNS) {
    let safety = 20;
    while (result.includes(pattern) && safety-- > 0) {
      const prev = result;
      result = addShadingToRun(result, pattern, 'FFCCCC');
      if (result === prev) break; // addShadingToRun couldn't modify — stop
    }
  }

  // 3. Highlight underscores/dots patterns in red
  const UNFILLED_RE = /_{3,}|\.{4,}|…{2,}/g;
  let regexMatch: RegExpExecArray | null;
  let safety = 50;
  while ((regexMatch = UNFILLED_RE.exec(result)) !== null && safety-- > 0) {
    const prev = result;
    result = addShadingToRun(result, regexMatch[0], 'FFCCCC');
    if (result === prev) continue; // Can't highlight this one, move on
    UNFILLED_RE.lastIndex = 0; // Reset after XML modification
  }

  return result;
}

/**
 * Check if a template contains {{}} delimiters (docxtemplater-style).
 */
function hasDocxtemplaterTags(xml: string): boolean {
  const plainText = stripXmlTags(xml);
  return /\{\{[^}]+\}\}/.test(plainText);
}

/**
 * Fill a DOCX template using AI to identify and replace free-text placeholders.
 * Falls back to docxtemplater if the template contains {{}} tags.
 */
export async function fillTemplateWithAI(
  templatePath: string,
  companyData: Record<string, string>,
  tenderData: {
    nazev_zakazky: string;
    evidencni_cislo?: string;
    zadavatel?: string;
    zadavatel_ico?: string;
    zadavatel_kontakt?: string;
    cena_bez_dph?: string;
    cena_s_dph?: string;
    dph?: string;
    dph_sazba?: string;
    datum?: string;
    doba_plneni_od?: string;
    doba_plneni_do?: string;
    lhuta_nabidek?: string;
    produkt_nazev?: string;
    produkt_popis?: string;
  }
): Promise<FillTemplateWithAIResult> {
  const content = await readFile(templatePath);
  const zip = new PizZip(content);
  const xml = zip.file('word/document.xml')?.asText();

  if (!xml) {
    throw new Error(`Cannot read word/document.xml from ${templatePath}`);
  }

  // Fallback: if template has {{}} tags, use docxtemplater instead
  if (hasDocxtemplaterTags(xml)) {
    console.log('    Template has {{}} tags — using docxtemplater');
    const data: Record<string, unknown> = { ...companyData, ...tenderData };
    const buf = await fillTemplate(templatePath, data);
    return { buffer: buf, replacements: [], costCZK: 0 };
  }

  // Extract plain text for AI
  const plainText = stripXmlTags(xml);
  const templateName = basename(templatePath);

  // Call AI to identify placeholders
  const result = await callClaude(
    TEMPLATE_FILL_SYSTEM,
    buildTemplateFillUserMessage(plainText, templateName, companyData, tenderData),
    { maxTokens: 4096, temperature: 0.1 }
  );

  // Parse AI response — extract JSON array robustly
  let replacements: TemplateReplacement[];
  try {
    let jsonStr = result.content.trim();
    // Extract JSON from markdown code block if present
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }
    // Fallback: find the first [...] in the response
    if (!jsonStr.startsWith('[')) {
      const bracketStart = jsonStr.indexOf('[');
      const bracketEnd = jsonStr.lastIndexOf(']');
      if (bracketStart !== -1 && bracketEnd > bracketStart) {
        jsonStr = jsonStr.slice(bracketStart, bracketEnd + 1);
      }
    }
    replacements = JSON.parse(jsonStr);
  } catch (err) {
    console.log(`    Warning: Failed to parse AI response as JSON: ${err}`);
    console.log(`    AI response: ${result.content.slice(0, 200)}...`);
    replacements = [];
  }

  // Apply replacements in XML — one at a time (important when multiple
  // placeholders have the same text, e.g. "doplní účastník" appearing 10x)
  let modifiedXml = xml;
  let replacementCount = 0;

  for (const { original, replacement } of replacements) {
    // First try: replace the FIRST occurrence in XML text
    const idx = modifiedXml.indexOf(original);
    if (idx !== -1) {
      modifiedXml = modifiedXml.slice(0, idx) + replacement + modifiedXml.slice(idx + original.length);
      replacementCount++;
      continue;
    }

    // Second try: flexible regex for text split across XML runs
    const flexRegex = buildFlexibleXmlRegex(original);
    const match = flexRegex.exec(modifiedXml);
    if (match) {
      modifiedXml = modifiedXml.slice(0, match.index) + replacement + modifiedXml.slice(match.index + match[0].length);
      replacementCount++;
      continue;
    }

    console.log(`    Warning: Could not find placeholder "${original.slice(0, 50)}..." in XML`);
  }

  // Apply color highlighting:
  // - Orange (#FFE0B2) for AI-filled values → user should review
  // - Red (#FFCCCC) for remaining unfilled placeholders → user must fill
  const appliedReplacements = replacements.slice(0, replacementCount);
  modifiedXml = applyHighlighting(modifiedXml, appliedReplacements);

  // Save modified XML back to ZIP
  zip.file('word/document.xml', modifiedXml);
  const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;

  console.log(`    AI replacements: ${replacementCount}/${replacements.length} applied (highlighted)`);

  return { buffer: buf, replacements, costCZK: result.costCZK };
}

// --- Template discovery ---

export interface DiscoveredTemplate {
  path: string;
  filename: string;
  type: 'kryci_list' | 'cestne_prohlaseni' | 'seznam_poddodavatelu' | 'kupni_smlouva' | 'technicka_specifikace' | 'unknown';
}

const TEMPLATE_PATTERNS: Array<{ type: DiscoveredTemplate['type']; patterns: RegExp[] }> = [
  {
    type: 'kryci_list',
    patterns: [/kryc[ií]\s*list/i, /cover\s*sheet/i],
  },
  {
    type: 'cestne_prohlaseni',
    patterns: [/[čc]estn[ée]\s*prohl[áa][šs]en[ií]/i, /sworn\s*statement/i],
  },
  {
    type: 'seznam_poddodavatelu',
    patterns: [/seznam\s*poddodavatel/i, /subcontractor/i],
  },
  {
    type: 'kupni_smlouva',
    patterns: [/kupn[ií]\s*smlouv/i, /smlouva.*dodávk/i],
  },
  {
    type: 'technicka_specifikace',
    patterns: [/technick[áa]\s*specifikace/i, /tech.*spec/i],
  },
];

/**
 * Scan an input directory and classify DOCX template files by name.
 */
export async function discoverTemplates(inputDir: string): Promise<DiscoveredTemplate[]> {
  const files = await readdir(inputDir);
  const templates: DiscoveredTemplate[] = [];
  const typeCounts = new Map<string, number>();

  for (const filename of files) {
    const lowerFilename = filename.toLowerCase();
    // Support both .docx and .xls/.xlsx templates
    if (!lowerFilename.endsWith('.docx') && !lowerFilename.endsWith('.xls') && !lowerFilename.endsWith('.xlsx')) continue;
    // Skip non-template files (main tender docs that shouldn't be filled)
    if (/obchodn[ií]\s*podm[ií]nky/i.test(filename)) continue;

    let type: DiscoveredTemplate['type'] = 'unknown';
    for (const { type: t, patterns } of TEMPLATE_PATTERNS) {
      if (patterns.some((p) => p.test(filename))) {
        type = t;
        break;
      }
    }

    // Include recognized template types, allow up to 2 per type (e.g. 2× čestné prohlášení)
    if (type !== 'unknown') {
      const count = typeCounts.get(type) || 0;
      if (count < 2) {
        typeCounts.set(type, count + 1);
        templates.push({ path: `${inputDir}/${filename}`, filename, type });
      }
    }
  }

  return templates;
}

// --- Cenová nabídka ---

export async function generateCenovaNabidka(
  analysis: TenderAnalysis,
  product: ProductCandidate,
  company: CompanyProfile,
  bidPriceBezDph?: number,
  bidPriceSdph?: number
): Promise<Buffer> {
  const priceBezDph = bidPriceBezDph ?? product.cena_bez_dph;
  const priceSdph = bidPriceSdph ?? product.cena_s_dph;
  const dph = priceSdph - priceBezDph;

  const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
  const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  const rows = [
    new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Položka', bold: true })] })],
          width: { size: 40, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
          borders,
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Množství', bold: true })] })],
          width: { size: 15, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
          borders,
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Cena bez DPH (Kč)', bold: true })] })],
          width: { size: 22, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
          borders,
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Cena s DPH (Kč)', bold: true })] })],
          width: { size: 23, type: WidthType.PERCENTAGE },
          shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
          borders,
        }),
      ],
    }),
    new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph(`${product.vyrobce} ${product.model}`)],
          borders,
        }),
        new TableCell({
          children: [new Paragraph('1 ks')],
          borders,
        }),
        new TableCell({
          children: [new Paragraph(priceBezDph.toLocaleString('cs-CZ'))],
          borders,
        }),
        new TableCell({
          children: [new Paragraph(priceSdph.toLocaleString('cs-CZ'))],
          borders,
        }),
      ],
    }),
  ];

  const doc = new Document({
    styles: DOC_STYLES,
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
            new TextRun(`${priceBezDph.toLocaleString('cs-CZ')} Kč`),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'DPH 21 %: ', bold: true }),
            new TextRun(`${dph.toLocaleString('cs-CZ')} Kč`),
          ],
        }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Celková nabídková cena s DPH: ', bold: true }),
            new TextRun({ text: `${priceSdph.toLocaleString('cs-CZ')} Kč`, bold: true }),
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

// --- Technický návrh ---

/** Parse AI-generated markdown content into docx elements */
function parseMarkdownContent(content: string): (Paragraph | Table)[] {
  const lines = content.split('\n');
  const elements: (Paragraph | Table)[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line → spacing paragraph
    if (line.trim() === '') {
      elements.push(new Paragraph({ text: '' }));
      i++;
      continue;
    }

    // Headings
    if (line.startsWith('### ')) {
      elements.push(new Paragraph({
        children: parseInlineFormatting(line.slice(4)),
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 200, after: 100 },
      }));
      i++;
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(new Paragraph({
        children: parseInlineFormatting(line.slice(3)),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }));
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      elements.push(new Paragraph({
        children: parseInlineFormatting(line.slice(2)),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 280, after: 140 },
      }));
      i++;
      continue;
    }

    // Markdown table: collect consecutive lines starting with |
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      // Need at least header + separator + 1 data row
      if (tableLines.length >= 3) {
        elements.push(parseMarkdownTable(tableLines));
      } else {
        // Not a proper table, render as plain text
        for (const tl of tableLines) {
          elements.push(new Paragraph({ children: parseInlineFormatting(tl) }));
        }
      }
      continue;
    }

    // Numbered list: 1. / 2. / etc.
    if (/^\d+\.\s/.test(line)) {
      elements.push(new Paragraph({
        children: parseInlineFormatting(line.replace(/^\d+\.\s/, '')),
        numbering: { reference: 'numbered-list', level: 0 },
        spacing: { before: 40, after: 40 },
      }));
      i++;
      continue;
    }

    // Bullet list
    if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(new Paragraph({
        children: parseInlineFormatting(line.slice(2)),
        bullet: { level: 0 },
        spacing: { before: 40, after: 40 },
      }));
      i++;
      continue;
    }

    // Regular paragraph with inline formatting
    elements.push(new Paragraph({
      children: parseInlineFormatting(line),
      spacing: { before: 60, after: 60 },
    }));
    i++;
  }

  return elements;
}

export async function generateTechnickyNavrh(
  analysis: TenderAnalysis,
  product: ProductCandidate,
  company: CompanyProfile,
  aiContent: string
): Promise<Buffer> {
  const contentElements = parseMarkdownContent(aiContent);

  const doc = new Document({
    styles: DOC_STYLES,
    numbering: NUMBERING_CONFIG,
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
        ...contentElements,
        new Paragraph({ text: '' }),
        new Paragraph(`V Praze dne ${new Date().toLocaleDateString('cs-CZ')}`),
        new Paragraph(company.jednajici_osoba),
        new Paragraph(company.nazev),
      ],
    }],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}
