/** Čistá příprava nákupních položek z product-match a webových nálezů. */
import type { ProductMatch, TenderAnalysis } from './types.js';
import type { WebFindingRow } from './web-findings-store.js';
import type { NakupItemInput } from './nakupy-store.js';

interface SupplierLink {
  dodavatel: string | null;
  url: string | null;
}

interface SeedableMatchItem {
  polozka_index: number;
  polozka_nazev: string;
  mnozstvi?: number | null;
  jednotka?: string | null;
  cenova_uprava?: NonNullable<ProductMatch['cenova_uprava']>;
  overeni_ceny?: ProductMatch['overeni_ceny'];
}

export interface NakupySeedPlan {
  items: NakupItemInput[];
  vynechane_nepotvrzene: number;
}

/** Porovnávací cena s DPH; všechny zdroje tak soutěží ve stejné daňové bázi. */
function sourcePrice(source: { cena_bez_dph?: number | null; cena_s_dph?: number | null }): number {
  if (typeof source.cena_s_dph === 'number') return source.cena_s_dph;
  if (typeof source.cena_bez_dph === 'number') return source.cena_bez_dph * 1.21;
  return Number.POSITIVE_INFINITY;
}

function cheapest<T extends { cena_bez_dph?: number | null; cena_s_dph?: number | null }>(items: T[]): T | undefined {
  return items.reduce<T | undefined>((best, item) => (
    !best || sourcePrice(item) < sourcePrice(best) ? item : best
  ), undefined);
}

/** Priorita zdroje: volba operátora → multi-source ověření → legacy ověření → findings → prázdno. */
export function selectSupplierLink(
  item: SeedableMatchItem,
  findings: WebFindingRow[],
): SupplierLink {
  const operatorSource = item.cenova_uprava?.zdroj_nakupu;
  if (operatorSource?.url) {
    return { dodavatel: operatorSource.dodavatel ?? null, url: operatorSource.url };
  }

  const sources = item.overeni_ceny?.zdroje?.filter((source) => !!source.url) ?? [];
  if (sources.length > 0) {
    const selected = cheapest(sources)!;
    return { dodavatel: selected.dodavatel ?? null, url: selected.url };
  }

  if (item.overeni_ceny?.zdroj_url) {
    return {
      dodavatel: item.overeni_ceny.dodavatel ?? null,
      url: item.overeni_ceny.zdroj_url,
    };
  }

  const matchingFindings = findings.filter((finding) => finding.polozka_index === item.polozka_index);
  const selectedFinding = cheapest(matchingFindings);
  if (selectedFinding) {
    return { dodavatel: selectedFinding.dodavatel ?? null, url: selectedFinding.url };
  }

  return { dodavatel: null, url: null };
}

function legacyItem(productMatch: ProductMatch, analysis?: TenderAnalysis): SeedableMatchItem | null {
  if (productMatch.polozky_match !== undefined) return null;
  const selected = productMatch.kandidati?.[productMatch.vybrany_index ?? 0];
  const analysisItem = analysis?.polozky?.[0];
  const candidateName = [selected?.vyrobce, selected?.model].filter(Boolean).join(' ').trim();
  return {
    polozka_index: 0,
    polozka_nazev: candidateName || analysisItem?.nazev || analysis?.zakazka.predmet || analysis?.zakazka.nazev || 'Položka',
    mnozstvi: analysisItem?.mnozstvi ?? 1,
    jednotka: analysisItem?.jednotka ?? 'ks',
    cenova_uprava: productMatch.cenova_uprava,
    overeni_ceny: productMatch.overeni_ceny,
  };
}

/**
 * Vrátí všechny aktuálně potvrzené položky pro upsert. Nepotvrzené položky do DB
 * neposílá, aby starší potvrzený řádek zůstal beze změny, a pouze je spočítá do odpovědi.
 */
export function buildNakupySeedPlan(
  productMatch: ProductMatch,
  findings: WebFindingRow[],
  analysis?: TenderAnalysis,
): NakupySeedPlan {
  const legacy = legacyItem(productMatch, analysis);
  const sourceItems: SeedableMatchItem[] = legacy ? [legacy] : (productMatch.polozky_match ?? []);
  const confirmed = sourceItems.filter((item) => item.cenova_uprava?.potvrzeno === true);

  return {
    items: confirmed.map((item) => {
      const supplier = selectSupplierLink(item, findings);
      return {
        polozka_index: item.polozka_index,
        polozka_nazev: item.polozka_nazev,
        mnozstvi: item.mnozstvi ?? null,
        jednotka: item.jednotka ?? null,
        nakupni_cena_bez_dph: item.cenova_uprava!.nakupni_cena_bez_dph,
        dodavatel: supplier.dodavatel,
        url: supplier.url,
      };
    }),
    vynechane_nepotvrzene: sourceItems.length - confirmed.length,
  };
}

/** Zpětně kompatibilní pomocník pro volající, kteří potřebují jen řádky. */
export function buildNakupySeedItems(
  productMatch: ProductMatch,
  findings: WebFindingRow[],
  _existing: Array<{ polozka_index: number }> = [],
  analysis?: TenderAnalysis,
): NakupItemInput[] {
  return buildNakupySeedPlan(productMatch, findings, analysis).items;
}
