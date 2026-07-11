import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseNenAttachments,
  zadavaciDokumentaceUrl,
  fetchNenAttachments,
  type NenAttachment,
} from '../src/lib/monitoring/nen-client.js';
import {
  sanitizeAttachmentName,
  downloadNenAttachments,
} from '../src/lib/monitoring/zd-download.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZD_FIXTURE = readFileSync(join(__dirname, 'fixtures', 'nen-zadavaci-dokumentace.html'), 'utf-8');

// --- Parser příloh (fixture z reálné NEN podstránky /zadavaci-dokumentace) ---

test('parseNenAttachments vytáhne přílohy z reálné NEN ZD fixture', () => {
  const rows = parseNenAttachments(ZD_FIXTURE);
  assert.equal(rows.length, 4);
  const names = rows.map((r) => r.nazev);
  assert.ok(names.includes('34_RÚ_Příloha č. 1_Krycí list nabídky.docx'));
  assert.ok(names.includes('34_RÚ_Výzva.pdf'));
  // Odkazy jsou absolutní na NEN doménu (relativní /file?id= se zabsolutní).
  assert.ok(rows.every((r) => r.url.startsWith('https://nen.nipez.cz/file?id=')));
});

test('parseNenAttachments deduplikuje stejnou URL', () => {
  const dup = ZD_FIXTURE + ZD_FIXTURE;
  const rows = parseNenAttachments(dup);
  assert.equal(rows.length, 4, 'zdvojená fixture nesmí zdvojit přílohy');
});

test('parseNenAttachments vrací [] pro HTML bez příloh', () => {
  assert.deepEqual(parseNenAttachments('<html><body>nic</body></html>'), []);
});

test('zadavaciDokumentaceUrl doplní podstránku a je idempotentní', () => {
  const base = 'https://nen.nipez.cz/verejne-zakazky/detail-zakazky/N006-26-V00021897';
  assert.equal(zadavaciDokumentaceUrl(base), `${base}/zadavaci-dokumentace`);
  assert.equal(zadavaciDokumentaceUrl(`${base}/`), `${base}/zadavaci-dokumentace`);
  assert.equal(
    zadavaciDokumentaceUrl(`${base}/zadavaci-dokumentace`),
    `${base}/zadavaci-dokumentace`,
  );
});

test('fetchNenAttachments je graceful — chyba fetchu vrací []', async () => {
  const failing: typeof fetch = async () => {
    throw new Error('network down');
  };
  const result = await fetchNenAttachments('https://nen.nipez.cz/x/detail-zakazky/N', { fetchFn: failing });
  assert.deepEqual(result, []);
});

test('fetchNenAttachments vrací [] při HTTP != 2xx', async () => {
  const notFound: typeof fetch = async () => new Response('nope', { status: 404 });
  const result = await fetchNenAttachments('https://nen.nipez.cz/x/detail-zakazky/N', { fetchFn: notFound });
  assert.deepEqual(result, []);
});

// --- Sanitizace názvů ---

test('sanitizeAttachmentName povolí bezpečné názvy včetně diakritiky', () => {
  assert.equal(
    sanitizeAttachmentName('34_RÚ_Příloha č. 1_Krycí list nabídky.docx'),
    '34_RÚ_Příloha č. 1_Krycí list nabídky.docx',
  );
});

test('sanitizeAttachmentName zablokuje path traversal', () => {
  assert.equal(sanitizeAttachmentName('../../etc/passwd'), null);
  assert.equal(sanitizeAttachmentName('..\\..\\win.ini'), null);
  // Adresářová komponenta se ořízne na holý basename.
  assert.equal(sanitizeAttachmentName('/abs/path/soubor.pdf'), 'soubor.pdf');
  assert.equal(sanitizeAttachmentName('a/b/c.xlsx'), 'c.xlsx');
});

test('sanitizeAttachmentName odmítne nepovolené přípony a prázdné', () => {
  assert.equal(sanitizeAttachmentName('malware.exe'), null);
  assert.equal(sanitizeAttachmentName('klíč.crt'), null);
  assert.equal(sanitizeAttachmentName(''), null);
  assert.equal(sanitizeAttachmentName('bez_pripony'), null);
});

// --- Download s limity (mock fetch, dočasná složka) ---

function fetchWithBodies(bodies: Record<string, Buffer | { status: number }>): typeof fetch {
  return (async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const entry = bodies[url];
    if (!entry) return new Response('missing', { status: 404 });
    if (entry instanceof Buffer) {
      return new Response(entry, { status: 200 });
    }
    return new Response('err', { status: entry.status });
  }) as unknown as typeof fetch;
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'zd-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('downloadNenAttachments stáhne povolené soubory a přeskočí nepovolené', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'vyzva.pdf', url: 'https://x/file?id=1' },
      { nazev: 'kryci-list.docx', url: 'https://x/file?id=2' },
      { nazev: 'malware.exe', url: 'https://x/file?id=3' },
    ];
    const fetchFn = fetchWithBodies({
      'https://x/file?id=1': Buffer.from('PDF-DATA'),
      'https://x/file?id=2': Buffer.from('DOCX-DATA'),
      'https://x/file?id=3': Buffer.from('EVIL'),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn });
    assert.equal(result.pocet_stazenych, 2);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['kryci-list.docx', 'vyzva.pdf']);
    assert.equal(await readFile(join(dir, 'vyzva.pdf'), 'utf-8'), 'PDF-DATA');
    assert.ok(result.varovani.some((w) => w.includes('malware.exe')));
  });
});

test('downloadNenAttachments respektuje limit počtu souborů', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = Array.from({ length: 5 }, (_, i) => ({
      nazev: `soubor-${i}.pdf`,
      url: `https://x/file?id=${i}`,
    }));
    const bodies: Record<string, Buffer> = {};
    for (let i = 0; i < 5; i += 1) bodies[`https://x/file?id=${i}`] = Buffer.from(`D${i}`);
    const result = await downloadNenAttachments(attachments, dir, { fetchFn: fetchWithBodies(bodies), maxFiles: 2 });
    assert.equal(result.pocet_stazenych, 2);
    assert.equal((await readdir(dir)).length, 2);
    assert.ok(result.varovani.some((w) => w.includes('limit 2 souborů')));
  });
});

test('downloadNenAttachments přeskočí soubor nad limitem velikosti', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'maly.pdf', url: 'https://x/file?id=1' },
      { nazev: 'velky.pdf', url: 'https://x/file?id=2' },
    ];
    const fetchFn = fetchWithBodies({
      'https://x/file?id=1': Buffer.from('ok'),
      'https://x/file?id=2': Buffer.alloc(10_000, 1),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn, maxFileBytes: 100 });
    assert.equal(result.pocet_stazenych, 1);
    assert.deepEqual(await readdir(dir), ['maly.pdf']);
    assert.ok(result.varovani.some((w) => w.includes('velky.pdf')));
  });
});

test('downloadNenAttachments respektuje souhrnný limit velikosti', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'a.pdf', url: 'https://x/file?id=1' },
      { nazev: 'b.pdf', url: 'https://x/file?id=2' },
    ];
    const fetchFn = fetchWithBodies({
      'https://x/file?id=1': Buffer.alloc(80, 1),
      'https://x/file?id=2': Buffer.alloc(80, 1),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn, maxTotalBytes: 100 });
    assert.equal(result.pocet_stazenych, 1);
    assert.ok(result.varovani.some((w) => w.toLowerCase().includes('souhrnný limit')));
  });
});

test('downloadNenAttachments odolá selhání jednotlivého souboru a pokračuje', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'ok.pdf', url: 'https://x/file?id=1' },
      { nazev: 'chyba.pdf', url: 'https://x/file?id=2' },
      { nazev: 'ok2.pdf', url: 'https://x/file?id=3' },
    ];
    const fetchFn = fetchWithBodies({
      'https://x/file?id=1': Buffer.from('A'),
      'https://x/file?id=2': { status: 500 },
      'https://x/file?id=3': Buffer.from('B'),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn });
    assert.equal(result.pocet_stazenych, 2);
    assert.ok(result.varovani.some((w) => w.includes('chyba.pdf')));
  });
});

test('downloadNenAttachments deduplikuje kolidující názvy', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'priloha.pdf', url: 'https://x/file?id=1' },
      { nazev: 'priloha.pdf', url: 'https://x/file?id=2' },
    ];
    const fetchFn = fetchWithBodies({
      'https://x/file?id=1': Buffer.from('first'),
      'https://x/file?id=2': Buffer.from('second'),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn });
    assert.equal(result.pocet_stazenych, 2);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['priloha-2.pdf', 'priloha.pdf']);
  });
});
