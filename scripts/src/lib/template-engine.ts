import { readFile, readdir, writeFile as fsWriteFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
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
import { parseDocx, parseExcel } from './document-parser.js';
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

type ReplacementStrategy =
  | 'exact-paragraph'
  | 'normalized'
  | 'multi-paragraph'
  | 'fuzzy'
  | 'label-deterministic'
  | 'xml-entity'
  | 'legacy-indexOf'
  | 'legacy-flexRegex'
  | 'legacy-proximity'
  | 'retry-pass'
  | 'not-found';

interface TemplateReplacement {
  original: string;
  replacement: string;
  strategy?: ReplacementStrategy;
}

interface FillTemplateWithAIResult {
  buffer: Buffer;
  replacements: TemplateReplacement[];
  costCZK: number;
}

// --- Known Czech label → company data field mapping for deterministic replacement ---
const CZECH_LABEL_MAP: Array<{ labels: RegExp[]; field: string }> = [
  { labels: [/^i[čc]o?\s*(?:dodavatele|uchazeče|účastníka)?:?\s*$/i, /^i\.?\s*[čc]\.?\s*(?:dodavatele|uchazeče)?:?\s*$/i], field: 'ico' },
  { labels: [/^di[čc]\s*(?:dodavatele|uchazeče|účastníka)?:?\s*$/i, /^d\.?\s*i\.?\s*[čc]\.?:?\s*$/i], field: 'dic' },
  { labels: [/^s[ií]dlo\s*(?:dodavatele|uchazeče|firmy|účastníka|společnosti)?:?\s*$/i, /^adresa\s*s[ií]dla:?\s*$/i], field: 'sidlo' },
  { labels: [/^obchodn[ií]\s*(?:firma|název|jméno)\s*(?:\(jméno\))?:?\s*$/i, /^název\s*(?:dodavatele|uchazeče|firmy|účastníka|společnosti):?\s*$/i, /^firma:?\s*$/i], field: 'nazev' },
  { labels: [/^(?:jednaj[ií]c[ií]\s*osob[ay]|jednatel|statutární\s*zástupce|osoba\s*oprávněná\s*jednat):?\s*$/i], field: 'jednajici_osoba' },
  { labels: [/^telefon:?\s*$/i, /^tel\.?:?\s*$/i, /^kontaktn[ií]\s*telefon:?\s*$/i], field: 'telefon' },
  { labels: [/^e-?mail:?\s*$/i, /^elektronická\s*pošta:?\s*$/i, /^kontaktn[ií]\s*e-?mail:?\s*$/i], field: 'email' },
  { labels: [/^(?:číslo\s*)?(?:bankovn[ií]\s*)?[úu](?:čtu|čet):?\s*$/i], field: 'ucet' },
  { labels: [/^iban:?\s*$/i], field: 'iban' },
  { labels: [/^(?:swift|bic):?\s*$/i], field: 'bic' },
  { labels: [/^datov[áa]\s*schr[áa]nka:?\s*$/i, /^id\s*datov[ée]\s*schr[áa]nky:?\s*$/i], field: 'datova_schranka' },
  { labels: [/^z[áa]pis\s*v\s*(?:obchodn[ií]m\s*)?rejst[řr][ií]ku:?\s*$/i, /^rejst[řr][ií]k:?\s*$/i, /^spisov[áa]\s*značka:?\s*$/i], field: 'rejstrik' },
];

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

// --- Paragraph map for reliable XML ↔ plain text mapping ---

interface TextNodeInfo {
  start: number;    // offset in the paragraph's plainText
  end: number;      // offset in the paragraph's plainText
  xmlStart: number; // position of text content start in original XML
  xmlEnd: number;   // position of text content end in original XML
}

interface ParagraphInfo {
  plainText: string;
  textNodes: TextNodeInfo[];
  xmlStart: number; // <w:p> start position in XML
  xmlEnd: number;   // </w:p> end position in XML
}

/**
 * Build a map of paragraphs with their plain text and XML offset information.
 * This allows mapping a substring found in plain text back to exact XML positions,
 * even when text is split across multiple <w:r> runs.
 */
function buildParagraphMap(xml: string): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = [];
  const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let paraMatch: RegExpExecArray | null;

  while ((paraMatch = paraRegex.exec(xml)) !== null) {
    const paraXml = paraMatch[0];
    const paraXmlStart = paraMatch.index;
    const paraXmlEnd = paraMatch.index + paraMatch[0].length;

    // Find all <w:t ...>text</w:t> within this paragraph
    const textNodes: TextNodeInfo[] = [];
    let plainText = '';
    const textRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let textMatch: RegExpExecArray | null;

    while ((textMatch = textRegex.exec(paraXml)) !== null) {
      const rawText = textMatch[1];
      // Decode XML entities for plain text
      const decoded = rawText
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

      const textContentStart = paraXmlStart + textMatch.index + textMatch[0].indexOf('>') + 1;
      // The text content end is right before </w:t>
      const textContentEnd = textContentStart + rawText.length;

      textNodes.push({
        start: plainText.length,
        end: plainText.length + decoded.length,
        xmlStart: textContentStart,
        xmlEnd: textContentEnd,
      });

      plainText += decoded;
    }

    paragraphs.push({ plainText, textNodes, xmlStart: paraXmlStart, xmlEnd: paraXmlEnd });
  }

  return paragraphs;
}

/**
 * Given a paragraph and a substring match (start/end offsets in plainText),
 * replace that substring in the original XML, handling text that spans multiple
 * <w:t> nodes. Returns the new XML string with the replacement applied.
 */
function replaceInXmlViaParagraphMap(
  xml: string,
  paragraph: ParagraphInfo,
  matchStart: number,
  matchEnd: number,
  replacement: string
): string {
  // Find all text nodes that overlap with our match range
  const overlapping = paragraph.textNodes.filter(
    (tn) => tn.start < matchEnd && tn.end > matchStart
  );

  if (overlapping.length === 0) return xml;

  // Simple case: match is within a single text node
  if (overlapping.length === 1) {
    const tn = overlapping[0];
    const offsetInNode = matchStart - tn.start;
    const lengthInNode = matchEnd - matchStart;

    // Encode replacement for XML context
    const xmlReplacement = replacement
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    // Calculate XML positions within the text node content
    // We need to find the raw (XML-encoded) text that corresponds to our plain text range
    const nodeRawText = xml.slice(tn.xmlStart, tn.xmlEnd);

    // Map plain text offset to raw XML offset within the node
    const rawStart = mapDecodedOffsetToRaw(nodeRawText, offsetInNode);
    const rawEnd = mapDecodedOffsetToRaw(nodeRawText, offsetInNode + lengthInNode);

    const xmlPos = tn.xmlStart + rawStart;
    const xmlEndPos = tn.xmlStart + rawEnd;

    return xml.slice(0, xmlPos) + xmlReplacement + xml.slice(xmlEndPos);
  }

  // Complex case: match spans multiple text nodes
  // Strategy: put the full replacement in the first node, clear the matched portions of subsequent nodes
  const xmlReplacement = replacement
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Work backwards through overlapping nodes to avoid offset corruption
  let result = xml;
  for (let i = overlapping.length - 1; i >= 0; i--) {
    const tn = overlapping[i];
    const overlapStart = Math.max(matchStart, tn.start);
    const overlapEnd = Math.min(matchEnd, tn.end);
    const offsetInNode = overlapStart - tn.start;
    const lengthInNode = overlapEnd - overlapStart;

    const nodeRawText = result.slice(tn.xmlStart, tn.xmlEnd);
    const rawStart = mapDecodedOffsetToRaw(nodeRawText, offsetInNode);
    const rawEnd = mapDecodedOffsetToRaw(nodeRawText, offsetInNode + lengthInNode);

    const xmlPos = tn.xmlStart + rawStart;
    const xmlEndPos = tn.xmlStart + rawEnd;

    if (i === 0) {
      // First overlapping node: insert the replacement
      result = result.slice(0, xmlPos) + xmlReplacement + result.slice(xmlEndPos);
    } else {
      // Subsequent nodes: just remove the overlapping portion
      result = result.slice(0, xmlPos) + result.slice(xmlEndPos);
    }
  }

  return result;
}

/**
 * Map a character offset in decoded text back to the raw XML-encoded text offset.
 * Handles XML entities like &amp; &lt; &gt; &quot; &apos;
 */
function mapDecodedOffsetToRaw(rawText: string, decodedOffset: number): number {
  let decoded = 0;
  let raw = 0;

  while (decoded < decodedOffset && raw < rawText.length) {
    if (rawText[raw] === '&') {
      // Check for XML entities
      const remaining = rawText.slice(raw);
      if (remaining.startsWith('&amp;')) { raw += 5; decoded++; continue; }
      if (remaining.startsWith('&lt;')) { raw += 4; decoded++; continue; }
      if (remaining.startsWith('&gt;')) { raw += 4; decoded++; continue; }
      if (remaining.startsWith('&quot;')) { raw += 6; decoded++; continue; }
      if (remaining.startsWith('&apos;')) { raw += 6; decoded++; continue; }
    }
    raw++;
    decoded++;
  }

  return raw;
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

/**
 * Find longest common prefix of two strings.
 */
function longestCommonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/**
 * Find longest common suffix of two strings.
 */
function longestCommonSuffix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return a.slice(a.length - i);
}

/**
 * Normalize <w:rPr> inner content for comparison.
 * Strips elements that don't affect visual formatting (language hints, spell check, etc.).
 */
function normalizeRPr(rPr: string): string {
  return rPr
    // Language hints — don't affect rendering
    .replace(/<w:lang[^/]*\/>/g, '')
    // Spell/grammar check markers
    .replace(/<w:rPrChange[^>]*>[\s\S]*?<\/w:rPrChange>/g, '')
    // No-spell-check hint
    .replace(/<w:noProof\/>/g, '')
    // Revision tracking artifacts
    .replace(/<w:rsid[A-Za-z]*="[^"]*"\/>/g, '')
    // Same-value redundant font hints (often Word adds these even when default font is set)
    .replace(/<w:rFonts\s+w:ascii="Calibri"\s+w:hAnsi="Calibri"\/>/g, '')
    .replace(/<w:rFonts\s+w:eastAsia="[^"]*"\/>/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Merge adjacent <w:r> runs with the same formatting within each <w:p> paragraph.
 * Word often splits text across multiple runs (due to spell-check, revision tracking,
 * or editing history), making placeholder text like "doplní účastník" impossible
 * to find via simple indexOf(). This function consolidates those split runs.
 */
function mergeRunsInParagraphs(xml: string): string {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (para) => {
    interface Segment {
      type: 'run' | 'other';
      content: string;
      rPr: string;
      rPrRaw: string;
      text: string;
    }

    const segments: Segment[] = [];
    const runRegex = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = runRegex.exec(para)) !== null) {
      if (match.index > lastIndex) {
        segments.push({
          type: 'other',
          content: para.slice(lastIndex, match.index),
          rPr: '', rPrRaw: '', text: '',
        });
      }

      const runBody = match[1];
      const rPrMatch = runBody.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
      const rPrRaw = rPrMatch ? rPrMatch[1] : '';
      const rPr = normalizeRPr(rPrRaw);
      const textMatch = runBody.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/);
      const text = textMatch ? textMatch[1] : '';
      // Only merge pure text runs — skip tabs, breaks, images, fields, etc.
      const isTextOnly = !/<w:(tab|br|cr|sym|drawing|pict|fldChar|instrText|lastRenderedPageBreak)\b/.test(runBody);

      if (isTextOnly && text) {
        segments.push({ type: 'run', content: match[0], rPr, rPrRaw, text });
      } else {
        segments.push({ type: 'other', content: match[0], rPr: '', rPrRaw: '', text: '' });
      }

      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < para.length) {
      segments.push({
        type: 'other',
        content: para.slice(lastIndex),
        rPr: '', rPrRaw: '', text: '',
      });
    }

    // Need at least 2 runs to merge
    if (segments.filter(s => s.type === 'run').length < 2) return para;

    // Pattern for ignorable content between runs (proofErr, bookmarks, whitespace)
    const IGNORABLE_RE = /^(<w:proofErr[^>]*\/?>|<w:bookmarkStart[^>]*\/?>|<w:bookmarkEnd[^>]*\/?>|\s)*$/;

    /**
     * Look backwards from the end of merged[] to find a run that is separated
     * from the current position only by a chain of ignorable 'other' segments.
     * Returns the index of the run in merged[], or -1 if not found.
     */
    function findRunThroughIgnorableChain(merged: Segment[]): number {
      // Walk backwards through merged, skipping ignorable 'other' segments
      for (let k = merged.length - 1; k >= 0; k--) {
        if (merged[k].type === 'run') return k;
        if (merged[k].type === 'other' && IGNORABLE_RE.test(merged[k].content.trim())) {
          continue; // ignorable, keep looking back
        }
        return -1; // non-ignorable 'other' — stop
      }
      return -1;
    }

    const merged: Segment[] = [];
    for (const seg of segments) {
      if (seg.type === 'run' && merged.length > 0) {
        const prev = merged[merged.length - 1];

        // Case 1: directly adjacent runs with same formatting
        if (prev.type === 'run' && prev.rPr === seg.rPr) {
          prev.text += seg.text;
          const rPrTag = prev.rPrRaw ? `<w:rPr>${prev.rPrRaw}</w:rPr>` : '';
          prev.content = `<w:r>${rPrTag}<w:t xml:space="preserve">${prev.text}</w:t></w:r>`;
          continue;
        }

        // Case 2: directly adjacent runs with DIFFERENT formatting — merge text for
        // placeholder detection (keep first run's formatting). This handles cases where
        // Word splits "doplní účastník" across bold/normal runs.
        if (prev.type === 'run' && prev.rPr !== seg.rPr) {
          prev.text += seg.text;
          const rPrTag = prev.rPrRaw ? `<w:rPr>${prev.rPrRaw}</w:rPr>` : '';
          prev.content = `<w:r>${rPrTag}<w:t xml:space="preserve">${prev.text}</w:t></w:r>`;
          continue;
        }

        // Case 3+4: separated by a CHAIN of ignorable content (proofErr, bookmarks, whitespace).
        // Handles both same and different formatting — merges runs separated by one or more
        // ignorable elements like: run → proofErr → bookmarkStart → bookmarkEnd → run
        if (prev.type === 'other') {
          const runIdx = findRunThroughIgnorableChain(merged);
          if (runIdx >= 0) {
            const prevRun = merged[runIdx];
            // Merge text into the earlier run (keep its formatting)
            prevRun.text += seg.text;
            const rPrTag = prevRun.rPrRaw ? `<w:rPr>${prevRun.rPrRaw}</w:rPr>` : '';
            prevRun.content = `<w:r>${rPrTag}<w:t xml:space="preserve">${prevRun.text}</w:t></w:r>`;
            // Remove all ignorable segments between the run and current position
            merged.splice(runIdx + 1);
            continue;
          }
        }
      }

      merged.push({ ...seg });
    }

    return merged.map(s => s.content).join('');
  });
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

// --- Replacement strategy helpers ---

/**
 * Normalize text for fuzzy matching: collapse whitespace, lowercase, strip entities.
 */
function normalizeText(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize text into words for fuzzy matching.
 */
function tokenize(text: string): string[] {
  return normalizeText(text).toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Calculate token overlap ratio between two texts.
 */
function tokenOverlap(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = new Set(tokenize(b));
  if (tokensA.length === 0) return 0;
  let matches = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) matches++;
  }
  return matches / tokensA.length;
}

/**
 * Try to find and apply a label→data deterministic replacement.
 * Looks for known Czech labels (IČO:, DIČ:, etc.) in the paragraph text,
 * and if the value after the label is a placeholder, replaces it with company data.
 */
function tryLabelDeterministicReplacement(
  xml: string,
  paragraphMap: ParagraphInfo[],
  companyData: Record<string, string>,
  original: string,
  replacement: string
): { xml: string; success: boolean } {
  // Try to find a label in the original text
  for (const { labels, field } of CZECH_LABEL_MAP) {
    const value = companyData[field];
    if (!value) continue;

    for (const labelRe of labels) {
      // Check if original contains this label pattern
      // Extract label prefix from original (everything before the placeholder)
      const parts = original.split(/(?:doplní\s*(?:účastník|uchazeč)|vyplní\s*(?:účastník|uchazeč)|\[doplnit\]|\[vyplnit\]|_{3,}|\.{4,}|…{2,})/i);
      if (parts.length < 2) continue;
      const labelPart = parts[0].trim();
      if (!labelRe.test(labelPart)) continue;

      // Found a matching label. Look for it in paragraphs.
      for (const para of paragraphMap) {
        const paraLower = para.plainText.toLowerCase();
        const labelMatch = paraLower.match(new RegExp(labelRe.source, 'i'));
        if (!labelMatch) continue;

        // Found the label in this paragraph. Find the placeholder after it.
        const labelEndIdx = (paraLower.indexOf(labelMatch[0]) ?? 0) + labelMatch[0].length;
        const afterLabel = para.plainText.slice(labelEndIdx);

        // Match common placeholder patterns after the label
        const phMatch = afterLabel.match(/^\s*(doplní\s*(?:účastník|uchazeč)|vyplní\s*(?:účastník|uchazeč)|\[doplnit\]|\[vyplnit\]|_{3,}|\.{4,}|…{2,})/i);
        if (phMatch) {
          const phStart = labelEndIdx + (phMatch.index ?? 0);
          const phEnd = phStart + phMatch[0].length;
          const newXml = replaceInXmlViaParagraphMap(xml, para, phStart, phEnd, value);
          if (newXml !== xml) {
            return { xml: newXml, success: true };
          }
        }
      }
    }
  }
  return { xml, success: false };
}

/**
 * Parse AI JSON response robustly, handling markdown code blocks and other wrappers.
 */
function parseAIReplacements(content: string): TemplateReplacement[] {
  let jsonStr = content.trim();
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
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Attempt repair: fix common AI JSON issues
    // 1. Remove control characters inside strings (newlines, tabs)
    const repaired = jsonStr
      .replace(/(?<=:\s*"[^"]*)\n/g, '\\n')   // unescaped newlines inside strings
      .replace(/(?<=:\s*"[^"]*)\t/g, '\\t')   // unescaped tabs
      .replace(/,\s*([}\]])/g, '$1');          // trailing commas
    try {
      return JSON.parse(repaired);
    } catch {
      // 2. Try extracting individual objects with regex
      const items: TemplateReplacement[] = [];
      const objRegex = /\{\s*"original"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"replacement"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
      let m: RegExpExecArray | null;
      while ((m = objRegex.exec(jsonStr)) !== null) {
        items.push({
          original: m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
          replacement: m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
        });
      }
      if (items.length > 0) {
        console.log(`    JSON repair: extracted ${items.length} replacements via regex`);
        return items;
      }
      throw new Error('Cannot parse AI response as JSON');
    }
  }
}

/**
 * Apply a single replacement using the 6-strategy pipeline.
 * Returns the modified XML and the strategy that succeeded.
 */
function applyReplacementWithStrategies(
  xml: string,
  paragraphMap: ParagraphInfo[],
  original: string,
  replacement: string,
  companyData: Record<string, string>
): { xml: string; strategy: ReplacementStrategy; appliedReplacement: string } {
  // Strategy 1: Exact paragraph match
  // Find the original text within a single paragraph's plainText, then replace via XML offsets
  for (const para of paragraphMap) {
    const idx = para.plainText.indexOf(original);
    if (idx !== -1) {
      const newXml = replaceInXmlViaParagraphMap(xml, para, idx, idx + original.length, replacement);
      if (newXml !== xml) {
        return { xml: newXml, strategy: 'exact-paragraph', appliedReplacement: replacement };
      }
    }
  }

  // Strategy 2: Normalized match
  // Normalize whitespace and entities in both the original and paragraph text, then match
  const normOriginal = normalizeText(original);
  for (const para of paragraphMap) {
    const normPara = normalizeText(para.plainText);
    const idx = normPara.indexOf(normOriginal);
    if (idx !== -1) {
      // Map the normalized offset back to the paragraph's raw plainText offset
      // This is approximate — find the best match window in the raw text
      let bestStart = -1;
      let bestLen = 0;
      for (let start = 0; start <= para.plainText.length - 1; start++) {
        for (let end = start + 1; end <= para.plainText.length; end++) {
          const candidate = normalizeText(para.plainText.slice(start, end));
          if (candidate === normOriginal) {
            bestStart = start;
            bestLen = end - start;
            break;
          }
        }
        if (bestStart >= 0) break;
      }
      if (bestStart >= 0) {
        const newXml = replaceInXmlViaParagraphMap(xml, para, bestStart, bestStart + bestLen, replacement);
        if (newXml !== xml) {
          return { xml: newXml, strategy: 'normalized', appliedReplacement: replacement };
        }
      }
    }
  }

  // Strategy 3: Multi-paragraph match
  // If original spans 2+ paragraphs (contains \n or looks like multi-line), match across adjacent paragraphs
  if (original.includes('\n') || original.includes('\r')) {
    const origLines = original.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    if (origLines.length >= 2) {
      for (let i = 0; i <= paragraphMap.length - origLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < origLines.length; j++) {
          if (!paragraphMap[i + j].plainText.includes(origLines[j])) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          // Extract the changed part: diff original vs replacement to find what changed
          const commonPre = longestCommonPrefix(original, replacement);
          const remainOrig = original.slice(commonPre.length);
          const remainRepl = replacement.slice(commonPre.length);
          const commonSuf = longestCommonSuffix(remainOrig, remainRepl);
          const oldPart = remainOrig.slice(0, remainOrig.length - commonSuf.length);
          const newPart = remainRepl.slice(0, remainRepl.length - commonSuf.length);

          if (oldPart.length >= 2) {
            // Find oldPart in one of the matched paragraphs
            for (let j = 0; j < origLines.length; j++) {
              const para = paragraphMap[i + j];
              const phIdx = para.plainText.indexOf(oldPart);
              if (phIdx !== -1) {
                const newXml = replaceInXmlViaParagraphMap(xml, para, phIdx, phIdx + oldPart.length, newPart);
                if (newXml !== xml) {
                  return { xml: newXml, strategy: 'multi-paragraph', appliedReplacement: newPart };
                }
              }
            }
          }
        }
      }
    }
  }

  // Strategy 4: Fuzzy match
  // Tokenize original, find paragraph with >=80% token overlap, then do replacement
  if (original.length >= 5) {
    let bestPara: ParagraphInfo | null = null;
    let bestOverlap = 0;
    for (const para of paragraphMap) {
      if (para.plainText.length < 3) continue;
      const overlap = tokenOverlap(original, para.plainText);
      if (overlap > bestOverlap && overlap >= 0.8) {
        bestOverlap = overlap;
        bestPara = para;
      }
    }
    if (bestPara) {
      // Extract the changed part
      const commonPre = longestCommonPrefix(original, replacement);
      const remainOrig = original.slice(commonPre.length);
      const remainRepl = replacement.slice(commonPre.length);
      const commonSuf = longestCommonSuffix(remainOrig, remainRepl);
      const oldPart = remainOrig.slice(0, remainOrig.length - commonSuf.length);
      const newPart = remainRepl.slice(0, remainRepl.length - commonSuf.length);

      if (oldPart.length >= 2) {
        const phIdx = bestPara.plainText.indexOf(oldPart);
        if (phIdx !== -1) {
          const newXml = replaceInXmlViaParagraphMap(xml, bestPara, phIdx, phIdx + oldPart.length, newPart);
          if (newXml !== xml) {
            return { xml: newXml, strategy: 'fuzzy', appliedReplacement: newPart };
          }
        }
      } else {
        // oldPart is the same as original (no common prefix/suffix) — try full match
        const phIdx = bestPara.plainText.indexOf(original);
        if (phIdx !== -1) {
          const newXml = replaceInXmlViaParagraphMap(xml, bestPara, phIdx, phIdx + original.length, replacement);
          if (newXml !== xml) {
            return { xml: newXml, strategy: 'fuzzy', appliedReplacement: replacement };
          }
        }
      }
    }
  }

  // Strategy 5: Label→data deterministic mapping
  // For known labels like "IČO:", "DIČ:", "Sídlo:", find the label in paragraphs
  // and replace the placeholder text after it
  const labelResult = tryLabelDeterministicReplacement(xml, paragraphMap, companyData, original, replacement);
  if (labelResult.success) {
    return { xml: labelResult.xml, strategy: 'label-deterministic', appliedReplacement: replacement };
  }

  // Strategy 6: XML entity match
  // Try with &amp; etc. encoding — direct indexOf on the XML string
  const xmlEncoded = original
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  if (xmlEncoded !== original) {
    const idx = xml.indexOf(xmlEncoded);
    if (idx !== -1) {
      const newXml = xml.slice(0, idx) + replacement + xml.slice(idx + xmlEncoded.length);
      return { xml: newXml, strategy: 'xml-entity', appliedReplacement: replacement };
    }
  }

  // Fallback: legacy direct indexOf on XML (handles cases where text appears directly in XML)
  const directIdx = xml.indexOf(original);
  if (directIdx !== -1) {
    const newXml = xml.slice(0, directIdx) + replacement + xml.slice(directIdx + original.length);
    return { xml: newXml, strategy: 'legacy-indexOf', appliedReplacement: replacement };
  }

  // Fallback: legacy flexible regex for text split across XML runs (shouldn't be needed after merge, but safety net)
  if (original.length <= 200) {
    const flexRegex = buildFlexibleXmlRegex(original);
    const match = flexRegex.exec(xml);
    if (match) {
      const newXml = xml.slice(0, match.index) + replacement + xml.slice(match.index + match[0].length);
      return { xml: newXml, strategy: 'legacy-flexRegex', appliedReplacement: replacement };
    }
  }

  // Fallback: proximity-based replacement (legacy strategy 3)
  const commonPre = longestCommonPrefix(original, replacement);
  const remainOrig = original.slice(commonPre.length);
  const remainRepl = replacement.slice(commonPre.length);
  const commonSuf = longestCommonSuffix(remainOrig, remainRepl);
  const oldPart = remainOrig.slice(0, remainOrig.length - commonSuf.length);
  const newPart = remainRepl.slice(0, remainRepl.length - commonSuf.length);

  if (oldPart.length >= 3 && oldPart !== original) {
    const anchorWords = commonPre.replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);
    let searchFrom = 0;
    let anchorFound = false;
    const anchorText = anchorWords.slice(-3).join(' ');
    if (anchorText.length >= 3) {
      for (let wordCount = Math.min(3, anchorWords.length); wordCount >= 1; wordCount--) {
        const tryAnchor = anchorWords.slice(-wordCount).join(' ');
        const anchorIdx = xml.indexOf(tryAnchor, searchFrom);
        if (anchorIdx !== -1) {
          searchFrom = anchorIdx;
          anchorFound = true;
          break;
        }
      }
    }
    const maxDist = anchorFound ? 5000 : xml.length;
    const phIdx = xml.indexOf(oldPart, searchFrom);
    if (phIdx !== -1 && phIdx - searchFrom < maxDist) {
      const newXml = xml.slice(0, phIdx) + newPart + xml.slice(phIdx + oldPart.length);
      return { xml: newXml, strategy: 'legacy-proximity', appliedReplacement: newPart };
    }
  }

  return { xml, strategy: 'not-found', appliedReplacement: replacement };
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
  const debugMode = process.env.DEBUG_TEMPLATES === '1';
  const outputDir = dirname(templatePath);
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

  // Merge split runs in paragraphs so placeholder text is contiguous
  const mergedXml = mergeRunsInParagraphs(xml);
  const mergeStats = xml.length - mergedXml.length;
  if (mergeStats > 0) {
    console.log(`    Run merging: consolidated XML (${mergeStats} chars removed)`);
  }

  // Debug: dump merged XML
  if (debugMode) {
    const debugName = basename(templatePath).replace('.docx', '_debug_merged.xml');
    await fsWriteFile(join(outputDir, debugName), mergedXml, 'utf-8');
    console.log(`    DEBUG: Saved merged XML to ${debugName}`);
  }

  // Build paragraph map from merged XML
  let paragraphMap = buildParagraphMap(mergedXml);
  const paragraphTexts = paragraphMap.map(p => p.plainText);

  // Extract plain text for AI (segmented by paragraphs)
  const plainText = stripXmlTags(mergedXml);
  const templateName = basename(templatePath);

  // Call AI to identify placeholders — now with paragraph-segmented text
  const aiResult = await callClaude(
    TEMPLATE_FILL_SYSTEM,
    buildTemplateFillUserMessage(plainText, templateName, companyData, tenderData, paragraphTexts),
    { maxTokens: 4096, temperature: 0.1 }
  );

  // Parse AI response — extract JSON array robustly
  let replacements: TemplateReplacement[];
  try {
    replacements = parseAIReplacements(aiResult.content);
  } catch (err) {
    console.log(`    Warning: Failed to parse AI response as JSON: ${err}`);
    console.log(`    AI response: ${aiResult.content.slice(0, 200)}...`);
    replacements = [];
  }

  // Apply replacements using 6-strategy pipeline
  let modifiedXml = mergedXml;
  let replacementCount = 0;
  const appliedReplacementsList: Array<{ replacement: string }> = [];
  const strategyCounts: Record<string, number> = {};

  for (const rep of replacements) {
    const { original, replacement } = rep;

    const strategyResult = applyReplacementWithStrategies(
      modifiedXml, paragraphMap, original, replacement, companyData
    );

    rep.strategy = strategyResult.strategy;

    if (strategyResult.strategy !== 'not-found') {
      modifiedXml = strategyResult.xml;
      replacementCount++;
      appliedReplacementsList.push({ replacement: strategyResult.appliedReplacement });
      strategyCounts[strategyResult.strategy] = (strategyCounts[strategyResult.strategy] || 0) + 1;

      // Rebuild paragraph map after each successful replacement (offsets changed)
      paragraphMap = buildParagraphMap(modifiedXml);
    } else {
      console.log(`    Warning: Could not find placeholder "${original.slice(0, 50)}..." in XML`);
    }
  }

  // Log strategy statistics
  const strategyInfo = Object.entries(strategyCounts)
    .map(([s, c]) => `${s}:${c}`)
    .join(', ');
  if (strategyInfo) {
    console.log(`    Strategies used: ${strategyInfo}`);
  }

  // Second-pass retry: if >2 unfilled placeholders remain, try again with explicit prompt
  let totalCostCZK = aiResult.costCZK;
  const remainingUnfilled = UNFILLED_PATTERNS.filter(p => modifiedXml.includes(p));
  if (remainingUnfilled.length > 2) {
    console.log(`    Second-pass retry: ${remainingUnfilled.length} unfilled placeholders remain`);

    // Rebuild paragraph map for second pass
    paragraphMap = buildParagraphMap(modifiedXml);
    const paragraphTexts2 = paragraphMap.map(p => p.plainText);
    const plainText2 = stripXmlTags(modifiedXml);

    const retryResult = await callClaude(
      TEMPLATE_FILL_SYSTEM,
      buildTemplateFillUserMessage(plainText2, `${templateName} (second pass)`, companyData, tenderData, paragraphTexts2),
      { maxTokens: 4096, temperature: 0.0 }
    );
    totalCostCZK += retryResult.costCZK;

    let retryReplacements: TemplateReplacement[] = [];
    try {
      retryReplacements = parseAIReplacements(retryResult.content);
    } catch {
      console.log(`    Second-pass JSON parse failed — skipping`);
    }

    let retryApplied = 0;
    for (const rep of retryReplacements) {
      const { original, replacement } = rep;
      const retryRes = applyReplacementWithStrategies(
        modifiedXml, paragraphMap, original, replacement, companyData
      );

      rep.strategy = retryRes.strategy !== 'not-found' ? 'retry-pass' : 'not-found';

      if (retryRes.strategy !== 'not-found') {
        modifiedXml = retryRes.xml;
        replacementCount++;
        retryApplied++;
        appliedReplacementsList.push({ replacement: retryRes.appliedReplacement });
        paragraphMap = buildParagraphMap(modifiedXml);
      }
    }
    console.log(`    Second-pass: applied ${retryApplied}/${retryReplacements.length} additional replacements`);

    // Merge retry replacements into the main list for reporting
    replacements.push(...retryReplacements);
  }

  // Debug: dump final XML
  if (debugMode) {
    const debugName = basename(templatePath).replace('.docx', '_debug_final.xml');
    await fsWriteFile(join(outputDir, debugName), modifiedXml, 'utf-8');
    console.log(`    DEBUG: Saved final XML to ${debugName}`);
  }

  // Apply color highlighting:
  // - Orange (#FFE0B2) for AI-filled values → user should review
  // - Red (#FFCCCC) for remaining unfilled placeholders → user must fill
  modifiedXml = applyHighlighting(modifiedXml, appliedReplacementsList);

  // Save modified XML back to ZIP
  zip.file('word/document.xml', modifiedXml);
  const buf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer;

  console.log(`    AI replacements: ${replacementCount}/${replacements.length} applied (highlighted)`);

  return { buffer: buf, replacements, costCZK: totalCostCZK };
}

// --- Template discovery ---

export interface DiscoveredTemplate {
  path: string;
  filename: string;
  type: 'kryci_list' | 'cestne_prohlaseni' | 'seznam_poddodavatelu' | 'kupni_smlouva' | 'technicka_specifikace' | 'other';
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

// Files that should NOT be treated as fillable templates (tender docs, instructions)
const SKIP_FILENAME_PATTERNS = [
  /obchodn[ií]\s*podm[ií]nky/i,
  /výzva/i,
  /zadávac[ií]\s*dokument/i,
];

/**
 * Classify template type by content keywords.
 * Returns 'other' if placeholders are present but type cannot be determined.
 */
function classifyByContent(text: string): DiscoveredTemplate['type'] | null {
  const lower = text.toLowerCase();
  if (/kryc[ií]\s*list/i.test(lower)) return 'kryci_list';
  if (/čestně\s*prohlašuj/i.test(lower) || /čestné\s*prohlášení/i.test(lower)) return 'cestne_prohlaseni';
  if (/poddodavatel/i.test(lower)) return 'seznam_poddodavatelu';
  if (/kupní\s*smlouv/i.test(lower) || /smlouva\s*o\s*dodávce/i.test(lower)) return 'kupni_smlouva';
  if (/technická\s*specifikace/i.test(lower)) return 'technicka_specifikace';
  return null;
}

/**
 * Check if text contains placeholder patterns that signal "needs manual input".
 */
function hasPlaceholders(text: string): boolean {
  const lower = text.toLowerCase();
  return UNFILLED_PATTERNS.some(p => lower.includes(p.toLowerCase()))
    || /_{3,}|\.{4,}|…{2,}|\[vyplnit\]|\[doplnit\]|\[účastník vyplní\]/i.test(text);
}

/**
 * Scan an input directory and classify DOCX/XLSX template files.
 * Uses filename regex first, then falls back to content-based detection.
 */
export async function discoverTemplates(inputDir: string): Promise<DiscoveredTemplate[]> {
  const files = await readdir(inputDir);
  const templates: DiscoveredTemplate[] = [];
  const typeCounts = new Map<string, number>();

  for (const filename of files) {
    const lowerFilename = filename.toLowerCase();
    // Support both .docx and .xls/.xlsx templates
    if (!lowerFilename.endsWith('.docx') && !lowerFilename.endsWith('.xls') && !lowerFilename.endsWith('.xlsx')) continue;
    // Skip non-template files by filename
    if (SKIP_FILENAME_PATTERNS.some(p => p.test(filename))) continue;

    const filePath = join(inputDir, filename);

    // 1. Try filename-based classification first (fast)
    let type: DiscoveredTemplate['type'] | null = null;
    for (const { type: t, patterns } of TEMPLATE_PATTERNS) {
      if (patterns.some((p) => p.test(filename))) {
        type = t;
        break;
      }
    }

    // 2. Fallback: content-based detection
    if (!type) {
      try {
        let text: string;
        if (lowerFilename.endsWith('.docx')) {
          text = await parseDocx(filePath);
        } else {
          text = await parseExcel(filePath);
        }

        // Only consider files that have placeholder patterns
        if (hasPlaceholders(text)) {
          type = classifyByContent(text) || 'other';
        }
      } catch (err) {
        console.log(`  Warning: Could not read ${filename} for content detection: ${err}`);
      }
    }

    // 3. Add if detected, with dedup limit of 4 per type
    if (type) {
      const count = typeCounts.get(type) || 0;
      if (count < 4) {
        typeCounts.set(type, count + 1);
        templates.push({ path: filePath, filename, type });
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

export interface MultiProductItem {
  polozka: string;
  mnozstvi: number;
  product: ProductCandidate;
  priceBezDph: number;
  priceSdph: number;
}

export async function generateCenovaNabidkaMulti(
  analysis: TenderAnalysis,
  items: MultiProductItem[],
  company: CompanyProfile,
): Promise<Buffer> {
  const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: '999999' };
  const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  const headerRow = new TableRow({
    children: [
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: 'Položka', bold: true })] })],
        width: { size: 30, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
        borders,
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: 'Produkt', bold: true })] })],
        width: { size: 25, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
        borders,
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: 'Množství', bold: true })] })],
        width: { size: 10, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
        borders,
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: 'Cena bez DPH (Kč)', bold: true })] })],
        width: { size: 17, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
        borders,
      }),
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: 'Cena s DPH (Kč)', bold: true })] })],
        width: { size: 18, type: WidthType.PERCENTAGE },
        shading: { type: ShadingType.SOLID, color: 'E8E8E8', fill: 'E8E8E8' },
        borders,
      }),
    ],
  });

  const dataRows = items.map(item => new TableRow({
    children: [
      new TableCell({ children: [new Paragraph(item.polozka)], borders }),
      new TableCell({ children: [new Paragraph(`${item.product.vyrobce} ${item.product.model}`)], borders }),
      new TableCell({ children: [new Paragraph(`${item.mnozstvi} ks`)], borders }),
      new TableCell({ children: [new Paragraph((item.priceBezDph * item.mnozstvi).toLocaleString('cs-CZ'))], borders }),
      new TableCell({ children: [new Paragraph((item.priceSdph * item.mnozstvi).toLocaleString('cs-CZ'))], borders }),
    ],
  }));

  const totalBezDph = items.reduce((sum, i) => sum + i.priceBezDph * i.mnozstvi, 0);
  const totalSdph = items.reduce((sum, i) => sum + i.priceSdph * i.mnozstvi, 0);
  const dph = totalSdph - totalBezDph;

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
        new Table({ rows: [headerRow, ...dataRows], width: { size: 100, type: WidthType.PERCENTAGE } }),
        new Paragraph({ text: '' }),
        new Paragraph({
          children: [
            new TextRun({ text: 'Celková nabídková cena bez DPH: ', bold: true }),
            new TextRun(`${totalBezDph.toLocaleString('cs-CZ')} Kč`),
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
            new TextRun({ text: `${totalSdph.toLocaleString('cs-CZ')} Kč`, bold: true }),
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
