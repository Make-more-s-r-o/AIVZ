import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  BID_BELOW_MARKET_PENALTY,
  BID_NONEXISTENT_CANDIDATE_PENALTY,
  BID_FACTOR_NAMES,
  GO_NO_GO_FACTOR_NAMES,
  serializeBidFeatureVector,
  serializeGoNoGoFeatureVector,
  scoreGoNoGo,
  scoreBid,
} from '../src/lib/go-no-go.js';
import {
  DEFAULT_GO_NO_GO_WEIGHTS,
  GO_NO_GO_CONFIG_PATH,
  loadGoNoGoWeights,
  resolveGoNoGoWeights,
} from '../src/lib/go-no-go-config.js';
import { TenderAnalysisSchema, type ProductMatch, type TenderAnalysis } from '../src/lib/types.js';
import type { PriceBand } from '../src/lib/winprice-query.js';

const KEYWORD_FILTERS = {
  IT: ['notebook', 'server', 'počítač'],
  AV: ['projektor', 'audio'],
  nabytek: ['židle', 'stůl'],
};

function analysis(overrides: {
  predmet?: string;
  expectedValue?: number | null;
  deadline?: string | null;
  extractedAt?: string;
  sectors?: string[];
} = {}): TenderAnalysis & {
  extractedAt?: string;
  obory?: string[];
  keyword_filters?: Record<string, string[]>;
} {
  const predmet = overrides.predmet ?? 'Dodávka notebooků a serverů';
  return {
    zakazka: {
      nazev: 'Testovací zakázka',
      zadavatel: { nazev: 'Testovací zadavatel' },
      predmet,
      predpokladana_hodnota: overrides.expectedValue === undefined ? 5_000_000 : overrides.expectedValue,
      typ_zakazky: 'Dodávky',
      typ_rizeni: 'Otevřené řízení',
    },
    kvalifikace: [],
    hodnotici_kriteria: [],
    terminy: { lhuta_nabidek: overrides.deadline ?? '2026-08-01T00:00:00.000Z' },
    casti: [],
    polozky: [{ nazev: predmet, specifikace: predmet }],
    technicke_pozadavky: [],
    rizika: [],
    doporuceni: { rozhodnuti: 'ZVAZIT', oduvodneni: 'Test', klicove_body: [] },
    extractedAt: overrides.extractedAt ?? '2026-07-01T00:00:00.000Z',
    obory: overrides.sectors ?? ['IT', 'AV'],
    keyword_filters: KEYWORD_FILTERS,
  };
}

function productMatch(successfulItems: number, totalItems: number, unitPrice = 100_000): ProductMatch {
  return {
    tenderId: 'test',
    matchedAt: '2026-07-01T00:00:00.000Z',
    polozky_match: Array.from({ length: totalItems }, (_, index) => ({
      polozka_nazev: `Položka ${index + 1}`,
      polozka_index: index,
      mnozstvi: 1,
      cena_max_s_dph: index < successfulItems ? unitPrice * 2 : unitPrice / 2,
      typ: 'produkt' as const,
      kandidati: [{
        vyrobce: 'Test',
        model: `Model ${index + 1}`,
        popis: 'Testovací produkt',
        parametry: {},
        shoda_s_pozadavky: [],
        cena_bez_dph: unitPrice / 1.21,
        cena_s_dph: unitPrice,
        cena_spolehlivost: 'vysoka' as const,
        dodavatele: [],
        dostupnost: 'skladem',
      }],
      vybrany_index: 0,
      oduvodneni_vyberu: 'Test',
    })),
  };
}

function winBand(median: number, count = 12): PriceBand {
  return { pocet: count, min: median * 0.8, median, max: median * 1.2, prumer: median };
}

test('silná shoda vrací GO', () => {
  const result = scoreGoNoGo(
    analysis(),
    productMatch(4, 4, 1_250_000),
    winBand(5_000_000),
  );
  assert.equal(result.doporuceni, 'GO');
  assert.ok(result.score >= 75);
  assert.ok(result.duvody.length >= 5);
});

test('hraniční kombinace vrací ZVAZIT', () => {
  const result = scoreGoNoGo(
    analysis({ expectedValue: 11_000_000, deadline: '2026-07-06T00:00:00.000Z' }),
    productMatch(1, 2, 6_000_000),
    winBand(8_000_000, 4),
  );
  assert.equal(result.doporuceni, 'ZVAZIT');
  assert.ok(result.score >= 45 && result.score < 75);
});

test('výchozí config zachovává původní go/no-go výsledek bit-perfect', () => {
  const weights = loadGoNoGoWeights(GO_NO_GO_CONFIG_PATH, () => {});
  assert.deepEqual(weights, DEFAULT_GO_NO_GO_WEIGHTS);

  const result = scoreGoNoGo(
    analysis({ expectedValue: 11_000_000, deadline: '2026-07-06T00:00:00.000Z' }),
    productMatch(1, 2, 6_000_000),
    winBand(8_000_000, 4),
    weights,
  );
  assert.deepEqual(result, {
    score: 59,
    doporuceni: 'ZVAZIT',
    duvody: [
      'Předmět zakázky odpovídá oborům firmy.',
      'Předpokládaná hodnota mírně překračuje firemní cenový limit.',
      '1 z 2 položek je úspěšně naceněno v mezích.',
      'Cena je 24 % od mediánu 4 historických výher.',
      'Na přípravu zbývá jen 5 dní.',
    ],
  });
});

test('custom váhy z configu mění skóre dle očekávání', () => {
  const weights = resolveGoNoGoWeights({
    weights: { sector: 1, budget: 100, priced_items: 1, win_price: 1, deadline: 1 },
  });
  const result = scoreGoNoGo(
    analysis({ expectedValue: 11_000_000, deadline: '2026-07-06T00:00:00.000Z' }),
    productMatch(1, 2, 6_000_000),
    winBand(8_000_000, 4),
    weights,
  );
  assert.equal(result.score, 41);
  assert.equal(result.doporuceni, 'NOGO');
});

test('nevalidní config použije výchozí váhy a zapíše warn', () => {
  const warnings: string[] = [];
  const weights = resolveGoNoGoWeights({
    weights: { sector: -1, budget: 0, priced_items: '25', win_price: Number.NaN, deadline: Infinity },
  }, (message) => warnings.push(message));

  assert.deepEqual(weights, DEFAULT_GO_NO_GO_WEIGHTS);
  assert.equal(warnings.length, 5);
  assert.ok(warnings.every((message) => message.startsWith('[go-no-go] Neplatná váha')));
});

test('zjevně nevhodná zakázka vrací NOGO', () => {
  const result = scoreGoNoGo(
    analysis({
      predmet: 'Dodávka kancelářských židlí a stolů',
      expectedValue: 20_000_000,
      deadline: '2026-06-30T00:00:00.000Z',
      sectors: ['IT', 'AV'],
    }),
    productMatch(0, 3, 10_000_000),
    winBand(2_000_000),
  );
  assert.equal(result.doporuceni, 'NOGO');
  assert.ok(result.score < 45);
});

// --- scoreBid: profit-aware skóre PO nacenění -------------------------------

// Naceněná položka s cenovou úpravou (kupní/nabídková cena), spolehlivostí a flagy.
function pricedItem(overrides: {
  index?: number;
  mnozstvi?: number;
  nakupni?: number;
  nabidkova?: number;
  potvrzeno?: boolean;
  spolehlivost?: 'vysoka' | 'stredni' | 'nizka';
  hardFlag?: boolean;
  staleHardFlag?: boolean;
  belowMarketFlag?: boolean;
  candidateNonexistent?: boolean;
} = {}) {
  const nakupni = overrides.nakupni ?? 100_000;
  const nabidkova = overrides.nabidkova ?? 130_000;
  return {
    polozka_nazev: `Položka ${(overrides.index ?? 0) + 1}`,
    polozka_index: overrides.index ?? 0,
    mnozstvi: overrides.mnozstvi ?? 1,
    cena_max_s_dph: overrides.hardFlag ? 1 : undefined,
    typ: 'produkt' as const,
    kandidati: [{
      vyrobce: 'Test',
      model: `Model ${(overrides.index ?? 0) + 1}`,
      popis: 'Reálný produkt',
      parametry: {},
      shoda_s_pozadavky: [],
      cena_bez_dph: nabidkova,
      cena_s_dph: nabidkova * 1.21,
      cena_spolehlivost: overrides.spolehlivost ?? 'vysoka' as const,
      dodavatele: [],
      dostupnost: 'skladem',
    }],
    vybrany_index: 0,
    oduvodneni_vyberu: 'Test',
    cenova_uprava: {
      nakupni_cena_bez_dph: nakupni,
      nakupni_cena_s_dph: nakupni * 1.21,
      marze_procent: 30,
      nabidkova_cena_bez_dph: nabidkova,
      nabidkova_cena_s_dph: nabidkova * 1.21,
      potvrzeno: overrides.potvrzeno ?? true,
    },
    sanity_flags: [
      ...(overrides.staleHardFlag
        ? [{ polozka_index: overrides.index ?? 0, level: 'hard' as const, code: 'zero_price' as const, message: 'Nulová cena' }]
        : []),
    ],
    ...(overrides.belowMarketFlag || overrides.candidateNonexistent ? {
      overeni_ceny: {
        stav: 'nalezeno' as const,
        overeno_at: '2026-07-11T10:00:00.000Z',
        kandidat_neexistuje: overrides.candidateNonexistent === true,
        ...(overrides.belowMarketFlag ? { zdroje: [{
          url: 'https://shop.cz/produkt', dodavatel: 'Shop',
          cena_bez_dph: nabidkova + 10_000, cena_s_dph: (nabidkova + 10_000) * 1.21,
          cena_baleni_s_dph: (nabidkova + 10_000) * 1.21, baleni_ks: 1,
          mena: 'CZK' as const, sazba_dph: 21, dostupnost: 'skladem' as const, poznamka: null,
        }] } : {}),
      },
    } : {}),
  };
}

function bidMatch(items: ReturnType<typeof pricedItem>[]): ProductMatch {
  return {
    tenderId: 'test',
    matchedAt: '2026-07-01T00:00:00.000Z',
    polozky_match: items,
  } as unknown as ProductMatch;
}

test('scoreBid: vysoký zisk + vysoká spolehlivost → GO', () => {
  const match = bidMatch([
    pricedItem({ index: 0 }),
    pricedItem({ index: 1 }),
    pricedItem({ index: 2 }),
    pricedItem({ index: 3 }),
  ]);
  // winBand median vysoko nad naší cenou (520 000) → pod mediánem = bonus.
  const result = scoreBid(analysis(), match, { default_marze_procent: 10 }, winBand(2_000_000));
  assert.equal(result.doporuceni, 'GO');
  assert.ok(result.score >= 75, `score ${result.score}`);
  assert.equal(result.zisk_kc, 120_000); // (130k−100k)×4
  assert.equal(result.marze_procent, 30);
});

test('scoreBid: nabídka přesně na cílové 10% přirážce není krácena na 9,1%', () => {
  const match = bidMatch([pricedItem({ index: 0, nakupni: 100_000, nabidkova: 110_000 })]);
  const result = scoreBid(analysis(), match, { default_marze_procent: 10 }, undefined);
  assert.equal(result.marze_procent, 10);
  assert.ok(result.duvody.some((d) => /Přirážka 10\.0 % z nákladů/i.test(d)), result.duvody.join(' | '));
});

test('scoreBid: nulová marže → srážka + důvod', () => {
  const match = bidMatch([
    pricedItem({ index: 0, nakupni: 130_000, nabidkova: 130_000 }),
    pricedItem({ index: 1, nakupni: 130_000, nabidkova: 130_000 }),
  ]);
  const result = scoreBid(analysis(), match, { default_marze_procent: 10 }, undefined);
  assert.equal(result.zisk_kc, 0);
  assert.equal(result.marze_procent, 0);
  assert.notEqual(result.doporuceni, 'GO');
  assert.ok(result.duvody.some((d) => /přirážku/i.test(d)), result.duvody.join(' | '));
});

test('M2: scoreBid přepočítá aktuální HARD nález → NOGO i při dobré ekonomice', () => {
  const match = bidMatch([
    pricedItem({ index: 0 }),
    pricedItem({ index: 1, hardFlag: true }),
    pricedItem({ index: 2 }),
  ]);
  const result = scoreBid(analysis(), match, { default_marze_procent: 10 }, winBand(2_000_000));
  assert.equal(result.doporuceni, 'NOGO');
  assert.ok(result.score < 45, `score ${result.score}`);
  assert.ok(result.duvody.some((d) => /HARD/.test(d)), result.duvody.join(' | '));
});

test('M2: scoreBid přepočítá aktuální ceny pod nákupem a nečte uložený flag', () => {
  const safe = bidMatch([
    pricedItem({ index: 0 }),
    pricedItem({ index: 1 }),
    pricedItem({ index: 2 }),
  ]);
  const risky = bidMatch([
    pricedItem({ index: 0, belowMarketFlag: true }),
    pricedItem({ index: 1, belowMarketFlag: true }),
    pricedItem({ index: 2 }),
  ]);

  const safeResult = scoreBid(analysis(), safe, { default_marze_procent: 10 }, undefined);
  const riskyResult = scoreBid(analysis(), risky, { default_marze_procent: 10 }, undefined);
  assert.ok(riskyResult.score <= safeResult.score - BID_BELOW_MARKET_PENALTY);
  assert.ok(riskyResult.duvody.some((reason) => /2 položek by se prodávalo pod reálnou nákupní cenou/.test(reason)));
  assert.equal(riskyResult.doporuceni, 'NOGO');
});

test('M2: zastaralý uložený HARD flag bez aktuálního nálezu skóre neotráví', () => {
  const match = bidMatch([
    pricedItem({ index: 0, staleHardFlag: true }),
    pricedItem({ index: 1 }),
    pricedItem({ index: 2 }),
  ]);
  const result = scoreBid(analysis(), match, { default_marze_procent: 10 }, winBand(2_000_000));
  assert.equal(result.doporuceni, 'GO');
  assert.equal(result.duvody.some((reason) => /HARD/.test(reason)), false);
});

test('scoreBid: každý webem vyvrácený AI kandidát snižuje kvalitu shod', () => {
  const safe = bidMatch([
    pricedItem({ index: 0 }),
    pricedItem({ index: 1 }),
    pricedItem({ index: 2 }),
  ]);
  const disproved = bidMatch([
    pricedItem({ index: 0, candidateNonexistent: true }),
    pricedItem({ index: 1, candidateNonexistent: true }),
    pricedItem({ index: 2 }),
  ]);

  const safeResult = scoreBid(analysis(), safe, { default_marze_procent: 10 }, undefined);
  const disprovedResult = scoreBid(analysis(), disproved, { default_marze_procent: 10 }, undefined);
  assert.equal(safeResult.score - disprovedResult.score, 2 * BID_NONEXISTENT_CANDIDATE_PENALTY);
  assert.ok(disprovedResult.duvody.some((reason) => /2× AI navržený produkt.*srážka 10 bodů/.test(reason)));
});

test('scoreBid: naše cena nad P75 → srážka za win-price', () => {
  const match = bidMatch([pricedItem({ index: 0, nabidkova: 130_000 })]);
  // Pásmo s P75 hluboko pod naší cenou (130 000) → nad P75 = srážka.
  const band: PriceBand = { pocet: 12, min: 10_000, p25: 20_000, median: 30_000, p75: 40_000, max: 60_000, prumer: 32_000 };
  const result = scoreBid(analysis(), match, { default_marze_procent: 10 }, band);
  assert.ok(result.duvody.some((d) => /P75/.test(d)), result.duvody.join(' | '));
});

test('scoreBid: bez naceněných položek → neutrální ZVAZIT', () => {
  const result = scoreBid(analysis(), undefined, null, undefined);
  assert.equal(result.doporuceni, 'ZVAZIT');
  assert.equal(result.score, 50);
  assert.equal(result.zisk_kc, 0);
});

test('chybějící volitelné vstupy nespadnou a vrátí neutrální výsledek', () => {
  const oldAnalysis = analysis({ expectedValue: null, deadline: null, extractedAt: '', sectors: [] });
  const parsedOldAnalysis = TenderAnalysisSchema.parse(oldAnalysis);
  assert.equal(parsedOldAnalysis.go_no_go, undefined);

  const result = scoreGoNoGo(
    oldAnalysis,
    undefined,
    undefined,
  );
  assert.deepEqual(result, {
    score: 50,
    doporuceni: 'ZVAZIT',
    duvody: ['Zadavatel neuvedl předpokládanou hodnotu — rozpočtový faktor nezapočítán'],
  });
});

test('go/no-go feature vektor obsahuje přesně všechny faktory výpočtu', () => {
  const vector = serializeGoNoGoFeatureVector(
    analysis(), productMatch(4, 4, 1_250_000), winBand(5_000_000),
  );
  assert.deepEqual(vector.faktory.map((factor) => factor.nazev), [...GO_NO_GO_FACTOR_NAMES]);
  assert.equal(vector.skore, scoreGoNoGo(analysis(), productMatch(4, 4, 1_250_000), winBand(5_000_000)).score);
  for (const factor of vector.faktory) {
    assert.ok('surova_hodnota' in factor);
    assert.equal(typeof factor.normalizovana_hodnota, 'number');
    assert.equal(typeof factor.vaha, 'number');
    assert.equal(typeof factor.prispevek, 'number');
  }
});

test('bid feature vektor obsahuje vážené faktory i všechny korekce skóre', () => {
  const match = bidMatch([
    pricedItem({ index: 0, belowMarketFlag: true, candidateNonexistent: true }),
    pricedItem({ index: 1, hardFlag: true }),
  ]);
  const vector = serializeBidFeatureVector(analysis(), match, { default_marze_procent: 10 }, winBand(2_000_000));
  const result = scoreBid(analysis(), match, { default_marze_procent: 10 }, winBand(2_000_000));
  assert.deepEqual(vector.faktory.map((factor) => factor.nazev), [...BID_FACTOR_NAMES]);
  assert.equal(vector.skore, result.score);
  assert.equal(vector.doporuceni, result.doporuceni);
  assert.ok(vector.faktory.some((factor) => factor.prispevek < 0));
});
