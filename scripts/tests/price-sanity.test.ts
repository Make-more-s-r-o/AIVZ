import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  BID_SHARE_THRESHOLD,
  LOW_CONFIDENCE_BIG_THRESHOLD,
  OUTLIER_VS_BATCH_MULTIPLIER,
  EXTREME_OUTLIER_BID_SHARE,
  EXTREME_OUTLIER_MEDIAN_MULTIPLIER,
  EXTREME_OUTLIER_MIN_ITEMS,
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
    marketWithoutVat?: number;
    aiBelowMarket?: boolean;
    lossOverride?: boolean;
    orientationalMarket?: boolean;
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

  const result: PolozkaMatch = {
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
      ...(options.lossOverride ? {
        override_pod_nakupem: {
          potvrzeno: true as const,
          duvod: 'Mám lepší cenu u vlastního dodavatele',
        },
      } : {}),
    },
  };
  if (options.marketWithoutVat !== undefined) {
    result.overeni_ceny = {
      stav: 'nalezeno',
      shoda_typ: 'presny',
      dodavatel: 'Reálný dodavatel',
      overeno_at: '2026-07-11T10:00:00.000Z',
      zdroje: [{
        url: 'https://realny-dodavatel.cz/produkt',
        dodavatel: 'Reálný dodavatel',
        cena_bez_dph: options.marketWithoutVat,
        cena_s_dph: options.marketWithoutVat * 1.21,
        cena_baleni_s_dph: options.marketWithoutVat * 1.21,
        baleni_ks: 1,
        mena: 'CZK',
        sazba_dph: 21,
        dostupnost: 'skladem',
        poznamka: null,
        ...(options.orientationalMarket ? { orientacni: true } : {}),
      }],
      realita: {
        nejlevnejsi_bez_dph: options.marketWithoutVat,
        rozdil_procent: 25,
        pod_trhem: options.aiBelowMarket ?? true,
      },
    };
  }
  return result;
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

test('H1: cena_pod_nakupem je HARD a obsahuje přímá čísla i zdroj', () => {
  const findings = checkPriceSanity([
    item(4, 121, { offerWithoutVat: 100, purchaseWithoutVat: 80, marketWithoutVat: 120 }),
  ]);
  const finding = findings.find((candidate) => candidate.code === 'cena_pod_nakupem');
  assert.ok(finding);
  assert.equal(finding.level, 'hard');
  assert.match(finding.message, /Nabídková cena 100 Kč.*nákupní náklad 120 Kč.*Reálný dodavatel.*nelze cenu potvrdit ani nabídku podat/);
});

test('H2: guard nestaví na uloženém reality flagu ani na AI odhadu', () => {
  const findings = checkPriceSanity([
    item(4, 121, {
      offerWithoutVat: 100,
      purchaseWithoutVat: 80,
      marketWithoutVat: 120,
      aiBelowMarket: false,
    }),
  ]);
  assert.equal(findings.some((candidate) => candidate.code === 'cena_pod_nakupem' && candidate.level === 'hard'), true);
});

test('cena_pod_nakupem: nevznikne, když je potvrzovaná nabídka alespoň na reálném nákupu', () => {
  const findings = checkPriceSanity([
    item(4, 145.2, { offerWithoutVat: 120, purchaseWithoutVat: 100, marketWithoutVat: 120 }),
  ]);
  assert.equal(findings.some((candidate) => candidate.code === 'cena_pod_nakupem'), false);
});

test('H1: auditovaný override s dostatečným důvodem ztrátový gate propustí', () => {
  const findings = checkPriceSanity([
    item(4, 121, { offerWithoutVat: 100, purchaseWithoutVat: 80, marketWithoutVat: 120, lossOverride: true }),
  ]);
  assert.equal(findings.some((candidate) => candidate.code === 'cena_pod_nakupem'), false);
});

test('orientační cena nad nabídkou vytvoří jen WARN a nikdy HARD cena_pod_nakupem', () => {
  const findings = checkPriceSanity([
    item(4, 121, {
      offerWithoutVat: 100,
      purchaseWithoutVat: 80,
      marketWithoutVat: 150,
      orientationalMarket: true,
    }),
  ]);

  assert.equal(findings.some((finding) => finding.code === 'cena_pod_nakupem'), false);
  const warning = findings.find((finding) => finding.code === 'orientacni_cena_nad_nabidkou');
  assert.equal(warning?.level, 'warn');
  assert.match(warning?.message ?? '', /Parametry produktu nejsou doložené/);
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

test('genericky_kandidat: produkt bez modelu i katalogového čísla vytvoří WARN', () => {
  const generic = item(0, 121);
  generic.kandidati[0]!.model = '';
  const findings = checkPriceSanity([generic]);
  const warning = findings.find((finding) => finding.code === 'genericky_kandidat');
  assert.equal(warning?.level, 'warn');
  assert.equal(warning?.message, 'Kandidát není jednoznačně identifikován — cenu ověřte.');
});

test('genericky_kandidat nevznikne s modelem, katalogovým číslem ani pro službu', () => {
  const withModel = item(0, 121);
  const withCatalogue = item(1, 121);
  withCatalogue.kandidati[0]!.model = '';
  withCatalogue.kandidati[0]!.katalogove_cislo = 'ABC-1';
  const service = item(2, 121);
  service.typ = 'sluzba';
  service.kandidati[0]!.model = '';
  assert.equal(checkPriceSanity([withModel, withCatalogue, service]).some((finding) => finding.code === 'genericky_kandidat'), false);
});

test('outlier_vs_batch: u osmi položek odhalí cenu nad 50× mediánem ostatních', () => {
  const items = Array.from({ length: 7 }, (_, index) => item(index, 100));
  items.push(item(7, 5_001));
  assert.equal(codes(items).includes('outlier_vs_batch'), true);
  assert.equal(codes(items.slice(1)).includes('outlier_vs_batch'), false);
});

test('exportuje pevné hranice extrémního outlieru', () => {
  assert.equal(EXTREME_OUTLIER_BID_SHARE, 0.60);
  assert.equal(EXTREME_OUTLIER_MEDIAN_MULTIPLIER, 30);
  assert.equal(EXTREME_OUTLIER_MIN_ITEMS, 5);
});

test('extreme_outlier: položka bez stropu za 280k mezi 57 běžnými je HARD (regrese N-485400)', () => {
  // 56 běžných položek ~1000 Kč s DPH + 1 halucinovaný „adaptér" za 280 000 Kč, žádné stropy.
  const items: PolozkaMatch[] = [];
  for (let i = 0; i < 56; i++) items.push(item(i, 1_000));
  const bigIndex = 56;
  items.push(item(bigIndex, 280_000)); // cap undefined → bez stropu
  const findings = checkPriceSanity(items, {});
  const hardExtreme = findings.find(
    (f) => f.level === 'hard' && f.code === 'extreme_outlier' && f.polozka_index === bigIndex,
  );
  assert.ok(hardExtreme, 'očekávám HARD extreme_outlier na 280k položce');
});

test('extreme_outlier: legitimně drahá JEDINÁ položka (single-item) není HARD', () => {
  const findings = checkPriceSanity([item(0, 280_000)], {});
  assert.equal(findings.some((f) => f.code === 'extreme_outlier'), false);
});

test('extreme_outlier: legit drahý server (vysoký násobek mediánu, ale malý podíl bidu) NENÍ HARD', () => {
  // AND, ne OR: 10 běžných položek à 20 000 Kč (Σ 200k) + 1 server 150k = 43 % bidu (< 60 %),
  // ale 7,5× medián → NESMÍ být HARD (jinak by legit drahá položka blokovala podání).
  const items: PolozkaMatch[] = [];
  for (let i = 0; i < 10; i++) items.push(item(i, 20_000));
  items.push(item(10, 150_000));
  const findings = checkPriceSanity(items, {});
  assert.equal(findings.some((f) => f.code === 'extreme_outlier'), false, 'legit drahá položka nesmí být HARD extreme_outlier');
});

test('extreme_outlier: položka SE stropem řeší overcap, ne extreme_outlier', () => {
  // 5 položek, drahá má strop → nesmí padnout jako extreme_outlier (má overcap).
  const items = [
    item(0, 280_000, { cap: 39_999 }),
    item(1, 1_000), item(2, 1_000), item(3, 1_000), item(4, 1_000),
  ];
  const found = checkPriceSanity(items, {});
  assert.equal(found.some((f) => f.code === 'extreme_outlier'), false);
  assert.equal(found.some((f) => f.level === 'hard' && f.code === 'overcap' && f.polozka_index === 0), true);
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
