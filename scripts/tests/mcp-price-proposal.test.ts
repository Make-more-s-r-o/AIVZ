import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { AgentIdentity } from '../src/lib/agent-identity.js';
import { candidateFingerprint } from '../src/lib/candidate-fingerprint.js';
import { persistPriceProposal } from '../src/mcp/price-proposal.js';
import {
  createMcpAgentServices,
  createSnapshotMutationRunner,
} from '../src/mcp/services.js';

const AGENT: AgentIdentity = {
  type: 'agent',
  kind: 'agent',
  sub: 'agent:price-test',
  id: 'price-test',
  agentId: 'price-test',
  name: 'Testovací cenový agent',
  purpose: 'Test návrhu ceny',
  role: 'analytik',
  budget: {
    day: '2026-09-04',
    limitCzk: 100,
    spentCzk: 0,
    remainingCzk: 100,
    exhausted: false,
  },
};

const TENDER_ID = 'mcp-price-test';
const DISCOVERED_AT = '2026-09-04T08:15:00.000Z';
const SAVED_AT = '2026-09-04T08:16:00.000Z';
const PRODUCT_URL = 'https://shop.example.cz/produkty/widget-42';

function candidate() {
  return {
    vyrobce: 'Acme',
    model: 'Widget 42',
    popis: 'Testovací produkt',
    parametry: {},
    shoda_s_pozadavky: [],
    cena_bez_dph: 90,
    cena_s_dph: 108.9,
    cena_spolehlivost: 'nizka',
    dodavatele: [],
    dostupnost: 'skladem',
  };
}

function productMatch(overrides: Record<string, unknown> = {}) {
  return {
    tenderId: TENDER_ID,
    matchedAt: '2026-09-04T08:00:00.000Z',
    polozky_match: [{
      polozka_nazev: 'Widget',
      polozka_index: 7,
      mnozstvi: 2,
      typ: 'produkt',
      kandidati: [candidate()],
      vybrany_index: 0,
      oduvodneni_vyberu: 'Nejlepší shoda',
    }],
    ...overrides,
  };
}

function proposalInput(overrides: Record<string, unknown> = {}) {
  return {
    tenderId: TENDER_ID,
    itemIndex: 0,
    nakupniCenaBezDph: 100,
    nabidkovaCenaBezDph: 125,
    sazbaDph: 21,
    zdrojUrl: PRODUCT_URL,
    zjistenoAt: DISCOVERED_AT,
    dodavatel: 'Example shop',
    ...overrides,
  };
}

async function withProductMatch(
  document: Record<string, unknown>,
  run: (fixture: { outputDir: string; matchPath: string }) => Promise<void>,
): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), 'vz-mcp-price-'));
  const tenderDir = join(outputDir, TENDER_ID);
  const matchPath = join(tenderDir, 'product-match.json');
  await mkdir(tenderDir);
  await writeFile(matchPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  try {
    await run({ outputDir, matchPath });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

test('konkrétní produktová URL uloží pouze nepotvrzený návrh s přesnou proveniencí agenta', async () => {
  await withProductMatch(productMatch(), async ({ outputDir, matchPath }) => {
    const result = await persistPriceProposal(proposalInput(), AGENT, {
      outputDir,
      now: () => new Date(SAVED_AT),
    });
    const stored = JSON.parse(await readFile(matchPath, 'utf8'));
    const fingerprint = candidateFingerprint(candidate(), 0);

    assert.equal(fingerprint, 'Acme|Widget 42|0');
    assert.equal(result.potvrzeno, false);
    assert.equal(stored.prices_updated_at, SAVED_AT);
    assert.deepEqual(stored.polozky_match[0].cenova_uprava, {
      nakupni_cena_bez_dph: 100,
      nakupni_cena_s_dph: 121,
      marze_procent: 25,
      nabidkova_cena_bez_dph: 125,
      nabidkova_cena_s_dph: 151.25,
      potvrzeno: false,
      zdroj_nakupu: {
        url: PRODUCT_URL,
        dodavatel: 'Example shop',
      },
      price_provenance: {
        verze: 1,
        typ: 'overeny_eshop',
        stav: 'dolozena',
        url: PRODUCT_URL,
        zjisteno_at: DISCOVERED_AT,
        cena_v_okamziku: {
          bez_dph: 100,
          s_dph: 121,
          mena: 'CZK',
          sazba_dph: 21,
          baleni_ks: 1,
        },
        zjistil: {
          typ: 'web_agent',
          id: AGENT.sub,
        },
        dodavatel: 'Example shop',
        kandidat_fingerprint: fingerprint,
      },
    });
  });
});

test('vyhledávací URL je odmítnuta a product-match zůstane byte-for-byte stejný', async () => {
  await withProductMatch(productMatch(), async ({ outputDir, matchPath }) => {
    const before = await readFile(matchPath);

    await assert.rejects(
      persistPriceProposal(proposalInput({
        zdrojUrl: 'https://shop.example.cz/search?q=widget',
      }), AGENT, { outputDir }),
      /konkrétní produktovou stránku|vyhledávání/,
    );

    assert.deepEqual(await readFile(matchPath), before);
  });
});

test('existující potvrzenou cenu agent nepřepíše a soubor zůstane beze změny', async () => {
  const document = productMatch();
  (document.polozky_match[0] as Record<string, unknown>).cenova_uprava = {
    nakupni_cena_bez_dph: 80,
    nakupni_cena_s_dph: 96.8,
    marze_procent: 25,
    nabidkova_cena_bez_dph: 100,
    nabidkova_cena_s_dph: 121,
    potvrzeno: true,
    zkontrolovano_at: '2026-09-04T07:00:00.000Z',
    zkontrolovano_kym: 'Člověk',
  };

  await withProductMatch(document, async ({ outputDir, matchPath }) => {
    const before = await readFile(matchPath);

    await assert.rejects(
      persistPriceProposal(proposalInput(), AGENT, { outputDir }),
      /potvrzenou cenu smí změnit pouze člověk/,
    );

    assert.deepEqual(await readFile(matchPath), before);
  });
});

test('MCP návrh drží sdílenou REST snapshot rezervaci a souběžný lidský zápis neprojde', async () => {
  await withProductMatch(productMatch(), async ({ outputDir, matchPath }) => {
    let reservedTender: string | null = null;
    let concurrentHumanWriteRan = false;
    let concurrentAttempted = false;
    const withSnapshotMutation = createSnapshotMutationRunner({
      reserve(tenderId) {
        if (reservedTender === tenderId) return { id: `mutation:${tenderId}`, step: 'mutation' };
        assert.equal(reservedTender, null, 'test očekává jedinou aktivní tender rezervaci');
        reservedTender = tenderId;
        return undefined;
      },
      release(tenderId) {
        assert.equal(reservedTender, tenderId);
        reservedTender = null;
      },
    });
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(reservedTender, TENDER_ID, 'rezervace musí vzniknout před REST kontrolami');
      if (url.pathname === '/api/jobs') {
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
      }
      if (url.pathname === `/api/tenders/${TENDER_ID}/product-match`) {
        concurrentAttempted = true;
        await assert.rejects(
          withSnapshotMutation(TENDER_ID, async () => { concurrentHumanWriteRan = true; }),
          /nelze měnit souběžně/,
        );
        return new Response(await readFile(matchPath, 'utf8'), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Neočekávaná REST cesta v testu: ${url.pathname}`);
    }) as typeof fetch;
    const services = createMcpAgentServices({
      restBaseUrl: 'http://127.0.0.1:3001',
      authorization: 'Bearer vza_test-only-never-use',
      outputDir,
      fetchFn,
      now: () => new Date(SAVED_AT),
      withSnapshotMutation,
    });

    const result = await services.proposePrice(proposalInput(), AGENT) as Record<string, unknown>;
    assert.equal(result.potvrzeno, false);
    assert.equal(concurrentAttempted, true);
    assert.equal(concurrentHumanWriteRan, false);
    assert.equal(reservedTender, null, 'rezervace se musí po zápisu uvolnit');

    await withSnapshotMutation(TENDER_ID, async () => { concurrentHumanWriteRan = true; });
    assert.equal(concurrentHumanWriteRan, true, 'po dokončení MCP návrhu může člověk rezervaci získat');
  });
});
