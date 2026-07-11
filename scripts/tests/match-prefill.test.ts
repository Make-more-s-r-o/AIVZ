/**
 * Jednotkový test předvyplnění cen z AI kandidáta (lib/price-prefill.ts) bez sítě a AI.
 *
 * Money-path invariant: kandidát bez reálné shody (zadna_shoda, placeholder název,
 * nulová cena) NIKDY nedostane předvyplněnou cenu z AI odhadu — dostane nulovou
 * nepotvrzenou cenu, kterou HARD sanity flag zero_price zablokuje do ručního nacenění.
 *
 * Spuštění z adresáře scripts/:
 *   npx tsx tests/match-prefill.test.ts
 */
import { strict as assert } from 'node:assert';

import {
  applyPricePrefill,
  candidateHasRealProduct,
  containsSadaKeyword,
  type PrefillCandidate,
  type PrefillItem,
} from '../src/lib/price-prefill.js';
import { checkPriceSanity } from '../src/lib/price-sanity.js';
import { PriceOverrideSchema } from '../src/lib/types.js';

function makeCandidate(overrides: Partial<PrefillCandidate> = {}): PrefillCandidate {
  return {
    vyrobce: 'Makita',
    model: 'B-54081',
    popis: 'Rázová redukce 3/4" na 1/2"',
    cena_bez_dph: 200,
    cena_s_dph: 242,
    cena_spolehlivost: 'stredni',
    ...overrides,
  };
}

function makeItem(overrides: Partial<PrefillItem> = {}): PrefillItem {
  return {
    polozka_nazev: 'Rázová redukce 3/4"×1/2"',
    polozka_index: 0,
    mnozstvi: 1,
    kandidati: [makeCandidate()],
    vybrany_index: 0,
    ...overrides,
  };
}

let passed = 0;
function ok(name: string) {
  passed++;
  console.log(`✓ ${name}`);
}

// Utlum console.warn během testů (guardy varují záměrně, ale výstup testu má zůstat čitelný).
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };

try {
  // (a) zadna_shoda kandidát → nulová nepotvrzená cena + poznámka o ručním nacenění
  {
    const item = makeItem({
      kandidati: [makeCandidate({ zadna_shoda: true, cena_bez_dph: 185000, cena_s_dph: 223850 })],
    });
    applyPricePrefill([item], 10);
    const cu = item.cenova_uprava as Record<string, unknown>;
    assert.ok(cu, 'cenova_uprava musí být vytvořena');
    assert.equal(cu.nakupni_cena_bez_dph, 0);
    assert.equal(cu.nakupni_cena_s_dph, 0);
    assert.equal(cu.nabidkova_cena_bez_dph, 0);
    assert.equal(cu.nabidkova_cena_s_dph, 0);
    assert.equal(cu.marze_procent, 10);
    assert.equal(cu.potvrzeno, false);
    assert.match(String(cu.poznamka), /BEZ NALEZENÉ SHODY/);
    assert.match(String(cu.poznamka), /ruční nacenění/);
    // Nulová cena musí spadnout do HARD sanity flagu zero_price (blokace potvrzení/podání).
    const flags = checkPriceSanity([item as never]);
    assert.ok(
      flags.some((f) => f.code === 'zero_price' && f.level === 'hard'),
      'nulová prefill cena musí vyvolat HARD zero_price flag',
    );
    // A projde PriceOverrideSchema (validace finálního ProductMatch).
    PriceOverrideSchema.parse(cu);
    ok('(a) zadna_shoda kandidát → nulová nepotvrzená cena + HARD zero_price');
  }

  // (b) placeholder název produktu (candidateHasRealProduct false) → totéž
  {
    const item = makeItem({
      kandidati: [makeCandidate({ model: 'None', popis: '-', cena_bez_dph: 4200, cena_s_dph: 5082 })],
    });
    assert.equal(candidateHasRealProduct(item.kandidati![0]), false);
    applyPricePrefill([item], 10);
    const cu = item.cenova_uprava as Record<string, unknown>;
    assert.equal(cu.nabidkova_cena_bez_dph, 0);
    assert.equal(cu.nabidkova_cena_s_dph, 0);
    assert.equal(cu.potvrzeno, false);
    assert.match(String(cu.poznamka), /BEZ NALEZENÉ SHODY/);
    ok('(b) placeholder název → nulová nepotvrzená cena + poznámka');
  }

  // (c) normální kandidát → cena s defaultMarze, potvrzeno false
  {
    const item = makeItem();
    applyPricePrefill([item], 10);
    const cu = item.cenova_uprava as Record<string, unknown>;
    assert.equal(cu.nakupni_cena_bez_dph, 200);
    assert.equal(cu.marze_procent, 10);
    assert.equal(cu.nabidkova_cena_bez_dph, 220);
    assert.equal(cu.nabidkova_cena_s_dph, 266.2);
    assert.equal(cu.potvrzeno, false);
    assert.match(String(cu.poznamka), /Cena z AI odhadu/);
    assert.doesNotMatch(String(cu.poznamka), /sada\/komplet/);
    // Spolehlivost kandidáta se u normální shody nemění.
    assert.equal(item.kandidati![0].cena_spolehlivost, 'stredni');
    ok('(c) normální kandidát → cena s defaultMarze, potvrzeno=false');
  }

  // (d) sada-mismatch: položka = jednotlivý díl, kandidát = sada → nizka spolehlivost + varovná poznámka
  {
    warnings.length = 0;
    const item = makeItem({
      kandidati: [makeCandidate({
        model: 'E-06616',
        popis: 'Kompletní sada nářadí v kufru, 120 dílů',
        cena_bez_dph: 5000,
        cena_s_dph: 6050,
        cena_spolehlivost: 'vysoka',
      })],
    });
    applyPricePrefill([item], 10);
    const cu = item.cenova_uprava as Record<string, unknown>;
    assert.equal(item.kandidati![0].cena_spolehlivost, 'nizka', 'spolehlivost musí být forcenutá na nizka');
    assert.match(String(cu.poznamka), /sada\/komplet, ale položka je jednotlivý díl/);
    // Cena se NEmění — jen označení (extrémy blokuje sanity gate).
    assert.equal(cu.nakupni_cena_bez_dph, 5000);
    assert.equal(cu.nabidkova_cena_bez_dph, 5500);
    assert.ok(warnings.some((w) => w.includes('Scale mismatch')), 'musí zaznít console.warn');
    ok('(d) sada-mismatch → nizka spolehlivost + varovná poznámka + warn');
  }

  // (e) položka, jejíž název sadu obsahuje, + kandidát sada → ŽÁDNÝ mismatch warning
  {
    warnings.length = 0;
    const item = makeItem({
      polozka_nazev: 'Sada nářadí v kufru',
      kandidati: [makeCandidate({
        model: 'E-06616',
        popis: 'Kompletní sada nářadí v kufru, 120 dílů',
        cena_bez_dph: 5000,
        cena_s_dph: 6050,
        cena_spolehlivost: 'vysoka',
      })],
    });
    applyPricePrefill([item], 10);
    const cu = item.cenova_uprava as Record<string, unknown>;
    assert.equal(item.kandidati![0].cena_spolehlivost, 'vysoka', 'spolehlivost se nesmí měnit');
    assert.doesNotMatch(String(cu.poznamka), /sada\/komplet/);
    assert.ok(!warnings.some((w) => w.includes('Scale mismatch')), 'nesmí zaznít mismatch warn');
    ok('(e) položka je sada + kandidát sada → žádný mismatch warning');
  }

  // Bonus: token matching klíčových slov — „Makita" obsahuje „kit" a „headset" obsahuje
  // „set" jen jako podřetězce → NESMÍ triggernout (regresní pojistka guardu).
  {
    assert.equal(containsSadaKeyword('Makita DTW285Z rázový utahovák'), false);
    assert.equal(containsSadaKeyword('Logitech H390 headset s mikrofonem'), false);
    assert.equal(containsSadaKeyword('Kompletní sada nářadí'), true);
    assert.equal(containsSadaKeyword('Gola souprava 1/2"'), true);
    assert.equal(containsSadaKeyword('Sada bitů, set 32 ks'), true);
    ok('(f) containsSadaKeyword porovnává celá slova (Makita/headset nefalšují poplach)');
  }

  // Bonus: nulová/chybějící cena u jinak reálného kandidáta → také nulový prefill
  // (cena 0 od AI není použitelná nabídková cena).
  {
    const item = makeItem({
      kandidati: [makeCandidate({ cena_bez_dph: 0, cena_s_dph: 0 })],
    });
    applyPricePrefill([item], 10);
    const cu = item.cenova_uprava as Record<string, unknown>;
    assert.equal(cu.nabidkova_cena_bez_dph, 0);
    assert.match(String(cu.poznamka), /BEZ NALEZENÉ SHODY/);
    ok('(g) kandidát s cenou 0 → nulový nepotvrzený prefill (ruční nacenění)');
  }

  // Bonus: existující cenova_uprava se NIKDY nepřepisuje.
  {
    const existing = { nakupni_cena_bez_dph: 999, potvrzeno: true };
    const item = makeItem({ cenova_uprava: existing });
    applyPricePrefill([item], 10);
    assert.equal(item.cenova_uprava, existing);
    ok('(h) existující cenova_uprava zůstává nedotčená');
  }
} finally {
  console.warn = originalWarn;
}

console.log(`\n${passed} passed, 0 failed`);
