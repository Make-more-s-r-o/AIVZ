import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  authoritativeSpecificationForItem,
  candidateFingerprint,
  mergePriceVerifications,
  parseWebPriceResponse,
  verifyAllPrices,
  verifyItemPrice,
  EQUIVALENT_MAX_SEARCHES,
  WEB_SEARCH_PHASE_TIMEOUT_MS,
  type PriceVerifierAiClient,
} from '../src/lib/price-verifier.js';
import type { ProductMatch, TenderAnalysis } from '../src/lib/types.js';
import type { WebFindingRow } from '../src/lib/web-findings-store.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);

function fakeAiClient(responses: string[], calls: Array<{ system: string; user: string; maxUses?: number }>): PriceVerifierAiClient {
  let index = 0;
  return {
    messages: {
      async create(params) {
        const user = params.messages[0]?.content;
        calls.push({
          system: typeof params.system === 'string' ? params.system : '',
          user: typeof user === 'string' ? user : JSON.stringify(user),
          maxUses: (params.tools?.[0] as { max_uses?: number } | undefined)?.max_uses,
        });
        const text = responses[index++];
        assert.notEqual(text, undefined, 'Mock AI klient dostal více volání, než test očekával');
        return {
          id: `msg_test_${index}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: text!, citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
  };
}

const NOT_FOUND = JSON.stringify({
  nalezeno: false,
  shoda_typ: 'presny',
  mena: 'CZK',
  zdroje: [],
  poznamka: 'Přesný produkt nebyl nalezen.',
});

function sourceResponse(options: {
  matchType?: 'presny' | 'ekvivalent';
  net?: number;
  productName?: string;
} = {}): string {
  const matchType = options.matchType ?? 'presny';
  const net = options.net ?? 100;
  return JSON.stringify({
    nalezeno: true,
    shoda_typ: matchType,
    mena: 'CZK',
    zdroje: [{
      url: `https://shop.cz/${matchType}-${net}`,
      dodavatel: 'Shop',
      nazev_produktu: options.productName ?? 'Skutečný produkt',
      mena: 'CZK',
      cena_bez_dph: net,
      cena_s_dph: net * 1.21,
      cena_baleni_s_dph: net * 1.21,
      baleni_ks: 1,
      prodava_po_kusech: true,
      sazba_dph: 21,
      dostupnost: 'skladem',
      splnuje_specifikaci: matchType === 'ekvivalent',
      shoda_parametru: matchType === 'ekvivalent' ? ['průměr 150 mm', 'zrnitost P80'] : [],
      poznamka: null,
    }],
  });
}

function testCandidate(vyrobce = 'Test', model = 'X') {
  return {
    vyrobce, model, popis: 'Test', parametry: {}, shoda_s_pozadavky: [],
    cena_bez_dph: 900, cena_s_dph: 1089, cena_spolehlivost: 'vysoka' as const,
    dodavatele: [], dostupnost: 'skladem',
  };
}

function foundVerification(fingerprint: string, at = '2026-07-10T10:00:00.000Z') {
  return {
    stav: 'nalezeno' as const,
    overeno_at: at,
    kandidat_fingerprint: fingerprint,
    poznamka: 'Původní ověření',
    zdroj_url: 'https://shop.cz/puvodni',
    zdroje: [{
      url: 'https://shop.cz/puvodni', dodavatel: 'Shop', nazev_produktu: 'Původní produkt',
      cena_bez_dph: 800, cena_s_dph: 968, cena_baleni_s_dph: 968, baleni_ks: 1,
      mena: 'CZK' as const, dostupnost: 'skladem' as const, poznamka: null,
    }],
  };
}

function cachedRow(daysOld: number): WebFindingRow {
  return {
    id: 1, tender_id: 'T-old', polozka_index: 0, polozka_nazev: 'Testovací položka',
    produkt: 'Test X', dodavatel: 'Historický shop', url: 'https://shop.cz/historie',
    cena_bez_dph: 800, cena_s_dph: 968, dostupnost: 'skladem', zdroj: 'web_verify',
    found_at: new Date(Date.now() - daysOld * 86_400_000).toISOString(),
    katalogove_cislo: 'CAT-X', vyrobce: 'Test', model: 'X',
  };
}

test('cache hit nevolá AI a zapíše metadata historie do ověření i souhrnu', async () => {
  let aiCalls = 0;
  const aiClient: PriceVerifierAiClient = { messages: { async create() { aiCalls++; throw new Error('AI se nemá volat'); } } };
  const match = {
    tenderId: 'T-cache', matchedAt: new Date().toISOString(),
    polozky_match: [{ polozka_index: 0, polozka_nazev: 'Testovací položka', typ: 'produkt', kandidati: [testCandidate()], vybrany_index: 0 }],
  } as ProductMatch;
  const { results, summary } = await verifyAllPrices(match, {
    tenderId: 'T-cache', aiClient, cacheLookup: async () => [cachedRow(5)],
  });
  assert.equal(aiCalls, 0);
  assert.equal(results[0]?.overeni_ceny.z_cache, true);
  assert.equal(results[0]?.overeni_ceny.cache_stari_dnu, 5);
  assert.equal(results[0]?.overeni_ceny.zdroje?.[0]?.z_cache, true);
  assert.equal(summary.z_cache, 1);
  assert.equal(summary.ai_polozek, 0);
  assert.ok(summary.usetreno_czk > 0);
});

test('cache starší než 30 dní je orientační a nevstupuje do HARD reality gate', async () => {
  const result = await verifyItemPrice({ vyrobce: 'Test', model: 'X', ai_cena_bez_dph: 100 }, {
    cacheDays: 60, cacheLookup: async () => [cachedRow(31)],
  });
  assert.equal(result.stav, 'orientacni');
  assert.equal(result.zdroje?.[0]?.orientacni, true);
  assert.equal(result.realita?.pod_trhem, false);
});

test('--no-cache ekvivalentní volba useCache=false cache obejde a použije AI', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  let cacheCalls = 0;
  const result = await verifyItemPrice({ vyrobce: 'Test', model: 'X' }, {
    useCache: false,
    cacheLookup: async () => { cacheCalls++; return [cachedRow(1)]; },
    aiClient: fakeAiClient([sourceResponse()], calls),
  });
  assert.equal(cacheCalls, 0);
  assert.equal(calls.length, 1);
  assert.equal(result.z_cache, undefined);
});

test('bez DB cache graceful mine a verify pokračuje AI cestou', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const result = await verifyItemPrice({ vyrobce: 'Test', model: 'X' }, {
    aiClient: fakeAiClient([sourceResponse()], calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(result.stav, 'nalezeno');
});

test('dvoufázové ověření spustí fallback jen po nenalezení a bez AI výrobce a modelu', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const input = {
    vyrobce: 'Mirka',
    model: 'Gold 150 mm P80 plný disk',
    nazev: 'Brusný disk na suchý zip 150 mm, zrnitost P80',
    specifikace: 'Průměr 150 mm, zrnitost P80, plný disk na suchý zip',
    mnozstvi: 10,
    jednotka: 'ks',
    ai_cena_bez_dph: 18,
  };

  const result = await verifyItemPrice(input, {
    aiClient: fakeAiClient([NOT_FOUND, sourceResponse({ matchType: 'ekvivalent', net: 65 })], calls),
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0]!.system, /NEZÁVAZNÝ ODHAD AI/);
  const fallbackPrompt = `${calls[1]!.system}\n${calls[1]!.user}`;
  assert.doesNotMatch(fallbackPrompt, /Mirka/i);
  assert.doesNotMatch(fallbackPrompt, /Gold 150 mm P80 plný disk/i);
  assert.match(calls[1]!.system, /U KAŽDÉHO zdroje je POVINNÉ vyplnit nazev_produktu/);
  assert.match(calls[1]!.system, /zdroj i tak vrať — operátor si ho ověří sám/);
  assert.equal(result.stav, 'ekvivalent');
  assert.equal(result.shoda_typ, 'ekvivalent');
  assert.equal(result.web_cena_bez_dph, 65);
});

test('fáze 2 má vlastní čtyřminutový limit a nejvýše tři webové search requesty', async () => {
  const calls: Array<{ system: string; user: string; maxUses?: number }> = [];
  await verifyItemPrice({
    vyrobce: 'Test', model: 'Neznámý', nazev: 'Test',
    specifikace: 'Dostatečně dlouhá závazná specifikace zadavatele',
  }, {
    maxSearches: 8,
    aiClient: fakeAiClient([NOT_FOUND, sourceResponse({ matchType: 'ekvivalent' })], calls),
  });

  assert.equal(WEB_SEARCH_PHASE_TIMEOUT_MS, 240_000);
  assert.equal(EQUIVALENT_MAX_SEARCHES, 3);
  assert.equal(calls[0]?.maxUses, 8);
  assert.equal(calls[1]?.maxUses, 3);
});

test('chyba fáze 2 zachová výsledek fáze 1 a uloží české vysvětlení', async () => {
  let call = 0;
  const aiClient: PriceVerifierAiClient = {
    messages: {
      async create() {
        call++;
        if (call === 2) throw Object.assign(new Error('upstream timeout'), { name: 'AbortError' });
        return {
          id: 'msg_first', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: NOT_FOUND, citations: null }],
          stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 7 },
        };
      },
    },
  };
  const result = await verifyItemPrice({
    vyrobce: 'Test', model: 'X', nazev: 'Položka',
    specifikace: 'Dostatečně dlouhá závazná specifikace zadavatele',
  }, { aiClient });

  assert.equal(result.stav, 'nenalezeno');
  assert.match(result.poznamka ?? '', /Hledání ekvivalentu překročilo časový limit 4 minuty/);
  assert.match(result.poznamka ?? '', /Výsledek první fáze byl zachován/);
});

test('ekvivalent označí explicitně vyvrácený AI kandidát, obyčejné nenalezení nikoli', async () => {
  const explicitNotFound = JSON.stringify({
    nalezeno: false, shoda_typ: 'presny', mena: 'CZK', zdroje: [],
    poznamka: 'Výrobce uvádí jiné rozměry a parametry neodpovídají zadání.',
  });
  const explicit = await verifyItemPrice({
    vyrobce: 'Test', model: 'Vymyšlený', nazev: 'Položka',
    specifikace: 'Dostatečně dlouhá závazná specifikace zadavatele',
  }, { aiClient: fakeAiClient([explicitNotFound, sourceResponse({ matchType: 'ekvivalent' })], []) });
  const uncertain = await verifyItemPrice({
    vyrobce: 'Test', model: 'Nedohledaný', nazev: 'Položka',
    specifikace: 'Dostatečně dlouhá závazná specifikace zadavatele',
  }, { aiClient: fakeAiClient([NOT_FOUND, sourceResponse({ matchType: 'ekvivalent' })], []) });

  assert.equal(explicit.kandidat_neexistuje, true);
  assert.equal(uncertain.kandidat_neexistuje, false);
});

test('dvoufázové ověření fallback nespustí, když přesná fáze našla použitelný zdroj', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const result = await verifyItemPrice({
    vyrobce: 'Bosch',
    model: 'X1',
    nazev: 'Nářadí',
    specifikace: 'Dostatečně dlouhá závazná specifikace zadavatele',
  }, { aiClient: fakeAiClient([sourceResponse()], calls) });

  assert.equal(calls.length, 1);
  assert.equal(result.stav, 'nalezeno');
  assert.equal(result.shoda_typ, 'presny');
});

test('dvoufázové ověření fallback nespustí bez autoritativní specifikace', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const result = await verifyItemPrice({
    vyrobce: 'Hedson',
    model: 'DPC-770',
    nazev: 'Míchací kelímek s víčkem',
  }, { aiClient: fakeAiClient([NOT_FOUND], calls) });

  assert.equal(calls.length, 1);
  assert.equal(result.stav, 'nenalezeno');
});

test('souhrn spočítá položky s reálným nákupem nad AI odhadem a průměrné procento', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const kandidat = (model: string, aiCena: number) => ({
    vyrobce: 'Test',
    model,
    cena_bez_dph: aiCena,
  });
  const match = {
    tenderId: 'T-summary',
    matchedAt: '2026-07-11T10:00:00.000Z',
    polozky_match: [
      { polozka_index: 0, polozka_nazev: 'A', typ: 'produkt', kandidati: [kandidat('A', 100)], vybrany_index: 0 },
      { polozka_index: 1, polozka_nazev: 'B', typ: 'produkt', kandidati: [kandidat('B', 100)], vybrany_index: 0 },
      { polozka_index: 2, polozka_nazev: 'C', typ: 'produkt', kandidati: [kandidat('C', 100)], vybrany_index: 0 },
    ],
  } as ProductMatch;

  const { summary } = await verifyAllPrices(match, {
    tenderId: 'T-summary',
    concurrency: 1,
    aiClient: fakeAiClient([
      sourceResponse({ net: 200 }),
      sourceResponse({ net: 150 }),
      sourceResponse({ net: 90 }),
    ], calls),
  });

  assert.equal(summary.faze1_nalezeno, 3);
  assert.equal(summary.faze2_nalezeno, 0);
  assert.equal(summary.realny_nakup_vyssi_nez_ai, 2);
  assert.equal(summary.prumerny_narust_procent, 75);
});

test('legacy single-product fallback používá název ze zadání, ne AI identitu kandidáta', async () => {
  const calls: Array<{ system: string; user: string }> = [];
  const match = {
    tenderId: 'T-single',
    matchedAt: '2026-07-11T10:00:00.000Z',
    kandidati: [{ vyrobce: 'VymyšlenýVýrobce', model: 'VymyšlenýModel', cena_bez_dph: 20 }],
    vybrany_index: 0,
  } as ProductMatch;
  const analysis = {
    polozky: [{ nazev: 'Brusný disk', specifikace: 'Průměr 150 mm, zrnitost P80, plný disk' }],
    technicke_pozadavky: [],
  } as TenderAnalysis;

  await verifyAllPrices(match, {
    tenderId: 'T-single',
    analysis,
    concurrency: 1,
    aiClient: fakeAiClient([NOT_FOUND, sourceResponse({ matchType: 'ekvivalent' })], calls),
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1]!.user, /Název položky ze zadání: Brusný disk/);
  assert.doesNotMatch(calls[1]!.user, /VymyšlenýVýrobce|VymyšlenýModel/);
});

test('parser seřadí, sanitizuje a omezí multi-source odpověď a naplní legacy pole', async () => {
  const response = await readFile(new URL('price-verifier-multi-response.txt', FIXTURES), 'utf-8');
  const parsed = parseWebPriceResponse(response, { cena_max_s_dph: 1_000 }, '2026-07-11T10:00:00.000Z');

  assert.equal(parsed.stav, 'nalezeno');
  assert.deepEqual(parsed.zdroje?.map((source) => source.dodavatel), ['Shop B', 'Shop C', 'Shop A']);
  assert.equal(parsed.zdroje?.length, 3);
  assert.equal(parsed.zdroj_url, 'https://shop-b.cz/model-x');
  assert.equal(parsed.dodavatel, 'Shop B');
  assert.equal(parsed.web_cena_s_dph, 968);
  assert.equal(parsed.web_cena_bez_dph, 800);
  assert.equal(parsed.prekracuje_strop, false);
  assert.match(parsed.poznamka ?? '', /akční cena.*Cena bez DPH dopočtena.*21 %/);
  assert.equal(parsed.zdroje?.[0]?.baleni_ks, 1);
});

test('parser zachová kompatibilitu se starou single-source odpovědí', async () => {
  const response = await readFile(new URL('price-verifier-legacy-response.txt', FIXTURES), 'utf-8');
  const parsed = parseWebPriceResponse(response, {}, '2026-07-11T10:00:00.000Z');

  assert.equal(parsed.stav, 'nalezeno');
  assert.equal(parsed.web_cena_bez_dph, 2_000);
  assert.equal(parsed.web_cena_s_dph, 2_420);
  assert.equal(parsed.zdroje?.[0]?.url, 'https://legacy-shop.cz/model-y');
  assert.equal(parsed.dodavatel, 'Legacy Shop');
  assert.equal(parsed.shoda_typ, 'presny');
  assert.equal(parsed.realita?.rozdil_procent, null);
});

test('parser zachová shoda_typ, názvy produktů a realitu multi-source ekvivalentu', async () => {
  const response = await readFile(new URL('price-verifier-equivalent-response.txt', FIXTURES), 'utf-8');
  const parsed = parseWebPriceResponse(
    response,
    { ai_cena_bez_dph: 20, mnozstvi: 10, specifikace: 'Brusné plátno 230 × 280 mm, zrnitost P120' },
    '2026-07-11T10:00:00.000Z',
  );

  assert.equal(parsed.stav, 'ekvivalent');
  assert.equal(parsed.shoda_typ, 'ekvivalent');
  assert.deepEqual(parsed.zdroje?.map((source) => source.nazev_produktu), [
    'Brusné plátno arch 230 × 280 mm P120',
    'Brusné plátno 230x280 zrnitost 120',
  ]);
  assert.equal(parsed.realita?.nejlevnejsi_bez_dph, 30);
  assert.equal(parsed.realita?.rozdil_procent, 50);
  assert.equal(parsed.realita?.pod_trhem, true);
});

test('M5: top-level legacy pole pocházejí výhradně z nejlevnějšího validního zdroje', () => {
  const parsed = parseWebPriceResponse(JSON.stringify({
    nalezeno: true,
    mena: 'CZK',
    cena_bez_dph: 9_999,
    cena_s_dph: 12_098.79,
    zdroj_url: 'https://legacy.cz/jiny-produkt',
    dodavatel: 'Legacy obchod',
    dostupnost: 'na dotaz',
    zdroje: [{
      url: 'https://nejlevnejsi.cz/model',
      dodavatel: 'Nejlevnější obchod',
      cena_bez_dph: null,
      cena_s_dph: 1_210,
      prodava_po_kusech: true,
      dostupnost: 'skladem',
      poznamka: null,
    }],
  }), {}, '2026-07-11T10:00:00.000Z');

  assert.equal(parsed.web_cena_s_dph, 1_210);
  assert.equal(parsed.web_cena_bez_dph, 1_000);
  assert.equal(parsed.zdroj_url, 'https://nejlevnejsi.cz/model');
  assert.equal(parsed.dodavatel, 'Nejlevnější obchod');
  assert.equal(parsed.dostupnost, 'skladem');
});

test('merge multi-source výsledku mění pouze overeni_ceny správné položky', () => {
  const candidate = {
    vyrobce: 'Test', model: 'X', popis: 'Test', parametry: {}, shoda_s_pozadavky: [],
    cena_bez_dph: 900, cena_s_dph: 1089, cena_spolehlivost: 'vysoka' as const,
    dodavatele: [], dostupnost: 'skladem',
  };
  const match = {
    tenderId: 'T-1',
    matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: [
      {
        polozka_index: 7,
        polozka_nazev: 'Notebook',
        typ: 'produkt',
        kandidati: [candidate],
        vybrany_index: 0,
        oduvodneni_vyberu: 'test',
        cenova_uprava: {
          nakupni_cena_bez_dph: 900,
          nakupni_cena_s_dph: 1089,
          marze_procent: 10,
          nabidkova_cena_bez_dph: 990,
          nabidkova_cena_s_dph: 1197.9,
          potvrzeno: true,
        },
      },
    ],
  } as ProductMatch;
  const originalOverride = match.polozky_match?.[0]?.cenova_uprava;
  const overeni = parseWebPriceResponse(
    '{"nalezeno":true,"mena":"CZK","zdroje":[{"url":"https://shop.cz/x","dodavatel":"Shop","cena_bez_dph":800,"cena_s_dph":968,"prodava_po_kusech":true,"dostupnost":"skladem","poznamka":null}]}',
    {},
    '2026-07-11T10:00:00.000Z',
  );
  overeni.kandidat_fingerprint = candidateFingerprint(candidate, 0);

  mergePriceVerifications(match, [{ polozka_index: 7, polozka_nazev: 'Notebook', overeni_ceny: overeni }]);

  assert.equal(match.polozky_match?.[0]?.overeni_ceny?.zdroje?.[0]?.url, 'https://shop.cz/x');
  assert.strictEqual(match.polozky_match?.[0]?.cenova_uprava, originalOverride);
  assert.equal(match.polozky_match?.[0]?.cenova_uprava?.potvrzeno, true);
});

test('chyba zachová předchozí ověření a zapíše poslední chybu', () => {
  const candidate = testCandidate();
  const fingerprint = candidateFingerprint(candidate, 0);
  const previous = foundVerification(fingerprint);
  const match = {
    tenderId: 'T-error-existing', matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: [{
      polozka_index: 0, polozka_nazev: 'Položka', typ: 'produkt', kandidati: [candidate],
      vybrany_index: 0, oduvodneni_vyberu: 'test', overeni_ceny: previous,
    }],
  } as ProductMatch;

  mergePriceVerifications(match, [{
    polozka_index: 0, polozka_nazev: 'Položka',
    overeni_ceny: {
      stav: 'chyba', poznamka: 'První fáze ověření selhala.',
      overeno_at: '2026-07-11T10:00:00.000Z', kandidat_fingerprint: fingerprint,
    },
  }]);

  const merged = match.polozky_match?.[0]?.overeni_ceny;
  assert.equal(merged?.stav, 'nalezeno');
  assert.equal(merged?.zdroje?.[0]?.url, 'https://shop.cz/puvodni');
  assert.deepEqual(merged?.posledni_chyba, {
    zprava: 'První fáze ověření selhala.',
    at: '2026-07-11T10:00:00.000Z',
  });
});

test('chyba bez předchozího ověření se uloží jako stav chyba', () => {
  const candidate = testCandidate();
  const fingerprint = candidateFingerprint(candidate, 0);
  const match = {
    tenderId: 'T-error-new', matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: [{
      polozka_index: 0, polozka_nazev: 'Položka', typ: 'produkt', kandidati: [candidate],
      vybrany_index: 0, oduvodneni_vyberu: 'test',
    }],
  } as ProductMatch;

  mergePriceVerifications(match, [{
    polozka_index: 0, polozka_nazev: 'Položka',
    overeni_ceny: {
      stav: 'chyba', poznamka: 'Síťová chyba', overeno_at: '2026-07-11T10:00:00.000Z',
      kandidat_fingerprint: fingerprint,
    },
  }]);

  assert.equal(match.polozky_match?.[0]?.overeni_ceny?.stav, 'chyba');
});

test('nenalezeno zachová staré zdroje, aktualizuje čas a přidá poznámku', () => {
  const candidate = testCandidate();
  const fingerprint = candidateFingerprint(candidate, 0);
  const previousAt = '2026-07-10T10:00:00.000Z';
  const match = {
    tenderId: 'T-not-found', matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: [{
      polozka_index: 0, polozka_nazev: 'Položka', typ: 'produkt', kandidati: [candidate],
      vybrany_index: 0, oduvodneni_vyberu: 'test', overeni_ceny: foundVerification(fingerprint, previousAt),
    }],
  } as ProductMatch;

  mergePriceVerifications(match, [{
    polozka_index: 0, polozka_nazev: 'Položka',
    overeni_ceny: {
      stav: 'nenalezeno', poznamka: 'Nový dotaz nic nenašel.',
      overeno_at: '2026-07-11T10:00:00.000Z', kandidat_fingerprint: fingerprint,
    },
  }]);

  const merged = match.polozky_match?.[0]?.overeni_ceny;
  assert.equal(merged?.stav, 'nalezeno');
  assert.equal(merged?.zdroje?.[0]?.url, 'https://shop.cz/puvodni');
  assert.equal(merged?.overeno_at, '2026-07-11T10:00:00.000Z');
  assert.match(merged?.poznamka ?? '', new RegExp(`poslední běh cenu nenašel.*${previousAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('změna kandidáta má přednost a staré zdroje se zahodí', () => {
  const oldCandidate = testCandidate('A', '1');
  const currentCandidate = testCandidate('B', '2');
  const oldFingerprint = candidateFingerprint(oldCandidate, 0);
  const currentFingerprint = candidateFingerprint(currentCandidate, 0);
  const match = {
    tenderId: 'T-candidate-change', matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: [{
      polozka_index: 0, polozka_nazev: 'Položka', typ: 'produkt', kandidati: [currentCandidate],
      vybrany_index: 0, oduvodneni_vyberu: 'změněno', overeni_ceny: foundVerification(oldFingerprint),
    }],
  } as ProductMatch;

  mergePriceVerifications(match, [{
    polozka_index: 0, polozka_nazev: 'Položka',
    overeni_ceny: {
      stav: 'nenalezeno', overeno_at: '2026-07-11T10:00:00.000Z',
      kandidat_fingerprint: currentFingerprint,
    },
  }]);

  assert.equal(match.polozky_match?.[0]?.overeni_ceny?.stav, 'nenalezeno');
  assert.equal(match.polozky_match?.[0]?.overeni_ceny?.zdroje, undefined);
});

test('došlý kredit přeruší běh po první položce a označí souhrn', async () => {
  const candidates = [testCandidate('A', '1'), testCandidate('B', '2'), testCandidate('C', '3')];
  const match = {
    tenderId: 'T-credit', matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: candidates.map((candidate, index) => ({
      polozka_index: index, polozka_nazev: `Položka ${index}`, typ: 'produkt', kandidati: [candidate],
      vybrany_index: 0, oduvodneni_vyberu: 'test',
    })),
  } as ProductMatch;
  let calls = 0;
  const aiClient: PriceVerifierAiClient = {
    messages: {
      async create() {
        calls++;
        throw Object.assign(new Error('credit balance is too low'), {
          status: 400,
          error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API' },
        });
      },
    },
  };

  const { results, summary } = await verifyAllPrices(match, { tenderId: 'T-credit', aiClient });

  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.overeni_ceny.stav, 'chyba');
  assert.equal(summary.preruseno_kvuli_kreditu, true);
});

test('C1: autoritativní specifikace pochází z analysis.json a obsahuje relevantní technický požadavek', () => {
  const analysis = {
    polozky: [
      { nazev: 'Notebook', specifikace: 'Notebook s 32 GB RAM' },
      { nazev: 'Monitor', specifikace: 'Monitor s úhlopříčkou 27 palců' },
    ],
    technicke_pozadavky: [
      { parametr: 'RAM', pozadovana_hodnota: '32 GB', povinny: true },
      { parametr: 'Úhlopříčka monitoru', pozadovana_hodnota: '27 palců', povinny: true },
    ],
  } as TenderAnalysis;
  const specification = authoritativeSpecificationForItem(analysis, 0);
  assert.match(specification ?? '', /Notebook s 32 GB RAM/);
  assert.match(specification ?? '', /RAM: 32 GB/);
  assert.doesNotMatch(specification ?? '', /Úhlopříčka monitoru/);
});

test('C1: ekvivalent bez specifikace zadavatele je odmítnut přesnou poznámkou', () => {
  const parsed = parseWebPriceResponse(JSON.stringify({
    nalezeno: true,
    shoda_typ: 'ekvivalent',
    mena: 'CZK',
    zdroje: [{
      url: 'https://shop.cz/ekvivalent', mena: 'CZK', dodavatel: 'Shop', nazev_produktu: 'Ekvivalent',
      cena_bez_dph: 100, cena_s_dph: 121, prodava_po_kusech: true, dostupnost: 'skladem',
      splnuje_specifikaci: true, shoda_parametru: ['parametr'],
    }],
  }), { specifikace: 'krátká' }, '2026-07-11T10:00:00.000Z');
  assert.equal(parsed.stav, 'nenalezeno');
  assert.equal(parsed.poznamka, 'bez specifikace zadavatele nelze ověřit ekvivalent');
});

test('H3: výsledek se po souběžné změně kandidáta nepřilepí k jiné volbě', () => {
  const first = { vyrobce: 'A', model: '1' };
  const second = { vyrobce: 'B', model: '2' };
  const match = {
    tenderId: 'T-race', matchedAt: '2026-07-11T09:00:00.000Z',
    polozky_match: [{
      polozka_index: 0, polozka_nazev: 'Položka', typ: 'produkt',
      kandidati: [first, second], vybrany_index: 1, oduvodneni_vyberu: 'změněno',
    }],
  } as ProductMatch;
  mergePriceVerifications(match, [{
    polozka_index: 0,
    polozka_nazev: 'Položka',
    overeni_ceny: {
      stav: 'nalezeno', overeno_at: '2026-07-11T10:00:00.000Z',
      kandidat_fingerprint: candidateFingerprint(first, 0),
    },
  }]);
  assert.equal(match.polozky_match?.[0]?.overeni_ceny, undefined);
});

test('H5: parser odmítne HTTP, vyhledávací URL a cizí měnu', () => {
  const common = { cena_bez_dph: 100, cena_s_dph: 121, prodava_po_kusech: true, dostupnost: 'skladem' };
  for (const payload of [
    { shoda_typ: 'presny', mena: 'CZK', zdroje: [{ ...common, url: 'http://shop.cz/produkt' }] },
    { shoda_typ: 'presny', mena: 'CZK', zdroje: [{ ...common, url: 'https://shop.cz/search?q=model' }] },
    { shoda_typ: 'presny', mena: 'EUR', zdroje: [{ ...common, url: 'https://shop.cz/produkt' }] },
  ]) {
    const parsed = parseWebPriceResponse(JSON.stringify({ nalezeno: true, ...payload }), { specifikace: 'Dostatečně dlouhá závazná specifikace' });
    assert.equal(parsed.stav, 'nenalezeno');
  }
});

test('nedoložený ekvivalent s platnou CZK cenou zůstane jako orientační zdroj', () => {
  const parsed = parseWebPriceResponse(JSON.stringify({
    nalezeno: true,
    shoda_typ: 'ekvivalent',
    mena: 'CZK',
    zdroje: [{
      url: 'https://shop.cz/produkt', dodavatel: 'Shop', cena_bez_dph: 100, cena_s_dph: 121,
      prodava_po_kusech: true, dostupnost: 'skladem', splnuje_specifikaci: false,
    }],
  }), { ai_cena_bez_dph: 80, specifikace: 'Dostatečně dlouhá závazná specifikace' });

  assert.equal(parsed.stav, 'orientacni');
  assert.equal(parsed.zdroje?.[0]?.orientacni, true);
  assert.equal(parsed.zdroje?.[0]?.splnuje_specifikaci, false);
  assert.equal(parsed.realita?.nejlevnejsi_bez_dph, null);
  assert.match(parsed.realita?.poznamka ?? '', /Orientační zdroje.*vyloučeny/);
});

test('H5: nekonzistentní DPH opraví hrubou cenu z ceny bez DPH a označí poznámkou', () => {
  const parsed = parseWebPriceResponse(JSON.stringify({
    nalezeno: true, shoda_typ: 'presny', mena: 'CZK',
    zdroje: [{ url: 'https://shop.cz/produkt', cena_bez_dph: 100, cena_s_dph: 200, prodava_po_kusech: true, dostupnost: 'skladem' }],
  }));
  assert.equal(parsed.web_cena_s_dph, 121);
  assert.match(parsed.poznamka ?? '', /Nekonzistentní ceny/);
});
