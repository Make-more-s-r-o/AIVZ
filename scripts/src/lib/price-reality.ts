import type { WebPriceSource } from './types.js';

export interface PriceReality {
  nejlevnejsi_bez_dph: number | null;
  rozdil_procent: number | null;
  pod_trhem: boolean;
  nejlevnejsi_dodavatel?: string | null;
  nejlevnejsi_zdroj_url?: string | null;
  poznamka?: string | null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Vrátí cenu celého balení použitou pro ochranu proti ztrátě.
 * Je-li čistá cena neznámá a sazba DPH nejasná, použije hrubou cenu jako
 * konzervativní horní odhad nákladu.
 */
function packageCostForGuard(source: WebPriceSource): number | null {
  const net = positiveNumber(source.cena_bez_dph);
  if (net !== null) return net;

  const gross = positiveNumber(source.cena_baleni_s_dph ?? source.cena_s_dph);
  if (gross === null) return null;
  if (source.sazba_dph === null) return gross;

  const rate = positiveNumber(source.sazba_dph) ?? 21;
  return Math.round((gross / (1 + rate / 100)) * 100) / 100;
}

/**
 * Skutečný nákupní náklad pro požadované množství. Kupují se vždy celá balení;
 * neznámé balení vrací null a nesmí ovlivnit peněžní gate.
 */
export function realCostForQuantity(source: WebPriceSource, mnozstvi: number): number | null {
  // Kritický money-path invariant: nedoložená shoda nikdy nesmí aktivovat HARD gate.
  if (source.orientacni === true) return null;
  const packageSize = positiveNumber(source.baleni_ks);
  const packageCost = packageCostForGuard(source);
  const quantity = positiveNumber(mnozstvi);
  if (packageSize === null || packageCost === null || quantity === null) return null;
  return Math.ceil(quantity / packageSize) * packageCost;
}

/**
 * Referenční náklad pro neblokující WARN. Na rozdíl od HARD guardu smí číst i
 * orientační zdroj, ale nesmí být použit jako autoritativní nákupní cena.
 */
export function informationalCostForQuantity(source: WebPriceSource, mnozstvi: number): number | null {
  const packageSize = positiveNumber(source.baleni_ks);
  const packageCost = packageCostForGuard(source);
  const quantity = positiveNumber(mnozstvi);
  if (packageSize === null || packageCost === null || quantity === null) return null;
  return Math.ceil(quantity / packageSize) * packageCost;
}

function isAvailableForGuard(source: WebPriceSource): boolean {
  const availability = String(source.dostupnost ?? '').trim().toLocaleLowerCase('cs-CZ');
  if (/nen[ií]\s+skladem|vyprod[aá]no|nedostup|na\s+dotaz|objedn[aá]vk/.test(availability)) return false;
  // Prázdná nebo nerozpoznaná historická hodnota se normalizuje na „neznámá“.
  return true;
}

/**
 * Porovná AI odhad s nejlevnějším použitelným reálným nákupem. Rozdíl vůči AI
 * zůstává informativní; ztrátový gate později porovnává přímo nabídkovou cenu.
 */
export function compareAiVsMarket(
  aiCenaBezDph: number | null,
  zdroje: WebPriceSource[],
  mnozstvi = 1,
): PriceReality {
  const quantity = positiveNumber(mnozstvi) ?? 1;
  const usable = zdroje
    .filter(isAvailableForGuard)
    .map((source) => {
      const total = realCostForQuantity(source, quantity);
      return total === null ? null : { source, unit: total / quantity };
    })
    .filter((entry): entry is { source: WebPriceSource; unit: number } => entry !== null)
    .sort((a, b) => a.unit - b.unit);

  const cheapest = usable[0];
  const market = cheapest?.unit ?? null;
  const validAi = positiveNumber(aiCenaBezDph);
  const excludedUnavailable = zdroje.some((source) => !isAvailableForGuard(source));
  const excludedOrientational = zdroje.some((source) => source.orientacni === true);
  const excludedPackaging = zdroje.some((source) => source.orientacni !== true && isAvailableForGuard(source) && positiveNumber(source.baleni_ks) === null);

  const notes: string[] = [];
  if (zdroje.length > 0 && usable.length === 0) notes.push('Žádný použitelný zdroj pro ochranu proti ztrátě.');
  if (excludedUnavailable) notes.push('Nedostupné zdroje a zdroje na dotaz byly z ochrany vyloučeny.');
  if (excludedOrientational) notes.push('Orientační zdroje bez doložené shody parametrů byly z ochrany proti ztrátě vyloučeny.');
  if (excludedPackaging) notes.push('Zdroj s nejasným počtem kusů v balení byl z ochrany vyloučen.');
  if (cheapest?.source.sazba_dph === null) notes.push('Kvůli nejasné sazbě DPH byla použita cena s DPH jako konzervativní horní odhad.');

  if (market === null || validAi === null) {
    return {
      nejlevnejsi_bez_dph: market,
      rozdil_procent: null,
      pod_trhem: false,
      ...(cheapest ? {
        nejlevnejsi_dodavatel: cheapest.source.dodavatel,
        nejlevnejsi_zdroj_url: cheapest.source.url,
      } : {}),
      ...(notes.length > 0 ? { poznamka: notes.join(' ') } : {}),
    };
  }

  const difference = ((market - validAi) / validAi) * 100;
  return {
    nejlevnejsi_bez_dph: Math.round(market * 100) / 100,
    rozdil_procent: Math.round(difference * 10) / 10,
    pod_trhem: market > validAi,
    nejlevnejsi_dodavatel: cheapest?.source.dodavatel ?? null,
    nejlevnejsi_zdroj_url: cheapest?.source.url ?? null,
    ...(notes.length > 0 ? { poznamka: notes.join(' ') } : {}),
  };
}
