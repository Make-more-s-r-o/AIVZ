import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candidatePrefill, listOutcomeCandidates } from '../src/lib/outcome-kandidati-store.js';
import { isWatcherEligible, parseNenOutcome, scoreOutcomeMatch } from '../src/lib/outcome-watcher.js';

test('parser NEN výsledku čte reálnou fixture', async () => {
  const html = await readFile(new URL('./fixtures/nen-outcome.html', import.meta.url), 'utf8');
  assert.deepEqual(parseNenOutcome(html), {
    vitez_nazev: 'SUNNY POWER s.r.o.', vitezna_cena_bez_dph: 485976,
    pocet_uchazecu: 3, ucastnici: ['SUNNY POWER s.r.o.', 'SOLAR SYSTEM CZ s.r.o.', 'Energo Morava a.s.'],
  });
});

test('skóre shody rozlišuje přesnou, částečnou a žádnou shodu', () => {
  const exact = scoreOutcomeMatch({ nazev: 'Dodávka tiskáren', zadavatel: 'Město Brno' }, { nazev: 'Dodávka tiskáren', zadavatel: 'Město Brno' });
  const partial = scoreOutcomeMatch({ nazev: 'Dodávka tiskáren a tonerů', zadavatel: null }, { nazev: 'Dodávka tiskáren', zadavatel: null });
  const none = scoreOutcomeMatch({ nazev: 'Dodávka tiskáren', zadavatel: null }, { nazev: 'Oprava střechy', zadavatel: null });
  assert.equal(exact, 1); assert.ok(partial > 0 && partial < exact); assert.equal(none, 0);
});

test('watcher nepřepisuje už lidsky potvrzený výsledek', () => {
  assert.equal(isWatcherEligible('odeslana', false), true);
  assert.equal(isWatcherEligible('odeslana', true), false);
  assert.equal(isWatcherEligible('nova', false), false);
});

test('store graceful degraduje bez DB', async () => {
  const previous = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  assert.deepEqual(await listOutcomeCandidates('bez-db'), []);
  if (previous) process.env.DATABASE_URL = previous;
});

test('potvrzení kandidáta pouze předvyplní formulář a nemění stav', () => {
  const candidate: any = { id: '7', stav: 'navrh', vitez_nazev: 'Vítěz s.r.o.', vitezna_cena_bez_dph: 100, pocet_uchazecu: 2 };
  assert.deepEqual(candidatePrefill(candidate), { vysledek: 'prohra', vitezna_cena_bez_dph: 100, pocet_uchazecu: 2, vitez_nazev: 'Vítěz s.r.o.', kandidat_id: '7' });
  assert.equal(candidate.stav, 'navrh');
});
