import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { classifyUrl, measureProvenance } from '../src/tools/mereni-provenience.js';

const scriptsDir = fileURLToPath(new URL('..', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/tools/mereni-provenience.ts', import.meta.url));

async function createOutputFixture(productMatches: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vz-mereni-provenience-'));
  for (const [index, productMatch] of productMatches.entries()) {
    const file = join(root, `zakazka-${index + 1}`, 'product-match.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(productMatch), 'utf8');
  }
  return root;
}

function runCli(outputDir: string, json = true): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.ANTHROPIC_API_KEY;

  const args = ['--import', 'tsx', cliPath];
  if (json) args.push('--json');
  args.push('--output-dir', outputDir);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: scriptsDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('měření počítá kandidáty a detekuje URL v libovolné hloubce', async () => {
  const outputDir = await createOutputFixture([
    {
      tenderId: 'moderni',
      polozky_match: [
        {
          vybrany_index: 0,
          kandidati: [
            {
              katalogove_cislo: ' ABC-123 ',
              dodavatele: ['Dodavatel A'],
              cena_spolehlivost: 'vysoka',
              zdroj_ceny: 'Katalog',
              metadata: { odkazy: [{ href: 'https://shop.example/produkt/abc' }] },
            },
            {
              katalogove_cislo: '',
              dodavatele: [],
              cena_spolehlivost: 'nizka',
              zdroj_ceny: 'Odhad',
            },
          ],
        },
      ],
    },
    {
      tenderId: 'legacy',
      kandidati: [
        {
          dodavatele: ['Dodavatel B'],
          cena_spolehlivost: 'stredni',
          zdroj_ceny: 'Odhad',
        },
      ],
    },
  ]);

  try {
    const result = await measureProvenance(outputDir);
    assert.equal(result.zakazek, 2);
    assert.equal(result.polozek, 2);
    assert.equal(result.kandidatu, 3);
    assert.equal(result.sKatalogovymCislem, 1);
    assert.equal(result.sDodavateli, 2);
    assert.equal(result.sUrl, 1);
    assert.equal(result.produktovaStranka, 1);
    assert.equal(result.jenVyhledavani, 0);
    assert.equal(result.bezOdkazu, 2);
    assert.equal(result.dolozenych, 1);
    assert.equal(result.podilDolozenych, '33.33 %');
    assert.deepEqual(result.odkazyPodleKategorie, {
      produktova_stranka: 1,
      vyhledavani: 0,
      neznamy: 0,
    });
    assert.deepEqual(result.hostitele, { 'shop.example': 1 });
    assert.deepEqual(result.cenaSpolehlivost, { nizka: 1, stredni: 1, vysoka: 1 });
    assert.deepEqual(result.topZdrojeCeny.slice(0, 2), [
      { hodnota: 'Odhad', pocet: 2 },
      { hodnota: 'Katalog', pocet: 1 },
    ]);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('dodavatel bez URL se nepočítá jako doložený zdroj', async () => {
  const outputDir = await createOutputFixture([{
    tenderId: 'jen-dodavatel',
    kandidati: [{ dodavatele: ['Alza.cz'], cena_spolehlivost: 'nizka', zdroj_ceny: 'Odhad' }],
  }]);

  try {
    const result = await measureProvenance(outputDir);
    assert.equal(result.sDodavateli, 1);
    assert.equal(result.sUrl, 0);
    assert.equal(result.sDoklademOvereniCeny, 0);
    assert.equal(result.dolozenych, 0);
    assert.equal(result.podilDolozenych, '0 %');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('klasifikátor rozliší vyhledávání, produktové cesty a neznámý odkaz', () => {
  assert.equal(classifyUrl('https://shop.example/search?q=vrtačka'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/search'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/hledat'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/hledani'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/vyhledavani'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/katalog?q=vrtačka'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/katalog?query=vrtačka'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/katalog?search=vrtačka'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/katalog?dotaz=vrtačka'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/katalog?keyword=vrtačka'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/produkt/aku-vrtacka-123?query=vrtačka'), 'vyhledavani');
  assert.equal(classifyUrl('https://shop.example/p/aku-vrtacka-123'), 'produktova_stranka');
  assert.equal(classifyUrl('https://shop.example/dp/aku-vrtacka-123'), 'produktova_stranka');
  assert.equal(classifyUrl('https://shop.example/zbozi/aku-vrtacka-123'), 'produktova_stranka');
  assert.equal(classifyUrl('https://shop.example/katalog/123456'), 'produktova_stranka');
  assert.equal(classifyUrl('https://www.formech.com/products/300xq'), 'produktova_stranka');
  assert.equal(classifyUrl('https://mayku.me/multiplier'), 'produktova_stranka');
  assert.equal(classifyUrl('https://shop.example/informace/kontakt'), 'neznamy');
  assert.equal(classifyUrl('https://shop.example/informace/privacy-policy'), 'neznamy');
  assert.equal(classifyUrl('https://shop.example/kategorie/3d-tiskarny'), 'neznamy');
});

test('Heureka h[fraze] je vyhledávání, ne produktová stránka', () => {
  assert.equal(
    classifyUrl('https://www.heureka.cz/?h%5Bfraze%5D=Bambu+Lab+X1E'),
    'vyhledavani',
  );
});

test('Prusa /produkt/ je produktová stránka', () => {
  assert.equal(
    classifyUrl('https://www.prusa3d.com/cs/produkt/original-prusa-xl-semi-assembled-5-toolhead-3d-printer/'),
    'produktova_stranka',
  );
});

test('trojice vyhledávacích odkazů je jen zdánlivě doložená cena', async () => {
  const outputDir = await createOutputFixture([{
    tenderId: 'search-sablona',
    kandidati: [{
      reference_urls: [
        'https://www.alza.cz/search?q=Bambu+Lab+X1E',
        'https://www.czc.cz/hledat?q=Bambu+Lab+X1E',
        'https://www.heureka.cz/?h%5Bfraze%5D=Bambu+Lab+X1E',
      ],
      cena_spolehlivost: 'nizka',
      zdroj_ceny: 'Web',
    }],
  }]);

  try {
    const result = await measureProvenance(outputDir);
    assert.equal(result.produktovaStranka, 0);
    assert.equal(result.jenVyhledavani, 1);
    assert.equal(result.bezOdkazu, 0);
    assert.equal(result.dolozenych, 0);
    assert.equal(result.podilDolozenych, '0 %');
    assert.deepEqual(result.odkazyPodleKategorie, {
      produktova_stranka: 0,
      vyhledavani: 3,
      neznamy: 0,
    });
    assert.deepEqual(result.hostitele, {
      'www.alza.cz': 1,
      'www.czc.cz': 1,
      'www.heureka.cz': 1,
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('URL v overeni_ceny.zdroje[].zdroj_url dokládá jen vybraného kandidáta', async () => {
  const outputDir = await createOutputFixture([{
    tenderId: 'polozkovy-doklad',
    polozky_match: [{
      vybrany_index: 1,
      kandidati: [
        { dodavatele: ['Dodavatel A'], cena_spolehlivost: 'nizka', zdroj_ceny: 'Odhad' },
        { dodavatele: ['Dodavatel B'], cena_spolehlivost: 'vysoka', zdroj_ceny: 'Web' },
      ],
      overeni_ceny: {
        zdroje: [{ zdroj_url: 'https://doklad.example/produkt' }],
      },
    }],
  }]);

  try {
    const result = await measureProvenance(outputDir);
    assert.equal(result.sUrl, 0);
    assert.equal(result.sDoklademOvereniCeny, 1);
    assert.equal(result.dolozenych, 1);
    assert.equal(result.podilDolozenych, '50 %');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('kanonické overeni_ceny.zdroje[].url se také počítá jako doklad', async () => {
  const outputDir = await createOutputFixture([{
    tenderId: 'kanonicky-doklad',
    polozky_match: [{
      vybrany_index: 0,
      kandidati: [
        { dodavatele: ['Dodavatel A'], cena_spolehlivost: 'vysoka', zdroj_ceny: 'Web' },
        { dodavatele: ['Dodavatel B'], cena_spolehlivost: 'nizka', zdroj_ceny: 'Odhad' },
      ],
      overeni_ceny: {
        zdroje: [{ url: 'https://doklad.example/kanonicky-produkt' }],
      },
    }],
  }]);

  try {
    const result = await measureProvenance(outputDir);
    assert.equal(result.sUrl, 0);
    assert.equal(result.sDoklademOvereniCeny, 1);
    assert.equal(result.dolozenych, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('vyhledávací URL v overeni_ceny není položkový doklad', async () => {
  const outputDir = await createOutputFixture([{
    tenderId: 'search-neni-doklad',
    kandidati: [{ cena_spolehlivost: 'nizka', zdroj_ceny: 'Odhad' }],
    overeni_ceny: {
      zdroj_url: 'https://shop.example/search?q=vymyšlený+produkt',
    },
  }]);

  try {
    const result = await measureProvenance(outputDir);
    assert.equal(result.sDoklademOvereniCeny, 0);
    assert.equal(result.dolozenych, 0);
    assert.equal(result.podilDolozenych, '0 %');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('top-level overeni_ceny.zdroj_url a URL kandidáta se v souhrnu neduplikuje', async () => {
  const outputDir = await createOutputFixture([{
    tenderId: 'prekryv-dokladu',
    polozky_match: [{
      vybrany_index: 0,
      kandidati: [{
        reference_urls: ['https://kandidat.example/produkt'],
        cena_spolehlivost: 'vysoka',
        zdroj_ceny: 'Web',
      }],
      overeni_ceny: { zdroj_url: 'https://doklad.example/produkt' },
    }],
  }]);

  try {
    const result = await measureProvenance(outputDir);
    assert.equal(result.sUrl, 1);
    assert.equal(result.sDoklademOvereniCeny, 1);
    assert.equal(result.dolozenych, 1);
    assert.equal(result.podilDolozenych, '100 %');
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('CLI poskytuje čistý JSON i čitelnou výchozí tabulku', async () => {
  const outputDir = await createOutputFixture([{
    tenderId: 'cli-vystup',
    kandidati: [{
      reference_urls: ['https://shop.example/produkt'],
      cena_spolehlivost: 'vysoka',
      zdroj_ceny: 'Web',
    }],
  }]);

  try {
    const jsonResult = await runCli(outputDir);
    assert.equal(jsonResult.code, 0);
    assert.equal(jsonResult.stderr, '');
    const jsonMeasurement = JSON.parse(jsonResult.stdout);
    assert.equal(jsonMeasurement.dolozenych, 1);
    assert.equal(jsonMeasurement.produktovaStranka, 1);
    assert.equal(jsonMeasurement.jenVyhledavani, 0);
    assert.equal(jsonMeasurement.bezOdkazu, 0);
    assert.deepEqual(jsonMeasurement.hostitele, { 'shop.example': 1 });

    const tableResult = await runCli(outputDir, false);
    assert.equal(tableResult.code, 0);
    assert.equal(tableResult.stderr, '');
    assert.match(tableResult.stdout, /Měření provenience cen/);
    assert.match(tableResult.stdout, /Zdánlivě doložené ceny \(jen vyhledávací odkazy\)\s+\| 0/);
    assert.match(tableResult.stdout, /Kandidáti s produktovou stránkou\s+\| 1/);
    assert.match(tableResult.stdout, /Kandidáti bez odkazu\s+\| 0/);
    assert.match(tableResult.stdout, /Skutečně doložené ceny\s+\| 1 \(100 %\)/);
    assert.match(tableResult.stdout, /Hostitelé odkazů kandidátů/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('prázdný vstup skončí chybou a nenulovým exit kódem', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'vz-mereni-provenience-empty-'));
  const invalidOutputDir = await createOutputFixture([{}]);
  try {
    const result = await runCli(outputDir);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /prázdný|product-match/i);

    const invalidResult = await runCli(invalidOutputDir);
    assert.notEqual(invalidResult.code, 0);
    assert.match(invalidResult.stderr, /žádné cenové kandidáty/i);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
    await rm(invalidOutputDir, { recursive: true, force: true });
  }
});
