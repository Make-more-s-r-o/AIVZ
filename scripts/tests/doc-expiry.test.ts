/**
 * Jednotkové testy sledování platnosti firemních kvalifikačních dokladů.
 * Čistá logika (bez FS/sítě): docExpiryStatus, daysUntilExpiry, isValidIsoDateString,
 * buildChecklistItem + zpětná kompatibilita manifestu bez pole platnost_do.
 *
 * Spuštění z adresáře scripts/:
 *   npx tsx tests/doc-expiry.test.ts
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  docExpiryStatus,
  daysUntilExpiry,
  isValidIsoDateString,
  buildChecklistItem,
  type DocManifest,
} from '../src/lib/doc-slots.js';

// Pevné „nyní" pro deterministické testy: 2026-07-11 (poledne, aby na časovém pásmu nezáleželo).
const NOW = new Date('2026-07-11T12:00:00.000Z');

/** Vrátí ISO datum (YYYY-MM-DD) posunuté o `days` od NOW. */
function isoOffset(days: number): string {
  const d = new Date(Date.UTC(2026, 6, 11) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// --- docExpiryStatus: hranice ---

test('docExpiryStatus: dnešní datum → expiruje (poslední den platnosti)', () => {
  assert.equal(docExpiryStatus('2026-07-11', NOW), 'expiruje');
});

test('docExpiryStatus: +30 dní → expiruje (hranice varování)', () => {
  assert.equal(docExpiryStatus(isoOffset(30), NOW), 'expiruje');
});

test('docExpiryStatus: +31 dní → ok (za hranicí varování)', () => {
  assert.equal(docExpiryStatus(isoOffset(31), NOW), 'ok');
});

test('docExpiryStatus: minulost → expirovany', () => {
  assert.equal(docExpiryStatus(isoOffset(-1), NOW), 'expirovany');
  assert.equal(docExpiryStatus('2020-01-01', NOW), 'expirovany');
});

test('docExpiryStatus: null / undefined / prázdno → nezadano', () => {
  assert.equal(docExpiryStatus(null, NOW), 'nezadano');
  assert.equal(docExpiryStatus(undefined, NOW), 'nezadano');
  assert.equal(docExpiryStatus('', NOW), 'nezadano');
});

test('docExpiryStatus: nevalidní / neexistující datum → nezadano', () => {
  assert.equal(docExpiryStatus('not-a-date', NOW), 'nezadano');
  assert.equal(docExpiryStatus('2026-02-30', NOW), 'nezadano'); // 30. únor neexistuje
  assert.equal(docExpiryStatus('2026-13-01', NOW), 'nezadano'); // měsíc 13
});

// --- daysUntilExpiry ---

test('daysUntilExpiry: počítá kalendářní dny nezávisle na čase', () => {
  assert.equal(daysUntilExpiry('2026-07-11', NOW), 0);
  assert.equal(daysUntilExpiry('2026-07-12', NOW), 1);
  assert.equal(daysUntilExpiry(isoOffset(30), NOW), 30);
  assert.equal(daysUntilExpiry(isoOffset(-5), NOW), -5);
  assert.equal(daysUntilExpiry(null, NOW), null);
  assert.equal(daysUntilExpiry('nonsense', NOW), null);
});

// --- isValidIsoDateString ---

test('isValidIsoDateString: přijímá jen platné YYYY-MM-DD', () => {
  assert.equal(isValidIsoDateString('2026-07-11'), true);
  assert.equal(isValidIsoDateString('2026-2-1'), false);   // bez vedoucích nul
  assert.equal(isValidIsoDateString('2026-02-30'), false); // neexistuje
  assert.equal(isValidIsoDateString('2026-07-11T00:00'), false);
  assert.equal(isValidIsoDateString('11.07.2026'), false);
});

// --- buildChecklistItem: expirace v checklistu ---

test('buildChecklistItem: firemní doklad po platnosti → status chybi + poznámka', () => {
  const item = buildChecklistItem({
    slot: 'vypis_or',
    label: 'Výpis z obchodního rejstříku',
    companyEntry: { filename: 'vypis.pdf', platnost_do: isoOffset(-10) },
    now: NOW,
  });
  assert.equal(item.status, 'chybi');
  assert.equal(item.platnost_status, 'expirovany');
  assert.equal(item.poznamka, 'nahraný doklad je po platnosti');
  assert.equal(item.filename, 'vypis.pdf');
});

test('buildChecklistItem: doklad brzy expiruje → nahráno + varovná poznámka s počtem dní', () => {
  const item = buildChecklistItem({
    slot: 'vypis_or',
    label: 'Výpis z obchodního rejstříku',
    companyEntry: { filename: 'vypis.pdf', platnost_do: isoOffset(10) },
    now: NOW,
  });
  assert.equal(item.status, 'nahrano');
  assert.equal(item.platnost_status, 'expiruje');
  assert.equal(item.zdroj, 'firma');
  assert.match(item.poznamka ?? '', /10 dní/);
});

test('buildChecklistItem: platný doklad → nahráno bez poznámky', () => {
  const item = buildChecklistItem({
    slot: 'vypis_or',
    label: 'Výpis z obchodního rejstříku',
    companyEntry: { filename: 'vypis.pdf', platnost_do: isoOffset(90) },
    now: NOW,
  });
  assert.equal(item.status, 'nahrano');
  assert.equal(item.platnost_status, 'ok');
  assert.equal(item.poznamka, undefined);
});

test('buildChecklistItem: žádný doklad → chybi', () => {
  const item = buildChecklistItem({
    slot: 'vypis_or',
    label: 'Výpis z obchodního rejstříku',
    companyEntry: null,
    attachmentFilename: null,
    now: NOW,
  });
  assert.equal(item.status, 'chybi');
  assert.equal(item.filename, undefined);
});

test('buildChecklistItem: příloha zakázky má přednost (zdroj=zakazka)', () => {
  const item = buildChecklistItem({
    slot: 'vypis_or',
    label: 'Výpis z obchodního rejstříku',
    companyEntry: { filename: 'firma.pdf', platnost_do: isoOffset(90) },
    attachmentFilename: 'zakazka.pdf',
    now: NOW,
  });
  assert.equal(item.status, 'nahrano');
  assert.equal(item.zdroj, 'zakazka');
  assert.equal(item.filename, 'zakazka.pdf');
});

// --- Zpětná kompatibilita manifestu (staré entries bez platnost_do) ---

test('zpětná kompatibilita: legacy manifest bez platnost_do → nezadano, checklist = nahráno', () => {
  // Manifest ve tvaru, jaký zapsala starší verze (žádné pole platnost_do).
  const legacy: DocManifest = {
    version: 1,
    entries: [
      { slot: 'vypis_or', filename: 'vypis.pdf', uploadedAt: '2026-01-01T00:00:00.000Z' },
      { slot: 'ostatni', filename: 'jine.pdf', uploadedAt: '2026-01-01T00:00:00.000Z' },
    ],
  };
  for (const e of legacy.entries) {
    assert.equal(docExpiryStatus(e.platnost_do, NOW), 'nezadano');
  }
  const item = buildChecklistItem({
    slot: 'vypis_or',
    label: 'Výpis z obchodního rejstříku',
    companyEntry: legacy.entries[0],
    now: NOW,
  });
  // Bez zadané platnosti se doklad NEhlásí jako po platnosti — zůstává nahráno.
  assert.equal(item.status, 'nahrano');
  assert.equal(item.platnost_status, undefined);
  assert.equal(item.poznamka, undefined);
});
