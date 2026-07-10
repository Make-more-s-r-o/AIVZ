import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  BID_SHARE_THRESHOLD,
  LOW_CONFIDENCE_BIG_THRESHOLD,
  OUTLIER_VS_BATCH_MULTIPLIER,
  checkPriceSanity,
} from '../src/lib/price-sanity.js';
import type { PolozkaMatch, ProductCandidate } from '../src/lib/types.js';

function item(
  polozkaIndex: number,
  priceWithVat: number,
  options: {
    quantity?: number;
    cap?: number;
    confidence?: 'vysoka' | 'stredni' | 'nizka';
    purchaseWithoutVat?: number;
    offerWithoutVat?: number;
    withOverride?: boolean;
  } = {},
): PolozkaMatch {
  const priceWithoutVat = options.offerWithoutVat ?? priceWithVat / 1.21;
  const purchaseWithoutVat = options.purchaseWithoutVat ?? priceWithoutVat;
  const candidate: ProductCandidate = {
    vyrobce: 'Test',
    model: `Model ${polozkaIndex}`,
    popis: 'Testovací kandidát',
    parametry: {},
    shoda_s_pozadavky: [],
    cena_bez_dph: purchaseWithoutVat,
    cena_s_dph: priceWithVat,
    cena_spolehlivost: options.confidence ?? 'vysoka',
    dodavatele: [],
    dostupnost: 'skladem',
  };

  return {
    polozka_nazev: `Položka ${polozkaIndex}`,
    polozka_index: polozkaIndex,
    mnozstvi: options.quantity ?? 1,
    cena_max_s_dph: options.cap,
    typ: 'produkt',
    kandidati: [candidate],
    vybrany_index: 0,
    oduvodneni_vyberu: 'Test',
    cenova_uprava: options.withOverride === false ? undefined : {
      nakupni_cena_bez_dph: purchaseWithoutVat,
      nakupni_cena_s_dph: purchaseWithoutVat * 1.21,
      marze_procent: 0,
      nabidkova_cena_bez_dph: priceWithoutVat,
      nabidkova_cena_s_dph: priceWithVat,
      potvrzeno: false,
    },
  };
}

function codes(items: PolozkaMatch[]): string[] {
  return checkPriceSanity(items, {}).map((finding) => finding.code);
}

test('exportuje pevné kontrolní hranice', () => {
  assert.equal(BID_SHARE_THRESHOLD, 0.40);
  assert.equal(LOW_CONFIDENCE_BIG_THRESHOLD, 0.10);
  assert.equal(OUTLIER_VS_BATCH_MULTIPLIER, 50);
});

test('overcap: cena nad stropem je HARD', () => {
  const findings = checkPriceSanity([item(7, 280_000, { cap: 39_999 })], {});
  assert.equal(findings.length, 1);
  assert.deepEqual(
    { level: findings[0]?.level, code: findings[0]?.code, polozka_index: findings[0]?.polozka_index },
    { level: 'hard', code: 'overcap', polozka_index: 7 },
  );
});

test('zero_price: nulová i záporná cena jsou HARD', () => {
  const findings = checkPriceSanity([item(0, 0), item(1, -1)], {});
  assert.deepEqual(findings.map((finding) => [finding.polozka_index, finding.level, finding.code]), [
    [0, 'hard', 'zero_price'],
    [1, 'hard', 'zero_price'],
  ]);
});

test('below_cost: prodej pod nákupní cenou je HARD', () => {
  const findings = checkPriceSanity([
    item(0, 968, { purchaseWithoutVat: 1_000, offerWithoutVat: 800 }),
  ], {});
  assert.equal(findings.some((finding) => finding.level === 'hard' && finding.code === 'below_cost'), true);
});

test('bid_share: přes 40 % se varuje jen u více než tří položek', () => {
  const fourItems = [item(0, 410), item(1, 200), item(2, 200), item(3, 190)];
  assert.equal(codes(fourItems).includes('bid_share'), true);
  assert.equal(codes(fourItems.slice(0, 3)).includes('bid_share'), false);
});

test('low_confidence_big: nízká spolehlivost nad 10 % bidu je WARN', () => {
  const findings = checkPriceSanity([
    item(0, 11, { confidence: 'nizka' }),
    item(1, 89),
  ], {});
  assert.equal(findings.some((finding) => finding.level === 'warn' && finding.code === 'low_confidence_big'), true);
});

test('outlier_vs_batch: u osmi položek odhalí cenu nad 50× mediánem ostatních', () => {
  const items = Array.from({ length: 7 }, (_, index) => item(index, 100));
  items.push(item(7, 5_001));
  assert.equal(codes(items).includes('outlier_vs_batch'), true);
  assert.equal(codes(items.slice(1)).includes('outlier_vs_batch'), false);
});

test('kombinuje nálezy a bez cenova_uprava použije vybraného kandidáta', () => {
  const items = [
    item(10, 600, { cap: 500, confidence: 'nizka', withOverride: false }),
    item(11, 100),
    item(12, 100),
    item(13, 100),
  ];
  const findings = checkPriceSanity(items, { polozkaIndexes: [10] });
  assert.deepEqual(findings.map((finding) => finding.code), ['overcap', 'bid_share', 'low_confidence_big']);
  assert.equal(findings.every((finding) => finding.polozka_index === 10), true);
});
