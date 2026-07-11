/**
 * Deterministický test submit-gate (žádná síť, žádné AI, žádný build).
 *
 * V projektu není nakonfigurovaný test runner (žádný vitest/jest, žádný `test`
 * script v package.json) — proto je tohle samostatný spustitelný tsx skript
 * postavený na `node:assert/strict`. Při chybě vypíše ✗ a ukončí se nenulovým
 * kódem, takže jde použít i v CI.
 *
 * Spuštění (z adresáře scripts/):
 *   npx tsx tests/submit-gate.test.ts
 *
 * Importuje se z `.ts` zdrojů přes příponu `.js` — stejná konvence jako v
 * ostatních souborech (viz submit-gate.ts: `import ... from './template-engine.js'`).
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeSubmitGate } from '../src/lib/submit-gate.js';
import { hasPlaceholders } from '../src/lib/template-engine.js';

// --- Mini test harness ---------------------------------------------------

let passed = 0;
let failed = 0;
const tempDirs: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
}

/**
 * Vytvoří čerstvý temp output-adresář a zapíše do něj zadané fixture soubory.
 * Když `productMatch`/`fieldValidation` chybí, soubor se nevytvoří (simuluje
 * chybějící vstup). Záměrně NEzapisujeme žádný .docx — bez .docx nemůže gate
 * hlásit zbytkové placeholdery, takže ostatní kontroly jsou izolované.
 */
async function makeCase(files: {
  productMatch?: unknown;
  fieldValidation?: unknown;
  partsSelection?: unknown;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vz-submit-gate-'));
  tempDirs.push(dir);
  if (files.productMatch !== undefined) {
    await writeFile(join(dir, 'product-match.json'), JSON.stringify(files.productMatch), 'utf-8');
  }
  if (files.fieldValidation !== undefined) {
    await writeFile(join(dir, 'field-validation.json'), JSON.stringify(files.fieldValidation), 'utf-8');
  }
  if (files.partsSelection !== undefined) {
    await writeFile(join(dir, 'parts-selection.json'), JSON.stringify(files.partsSelection), 'utf-8');
  }
  return dir;
}

// Položka s cast_id pro test vícečástových zakázek.
function partItem(polozka_index: number, cast_id: string, potvrzeno: boolean) {
  return { ...item(polozka_index, null, 1000, potvrzeno), cast_id };
}

// Tvar položky odpovídá reálnému PolozkaMatch (viz types.ts): pole, která gate
// čte, jsou polozka_index, cena_max_s_dph a cenova_uprava (cena + potvrzeno).
function item(
  polozka_index: number,
  cena_max_s_dph: number | null,
  nabidkova_cena_s_dph: number,
  potvrzeno = true,
) {
  return {
    polozka_nazev: `Položka ${polozka_index + 1}`,
    polozka_index,
    cena_max_s_dph,
    cenova_uprava: { nabidkova_cena_s_dph, potvrzeno },
  };
}

const PASS_TWICE = [{ overall: 'pass' }, { overall: 'pass' }];

// --- Testy ---------------------------------------------------------------

async function run(): Promise<void> {
  // 1) Vše OK → ready=true, žádné problémy.
  await test('all-good → ready=true, bez problémů', async () => {
    const dir = await makeCase({
      productMatch: {
        polozky_match: [
          item(0, null, 1000), // bez stropu, naceněno
          item(1, 50000, 45000), // pod stropem, naceněno
        ],
      },
      fieldValidation: PASS_TWICE,
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, true);
    assert.deepEqual(res.problems, []);
  });

  await test('změna ceny po generování → stale dokumenty blokují submit-gate', async () => {
    const dir = await makeCase({
      productMatch: {
        prices_updated_at: '2099-01-01T00:00:00.000Z',
        polozky_match: [item(0, null, 1000)],
      },
      fieldValidation: PASS_TWICE,
    });
    await writeFile(join(dir, 'cenova_nabidka.pdf'), 'stará cena', 'utf-8');
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, false);
    assert.ok(res.problems.includes(
      'Dokumenty neodpovídají aktuálním cenám — spusťte znovu Generování a Kontrolu.',
    ));
  });

  // 1b) Nepotvrzená cena → ready=false (kryje i scénář „přepnutí kandidáta smazalo
  // potvrzení, dokumenty zůstaly stale" — sanity fallback na cenu kandidáta nesmí stačit).
  await test('unconfirmed → ready=false, problém zmiňuje "potvrzenou cenu"', async () => {
    const dir = await makeCase({
      productMatch: {
        polozky_match: [item(0, null, 1000), item(1, 50000, 45000, false)],
      },
      fieldValidation: PASS_TWICE,
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, false);
    assert.ok(res.problems.some((p) => p.includes('potvrzenou cenu')));
  });

  // 1c) Vícečástová zakázka: nepotvrzené položky NEVYBRANÉ části nesmí blokovat gate
  // (podává se jen část A; položky části B zůstanou nepotvrzené a musí se ignorovat).
  await test('multi-part → nepotvrzené položky nevybrané části neblokují', async () => {
    const dir = await makeCase({
      productMatch: {
        polozky_match: [
          partItem(0, 'A', true),   // vybraná část, potvrzeno
          partItem(1, 'A', true),   // vybraná část, potvrzeno
          partItem(2, 'B', false),  // NEvybraná část, nepotvrzeno — musí být ignorováno
        ],
      },
      partsSelection: { selected_parts: ['A'] },
      fieldValidation: PASS_TWICE,
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, true, `problems: ${res.problems.join(' | ')}`);
  });

  await test('změněný výběr částí od nacenění blokuje submit-gate', async () => {
    const dir = await makeCase({
      productMatch: {
        selected_parts_snapshot: ['A'],
        polozky_match: [partItem(0, 'A', true), partItem(1, 'B', true)],
      },
      partsSelection: { selected_parts: ['A', 'B'] },
      fieldValidation: PASS_TWICE,
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, false);
    assert.ok(res.problems.includes('Výběr částí se změnil od posledního nacenění — spusťte znovu krok Produkty.'));
  });

  await test('shodný snapshot výběru částí submit-gate propustí', async () => {
    const dir = await makeCase({
      productMatch: {
        selected_parts_snapshot: ['A'],
        polozky_match: [partItem(0, 'A', true), partItem(1, 'B', true)],
      },
      partsSelection: { selected_parts: ['A'] },
      fieldValidation: PASS_TWICE,
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, true, `problems: ${res.problems.join(' | ')}`);
  });

  await test('starý product-match bez snapshotu zůstává kompatibilní', async () => {
    const dir = await makeCase({
      productMatch: { polozky_match: [partItem(0, 'A', true), partItem(1, 'B', true)] },
      partsSelection: { selected_parts: ['B'] },
      fieldValidation: PASS_TWICE,
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, true, `problems: ${res.problems.join(' | ')}`);
  });

  // 2) Překročený cenový strop → ready=false + problém zmiňuje "strop".
  await test('over cap → ready=false, problém zmiňuje "strop"', async () => {
    const dir = await makeCase({
      productMatch: {
        polozky_match: [item(0, 39999, 45000)], // nabídka > strop
      },
      fieldValidation: [{ overall: 'pass' }],
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, false);
    assert.ok(
      res.problems.some((p) => p.includes('strop')),
      `očekáván problém se "strop", got: ${JSON.stringify(res.problems)}`,
    );
  });

  // 3) Nenaceněná položka (cena ≤ 0) → ready=false + "nemá nabídkovou cenu".
  await test('unpriced → ready=false, problém zmiňuje "nemá nabídkovou cenu"', async () => {
    const dir = await makeCase({
      productMatch: {
        polozky_match: [item(0, null, 0)], // cena = 0
      },
      fieldValidation: [{ overall: 'pass' }],
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, false);
    assert.ok(
      res.problems.some((p) => p.includes('nemá nabídkovou cenu')),
      `očekáván problém "nemá nabídkovou cenu", got: ${JSON.stringify(res.problems)}`,
    );
  });

  // 4) Chybí field-validation.json → ready=false + "field-validace".
  await test('missing field-validation → ready=false, problém zmiňuje "field-validace"', async () => {
    const dir = await makeCase({
      productMatch: {
        polozky_match: [item(0, null, 1000)],
      },
      // field-validation.json záměrně chybí
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, false);
    assert.ok(
      res.problems.some((p) => p.includes('field-validace')),
      `očekáván problém "field-validace", got: ${JSON.stringify(res.problems)}`,
    );
  });

  // 5) Field-validace neprošla → ready=false.
  await test('field-validation fail → ready=false', async () => {
    const dir = await makeCase({
      productMatch: {
        polozky_match: [item(0, null, 1000)],
      },
      fieldValidation: [{ overall: 'fail' }],
    });
    const res = await computeSubmitGate(dir);
    assert.equal(res.ready, false);
  });

  // 6) hasPlaceholders — jednotkový test detekce placeholderů.
  await test('hasPlaceholders — detekuje placeholdery, ignoruje normální text', () => {
    assert.equal(hasPlaceholders('doplní účastník'), true);
    assert.equal(hasPlaceholders('______'), true);
    assert.equal(hasPlaceholders('normální text'), false);
  });
}

// --- Spuštění + úklid ----------------------------------------------------

run()
  .catch((err) => {
    // Neočekávaná chyba mimo jednotlivý test.
    failed++;
    console.error('✗ neočekávaná chyba v test harness');
    console.error(err);
  })
  .finally(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  });
