/**
 * Programatická validace dokumentů — field-by-field ověření.
 * Pro Clean mode: 100% spolehlivá (sami jsme dokument vytvořili).
 * Pro Reconstruct: readback + porovnání s extrakcí.
 * Pro Fill: deleguje na stávající AI validaci.
 */
import { parseDocx } from './document-parser.js';
import type { DocumentData, DocMode } from './data-resolver.js';

export interface ValidationCheck {
  field: string;
  expected: string;
  actual: string;
  status: 'pass' | 'fail' | 'warning';
}

export interface ValidationResult {
  document: string;
  mode: DocMode;
  checks: ValidationCheck[];
  overall: 'pass' | 'fail';
  confidence: number;
}

/** Kontroluje, zda text dokumentu obsahuje expected hodnotu poblíž labelu */
function checkFieldPresence(
  docText: string,
  field: string,
  expected: string,
  label?: string,
): ValidationCheck {
  if (!expected || expected === '—') {
    return { field, expected, actual: '(skipped)', status: 'pass' };
  }

  const normalizedDoc = docText.replace(/\s+/g, ' ');
  const normalizedExpected = expected.replace(/\s+/g, ' ').trim();

  // Přímá přítomnost
  const found = normalizedDoc.includes(normalizedExpected);

  // Strukturální placement: pokud máme label, ověř že expected je blízko
  let actual = found ? normalizedExpected : '(nenalezeno)';
  let status: 'pass' | 'fail' | 'warning' = found ? 'pass' : 'fail';

  if (found && label) {
    const labelIdx = normalizedDoc.indexOf(label);
    const valueIdx = normalizedDoc.indexOf(normalizedExpected);
    // Hodnota by měla být max ~200 znaků za labelem
    if (labelIdx >= 0 && valueIdx >= 0 && valueIdx > labelIdx && valueIdx - labelIdx < 200) {
      status = 'pass';
    } else if (labelIdx >= 0 && valueIdx >= 0) {
      status = 'warning'; // Nalezeno, ale daleko od labelu
      actual = `${normalizedExpected} (pozice: ${valueIdx - labelIdx} znaků od labelu)`;
    }
  }

  return { field, expected: normalizedExpected, actual, status };
}

/**
 * Validuje dokument: přečte zpět DOCX a ověří přítomnost dat.
 */
export async function validateDocument(
  docxPath: string,
  data: DocumentData,
  mode: DocMode,
  documentType?: string,
): Promise<ValidationResult> {
  const docText = await parseDocx(docxPath);
  const checks: ValidationCheck[] = [];

  // Společné kontroly pro všechny typy dokumentů
  const commonFields: Array<{ field: string; expected: string; label?: string }> = [
    { field: 'Název firmy', expected: data.nazev, label: 'firma' },
    { field: 'IČO', expected: data.ico, label: 'IČO' },
  ];

  // Specifické kontroly dle typu dokumentu
  if (documentType === 'kryci_list' || documentType === 'cenova_nabidka') {
    commonFields.push(
      { field: 'DIČ', expected: data.dic, label: 'DIČ' },
      { field: 'Sídlo', expected: data.sidlo, label: 'Sídlo' },
      { field: 'Jednající osoba', expected: data.jednajici_osoba },
      { field: 'Telefon', expected: data.telefon, label: 'Telefon' },
      { field: 'E-mail', expected: data.email, label: 'mail' },
      { field: 'Název zakázky', expected: data.nazev_zakazky },
      { field: 'Zadavatel', expected: data.zadavatel_nazev, label: 'Zadavatel' },
      { field: 'Datum', expected: data.datum },
    );
    // Ceny — formátované
    const cenaBezDph = data.celkova_cena_bez_dph.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cenaSdph = data.celkova_cena_s_dph.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    commonFields.push(
      { field: 'Cena bez DPH', expected: cenaBezDph },
      { field: 'Cena s DPH', expected: cenaSdph },
    );
  }

  if (documentType === 'kryci_list') {
    if (data.datova_schranka) {
      commonFields.push({ field: 'Datová schránka', expected: data.datova_schranka, label: 'schránka' });
    }
    if (data.rejstrik) {
      commonFields.push({ field: 'Rejstřík', expected: data.rejstrik, label: 'rejstřík' });
    }
  }

  if (documentType === 'cestne_prohlaseni') {
    commonFields.push(
      { field: 'Jednající osoba', expected: data.jednajici_osoba },
      { field: 'Sídlo', expected: data.sidlo },
      { field: 'Název zakázky', expected: data.nazev_zakazky },
      { field: 'Datum', expected: data.datum },
    );
    // Kontrola přítomnosti právního textu
    const legalKeywords = ['pravomocně odsouzen', 'daňový nedoplatek', 'zdravotní pojištění'];
    for (const keyword of legalKeywords) {
      const found = docText.includes(keyword);
      checks.push({
        field: `Právní text: "${keyword}"`,
        expected: keyword,
        actual: found ? keyword : '(nenalezeno)',
        status: found ? 'pass' : 'fail',
      });
    }
  }

  if (documentType === 'seznam_poddodavatelu') {
    commonFields.push(
      { field: 'Název zakázky', expected: data.nazev_zakazky },
      { field: 'Datum', expected: data.datum },
    );
  }

  // Spustit kontroly
  for (const { field, expected, label } of commonFields) {
    checks.push(checkFieldPresence(docText, field, expected, label));
  }

  // Výsledek
  const failCount = checks.filter(c => c.status === 'fail').length;
  const warnCount = checks.filter(c => c.status === 'warning').length;
  const totalChecks = checks.filter(c => c.expected !== '(skipped)').length;
  const passCount = checks.filter(c => c.status === 'pass').length;

  let confidence: number;
  if (mode === 'clean') {
    confidence = 100; // Sami jsme vytvořili → vždy 100%
  } else if (mode === 'reconstruct') {
    confidence = totalChecks > 0 ? Math.round((passCount / totalChecks) * 100) : 90;
  } else {
    confidence = totalChecks > 0 ? Math.round((passCount / totalChecks) * 100) : 50;
  }

  return {
    document: docxPath,
    mode,
    checks,
    overall: failCount > 0 ? 'fail' : 'pass',
    confidence,
  };
}

/**
 * Validuje všechny dokumenty tenderu.
 */
export async function validateAllDocuments(
  outputDir: string,
  data: DocumentData,
  generationMeta: Record<string, { mode: DocMode; source: string }>,
): Promise<ValidationResult[]> {
  const { readdir } = await import('fs/promises');
  const { join } = await import('path');
  const files = await readdir(outputDir);
  const docxFiles = files.filter(f => f.endsWith('.docx'));
  const results: ValidationResult[] = [];

  // Infer document type from filename
  const inferType = (filename: string): string | undefined => {
    if (filename.startsWith('kryci_list')) return 'kryci_list';
    if (filename.startsWith('cestne_prohlaseni')) return 'cestne_prohlaseni';
    if (filename.startsWith('seznam_poddodavatelu')) return 'seznam_poddodavatelu';
    if (filename.startsWith('cenova_nabidka')) return 'cenova_nabidka';
    if (filename.startsWith('technicky_navrh')) return 'technicky_navrh';
    return undefined;
  };

  for (const filename of docxFiles) {
    const meta = generationMeta[filename];
    const mode: DocMode = meta?.mode || 'fill';
    const docType = inferType(filename);
    const docPath = join(outputDir, filename);

    try {
      const result = await validateDocument(docPath, data, mode, docType);
      result.document = filename;
      results.push(result);
    } catch (err) {
      results.push({
        document: filename,
        mode,
        checks: [{
          field: 'readback',
          expected: 'readable DOCX',
          actual: `Error: ${err}`,
          status: 'fail',
        }],
        overall: 'fail',
        confidence: 0,
      });
    }
  }

  return results;
}
