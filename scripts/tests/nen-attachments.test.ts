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
  isAllowedNenUrl,
  type NenAttachment,
} from '../src/lib/monitoring/nen-client.js';
import {
  sanitizeAttachmentName,
  downloadNenAttachments,
  incompleteDownloadWarning,
  shouldAutoStartDownloadedPipeline,
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

test('NEN URL allowlist povolí jen přesný HTTPS hostname a defaultní port', () => {
  assert.equal(isAllowedNenUrl('https://nen.nipez.cz/file?id=1'), true);
  assert.equal(isAllowedNenUrl('https://nen.nipez.cz:443/file?id=1'), true);
  assert.equal(isAllowedNenUrl('http://nen.nipez.cz/file?id=1'), false);
  assert.equal(isAllowedNenUrl('https://nen.nipez.cz:444/file?id=1'), false);
  assert.equal(isAllowedNenUrl('https://nen.nipez.cz.evil.test/file?id=1'), false);
  assert.equal(isAllowedNenUrl('https://evil.test/?next=nen.nipez.cz'), false);
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

function fetchWithResponses(
  responses: Record<string, { body: string; headers?: HeadersInit; status?: number }>,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const entry = responses[String(input)];
    if (!entry) return new Response('missing', { status: 404 });
    return new Response(entry.body, { status: entry.status ?? 200, headers: entry.headers });
  }) as typeof fetch;
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
      { nazev: 'vyzva.pdf', url: 'https://nen.nipez.cz/file?id=1' },
      { nazev: 'kryci-list.docx', url: 'https://nen.nipez.cz/file?id=2' },
      { nazev: 'malware.exe', url: 'https://nen.nipez.cz/file?id=3' },
    ];
    const fetchFn = fetchWithBodies({
      'https://nen.nipez.cz/file?id=1': Buffer.from('PDF-DATA'),
      'https://nen.nipez.cz/file?id=2': Buffer.from('DOCX-DATA'),
      'https://nen.nipez.cz/file?id=3': Buffer.from('EVIL'),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn });
    assert.equal(result.pocet_stazenych, 2);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['kryci-list.docx', 'vyzva.pdf']);
    assert.equal(await readFile(join(dir, 'vyzva.pdf'), 'utf-8'), 'PDF-DATA');
    assert.ok(result.varovani.some((w) => w.includes('malware.exe')));
  });
});

test('downloadNenAttachments použije RFC 5987 název z Content-Disposition', async () => {
  await withTmpDir(async (dir) => {
    const url = 'https://nen.nipez.cz/file?id=disposition';
    const fetchFn = fetchWithResponses({
      [url]: {
        body: 'DOCX-DATA',
        headers: {
          'content-disposition': "attachment; filename*=UTF-8''P%C5%99%C3%ADloha%20%C4%8D.%201%20Smluvn%C3%AD%20vzor.docx",
          'content-type': 'application/octet-stream',
        },
      },
    });
    const result = await downloadNenAttachments(
      [{ nazev: 'Příloha č. 1 Smluvní vzor', url }],
      dir,
      { fetchFn },
    );
    assert.equal(result.pocet_stazenych, 1);
    assert.deepEqual(await readdir(dir), ['Příloha č. 1 Smluvní vzor.docx']);
    assert.deepEqual(result.varovani, []);
  });
});

test('downloadNenAttachments odvodí .pdf z Content-Type, když název nemá příponu', async () => {
  await withTmpDir(async (dir) => {
    const url = 'https://nen.nipez.cz/file?id=pdf';
    const result = await downloadNenAttachments(
      [{ nazev: 'Výzva k podání nabídky', url }],
      dir,
      { fetchFn: fetchWithResponses({ [url]: { body: 'PDF-DATA', headers: { 'content-type': 'application/pdf; charset=binary' } } }) },
    );
    assert.equal(result.pocet_stazenych, 1);
    assert.deepEqual(await readdir(dir), ['Výzva k podání nabídky.pdf']);
  });
});

test('downloadNenAttachments přeskočí nepodporovaný Content-Type s konkrétním důvodem', async () => {
  await withTmpDir(async (dir) => {
    const url = 'https://nen.nipez.cz/file?id=image';
    const result = await downloadNenAttachments(
      [{ nazev: 'Náhled přílohy', url }],
      dir,
      { fetchFn: fetchWithResponses({ [url]: { body: 'PNG-DATA', headers: { 'content-type': 'image/png' } } }) },
    );
    assert.equal(result.pocet_stazenych, 0);
    assert.deepEqual(await readdir(dir), []);
    assert.ok(result.varovani.some((warning) => warning.includes('nepodporovaný typ image/png')));
  });
});

test('downloadNenAttachments řeší kolize názvů získaných z hlaviček', async () => {
  await withTmpDir(async (dir) => {
    const firstUrl = 'https://nen.nipez.cz/file?id=collision-1';
    const secondUrl = 'https://nen.nipez.cz/file?id=collision-2';
    const headers = { 'content-disposition': 'attachment; filename="smluvni-vzor.docx"' };
    const result = await downloadNenAttachments(
      [
        { nazev: 'Smluvní vzor A', url: firstUrl },
        { nazev: 'Smluvní vzor B', url: secondUrl },
      ],
      dir,
      { fetchFn: fetchWithResponses({
        [firstUrl]: { body: 'FIRST', headers },
        [secondUrl]: { body: 'SECOND', headers },
      }) },
    );
    assert.equal(result.pocet_stazenych, 2);
    assert.deepEqual((await readdir(dir)).sort(), ['smluvni-vzor-2.docx', 'smluvni-vzor.docx']);
  });
});

test('downloadNenAttachments sanitizuje traversal pokus v Content-Disposition', async () => {
  await withTmpDir(async (dir) => {
    const url = 'https://nen.nipez.cz/file?id=traversal';
    const result = await downloadNenAttachments(
      [{ nazev: 'Dokument bez přípony', url }],
      dir,
      { fetchFn: fetchWithResponses({
        [url]: { body: 'SAFE', headers: { 'content-disposition': 'attachment; filename="../../etc/passwd.docx"' } },
      }) },
    );
    assert.equal(result.pocet_stazenych, 1);
    assert.deepEqual(await readdir(dir), ['passwd.docx']);
    assert.equal(await readFile(join(dir, 'passwd.docx'), 'utf-8'), 'SAFE');
  });
});

test('downloadNenAttachments respektuje limit počtu souborů', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = Array.from({ length: 5 }, (_, i) => ({
      nazev: `soubor-${i}.pdf`,
      url: `https://nen.nipez.cz/file?id=${i}`,
    }));
    const bodies: Record<string, Buffer> = {};
    for (let i = 0; i < 5; i += 1) bodies[`https://nen.nipez.cz/file?id=${i}`] = Buffer.from(`D${i}`);
    const result = await downloadNenAttachments(attachments, dir, { fetchFn: fetchWithBodies(bodies), maxFiles: 2 });
    assert.equal(result.pocet_stazenych, 2);
    assert.equal((await readdir(dir)).length, 2);
    assert.ok(result.varovani.some((w) => w.includes('limit 2 souborů')));
  });
});

test('downloadNenAttachments přeskočí soubor nad limitem velikosti', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'maly.pdf', url: 'https://nen.nipez.cz/file?id=1' },
      { nazev: 'velky.pdf', url: 'https://nen.nipez.cz/file?id=2' },
    ];
    const fetchFn = fetchWithBodies({
      'https://nen.nipez.cz/file?id=1': Buffer.from('ok'),
      'https://nen.nipez.cz/file?id=2': Buffer.alloc(10_000, 1),
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
      { nazev: 'a.pdf', url: 'https://nen.nipez.cz/file?id=1' },
      { nazev: 'b.pdf', url: 'https://nen.nipez.cz/file?id=2' },
    ];
    const fetchFn = fetchWithBodies({
      'https://nen.nipez.cz/file?id=1': Buffer.alloc(80, 1),
      'https://nen.nipez.cz/file?id=2': Buffer.alloc(80, 1),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn, maxTotalBytes: 100 });
    assert.equal(result.pocet_stazenych, 1);
    assert.ok(result.varovani.some((w) => w.toLowerCase().includes('souhrnný limit')));
  });
});

test('downloadNenAttachments odolá selhání jednotlivého souboru a pokračuje', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'ok.pdf', url: 'https://nen.nipez.cz/file?id=1' },
      { nazev: 'chyba.pdf', url: 'https://nen.nipez.cz/file?id=2' },
      { nazev: 'ok2.pdf', url: 'https://nen.nipez.cz/file?id=3' },
    ];
    const fetchFn = fetchWithBodies({
      'https://nen.nipez.cz/file?id=1': Buffer.from('A'),
      'https://nen.nipez.cz/file?id=2': { status: 500 },
      'https://nen.nipez.cz/file?id=3': Buffer.from('B'),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn });
    assert.equal(result.pocet_stazenych, 2);
    assert.ok(result.varovani.some((w) => w.includes('chyba.pdf')));
  });
});

test('downloadNenAttachments deduplikuje kolidující názvy', async () => {
  await withTmpDir(async (dir) => {
    const attachments: NenAttachment[] = [
      { nazev: 'priloha.pdf', url: 'https://nen.nipez.cz/file?id=1' },
      { nazev: 'priloha.pdf', url: 'https://nen.nipez.cz/file?id=2' },
    ];
    const fetchFn = fetchWithBodies({
      'https://nen.nipez.cz/file?id=1': Buffer.from('first'),
      'https://nen.nipez.cz/file?id=2': Buffer.from('second'),
    });
    const result = await downloadNenAttachments(attachments, dir, { fetchFn });
    assert.equal(result.pocet_stazenych, 2);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['priloha-2.pdf', 'priloha.pdf']);
  });
});

test('downloadNenAttachments odmítne cizí URL bez síťového požadavku', async () => {
  await withTmpDir(async (dir) => {
    let calls = 0;
    const result = await downloadNenAttachments(
      [{ nazev: 'tajne.pdf', url: 'https://127.0.0.1/admin' }],
      dir,
      { fetchFn: (async () => { calls += 1; return new Response('x'); }) as typeof fetch },
    );
    assert.equal(calls, 0);
    assert.equal(result.pocet_stazenych, 0);
    assert.ok(result.varovani.some((warning) => warning.includes('nepovolená URL')));
  });
});

test('downloadNenAttachments ověřuje každý redirect a používá redirect manual', async () => {
  await withTmpDir(async (dir) => {
    const redirects: RequestRedirect[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      redirects.push(init?.redirect ?? 'follow');
      const url = String(input);
      if (url.endsWith('/start')) {
        return new Response(null, { status: 302, headers: { location: '/second' } });
      }
      if (url.endsWith('/second')) {
        return new Response(null, { status: 302, headers: { location: 'https://evil.test/secret' } });
      }
      throw new Error(`neočekávaná URL ${url}`);
    }) as typeof fetch;
    const result = await downloadNenAttachments(
      [{ nazev: 'redirect.pdf', url: 'https://nen.nipez.cz/start' }],
      dir,
      { fetchFn },
    );
    assert.deepEqual(redirects, ['manual', 'manual']);
    assert.equal(result.pocet_stazenych, 0);
    assert.ok(result.varovani.some((warning) => warning.includes('nepovolená NEN URL')));
  });
});

test('downloadNenAttachments povolí nejvýše tři ověřené redirecty', async () => {
  await withTmpDir(async (dir) => {
    const called: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      called.push(url);
      const hop = Number(new URL(url).pathname.slice(1));
      if (hop < 4) {
        return new Response(null, { status: 302, headers: { location: `/${hop + 1}` } });
      }
      return new Response('obsah');
    }) as typeof fetch;
    const result = await downloadNenAttachments(
      [{ nazev: 'redirect.pdf', url: 'https://nen.nipez.cz/0' }],
      dir,
      { fetchFn },
    );
    assert.equal(called.length, 4, 'počáteční požadavek + tři povolené hopy');
    assert.equal(result.pocet_stazenych, 0);
    assert.ok(result.varovani.some((warning) => warning.includes('limit 3 přesměrování')));
  });
});

test('downloadNenAttachments kontroluje Content-Length ještě před čtením těla', async () => {
  await withTmpDir(async (dir) => {
    let readerCalls = 0;
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '1000' }),
      get body() {
        return {
          getReader: () => { readerCalls += 1; throw new Error('tělo se nemá číst'); },
          cancel: async () => {},
        };
      },
    } as unknown as Response;
    const fetchFn = (async () => response) as typeof fetch;
    const result = await downloadNenAttachments(
      [{ nazev: 'velky.pdf', url: 'https://nen.nipez.cz/file?id=large' }],
      dir,
      { fetchFn, maxFileBytes: 100 },
    );
    assert.equal(readerCalls, 0);
    assert.equal(result.pocet_stazenych, 0);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('downloadNenAttachments při překročení streamového limitu abortuje a smaže část souboru', async () => {
  await withTmpDir(async (dir) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
        controller.close();
      },
    });
    const result = await downloadNenAttachments(
      [{ nazev: 'chunked.pdf', url: 'https://nen.nipez.cz/file?id=chunked' }],
      dir,
      { fetchFn: (async () => new Response(body, { status: 200 })) as typeof fetch, maxFileBytes: 100 },
    );
    assert.equal(result.pocet_stazenych, 0);
    assert.deepEqual(await readdir(dir), []);
    assert.ok(result.varovani.some((warning) => warning.includes('částečný soubor byl smazán')));
  });
});

test('automatická pipeline se spustí jen po úplném stažení bez varování', () => {
  assert.equal(shouldAutoStartDownloadedPipeline(2, 2, []), true);
  assert.equal(shouldAutoStartDownloadedPipeline(2, 1, []), false);
  assert.equal(shouldAutoStartDownloadedPipeline(2, 2, ['varování']), false);
  assert.equal(shouldAutoStartDownloadedPipeline(0, 0, []), false);
  assert.equal(
    incompleteDownloadWarning(1, 2),
    'staženo 1/2 — pipeline nespuštěna, zkontrolujte dokumenty a spusťte ručně',
  );
});
