import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import { parseDocx } from './document-parser.js';
import type { ProductMatch, ValidationCheck } from './types.js';
import type { CompanyProfile } from './data-resolver.js';

export const DOCUMENT_TEXT_LIMIT = 15_000;

export interface GeneratedDocumentText {
  filename: string;
  path: string;
  text: string;
}

export interface ExpectedPriceTotals {
  bezDph: number;
  dph: number;
  sDph: number;
}

export interface DeterministicValidationInput {
  company: Pick<CompanyProfile, 'nazev' | 'ico' | 'dic'>;
  productMatch: ProductMatch;
  documents: GeneratedDocumentText[];
  selectedPartIds?: Set<string> | null;
}

const PLACEHOLDER_PATTERNS = [
  { label: 'doplní účastník', normalized: 'doplni ucastnik' },
  { label: '[účastník vyplní]', normalized: '[ucastnik vyplni]' },
];

function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizeTaxId(value: string): string {
  return value.replace(/[^0-9a-z]/gi, '').toUpperCase();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return value.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function priority(filename: string): number {
  const normalized = normalizeForSearch(filename.replace(/[_-]/g, ' '));
  if (normalized.includes('kryci list')) return 0;
  if (normalized.includes('cenova nabidka')) return 1;
  if (normalized.includes('cestne prohlaseni') || normalized.includes('cestneho prohlaseni')) return 2;
  return 10;
}

function classifyDocument(filename: string, text: string): 'kryci_list' | 'cenova_nabidka' | 'cestne_prohlaseni' | null {
  const combined = normalizeForSearch(`${filename} ${text.slice(0, 1000)}`.replace(/[_-]/g, ' '));
  if (combined.includes('kryci list')) return 'kryci_list';
  if (combined.includes('cenova nabidka')) return 'cenova_nabidka';
  if (combined.includes('cestne prohlaseni') || combined.includes('cestne prohlasuji')) return 'cestne_prohlaseni';
  return null;
}

export function findDocument(
  documents: GeneratedDocumentText[],
  type: 'kryci_list' | 'cenova_nabidka' | 'cestne_prohlaseni',
): GeneratedDocumentText | null {
  return documents.find((doc) => classifyDocument(doc.filename, doc.text) === type) ?? null;
}

export async function loadGeneratedDocumentTexts(outputDir: string): Promise<GeneratedDocumentText[]> {
  const preferredDir = join(outputDir, 'documents');
  const candidateDirs = existsSync(preferredDir) ? [preferredDir, outputDir] : [outputDir];

  for (const docsDir of candidateDirs) {
    let files: string[] = [];
    try {
      files = (await readdir(docsDir)).filter((f) => f.toLowerCase().endsWith('.docx'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const sorted = files.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b, 'cs'));
    const documents: GeneratedDocumentText[] = [];

    for (const file of sorted) {
      const filePath = join(docsDir, file);
      try {
        const text = await parseDocx(filePath);
        documents.push({
          filename: file,
          path: filePath,
          text,
        });
      } catch (err) {
        documents.push({
          filename: file,
          path: filePath,
          text: `[DOCX se nepodařilo načíst: ${err instanceof Error ? err.message : String(err)}]`,
        });
      }
    }

    return documents;
  }

  return [];
}

export function buildDocumentsPromptSection(documents: GeneratedDocumentText[]): string {
  if (documents.length === 0) return 'ŽÁDNÉ DOCX dokumenty nebyly nalezeny ani načteny.';

  return documents
    .map((doc) => `--- DOKUMENT: ${doc.filename} ---\n${doc.text.slice(0, DOCUMENT_TEXT_LIMIT)}`)
    .join('\n\n');
}

function selectedProductPrice(productMatch: ProductMatch, selectedPartIds?: Set<string> | null): Array<{ unitBezDph: number; quantity: number }> {
  if (productMatch.polozky_match) {
    let items = productMatch.polozky_match;
    if (selectedPartIds) {
      items = items.filter((item) => !item.cast_id || selectedPartIds.has(item.cast_id));
    }
    return items.map((item) => {
      const selected = item.kandidati[item.vybrany_index];
      const unitBezDph = item.cenova_uprava?.nabidkova_cena_bez_dph ?? selected?.cena_bez_dph ?? 0;
      return {
        unitBezDph,
        quantity: item.mnozstvi ?? 1,
      };
    });
  }

  const selected = productMatch.kandidati?.[productMatch.vybrany_index ?? 0];
  const unitBezDph = productMatch.cenova_uprava?.nabidkova_cena_bez_dph ?? selected?.cena_bez_dph ?? 0;
  return [{ unitBezDph, quantity: 1 }];
}

export function computeExpectedPriceTotals(productMatch: ProductMatch, selectedPartIds?: Set<string> | null): ExpectedPriceTotals {
  const lines = selectedProductPrice(productMatch, selectedPartIds);
  const bezDph = round2(lines.reduce((sum, line) => sum + round2(line.unitBezDph * line.quantity), 0));
  const sDph = round2(bezDph * 1.21);
  return {
    bezDph,
    dph: round2(sDph - bezDph),
    sDph,
  };
}

function parseNumberToken(token: string): number | null {
  let normalized = token.replace(/\u00a0/g, ' ').trim().replace(/\s+/g, '');
  if (!normalized || !/\d/.test(normalized)) return null;

  if (normalized.includes(',') && normalized.includes('.')) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d[\d\s\u00a0.]*(?:,\d+)?/g) ?? [];
  return matches
    .map(parseNumberToken)
    .filter((n): n is number => n !== null);
}

export function textContainsAmount(text: string, expected: number, tolerance = 2): boolean {
  return extractNumbers(text).some((value) => Math.abs(value - expected) <= tolerance);
}

export function containsHardPlaceholder(text: string): string | null {
  if (text.includes('{{')) return '{{';
  const normalized = normalizeForSearch(text);
  const found = PLACEHOLDER_PATTERNS.find((pattern) => normalized.includes(pattern.normalized));
  return found?.label ?? null;
}

function checkCompanyIdentity(company: DeterministicValidationInput['company'], documents: GeneratedDocumentText[]): ValidationCheck {
  const kryciList = findDocument(documents, 'kryci_list');
  if (!kryciList) {
    return {
      kategorie: 'formalni',
      kontrola: 'Identita firmy v krycím listu',
      status: 'fail',
      detail: 'Krycí list nebyl mezi vygenerovanými DOCX dokumenty nalezen.',
      zdroj: 'deterministic',
    };
  }

  const normalizedText = normalizeForSearch(kryciList.text);
  const textDigits = normalizeDigits(kryciList.text);
  const textTaxId = normalizeTaxId(kryciList.text);
  const missing: string[] = [];

  if (!company.nazev || !normalizedText.includes(normalizeForSearch(company.nazev))) missing.push('název firmy');
  if (!company.ico || !textDigits.includes(normalizeDigits(company.ico))) missing.push('IČO');
  if (!company.dic || !textTaxId.includes(normalizeTaxId(company.dic))) missing.push('DIČ');

  return {
    kategorie: 'formalni',
    kontrola: 'Identita firmy v krycím listu',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0
      ? `Krycí list obsahuje název firmy, IČO i DIČ z konfigurace (${basename(kryciList.path)}).`
      : `Krycí list neobsahuje: ${missing.join(', ')}.`,
    zdroj: 'deterministic',
  };
}

function checkPriceTotals(
  productMatch: ProductMatch,
  documents: GeneratedDocumentText[],
  selectedPartIds?: Set<string> | null,
): ValidationCheck {
  const cenovaNabidka = findDocument(documents, 'cenova_nabidka');
  if (!cenovaNabidka) {
    return {
      kategorie: 'cenova_spravnost',
      kontrola: 'DPH a celková cena v cenové nabídce',
      status: 'fail',
      detail: 'Cenová nabídka nebyla mezi vygenerovanými DOCX dokumenty nalezena.',
      zdroj: 'deterministic',
    };
  }

  const totals = computeExpectedPriceTotals(productMatch, selectedPartIds);
  const bezFound = textContainsAmount(cenovaNabidka.text, totals.bezDph);
  const sFound = textContainsAmount(cenovaNabidka.text, totals.sDph);
  const missing = [
    !bezFound ? `bez DPH ${formatMoney(totals.bezDph)} Kč` : null,
    !sFound ? `s DPH ${formatMoney(totals.sDph)} Kč` : null,
  ].filter(Boolean);

  return {
    kategorie: 'cenova_spravnost',
    kontrola: 'DPH a celková cena v cenové nabídce',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0
      ? `Cenová nabídka obsahuje očekávané celkové ceny ${formatMoney(totals.bezDph)} Kč bez DPH a ${formatMoney(totals.sDph)} Kč s DPH (21 %).`
      : `V cenové nabídce chybí očekávaná částka: ${missing.join(', ')} (tolerance ±2 Kč).`,
    zdroj: 'deterministic',
  };
}

function checkHardPlaceholders(documents: GeneratedDocumentText[]): ValidationCheck {
  if (documents.length === 0) {
    return {
      kategorie: 'kompletnost',
      kontrola: 'Tvrdé placeholdery ve vygenerovaných dokumentech',
      status: 'fail',
      detail: 'Nebyly načteny žádné vygenerované DOCX dokumenty.',
      zdroj: 'deterministic',
    };
  }

  const offenders = documents
    .map((doc) => {
      const pattern = containsHardPlaceholder(doc.text);
      return pattern ? `${doc.filename} (${pattern})` : null;
    })
    .filter((item): item is string => item !== null);

  return {
    kategorie: 'kompletnost',
    kontrola: 'Tvrdé placeholdery ve vygenerovaných dokumentech',
    status: offenders.length === 0 ? 'pass' : 'fail',
    detail: offenders.length === 0
      ? 'Dokumenty neobsahují tvrdé placeholdery typu „doplní účastník", „[účastník vyplní]" ani „{{".'
      : `Nalezeny tvrdé placeholdery: ${offenders.join(', ')}.`,
    zdroj: 'deterministic',
  };
}

export function runDeterministicValidation(input: DeterministicValidationInput): ValidationCheck[] {
  return [
    checkCompanyIdentity(input.company, input.documents),
    checkPriceTotals(input.productMatch, input.documents, input.selectedPartIds),
    checkHardPlaceholders(input.documents),
  ];
}
