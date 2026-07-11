import { strict as assert } from 'node:assert';
import test from 'node:test';
import PizZip from 'pizzip';

import { peekZipFileCount } from '../src/lib/input-discovery.js';

function buildZip(entries: Record<string, string>): Buffer {
  const zip = new PizZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.file(name, content);
  }
  return zip.generate({ type: 'nodebuffer' });
}

test('peekZipFileCount: spočítá reálné soubory, ignoruje šum', () => {
  const buf = buildZip({
    'kryci_list.docx': 'a',
    'cenova_nabidka.xlsx': 'b',
    '__MACOSX/kryci_list.docx': 'c',
    '.DS_Store': 'd',
    '~$soupis.xlsx': 'e',
  });
  assert.equal(peekZipFileCount(buf), 2);
});

test('peekZipFileCount: prázdný ZIP → 0', () => {
  const buf = buildZip({});
  assert.equal(peekZipFileCount(buf), 0);
});

test('peekZipFileCount: poškozený/nevalidní buffer → null (žádná výjimka)', () => {
  const buf = Buffer.from('not a zip file at all');
  assert.equal(peekZipFileCount(buf), null);
});

test('peekZipFileCount: soubory ve vnořené složce se počítají', () => {
  const buf = buildZip({
    'ZD komplet/kryci_list.docx': 'a',
    'ZD komplet/priloha/smlouva.doc': 'b',
  });
  assert.equal(peekZipFileCount(buf), 2);
});
