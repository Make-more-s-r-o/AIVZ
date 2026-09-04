import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPartDocumentPriceAssignments,
  resolveDocumentCastId,
  scopeDocumentDataToPart,
  type DocumentData,
  type PartDocumentPriceAssignment,
} from '../src/lib/data-resolver.js';
import { calculateTenderPriceRecap } from '../src/lib/price-calculator.js';
import { checkPartPriceCaps } from '../src/lib/price-sanity.js';
import { computeSubmitGate, isPartPriceCapBlockingEnabled } from '../src/lib/submit-gate.js';
import { CastSchema, type Cast, type ProductMatch } from '../src/lib/types.js';
import { buildPartPriceCapValidationChecks } from '../src/lib/validation-deterministic.js';
import { ANALYZE_TENDER_SYSTEM, buildAnalyzeUserMessage } from '../src/prompts/analyze-tender.js';

const parts: Cast[] = [
  { id: 'A', nazev: 'Šicí dílna', pocet_polozek: 0 },
  { id: 'B', nazev: 'Kovodílna', pocet_polozek: 0 },
  { id: 'C', nazev: 'Truhlářská dílna', pocet_polozek: 0 },
];

function provenance(index: number, net: number, gross: number) {
  return {
    verze: 1,
    typ: 'lidsky_vstup',
    stav: 'dolozena',
    url: null,
    doklad_ref: `cenovy-doklad-${index}`,
    zjisteno_at: '2026-09-01T10:00:00.000Z',
    cena_v_okamziku: {
      bez_dph: net,
      s_dph: gross,
      mena: 'CZK',
      sazba_dph: 21,
      baleni_ks: 1,
    },
    zjistil: { typ: 'uzivatel', id: 'e6a-test' },
    kandidat_fingerprint: `e6a|${index}|0`,
  };
}

function matchItem(index: number, castId: string | undefined, net: number, gross: number, quantity = 1) {
  return {
    polozka_nazev: `Položka ${index + 1}`,
    polozka_index: index,
    mnozstvi: quantity,
    jednotka: 'ks',
    typ: 'produkt',
    ...(castId ? { cast_id: castId } : {}),
    kandidati: [{
      vyrobce: 'Výrobce',
      model: `Model ${index + 1}`,
      katalogove_cislo: `KAT-${index + 1}`,
      popis: 'Testovací produkt',
      parametry: {},
      shoda_s_pozadavky: [],
      cena_bez_dph: net,
      cena_s_dph: gross,
      cena_spolehlivost: 'vysoka',
      dodavatele: [],
      dostupnost: 'skladem',
    }],
    vybrany_index: 0,
    oduvodneni_vyberu: 'Test',
    cenova_uprava: {
      nakupni_cena_bez_dph: 0,
      nakupni_cena_s_dph: 0,
      marze_procent: 0,
      nabidkova_cena_bez_dph: net,
      nabidkova_cena_s_dph: gross,
      potvrzeno: true,
      zkontrolovano_at: '2026-09-01T10:00:00.000Z',
      zkontrolovano_kym: 'E6a test',
      price_provenance: provenance(index, net, gross),
    },
  };
}

function productMatch(...items: ReturnType<typeof matchItem>[]): ProductMatch {
  return { polozky_match: items } as unknown as ProductMatch;
}

function documentData(recap: ReturnType<typeof calculateTenderPriceRecap>): DocumentData {
  return {
    celkova_cena_bez_dph: recap.celkova_cena_bez_dph,
    celkova_cena_s_dph: recap.celkova_cena_s_dph,
    dph_castka: recap.celkova_cena_s_dph - recap.celkova_cena_bez_dph,
    dph_sazba: '21',
    casti: recap.casti,
    polozky: [
      { nazev: 'A', mnozstvi: 2, jednotka: 'ks', cena_za_jednotku_bez_dph: 100, cena_celkem_bez_dph: 200, cast_id: 'A' },
      { nazev: 'B', mnozstvi: 1, jednotka: 'ks', cena_za_jednotku_bez_dph: 300, cena_celkem_bez_dph: 300, cast_id: 'B' },
      { nazev: 'C', mnozstvi: 1, jednotka: 'ks', cena_za_jednotku_bez_dph: 400, cena_celkem_bez_dph: 400, cast_id: 'C' },
    ],
  } as DocumentData;
}

async function makeGateCase(
  t: { after: (fn: () => Promise<void> | void) => void },
  match: ProductMatch,
  declaredParts: readonly Cast[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'e6a-part-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(dir, 'analysis.json'), JSON.stringify({
      pozadovane_dokumenty: [],
      kvalifikace: [],
      casti: declaredParts,
    })),
    writeFile(join(dir, 'product-match.json'), JSON.stringify(match)),
    writeFile(join(dir, 'field-validation.json'), JSON.stringify([{ overall: 'pass' }])),
  ]);
  return dir;
}

test('schéma a prompt vyžadují explicitní strop i základ DPH bez odhadu', () => {
  const parsed = CastSchema.parse({
    id: 'A',
    nazev: 'Šicí dílna',
    cenovy_strop: '646 500 Kč vč. DPH',
    cenovy_strop_vcetne_dph: true,
  });
  assert.equal(parsed.cenovy_strop, 646_500);
  assert.equal(parsed.cenovy_strop_vcetne_dph, true);
  assert.equal(CastSchema.safeParse({ id: 'A', nazev: 'Šicí dílna', cenovy_strop: 646_500 }).success, false);
  const withoutCap = CastSchema.parse({
    id: 'B', nazev: 'Kovodílna', cenovy_strop: null, cenovy_strop_vcetne_dph: null,
  });
  assert.equal(withoutCap.cenovy_strop, null);
  const expectedValueOnly = CastSchema.parse({
    id: 'C', nazev: 'Truhlářská dílna', predpokladana_hodnota: 531_600,
  });
  assert.equal(expectedValueOnly.cenovy_strop, undefined);
  const prompt = `${ANALYZE_TENDER_SYSTEM}\n${buildAnalyzeUserMessage('test')}`;
  assert.match(prompt, /vrať cenovy_strop: null a cenovy_strop_vcetne_dph: null/);
  assert.match(prompt, /Strop nikdy neodhaduj/);
  assert.match(prompt, /Běžná předpokládaná\s+hodnota není automaticky cenový strop/);
  assert.match(prompt, /základ nehádej a vrať obě pole jako null/);
});

test('rekapitulace tří částí a smlouvy 4a/4b/4c používají tři různé ceny', async () => {
  const match = productMatch(
    matchItem(0, 'A', 100, 121, 2),
    matchItem(1, 'B', 300, 363),
    matchItem(2, 'C', 400, 484),
  );
  const recap = calculateTenderPriceRecap(match, parts);
  assert.deepEqual(
    recap.casti.map(({ id, cena_bez_dph, cena_s_dph, pocet_polozek }) => ({ id, cena_bez_dph, cena_s_dph, pocet_polozek })),
    [
      { id: 'A', cena_bez_dph: 200, cena_s_dph: 242, pocet_polozek: 1 },
      { id: 'B', cena_bez_dph: 300, cena_s_dph: 363, pocet_polozek: 1 },
      { id: 'C', cena_bez_dph: 400, cena_s_dph: 484, pocet_polozek: 1 },
    ],
  );

  const filenames = [
    'Příloha 4a Návrh kupní smlouvy Šicí dílna.docx',
    'Příloha 4b Návrh kupní smlouvy Kovodílna.docx',
    'Příloha 4c Návrh kupní smlouvy truhlářská dílna.docx',
  ];
  const data = documentData(recap);
  const assignments: PartDocumentPriceAssignment[] = filenames.map((filename) => {
    const castId = resolveDocumentCastId({ filename }, parts)!;
    const scoped = scopeDocumentDataToPart(data, castId);
    return {
      document: filename,
      cast_id: castId,
      cena_bez_dph: scoped.celkova_cena_bez_dph,
      cena_s_dph: scoped.celkova_cena_s_dph,
    };
  });
  assert.deepEqual(assignments.map((assignment) => assignment.cast_id), ['A', 'B', 'C']);
  assert.deepEqual(assignments.map((assignment) => assignment.cena_bez_dph), [200, 300, 400]);
  assert.doesNotThrow(() => assertPartDocumentPriceAssignments(assignments, recap.casti));
  assert.throws(() => assertPartDocumentPriceAssignments([
    assignments[0]!,
    { ...assignments[1]!, cena_bez_dph: 200, cena_s_dph: 242 },
  ], recap.casti), /dostaly tutéž cenu/);
  assert.throws(() => assertPartDocumentPriceAssignments([
    { ...assignments[0]!, cena_bez_dph: 300, cena_s_dph: 363 },
    { ...assignments[1]!, cena_bez_dph: 200, cena_s_dph: 242 },
  ], recap.casti), /nedostal cenu své části/);
  assert.doesNotThrow(() => assertPartDocumentPriceAssignments([
    { document: 'a.docx', cast_id: 'A', cena_bez_dph: 200, cena_s_dph: 242 },
    { document: 'b.docx', cast_id: 'B', cena_bez_dph: 200, cena_s_dph: 242 },
  ], [
    { id: 'A', nazev: 'A', cena_bez_dph: 200, cena_s_dph: 242, pocet_polozek: 1 },
    { id: 'B', nazev: 'B', cena_bez_dph: 200, cena_s_dph: 242, pocet_polozek: 1 },
  ]));

  const selectedB = calculateTenderPriceRecap(match, parts, new Set(['B']));
  assert.equal(selectedB.celkova_cena_bez_dph, 300);
  assert.deepEqual(selectedB.casti.map((part) => part.cena_bez_dph), [200, 300, 400]);

  const generateSource = await readFile(new URL('../src/generate-bid.ts', import.meta.url), 'utf-8');
  assert.match(generateSource, /scopeDocumentDataToPart\(docData, templateCastId\)/);
  assert.match(generateSource, /fillExcelWithAI\(template\.path, company, templateTenderData\)/);
  assert.match(generateSource, /fillTemplateWithAI\(template\.path, company, templateTenderData, template\.type\)/);
  assert.match(generateSource, /assertPartDocumentPriceAssignments\(/);
});

test('překročení stropu je ve validaci i submit gate warning a přepínač umí blokovat', async (t) => {
  const cappedParts: Cast[] = [
    { id: 'A', nazev: 'Šicí dílna', pocet_polozek: 0, cenovy_strop: 120, cenovy_strop_vcetne_dph: true },
    { id: 'B', nazev: 'Kovodílna', pocet_polozek: 0, cenovy_strop: null, cenovy_strop_vcetne_dph: null },
  ];
  const match = productMatch(matchItem(0, 'A', 100, 121), matchItem(1, 'B', 10, 12.1));
  const recap = calculateTenderPriceRecap(match, cappedParts);
  const validation = buildPartPriceCapValidationChecks(cappedParts, recap.casti);
  assert.equal(validation.length, 1);
  assert.equal(validation[0]?.status, 'warning');
  assert.match(validation[0]?.detail ?? '', /část A.*121.*120.*1 Kč/i);
  assert.equal(isPartPriceCapBlockingEnabled(''), false);
  assert.equal(isPartPriceCapBlockingEnabled('0'), false);
  assert.equal(isPartPriceCapBlockingEnabled('true'), true);
  assert.equal(isPartPriceCapBlockingEnabled('1'), true);

  const dir = await makeGateCase(t, match, cappedParts);

  const warningGate = await computeSubmitGate(dir, { now: new Date('2026-09-04T12:00:00.000Z') });
  assert.equal(warningGate.ready, true, warningGate.problems.join(' | '));
  assert.ok(warningGate.warnings.some((warning) => /Cenový strop části A.*121.*120.*1 Kč/i.test(warning)));

  const blockingGate = await computeSubmitGate(dir, {
    now: new Date('2026-09-04T12:00:00.000Z'),
    blockPartPriceCapExceeded: true,
  });
  assert.equal(blockingGate.ready, false);
  assert.ok(blockingGate.problems.some((problem) => /Cenový strop části A.*121.*120.*1 Kč/i.test(problem)));
});

test('strop včetně DPH se porovnává s cenou včetně DPH', () => {
  const cappedParts: Cast[] = [
    { id: 'A', nazev: 'Kovodílna', pocet_polozek: 0, cenovy_strop: 552_000, cenovy_strop_vcetne_dph: true },
    parts[1]!,
  ];
  const recap = calculateTenderPriceRecap(productMatch(
    matchItem(0, 'A', 500_000, 605_000),
    matchItem(1, 'B', 1, 1.21),
  ), cappedParts);
  const findings = checkPartPriceCaps(cappedParts, recap.casti);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.cena, 605_000);
  assert.equal(findings[0]?.strop, 552_000);
  assert.equal(findings[0]?.rozdil, 53_000);
  assert.equal(findings[0]?.vcetne_dph, true);

  const netCappedParts: Cast[] = [
    { id: 'A', nazev: 'Kovodílna', pocet_polozek: 0, cenovy_strop: 499_999, cenovy_strop_vcetne_dph: false },
    parts[1]!,
  ];
  const netFindings = checkPartPriceCaps(netCappedParts, recap.casti);
  assert.equal(netFindings[0]?.cena, 500_000);
  assert.equal(netFindings[0]?.rozdil, 1);
  assert.equal(netFindings[0]?.vcetne_dph, false);
});

test('položka bez cast_id u dělené zakázky je výslovný nález', async (t) => {
  const match = productMatch(
    matchItem(0, 'A', 100, 121),
    matchItem(1, undefined, 200, 242),
  );
  const recap = calculateTenderPriceRecap(match, parts);
  assert.deepEqual(recap.polozky_bez_cast_id, [{ polozka_index: 1, polozka_nazev: 'Položka 2' }]);
  assert.equal(recap.celkova_cena_bez_dph, 300);
  assert.equal(recap.casti.reduce((sum, part) => sum + part.cena_bez_dph, 0), 100);
  const gate = await computeSubmitGate(await makeGateCase(t, match, parts), {
    now: new Date('2026-09-04T12:00:00.000Z'),
  });
  assert.ok(gate.warnings.some((warning) => /Položka „Položka 2“.*nemá.*cast_id/.test(warning)));
});

test('nedělená a jednočástová zakázka zachovají agregovanou cenu', () => {
  const match = productMatch(matchItem(0, undefined, 100, 121), matchItem(1, undefined, 200, 242));
  const withoutParts = calculateTenderPriceRecap(match, []);
  const onePart = calculateTenderPriceRecap(match, [{ id: 'A', nazev: 'Celá zakázka' }]);
  for (const recap of [withoutParts, onePart]) {
    assert.equal(recap.celkova_cena_bez_dph, 300);
    assert.equal(recap.celkova_cena_s_dph, 363);
    assert.equal(recap.pocet_polozek, 2);
    assert.deepEqual(recap.casti, []);
    assert.deepEqual(recap.polozky_bez_cast_id, []);
  }
  const halfCent = calculateTenderPriceRecap(productMatch(matchItem(2, undefined, 1.005, 1.005)), []);
  assert.equal(halfCent.celkova_cena_bez_dph, 1);
  assert.equal(halfCent.celkova_cena_s_dph, 1);

  const legacyItem = matchItem(3, undefined, 125, 151.25);
  const legacy = {
    kandidati: legacyItem.kandidati,
    vybrany_index: 0,
    cenova_uprava: legacyItem.cenova_uprava,
  } as unknown as ProductMatch;
  const legacyRecap = calculateTenderPriceRecap(legacy, []);
  assert.equal(legacyRecap.celkova_cena_bez_dph, 125);
  assert.equal(legacyRecap.celkova_cena_s_dph, 151.25);
  assert.equal(legacyRecap.pocet_polozek, 1);
  const aggregate = documentData({ ...withoutParts, casti: [] });
  assert.deepEqual(scopeDocumentDataToPart(aggregate), aggregate);
  assert.equal(resolveDocumentCastId({ filename: 'Příloha 4a smlouva.docx' }, []), undefined);
});

test('část bez stropu nevytvoří varování', async (t) => {
  const uncapped: Cast[] = [
    { id: 'A', nazev: 'A', pocet_polozek: 0, cenovy_strop: null, cenovy_strop_vcetne_dph: null },
    parts[1]!,
  ];
  const recap = calculateTenderPriceRecap(productMatch(
    matchItem(0, 'A', 500_000, 605_000),
    matchItem(1, 'B', 1, 1.21),
  ), uncapped);
  assert.deepEqual(checkPartPriceCaps(uncapped, recap.casti), []);
  const gate = await computeSubmitGate(await makeGateCase(t, productMatch(
    matchItem(0, 'A', 500_000, 605_000),
    matchItem(1, 'B', 1, 1.21),
  ), uncapped), { now: new Date('2026-09-04T12:00:00.000Z') });
  assert.equal(gate.ready, true, gate.problems.join(' | '));
  assert.equal(gate.warnings.some((warning) => /Cenový strop části/.test(warning)), false);
});

test('cena přesně rovná stropu nevytvoří varování', async (t) => {
  const cappedParts: Cast[] = [
    { id: 'A', nazev: 'A', pocet_polozek: 0, cenovy_strop: 605_000, cenovy_strop_vcetne_dph: true },
    parts[1]!,
  ];
  const recap = calculateTenderPriceRecap(productMatch(
    matchItem(0, 'A', 500_000, 605_000),
    matchItem(1, 'B', 1, 1.21),
  ), cappedParts);
  assert.deepEqual(checkPartPriceCaps(cappedParts, recap.casti), []);
  const gate = await computeSubmitGate(await makeGateCase(t, productMatch(
    matchItem(0, 'A', 500_000, 605_000),
    matchItem(1, 'B', 1, 1.21),
  ), cappedParts), { now: new Date('2026-09-04T12:00:00.000Z') });
  assert.equal(gate.ready, true, gate.problems.join(' | '));
  assert.equal(gate.warnings.some((warning) => /Cenový strop části/.test(warning)), false);
});
