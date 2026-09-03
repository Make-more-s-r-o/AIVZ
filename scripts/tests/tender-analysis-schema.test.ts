import { strict as assert } from 'node:assert';
import test from 'node:test';

import { mergeDetectedCastiDetails, TenderAnalysisSchema } from '../src/lib/types.js';
import { ANALYZE_TENDER_SYSTEM, buildAnalyzeUserMessage } from '../src/prompts/analyze-tender.js';

function analysisInput(overrides: Record<string, unknown> = {}) {
  return {
    zakazka: {
      nazev: 'Sdílna Litoměřice - technické vybavení',
      evidencni_cislo: 'N006/26/V00027380',
      zadavatel: { nazev: 'Institut technického vzdělávání, z. ú.' },
      predmet: 'Technické vybavení dílen',
      predpokladana_hodnota: 1_409_173,
      typ_zakazky: 'dodavky',
      typ_rizeni: 'zjednodusene_podlimitni',
    },
    kvalifikace: [],
    hodnotici_kriteria: [],
    terminy: {
      lhuta_nabidek: '2026-09-14T10:00:00',
      otevirani_obalek: null,
      doba_plneni_od: null,
      doba_plneni_do: '2027-02-15',
      prohlidka_mista: null,
    },
    casti: [],
    polozky: [],
    technicke_pozadavky: [],
    rizika: [],
    doporuceni: { rozhodnuti: 'GO', oduvodneni: 'Test', klicove_body: [] },
    ...overrides,
  };
}

test('dělená zakázka vezme deklarovaný celek bez DPH místo součtu a zachová hodnoty částí', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: {
        celkem_bez_DPH_Kc: 1_409_173.55,
        celkem_vcDPH_Kc: 1_705_100,
        cast1_sici_dilna_vcDPH_Kc: 646_500,
        cast2_kovodiln_vcDPH_Kc: 552_000,
        cast3_truhlarska_dilna_vcDPH_Kc: 531_600,
      },
    },
  }));

  assert.equal(parsed.zakazka.predpokladana_hodnota, 1_409_173.55);
  assert.deepEqual(
    parsed.zakazka.hodnota_po_castech,
    {
      cast1_sici_dilna_vcDPH_Kc: 646_500,
      cast2_kovodiln_vcDPH_Kc: 552_000,
      cast3_truhlarska_dilna_vcDPH_Kc: 531_600,
    },
  );
  assert.deepEqual(parsed.casti.map((part) => part.id), ['1', '2', '3']);
  assert.ok(parsed.casti.every((part) => part.predpokladana_hodnota === undefined));
});

test('samotný deklarovaný celek včetně DPH se nevydává za hodnotu bez DPH', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: {
        'celkem s 21 % DPH': 1_705_100,
        cast1_sici_dilna_vcDPH_Kc: 646_500,
      },
    },
  }));

  assert.equal(parsed.zakazka.predpokladana_hodnota, null);
  assert.deepEqual(parsed.zakazka.hodnota_po_castech, { cast1_sici_dilna_vcDPH_Kc: 646_500 });
});

test('bez deklarovaného celku použije schema maximum částí, nikoli jejich součet', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: { 'Část 1': 621_500, 'Část 2': 552_000, 'Část 3': 531_600 },
    },
  }));

  assert.equal(parsed.zakazka.predpokladana_hodnota, 621_500);
  assert.deepEqual(parsed.zakazka.hodnota_po_castech, {
    'Část 1': 621_500,
    'Část 2': 552_000,
    'Část 3': 531_600,
  });
  assert.ok(parsed.casti.every((part) => part.predpokladana_hodnota === undefined));
});

test('DPH kontext obálky částí se při normalizaci neztratí ani nepřepíše net pole', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: {
        celkem_vcDPH_Kc: 1_705_100,
        casti_vcDPH_Kc: { 'Část 1': 646_500 },
      },
    },
  }));

  assert.equal(parsed.zakazka.predpokladana_hodnota, null);
  assert.deepEqual(parsed.zakazka.hodnota_po_castech, { 'casti_vcDPH_Kc.Část 1': 646_500 });
  assert.equal(parsed.casti[0]?.predpokladana_hodnota, undefined);
});

test('částka z AI projde i jako český string s měnou a údajem o DPH', () => {
  const scalar = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: '1 409 173,55 Kč bez DPH',
    },
  }));
  const structured = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: {
        celkem_bez_DPH_Kc: '1 409 173,55 Kč bez DPH',
        celkem_vcDPH_Kc: '1 705 100 Kč vč. DPH',
      },
    },
  }));

  assert.equal(scalar.zakazka.predpokladana_hodnota, 1_409_173.55);
  assert.equal(structured.zakazka.predpokladana_hodnota, 1_409_173.55);
});

test('gross kvalifikátor v hodnotě se neztratí a částka nevstoupí do net pole', () => {
  const scalar = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: '1 705 100 Kč vč. DPH',
    },
  }));
  const structured = TenderAnalysisSchema.parse(analysisInput({
    zakazka: {
      ...(analysisInput().zakazka as Record<string, unknown>),
      predpokladana_hodnota: { celkem: '1 705 100 Kč vč. DPH' },
    },
  }));

  assert.equal(scalar.zakazka.predpokladana_hodnota, null);
  assert.equal(structured.zakazka.predpokladana_hodnota, null);
});

test('objektové termíny z částí se převedou na konzervativní celek a detail se neztratí', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    terminy: {
      lhuta_nabidek: {
        'Část 1': '2026-09-14T10:00:00',
        'Část 2': '2026-09-13T12:00:00',
        'Část 3': '2026-09-14T08:00:00',
      },
      otevirani_obalek: { 'Část 1': '2026-09-14T10:30:00', 'Část 2': '2026-09-14T10:15:00' },
      doba_plneni_od: { 'Část 1': '20. 9. 2026', 'Část 2': '18. 9. 2026' },
      doba_plneni_do: {
        cast1_sici_dilna: '2026-10-14',
        cast2_kovodilna: '2027-02-15',
        cast3_truhlarska_dilna: '2026-10-14',
      },
      prohlidka_mista: null,
    },
  }));

  assert.equal(parsed.terminy.lhuta_nabidek, '2026-09-13T12:00:00');
  assert.equal(parsed.terminy.otevirani_obalek, '2026-09-14T10:15:00');
  assert.equal(parsed.terminy.doba_plneni_od, '18. 9. 2026');
  assert.equal(parsed.terminy.doba_plneni_do, '2027-02-15');
  assert.equal(parsed.casti.find((part) => part.id === '1')?.terminy?.doba_plneni_do, '2026-10-14');
  assert.equal(parsed.casti.find((part) => part.id === '2')?.terminy?.doba_plneni_do, '2027-02-15');
  assert.equal(parsed.casti.find((part) => part.id === '3')?.terminy?.doba_plneni_do, '2026-10-14');
  assert.deepEqual(parsed.terminy_po_castech, {
    'Část 1': {
      lhuta_nabidek: '2026-09-14T10:00:00',
      otevirani_obalek: '2026-09-14T10:30:00',
      doba_plneni_od: '20. 9. 2026',
    },
    'Část 2': {
      lhuta_nabidek: '2026-09-13T12:00:00',
      otevirani_obalek: '2026-09-14T10:15:00',
      doba_plneni_od: '18. 9. 2026',
    },
    'Část 3': { lhuta_nabidek: '2026-09-14T08:00:00' },
    cast1_sici_dilna: { doba_plneni_do: '2026-10-14' },
    cast2_kovodilna: { doba_plneni_do: '2027-02-15' },
    cast3_truhlarska_dilna: { doba_plneni_do: '2026-10-14' },
  });
});

test('skalární hodnoty nedělené zakázky projdou beze změny chování', () => {
  const input = analysisInput();
  const parsed = TenderAnalysisSchema.parse(input);

  assert.equal(parsed.zakazka.predpokladana_hodnota, 1_409_173);
  assert.equal(parsed.terminy.doba_plneni_do, '2027-02-15');
  assert.deepEqual(parsed.casti, []);
});

test('skalární hodnoty zakázky s jedinou explicitní částí projdou beze změny', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    casti: [{ id: 'A', nazev: 'Jediná část', pocet_polozek: 0 }],
  }));

  assert.equal(parsed.zakazka.predpokladana_hodnota, 1_409_173);
  assert.equal(parsed.terminy.doba_plneni_do, '2027-02-15');
  assert.deepEqual(parsed.casti.map((part) => part.id), ['A']);
});

test('deterministické části převezmou detail podle stabilního ID a nezahodí neparsovanou část', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    casti: [
      {
        id: '1',
        nazev: 'Část 1 - Šicí dílna',
        predpokladana_hodnota: 646_500,
        pocet_polozek: 0,
        terminy: { doba_plneni_do: '14.10.2026' },
      },
      { id: '2', nazev: 'Část 2 - Kovodílna', pocet_polozek: 0 },
      { id: '3', nazev: 'Část 3 - Truhlářská dílna', pocet_polozek: 0, terminy: { doba_plneni_do: '14.10.2026' } },
    ],
  }));

  const merged = mergeDetectedCastiDetails(parsed.casti, [
    { id: 'A', nazev: 'Část A', pocet_polozek: 13, soupis_filename: 'Příloha 3a Výkaz výměr šicí dílna.xlsx' },
    { id: 'B', nazev: 'Část B', pocet_polozek: 3, soupis_filename: 'Příloha 3b Výkaz výměr kovodílna.xlsx' },
  ]);
  assert.deepEqual(merged.map((part) => part.id), ['A', 'B', '3']);
  assert.equal(merged[0].nazev, 'Část 1 - Šicí dílna');
  assert.equal(merged[0].predpokladana_hodnota, 646_500);
  assert.equal(merged[0].terminy?.doba_plneni_do, '14.10.2026');
  assert.equal(merged[0].pocet_polozek, 13);
  assert.equal(merged[2].nazev, 'Část 3 - Truhlářská dílna');
  assert.equal(merged[2].terminy?.doba_plneni_do, '14.10.2026');
});

test('popisné klíče objektového termínu nevytvoří falešnou dělenou zakázku', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    terminy: {
      ...(analysisInput().terminy as Record<string, unknown>),
      doba_plneni_do: {
        nejzazsi_termin: '2027-02-15',
        podminka: 'do 30 dnů od podpisu smlouvy',
      },
    },
  }));

  assert.equal(parsed.terminy.doba_plneni_do, '2027-02-15');
  assert.deepEqual(parsed.casti, []);
  assert.equal(parsed.terminy_po_castech, undefined);
});

test('český a ISO termín bez offsetu se porovnají ve stejné lokální časové bázi', () => {
  const parsed = TenderAnalysisSchema.parse(analysisInput({
    terminy: {
      ...(analysisInput().terminy as Record<string, unknown>),
      lhuta_nabidek: {
        'Část 1': '14. 9. 2026 10:00',
        'Část 2': '2026-09-14T10:30:00',
      },
    },
  }));

  assert.equal(parsed.terminy.lhuta_nabidek, '14. 9. 2026 10:00');
});

test('prompt požaduje skalární celkové hodnoty a detail termínů v casti[]', () => {
  const prompt = `${ANALYZE_TENDER_SYSTEM}\n${buildAnalyzeUserMessage('test')}`;
  assert.match(prompt, /predpokladana_hodnota vždy vyplň jedním číslem za CELOU zakázku bez DPH/);
  assert.match(prompt, /hodnoty částí nesčítej/);
  assert.match(prompt, /Všechna pole v terminy vyplň jako skalární hodnotu za CELOU zakázku/);
  assert.match(prompt, /Termíny jednotlivých částí zachovej v\s+casti\[\]\.terminy/);
  assert.match(prompt, /"casti": \[/);
});
