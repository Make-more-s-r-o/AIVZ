/**
 * DataResolver — centrální zdroj dat pro generování dokumentů.
 * Načte company, analysis, product-match, parts-selection a vrátí
 * jednotný DocumentData interface pro všechny buildery.
 */
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { TenderAnalysis, ProductMatch, ProductCandidate } from './types.js';

const ROOT = new URL('../../../', import.meta.url).pathname;

// Generation mode for each document
export type DocMode = 'clean' | 'reconstruct' | 'fill';

/** Metadata about generated document mode */
export interface GenerationMeta {
  [filename: string]: {
    mode: DocMode;
    source: 'clean-builder' | 'reconstruct-engine' | 'ai-fill' | 'excel-ai' | 'programmatic';
    cost_czk: number;
    template_source?: string;
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

  // Meta
  datum: string;
  misto: string;
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

  // Calculate totals
  const celkova_cena_bez_dph = selectedProducts.reduce((s, p) => s + p.priceBezDph * p.mnozstvi, 0);
  const celkova_cena_s_dph = selectedProducts.reduce((s, p) => s + p.priceSdph * p.mnozstvi, 0);
  const dph_castka = celkova_cena_s_dph - celkova_cena_bez_dph;

  // Build items
  const polozky: DocumentDataItem[] = selectedProducts.map(p => ({
    nazev: p.polozka,
    mnozstvi: p.mnozstvi,
    jednotka: p.jednotka,
    cena_za_jednotku_bez_dph: p.priceBezDph,
    cena_celkem_bez_dph: p.priceBezDph * p.mnozstvi,
    cast_id: p.castId,
  }));

  // Build casti (multi-part)
  let casti: DocumentDataCast[] | undefined;
  if (hasParts && selectedPartIds) {
    casti = analysis.casti
      .filter(c => selectedPartIds!.has(c.id))
      .map(c => {
        const castItems = polozky.filter(p => p.cast_id === c.id);
        const castBezDph = castItems.reduce((s, p) => s + p.cena_celkem_bez_dph, 0);
        return {
          id: c.id,
          nazev: c.nazev,
          cena_bez_dph: castBezDph,
          cena_s_dph: Math.round(castBezDph * 1.21 * 100) / 100,
        };
      });
  }

  return {
    // Tender
    nazev_zakazky: analysis.zakazka.nazev,
    evidencni_cislo: analysis.zakazka.evidencni_cislo || '',
    zadavatel_nazev: analysis.zakazka.zadavatel.nazev,
    zadavatel_ico: analysis.zakazka.zadavatel.ico || '',
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

    // Meta
    datum: formatDatum(),
    misto: extractMisto(company.sidlo),
  };
}
