import { readFile, readdir } from 'fs/promises';
import { join, extname } from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import type { ExtractedDocument } from './types.js';

// Template files - these are filled in generate step, not analyzed
const TEMPLATE_PATTERNS = [
  'krycí list',
  'kryci list',
  'čestné prohlášení',
  'cestne prohlaseni',
  'seznam poddodavatel',
  'příloha č. 3',
  'příloha č. 4',
  'příloha č. 5',
];

function isTemplate(filename: string): boolean {
  const lower = filename.toLowerCase();
  return TEMPLATE_PATTERNS.some((pattern) => lower.includes(pattern));
}

export async function parsePdf(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

export async function parseDocx(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

export async function extractDocuments(
  inputDir: string
): Promise<ExtractedDocument[]> {
  const files = await readdir(inputDir);
  const documents: ExtractedDocument[] = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const filePath = join(inputDir, file);

    if (ext === '.pdf') {
      console.log(`  Parsing PDF: ${file}`);
      const text = await parsePdf(filePath);
      documents.push({
        filename: file,
        type: 'pdf',
        text,
        isTemplate: isTemplate(file),
      });
    } else if (ext === '.docx') {
      console.log(`  Parsing DOCX: ${file}`);
      const text = await parseDocx(filePath);
      documents.push({
        filename: file,
        type: 'docx',
        text,
        isTemplate: isTemplate(file),
      });
    } else if (ext === '.doc') {
      console.log(`  Skipping .doc file (needs conversion): ${file}`);
    }
  }

  return documents;
}
