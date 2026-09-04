/**
 * DataResolver — centrální zdroj dat pro generování dokumentů.
 * Načte company, analysis, product-match, parts-selection a vrátí
 * jednotný DocumentData interface pro všechny buildery.
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { TenderAnalysis, ProductMatch, ProductCandidate } from './types.js';
import {
  calculateTenderPriceRecap,
  type UnassignedPartPriceItem,
} from './price-calculator.js';
import { extractCastIdFromFilename } from '../parse-soupis.js';

const ROOT = new URL('../../../', import.meta.url).pathname;

// Generation mode for each document
export type DocMode = 'clean' | 'reconstruct' | 'fill';
export type FormSource = 'tender-form' | 'own-fallback';

const FORM_TEMPLATE_TYPES = new Set([
  'kryci_list',
  'cestne_prohlaseni',
  'seznam_poddodavatelu',
]);

/**
 * Formulář zadavatele se vždy skutečně vyplňuje; clean-builder je povolen jen
 * pro explicitní vlastní fallback. Vrácený původ se zapisuje do metadata dokumentu.
 */
export function resolveFormGenerationPolicy(
  template: { type: string; origin?: FormSource },
  requestedMode: DocMode,
): { mode: DocMode; form_source?: FormSource } {
  if (!FORM_TEMPLATE_TYPES.has(template.type)) return { mode: requestedMode };
  if (template.origin === 'own-fallback') {
    return { mode: 'clean', form_source: 'own-fallback' };
  }
  return {
    // In-place fill jako jediné zachová zadavatelem předepsaný dokument.
    mode: 'fill',
    form_source: 'tender-form',
  };
}

/** Metadata about generated document mode */
export interface GenerationMeta {
  [filename: string]: {
    mode: DocMode;
    source: 'clean-builder' | 'reconstruct-engine' | 'ai-fill' | 'excel-ai' | 'programmatic';
    cost_czk: number;
    template_source?: string;
    form_source?: FormSource;
    cast_id?: string;
    cena_bez_dph?: number;
    cena_s_dph?: number;
  };
}

// Company profile (matches config/company.json structure)
export interface CompanyProfile {
  nazev: string;
  ico: string;
  dic: string;
  sidlo: string;
  ucet?: string;
  iban?: string;
  bic?: string;
  datova_schranka?: string;
  rejstrik?: string;
  jednajici_osoba: string;
  telefon: string;
  email: string;
  obory?: string[];
  keyword_filters?: Record<string, string[]>;
}

export interface DocumentDataItem {
  nazev: string;
  mnozstvi: number;
  jednotka: string;
  cena_za_jednotku_bez_dph: number;
  cena_celkem_bez_dph: number;
  cast_id?: string;
}

export interface DocumentDataCast {
  id: string;
  nazev: string;
  cena_bez_dph: number;
  cena_s_dph: number;
  pocet_polozek: number;
}

export interface PartDocumentPriceAssignment {
  document: string;
  cast_id: string;
  cena_bez_dph: number;
  cena_s_dph: number;
}

export interface DocumentData {
  // Tender
  nazev_zakazky: string;
  evidencni_cislo: string;
  zadavatel_nazev: string;
  zadavatel_ico: string;
  predmet: string;

  // Company
  nazev: string;
  ico: string;
  dic: string;
  sidlo: string;
  jednajici_osoba: string;
  email: string;
  telefon: string;
  datova_schranka?: string;
  rejstrik?: string;
  ucet?: string;
  iban?: string;
  bic?: string;

  // Prices
  celkova_cena_bez_dph: number;
  celkova_cena_s_dph: number;
  dph_sazba: string;
  dph_castka: number;

  // Items
  polozky: DocumentDataItem[];

  // Multi-part tender
  casti?: DocumentDataCast[];
  /** Rekapitulace všech částí pro povinné šablony, i když se podává jen jejich podmnožina. */
  cenova_rekapitulace_po_castech?: DocumentDataCast[];
  polozky_bez_cast_id?: UnassignedPartPriceItem[];

  // Meta
  datum: string;
  misto: string;

  // Validační příznaky: povinné pole zakázky přišlo z analýzy jako zástupný text (AI hedge,
  // např. „neuvedeno (pravděpodobně…)") nebo prázdné. Builder pole vypíše prázdné (—),
  // field-validace to označí jako blocker (krycí list NEsmí projít jako pass).
  zadavatel_placeholder?: boolean;
  evidencni_cislo_placeholder?: boolean;
}

// Zástupné / hedge hodnoty v povinných polích krycího listu ("neuvedeno", "pravděpodobně…",
// prázdno, "xxx", "doplní…", otevřená hranatá závorka). Nesmí se vypsat do formálního dokumentu.
const PLACEHOLDER_VALUE_RE = /neuveden|pravděpodobn|^\s*$|xxx|doplní|\[/i;
// Varianta bez prázdna: zástupný TEXT (u evidenčního čísla je prázdno legitimní — VZMR ho nemá).
const PLACEHOLDER_TEXT_RE = /neuveden|pravděpodobn|xxx|doplní|\[/i;

function isPlaceholderValue(value: unknown): boolean {
  return PLACEHOLDER_VALUE_RE.test(String(value ?? ''));
}

function hasPlaceholderText(value: unknown): boolean {
  return PLACEHOLDER_TEXT_RE.test(String(value ?? ''));
}

/**
 * Extrahuje město z adresy sídla pro podpis dokumentů.
 * "Partyzánská 18/23, 170 00 Praha 7-Holešovice" → "V Praze"
 * "Náměstí 5, 602 00 Brno" → "V Brně"
 */
function extractMisto(sidlo: string): string {
  // Odstranit PSČ a čísla, hledat známá česká města
  const normalized = sidlo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const cityMap: Record<string, string> = {
    'praha': 'V Praze',
    'brno': 'V Brně',
    'ostrava': 'V Ostravě',
    'plzen': 'V Plzni',
    'liberec': 'V Liberci',
    'olomouc': 'V Olomouci',
    'ceske budejovice': 'V Českých Budějovicích',
    'hradec kralove': 'V Hradci Králové',
    'usti nad labem': 'V Ústí nad Labem',
    'pardubice': 'V Pardubicích',
    'zlin': 'Ve Zlíně',
    'havirov': 'V Havířově',
    'kladno': 'V Kladně',
    'most': 'V Mostě',
    'opava': 'V Opavě',
    'karlovy vary': 'V Karlových Varech',
    'jihlava': 'V Jihlavě',
  };

  for (const [key, value] of Object.entries(cityMap)) {
    if (normalized.includes(key)) return value;
  }

  // Fallback: zkusit extrahovat město z formátu "PSČ Město"
  const pscMatch = sidlo.match(/\d{3}\s?\d{2}\s+([A-ZÁ-Ž][a-zá-ž]+(?:\s+[a-zá-ž]+)*)/);
  if (pscMatch) {
    return `V obci ${pscMatch[1]}`;
  }

  return 'V Praze';
}

/** Zaokrouhlí na 2 desetinná místa (odstraní i float šum typu 92828.19000000006) */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Určí část explicitním cast_id, jinak stabilním identifikátorem v názvu šablony. */
export function resolveDocumentCastId(
  document: { filename: string; cast_id?: string },
  availableParts: readonly { id: string }[],
): string | undefined {
  const candidate = document.cast_id?.trim() || extractCastIdFromFilename(document.filename);
  return candidate && availableParts.some((part) => part.id === candidate) ? candidate : undefined;
}

/** Přepne pouze data dokumentu vázaného na část; bez cast_id vrací původní agregát. */
export function scopeDocumentDataToPart(data: DocumentData, castId?: string): DocumentData {
  if (!castId) return data;
  const part = (data.cenova_rekapitulace_po_castech ?? data.casti)
    ?.find((candidate) => candidate.id === castId);
  if (!part) throw new Error(`Pro část ${castId} chybí cenová rekapitulace dokumentu.`);
  return {
    ...data,
    celkova_cena_bez_dph: part.cena_bez_dph,
    celkova_cena_s_dph: part.cena_s_dph,
    dph_castka: round2(part.cena_s_dph - part.cena_bez_dph),
    polozky: data.polozky.filter((item) => item.cast_id === castId),
    casti: [part],
    polozky_bez_cast_id: [],
  };
}

/**
 * Obrana proti regresi, kdy různé části dostaly globální cenu. Stejné přidělené
 * ceny jsou povolené jen tehdy, když jsou stejné i skutečné rekapitulace částí.
 */
export function assertPartDocumentPriceAssignments(
  assignments: readonly PartDocumentPriceAssignment[],
  expectedParts: readonly DocumentDataCast[],
): void {
  const expectedById = new Map(expectedParts.map((part) => [part.id, part]));
  for (let left = 0; left < assignments.length; left++) {
    for (let right = left + 1; right < assignments.length; right++) {
      const a = assignments[left]!;
      const b = assignments[right]!;
      if (a.cast_id === b.cast_id) continue;
      const expectedA = expectedById.get(a.cast_id);
      const expectedB = expectedById.get(b.cast_id);
      if (!expectedA || !expectedB) continue;
      const expectedDiffer = expectedA.cena_bez_dph !== expectedB.cena_bez_dph
        || expectedA.cena_s_dph !== expectedB.cena_s_dph;
      const assignedSame = a.cena_bez_dph === b.cena_bez_dph && a.cena_s_dph === b.cena_s_dph;
      if (expectedDiffer && assignedSame) {
        throw new Error(`Dokumenty ${a.document} (${a.cast_id}) a ${b.document} (${b.cast_id}) dostaly tutéž cenu, přestože ceny částí se liší.`);
      }
    }
  }

  for (const assignment of assignments) {
    const expected = expectedById.get(assignment.cast_id);
    if (!expected) throw new Error(`Dokument ${assignment.document} odkazuje na neznámou část ${assignment.cast_id}.`);
    if (assignment.cena_bez_dph !== expected.cena_bez_dph || assignment.cena_s_dph !== expected.cena_s_dph) {
      throw new Error(`Dokument ${assignment.document} nedostal cenu své části ${assignment.cast_id}.`);
    }
  }
}

/** Formátuje datum jako DD.MM.YYYY */
function formatDatum(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `${day}.${month}.${year}`;
}

/** Načte company profil — respektuje tender-meta.json → company_id override */
export async function loadCompany(tenderId: string): Promise<CompanyProfile> {
  const outputDir = join(ROOT, 'output', tenderId);
  try {
    const meta = JSON.parse(await readFile(join(outputDir, 'tender-meta.json'), 'utf-8'));
    if (meta.company_id) {
      const companyPath = join(ROOT, 'config', 'companies', `${meta.company_id}.json`);
      return JSON.parse(await readFile(companyPath, 'utf-8'));
    }
  } catch {
    // fallback to legacy
  }
  return JSON.parse(await readFile(join(ROOT, 'config', 'company.json'), 'utf-8'));
}

/**
 * Resolves all data needed for document generation into a single DocumentData object.
 */
export async function resolveDocumentData(tenderId: string): Promise<DocumentData> {
  const outputDir = join(ROOT, 'output', tenderId);

  // Load all sources
  const company = await loadCompany(tenderId);
  const analysis: TenderAnalysis = JSON.parse(
    await readFile(join(outputDir, 'analysis.json'), 'utf-8')
  );
  const productMatch: ProductMatch = JSON.parse(
    await readFile(join(outputDir, 'product-match.json'), 'utf-8')
  );

  // Parts selection
  let selectedPartIds: Set<string> | null = null;
  const hasParts = analysis.casti && analysis.casti.length > 1;
  if (hasParts) {
    try {
      const sel = JSON.parse(await readFile(join(outputDir, 'parts-selection.json'), 'utf-8'));
      selectedPartIds = new Set(sel.selected_parts || []);
    } catch {
      selectedPartIds = new Set(analysis.casti.map((c) => c.id));
    }
  }

  // Resolve products + prices (same logic as generate-bid.ts)
  const isMultiProduct = !!productMatch.polozky_match;
  let selectedProducts: Array<{
    polozka: string;
    mnozstvi: number;
    jednotka: string;
    product: ProductCandidate;
    priceBezDph: number;
    priceSdph: number;
    castId?: string;
  }>;

  if (isMultiProduct) {
    let filteredMatch = productMatch.polozky_match!;
    if (selectedPartIds) {
      filteredMatch = filteredMatch.filter(pm => {
        const castId = pm.cast_id;
        return !castId || selectedPartIds!.has(castId);
      });
    }
    selectedProducts = filteredMatch.map(pm => {
      const product = pm.kandidati[pm.vybrany_index];
      const override = pm.cenova_uprava;
      return {
        polozka: pm.polozka_nazev,
        mnozstvi: pm.mnozstvi || 1,
        jednotka: pm.jednotka || 'ks',
        product,
        priceBezDph: override?.nabidkova_cena_bez_dph ?? product.cena_bez_dph,
        priceSdph: override?.nabidkova_cena_s_dph ?? product.cena_s_dph,
        castId: pm.cast_id,
      };
    });
  } else {
    const selectedProduct = productMatch.kandidati![productMatch.vybrany_index!];
    const priceOverride = productMatch.cenova_uprava;
    selectedProducts = [{
      polozka: analysis.zakazka.predmet,
      mnozstvi: 1,
      jednotka: 'ks',
      product: selectedProduct,
      priceBezDph: priceOverride?.nabidkova_cena_bez_dph ?? selectedProduct.cena_bez_dph,
      priceSdph: priceOverride?.nabidkova_cena_s_dph ?? selectedProduct.cena_s_dph,
    }];
  }

  // Řádkové ceny zaokrouhlíme na 2 desetinná místa; celkové ceny počítáme jako součet
  // těchto zaokrouhlených řádků → Σ položek == celková cena (žádný drift z per-item zaokrouhlení).
  const lines = selectedProducts.map(p => ({
    ...p,
    lineBezDph: round2(p.priceBezDph * p.mnozstvi),
    lineSdph: round2(p.priceSdph * p.mnozstvi),
  }));

  const priceRecap = calculateTenderPriceRecap(productMatch, analysis.casti ?? [], selectedPartIds);
  const celkova_cena_bez_dph = priceRecap.celkova_cena_bez_dph;
  const celkova_cena_s_dph = priceRecap.celkova_cena_s_dph;
  const dph_castka = round2(celkova_cena_s_dph - celkova_cena_bez_dph);

  // Build items
  const polozky: DocumentDataItem[] = lines.map(l => ({
    nazev: l.polozka,
    mnozstvi: l.mnozstvi,
    jednotka: l.jednotka,
    cena_za_jednotku_bez_dph: l.priceBezDph,
    cena_celkem_bez_dph: l.lineBezDph,
    cast_id: l.castId,
  }));

  // Sdílená rekapitulace je současně zdrojem pro dokumenty vázané na část.
  const casti: DocumentDataCast[] | undefined = hasParts
    ? priceRecap.casti.filter((part) => !selectedPartIds || selectedPartIds.has(part.id))
    : undefined;
  for (const item of priceRecap.polozky_bez_cast_id) {
    console.warn(
      `  ⚠ Položka „${item.polozka_nazev}“ (#${item.polozka_index + 1}) nemá u dělené zakázky cast_id a není zahrnuta v rekapitulaci žádné části.`,
    );
  }

  // Povinná pole zakázky: zástupný text z analýzy (AI hedge) do formálního dokumentu nepatří.
  // Zadavatele bereme jako placeholder i při prázdnu (bez zadavatele nelze podat); u evidenčního
  // čísla jen zástupný TEXT (prázdno je u VZMR legitimní). Placeholder pole vyprázdníme (builder → —)
  // a nastavíme příznak pro field-validaci.
  const zadavatelRaw = analysis.zakazka.zadavatel.nazev || '';
  const zadavatelIsPlaceholder = isPlaceholderValue(zadavatelRaw);
  const evidencniRaw = analysis.zakazka.evidencni_cislo || '';
  const evidencniIsPlaceholder = hasPlaceholderText(evidencniRaw);
  const zadavatelIcoRaw = analysis.zakazka.zadavatel.ico || '';

  return {
    // Tender
    nazev_zakazky: analysis.zakazka.nazev,
    evidencni_cislo: evidencniIsPlaceholder ? '' : evidencniRaw,
    zadavatel_nazev: zadavatelIsPlaceholder ? '' : zadavatelRaw,
    zadavatel_ico: hasPlaceholderText(zadavatelIcoRaw) ? '' : zadavatelIcoRaw,
    zadavatel_placeholder: zadavatelIsPlaceholder,
    evidencni_cislo_placeholder: evidencniIsPlaceholder,
    predmet: analysis.zakazka.predmet,

    // Company
    nazev: company.nazev,
    ico: company.ico,
    dic: company.dic,
    sidlo: company.sidlo,
    jednajici_osoba: company.jednajici_osoba,
    email: company.email,
    telefon: company.telefon,
    datova_schranka: company.datova_schranka,
    rejstrik: company.rejstrik,
    ucet: company.ucet,
    iban: company.iban,
    bic: company.bic,

    // Prices
    celkova_cena_bez_dph,
    celkova_cena_s_dph,
    dph_sazba: '21',
    dph_castka,

    // Items
    polozky,

    // Multi-part
    casti,
    cenova_rekapitulace_po_castech: hasParts ? priceRecap.casti : undefined,
    polozky_bez_cast_id: hasParts ? priceRecap.polozky_bez_cast_id : undefined,

    // Meta
    datum: formatDatum(),
    misto: extractMisto(company.sidlo),
  };
}
