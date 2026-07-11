import type { PolozkaMatch, ProductMatch, WebPriceSource } from '../types/tender';
import { calculateItemPrice, roundCurrency } from './price-calculator';

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function packageCostWithoutVat(source: WebPriceSource): number | null {
  const net = positiveNumber(source.cena_bez_dph);
  if (net !== null) return net;
  const gross = positiveNumber(source.cena_baleni_s_dph ?? source.cena_s_dph);
  if (gross === null) return null;
  if (source.sazba_dph === null) return gross;
  const rate = positiveNumber(source.sazba_dph) ?? 21;
  return roundCurrency(gross / (1 + rate / 100));
}

function sourceIsAvailable(source: WebPriceSource): boolean {
  const availability = String(source.dostupnost ?? '').trim().toLocaleLowerCase('cs-CZ');
  return !/nen[ií]\s+skladem|vyprod[aá]no|nedostup|na\s+dotaz|objedn[aá]vk/.test(availability);
}

function currentFingerprint(item: PolozkaMatch): string | null {
  const selected = item.kandidati[item.vybrany_index];
  return selected ? `${selected.vyrobce.trim()}|${selected.model.trim()}|${item.vybrany_index}` : null;
}

/** Nejlevnější doložený nákup jednotky po započtení celých balení. */
export function verifiedUnitPurchasePrice(item: PolozkaMatch): number | null {
  const verification = item.overeni_ceny;
  if (!verification?.kandidat_fingerprint
    || verification.kandidat_fingerprint !== currentFingerprint(item)
    || verification.stav === 'orientacni') return null;

  const quantity = positiveNumber(item.mnozstvi) ?? 1;
  const prices = (verification.zdroje ?? []).flatMap((source) => {
    if (source.orientacni === true || !sourceIsAvailable(source)) return [];
    const pack = positiveNumber(source.baleni_ks);
    const cost = packageCostWithoutVat(source);
    if (pack === null || cost === null) return [];
    return [Math.ceil(quantity / pack) * cost / quantity];
  });
  if (prices.length === 0) return null;
  return roundCurrency(Math.min(...prices));
}

export interface MarketPriceImpact {
  eligibleCount: number;
  purchaseWithoutVat: number;
  offerWithoutVat: number;
  todayOfferWithoutVat: number;
  effectiveMarginPercent: number;
}

/** Souhrn pro potvrzovací dialog hromadného předvyplnění. */
export function marketPriceImpact(match: ProductMatch, defaultMargin: number): MarketPriceImpact {
  const items = match.polozky_match ?? [];
  let eligibleCount = 0;
  let purchase = 0;
  let offer = 0;
  let today = 0;

  for (const item of items) {
    const quantity = positiveNumber(item.mnozstvi) ?? 1;
    const selected = item.kandidati[item.vybrany_index];
    const unitPurchase = verifiedUnitPurchasePrice(item);
    if (unitPurchase === null) continue;
    const margin = item.cenova_uprava?.marze_procent ?? defaultMargin;
    eligibleCount += 1;
    purchase += unitPurchase * quantity;
    offer += calculateItemPrice(unitPurchase, margin).nabidkova_cena_bez_dph * quantity;
    // „Dnes“ porovnává stejný rozsah N způsobilých položek, ne celý tender.
    today += (item.cenova_uprava?.nabidkova_cena_bez_dph ?? selected?.cena_bez_dph ?? 0) * quantity;
  }

  return {
    eligibleCount,
    purchaseWithoutVat: roundCurrency(purchase),
    offerWithoutVat: roundCurrency(offer),
    todayOfferWithoutVat: roundCurrency(today),
    effectiveMarginPercent: purchase > 0 ? roundCurrency((offer / purchase - 1) * 100) : 0,
  };
}
