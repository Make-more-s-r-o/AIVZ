/**
 * ReconstructEngine (Mode 2) — AI extrakce struktury šablony + deterministická rekonstrukce.
 * AI přečte DOCX šablonu → TemplateStructure JSON → kód postaví nový DOCX s daty.
 */
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';
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
import { parseDocx } from './document-parser.js';
import { callClaude } from './ai-client.js';
import { TEMPLATE_EXTRACT_SYSTEM, buildTemplateExtractUserMessage } from '../prompts/template-extract.js';
import type { DocumentData } from './data-resolver.js';

const ROOT = new URL('../../../', import.meta.url).pathname;

const DOC_STYLES = {
  default: {
    document: { run: { font: 'Calibri', size: 22 } },
    heading1: { run: { font: 'Calibri', size: 32, bold: true } },
    heading2: { run: { font: 'Calibri', size: 28, bold: true } },
  },
};

const thinBorder = { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA' };
const borders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

// Value type → DocumentData field mapping
function resolveValue(valueType: string, data: DocumentData): string {
  const map: Record<string, string> = {
    company_name: data.nazev,
    ico: data.ico,
    dic: data.dic,
    address: data.sidlo,
    person_name: data.jednajici_osoba,
    email: data.email,
    phone: data.telefon,
    datova_schranka: data.datova_schranka || '',
    rejstrik: data.rejstrik || '',
    ucet: data.ucet || '',
    tender_name: data.nazev_zakazky,
    tender_id: data.evidencni_cislo,
    price_no_vat: data.celkova_cena_bez_dph.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    price_with_vat: data.celkova_cena_s_dph.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    vat_amount: data.dph_castka.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    date: data.datum,
    place: data.misto,
    supplier_name: data.zadavatel_nazev,
    supplier_ico: data.zadavatel_ico,
  };
  return map[valueType] ?? '';
}

export interface TemplateStructureSection {
  title?: string;
  content_type: 'paragraph_with_fields' | 'field_block' | 'table' | 'legal_only';
  legal_text?: string;
  template_string?: string;
  fields?: Array<{
    label: string;
    value_type: string;
    custom_instruction?: string;
  }>;
  table?: {
    headers: string[];
    row_value_types: string[];
  };
}

export interface TemplateStructure {
  document_type: 'kryci_list' | 'cestne_prohlaseni' | 'smlouva' | 'specifikace' | 'other';
  sections: TemplateStructureSection[];
}

export interface ReconstructResult {
  buffer: Buffer;
  costCZK: number;
  structure: TemplateStructure;
}

/**
 * Extrahuje strukturu šablony přes AI (s cache).
 */
async function extractTemplateStructure(
  templatePath: string,
  tenderId: string,
): Promise<{ structure: TemplateStructure; costCZK: number }> {
  const filename = basename(templatePath, '.docx');
  const outputDir = join(ROOT, 'output', tenderId);
  const cachePath = join(outputDir, `template-structure-${filename}.json`);

  // Cache hit
  if (existsSync(cachePath)) {
    const cached = JSON.parse(await readFile(cachePath, 'utf-8'));
    return { structure: cached, costCZK: 0 };
  }

  // Extract text from template
  const templateText = await parseDocx(templatePath);

  // AI extraction
  const result = await callClaude(
    TEMPLATE_EXTRACT_SYSTEM,
    buildTemplateExtractUserMessage(templateText, filename),
    { maxTokens: 8192, temperature: 0.1 }
  );

  // Parse JSON response (resilient)
  let jsonStr = result.content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let structure: TemplateStructure;
  try {
    structure = JSON.parse(jsonStr);
  } catch {
    // Try to find JSON in the response
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      structure = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Failed to parse template structure JSON`);
    }
  }

  // Cache result
  await writeFile(cachePath, JSON.stringify(structure, null, 2), 'utf-8');
  return { structure, costCZK: result.costCZK };
}

/**
 * Builds a DOCX from extracted structure + DocumentData.
 */
function buildFromStructure(structure: TemplateStructure, data: DocumentData): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = [];

  for (const section of structure.sections) {
    // Section title
    if (section.title) {
      elements.push(new Paragraph({
        children: [new TextRun({ text: section.title, bold: true })],
        spacing: { before: 200, after: 100 },
      }));
    }

    switch (section.content_type) {
      case 'legal_only': {
        if (section.legal_text) {
          for (const line of section.legal_text.split('\n')) {
            elements.push(new Paragraph({
              text: line,
              spacing: { before: 40, after: 40 },
            }));
          }
        }
        break;
      }

      case 'paragraph_with_fields': {
        if (section.template_string) {
          // Replace {value_type} markers with actual data
          const parts = section.template_string.split(/(\{[a-z_]+\})/g);
          const runs: TextRun[] = parts.map(part => {
            const match = part.match(/^\{([a-z_]+)\}$/);
            if (match) {
              const value = resolveValue(match[1], data);
              return new TextRun({ text: value || part, bold: true });
            }
            return new TextRun(part);
          });
          elements.push(new Paragraph({
            children: runs,
            spacing: { before: 60, after: 60 },
          }));
        }
        break;
      }

      case 'field_block': {
        if (section.fields) {
          const rows = section.fields.map(field => {
            const value = resolveValue(field.value_type, data);
            return new TableRow({
              children: [
                new TableCell({
                  children: [new Paragraph({
                    children: [new TextRun({ text: field.label, bold: true })],
                    spacing: { before: 60, after: 60 },
                  })],
                  width: { size: 40, type: WidthType.PERCENTAGE },
                  shading: { type: ShadingType.SOLID as const, color: 'F0F0F0', fill: 'F0F0F0' },
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
          });
          elements.push(new Table({
            rows,
            width: { size: 100, type: WidthType.PERCENTAGE },
          }));
        }
        break;
      }

      case 'table': {
        if (section.table) {
          const headerRow = new TableRow({
            children: section.table.headers.map(h => new TableCell({
              children: [new Paragraph({
                children: [new TextRun({ text: h, bold: true })],
                spacing: { before: 60, after: 60 },
              })],
              shading: { type: ShadingType.SOLID as const, color: 'E8E8E8', fill: 'E8E8E8' },
              borders,
            })),
          });

          const dataRows = data.polozky.map(item => new TableRow({
            children: section.table!.row_value_types.map(vt => {
              let val = '';
              if (vt === 'item_name') val = item.nazev;
              else if (vt === 'quantity') val = String(item.mnozstvi);
              else if (vt === 'unit') val = item.jednotka;
              else if (vt === 'unit_price') val = item.cena_za_jednotku_bez_dph.toLocaleString('cs-CZ');
              else if (vt === 'total_price') val = item.cena_celkem_bez_dph.toLocaleString('cs-CZ');
              else val = resolveValue(vt, data);
              return new TableCell({
                children: [new Paragraph({ text: val, spacing: { before: 60, after: 60 } })],
                borders,
              });
            }),
          }));

          elements.push(new Table({
            rows: [headerRow, ...dataRows],
            width: { size: 100, type: WidthType.PERCENTAGE },
          }));
        }
        break;
      }
    }

    elements.push(new Paragraph({ text: '' }));
  }

  return elements;
}

/**
 * Reconstruct document: AI extracts template structure, code builds DOCX.
 */
export async function reconstructDocument(
  templatePath: string,
  data: DocumentData,
  tenderId: string,
): Promise<ReconstructResult> {
  const { structure, costCZK } = await extractTemplateStructure(templatePath, tenderId);

  // If AI couldn't classify the document, throw to trigger Fill fallback
  if (structure.document_type === 'other') {
    throw new Error('Template classified as "other" — falling back to Fill mode');
  }

  const elements = buildFromStructure(structure, data);

  const doc = new Document({
    styles: DOC_STYLES,
    sections: [{ children: elements }],
  });

  const buffer = Buffer.from(await Packer.toBuffer(doc));
  return { buffer, costCZK, structure };
}
