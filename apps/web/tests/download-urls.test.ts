/**
 * Jednotkový test pro skládání download URL v apps/web/src/lib/api.ts.
 *
 * Kontroluje, že se do URL už NEPŘIDÁVÁ `?token=` (bezpečnostní dluh — JWT unikal do nginx
 * access logů, viz downloadWithAuth, které místo toho posílá Authorization hlavičku).
 * Modul se importuje přímo v Node (bez DOM) — testované funkce jsou čisté string buildery,
 * které se nedotknou `window`/`document`/`localStorage` (ty žijí jen uvnitř downloadWithAuth
 * a authHeaders, které se zde nevolají).
 *
 * Spuštění z adresáře apps/web/:
 *   npx tsx --test tests/*.test.ts
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  getDocumentDownloadUrl,
  getAttachmentDownloadUrl,
  getDocumentsZipUrl,
  getBundleZipUrl,
} from '../src/lib/api.ts';

test('getDocumentDownloadUrl neobsahuje token v query stringu', () => {
  const url = getDocumentDownloadUrl('tender-1', 'kryci_list.docx');
  assert.equal(url, '/api/tenders/tender-1/documents/kryci_list.docx');
  assert.ok(!url.includes('token='), 'URL nesmí nést token v query stringu');
});

test('getDocumentDownloadUrl escapuje název souboru', () => {
  const url = getDocumentDownloadUrl('tender-1', 'a b/c.docx');
  assert.equal(url, '/api/tenders/tender-1/documents/a%20b%2Fc.docx');
});

test('getAttachmentDownloadUrl neobsahuje token v query stringu', () => {
  const url = getAttachmentDownloadUrl('tender-2', 'vypis-or.pdf');
  assert.equal(url, '/api/tenders/tender-2/attachments/vypis-or.pdf');
  assert.ok(!url.includes('token='));
});

test('getDocumentsZipUrl a getBundleZipUrl neobsahují token v query stringu', () => {
  const docsUrl = getDocumentsZipUrl('tender-3');
  const bundleUrl = getBundleZipUrl('tender-3');
  assert.equal(docsUrl, '/api/tenders/tender-3/download/documents');
  assert.equal(bundleUrl, '/api/tenders/tender-3/download/bundle');
  assert.ok(!docsUrl.includes('?'));
  assert.ok(!bundleUrl.includes('?'));
});
