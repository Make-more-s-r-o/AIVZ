import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  enrichPolozkySpecifikace,
  parsePolozkaDescriptions,
} from '../src/lib/polozka-desc-enricher.js';

const REDUCTION_BLOCK = `
42. | Rázová redukce 3/4 x ½:
viz popis níže | Rázová redukce 3/4 x ½ | kus | 5
Položka č. 42 Rázová redukce 3/4 x ½:
•  Redukce pro rázové použití
•  Kovaná
•  Redukce z 3/4" na 1/2"`;

test('parse: načte odrážky bez úvodního řádku a ignoruje řádek soupisu', () => {
  const descriptions = parsePolozkaDescriptions(REDUCTION_BLOCK);

  assert.equal(descriptions.size, 1);
  assert.equal(
    descriptions.get(42),
    '• Redukce pro rázové použití\n• Kovaná\n• Redukce z 3/4" na 1/2"',
  );
  assert.equal(descriptions.get(42)?.includes('Rázová redukce'), false);
});

test('parse: z opakovaných bloků oddělených rourou vyhraje nejdelší varianta', () => {
  const text = [
    'Položka č. 42 Rázová redukce 3/4 x ½:\n• Kovaná',
    'Položka č. 42 Rázová redukce 3/4 x ½:\n• Redukce pro rázové použití\n• Kovaná\n• Redukce z 3/4" na 1/2"',
    'Položka č. 42 Rázová redukce 3/4 x ½:\n• Kovaná',
  ].join(' | ');

  const descriptions = parsePolozkaDescriptions(text);

  assert.equal(descriptions.size, 1);
  assert.equal(descriptions.get(42)?.includes('Redukce z 3/4" na 1/2"'), true);
});

test('parse: rozliší dva různé bloky', () => {
  const descriptions = parsePolozkaDescriptions(`${REDUCTION_BLOCK}
Položka č. 43 Nástavec 1'':
• Nástavec pro rázové použití
• Kovaný ořech`);

  assert.equal(descriptions.size, 2);
  assert.equal(descriptions.get(42)?.includes('Kovaná'), true);
  assert.equal(descriptions.get(43), '• Nástavec pro rázové použití\n• Kovaný ořech');
});

test('parse: omezí dlouhý popis na 1500 znaků včetně výpustky', () => {
  const description = parsePolozkaDescriptions(
    `Položka č. 1 Zkušební položka:\n• ${'a'.repeat(2_000)}`,
  ).get(1);

  assert.equal(description?.length, 1500);
  assert.equal(description?.endsWith('…'), true);
});

test('enrich: odstraní viz popis níže a připojí popis při shodě názvu', () => {
  const polozky = [{
    nazev: 'Rázová redukce 3/4 x ½:\nviz popis níže',
    specifikace: 'Rázová redukce: viz popis níže',
  }];

  const count = enrichPolozkySpecifikace(polozky, [REDUCTION_BLOCK.replace('č. 42', 'č. 1')]);

  assert.equal(count, 1);
  assert.equal(/viz popis níže/i.test(polozky[0].specifikace), false);
  assert.equal(polozky[0].specifikace.includes('Redukce pro rázové použití'), true);
});

test('enrich: při shodě čísla, ale jiném názvu guard obohacení zakáže', () => {
  const polozky = [{ nazev: 'Kompletní sada nářadí', specifikace: '' }];

  const count = enrichPolozkySpecifikace(polozky, [REDUCTION_BLOCK.replace('č. 42', 'č. 1')]);

  assert.equal(count, 0);
  assert.equal(polozky[0].specifikace, '');
});

test('enrich: bohatou specifikaci bez odkazu nepřepisuje', () => {
  const original = 'Původní úplná specifikace má více než třicet znaků a musí zůstat.';
  const polozky = [{ nazev: 'Rázová redukce 3/4 x ½', specifikace: original }];

  const count = enrichPolozkySpecifikace(polozky, [REDUCTION_BLOCK.replace('č. 42', 'č. 1')]);

  assert.equal(count, 0);
  assert.equal(polozky[0].specifikace, original);
});

test('enrich: doplní prázdnou specifikaci při shodě názvu', () => {
  const polozky = [{ nazev: 'Rázová redukce 3/4 x ½', specifikace: '' }];

  const count = enrichPolozkySpecifikace(polozky, [REDUCTION_BLOCK.replace('č. 42', 'č. 1')]);

  assert.equal(count, 1);
  assert.equal(polozky[0].specifikace.startsWith('• Redukce pro rázové použití'), true);
});
