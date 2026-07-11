import type { WebPriceSource } from './types.js';

export interface PriceReality {
  nejlevnejsi_bez_dph: number | null;
  rozdil_procent: number | null;
  pod_trhem: boolean;
}

/** Vrátí použitelnou jednotkovou cenu zdroje bez DPH; chybějící DPH dopočítá sazbou 21 %. */
function sourceNetPrice(source: WebPriceSource): number | null {
  const direct = source.cena_bez_dph;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct;

  const gross = source.cena_s_dph;
  if (typeof gross === 'number' && Number.isFinite(gross) && gross > 0) {
    return Math.round((gross / 1.21) * 100) / 100;
  }
  return null;
}

/**
 * Porovná AI odhad s nejlevnější reálnou jednotkovou nákupní cenou bez DPH.
 * Přesně pětiprocentní rozdíl ještě není flag; riziko vzniká až při rozdílu > 5 %.
 */
export function compareAiVsMarket(
  aiCenaBezDph: number | null,
  zdroje: WebPriceSource[],
): PriceReality {
  const marketPrices = zdroje
    .map(sourceNetPrice)
    .filter((price): price is number => price !== null);
  const market = marketPrices.length > 0 ? Math.min(...marketPrices) : null;
  const validAi = typeof aiCenaBezDph === 'number' && Number.isFinite(aiCenaBezDph) && aiCenaBezDph > 0
    ? aiCenaBezDph
    : null;

  if (market === null || validAi === null) {
    return { nejlevnejsi_bez_dph: market, rozdil_procent: null, pod_trhem: false };
  }

  const difference = ((market - validAi) / validAi) * 100;
  return {
    nejlevnejsi_bez_dph: market,
    rozdil_procent: Math.round(difference * 10) / 10,
    pod_trhem: market > validAi * 1.05,
  };
}
