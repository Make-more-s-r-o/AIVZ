import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { candidateFingerprint } from '../src/lib/candidate-fingerprint.js';
import { persistPriceVerifications } from '../src/lib/price-verification-store.js';
import type { ItemVerification } from '../src/lib/price-verifier.js';
import type { ProductCandidate, ProductMatch } from '../src/lib/types.js';

function candidate(): ProductCandidate {
  return {
    vyrobce: 'Pilot', model: 'Kelímek', popis: 'Míchací kelímek', parametry: {},
    shoda_s_pozadavky: [], cena_bez_dph: 15, cena_s_dph: 18.15,
    cena_spolehlivost: 'nizka', dodavatele: [], dostupnost: 'skladem',
  };
}

test('verify uloží čerstvý HARD cena_pod_nakupem do product-match.json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vz-verify-sanity-'));
  const matchPath = join(directory, 'product-match.json');
  const selected = candidate();
  const match: ProductMatch = {
    tenderId: 'pilot', matchedAt: '2026-07-11T10:00:00.000Z',
    polozky_match: [{
      polozka_nazev: 'Míchací kelímek', polozka_index: 0, mnozstvi: 1, typ: 'produkt',
      kandidati: [selected], vybrany_index: 0, oduvodneni_vyberu: 'pilot', sanity_flags: [],
      cenova_uprava: {
        nakupni_cena_bez_dph: 15, nakupni_cena_s_dph: 18.15, marze_procent: 0,
        nabidkova_cena_bez_dph: 20, nabidkova_cena_s_dph: 24.2, potvrzeno: true,
        zkontrolovano_at: '2026-07-11T10:00:00.000Z', zkontrolovano_kym: 'tester',
      },
    }],
  };
  const result: ItemVerification = {
    polozka_index: 0,
    polozka_nazev: 'Míchací kelímek',
    overeni_ceny: {
      stav: 'nalezeno',
      overeno_at: '2026-07-11T11:00:00.000Z',
      kandidat_fingerprint: candidateFingerprint(selected, 0),
      zdroje: [{
        url: 'https://bauhaus.cz/kelimek', dodavatel: 'BAUHAUS',
        cena_bez_dph: 40.5, cena_s_dph: 49.01, cena_baleni_s_dph: 49.01,
        baleni_ks: 1, mena: 'CZK', sazba_dph: 21, dostupnost: 'skladem', poznamka: null,
      }],
    },
  };

  try {
    await writeFile(matchPath, JSON.stringify(match), 'utf-8');
    let invalidated: number[] = [];
    await persistPriceVerifications(matchPath, [result], async (indexes) => { invalidated = indexes; });
    const stored = JSON.parse(await readFile(matchPath, 'utf-8')) as ProductMatch;
    const hard = stored.polozky_match?.[0]?.sanity_flags?.find(
      (flag) => flag.level === 'hard' && flag.code === 'cena_pod_nakupem',
    );
    assert.ok(hard);
    assert.match(hard.message, /40,5/);
    assert.equal(stored.polozky_match?.[0]?.cenova_uprava?.potvrzeno, false);
    assert.equal(stored.polozky_match?.[0]?.cenova_uprava?.zkontrolovano_at, undefined);
    assert.deepEqual(invalidated, [0]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
