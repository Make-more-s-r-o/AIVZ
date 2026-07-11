/**
 * CLI: ověření reálných cen web-searchem pro danou zakázku.
 *
 * Načte output/<id>/product-match.json, přes web search dohledá aktuální ceny
 * v českých e-shopech a MERGE `overeni_ceny` do jednotlivých položek (ostatní
 * pole nedotčená), pak atomicky (tmp + rename) zapíše soubor zpět.
 *
 * NIKDY nesahá na `cenova_uprava` — tu potvrzuje uživatel v UI (money-path).
 *
 * Použití:
 *   npx tsx src/verify-prices.ts --tender-id=<id> [--limit=N] [--only-index=i]
 */
import { readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { config } from 'dotenv';
import {
  ANTHROPIC_CREDIT_ERROR_MESSAGE,
  mergePriceVerifications,
  verifyAllPrices,
  type ItemVerification,
} from './lib/price-verifier.js';
import { upsertFindings, type WebFindingInput } from './lib/web-findings-store.js';
import type { ProductMatch, ProductCandidate, TenderAnalysis } from './lib/types.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;

function getArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

function parseIntArg(name: string): number | undefined {
  const v = getArg(name);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

function selectedCandidate(matchData: ProductMatch, polozkaIndex: number): ProductCandidate | undefined {
  if (polozkaIndex === -1) {
    return matchData.kandidati?.[matchData.vybrany_index ?? 0];
  }
  const item = matchData.polozky_match?.find((candidateItem) => candidateItem.polozka_index === polozkaIndex);
  return item?.kandidati[item.vybrany_index];
}

/** Připraví všechny validní nákupní zdroje pro oddělený sklad webových nálezů. */
function findingsFromResults(
  tenderId: string,
  matchData: ProductMatch,
  results: ItemVerification[],
): WebFindingInput[] {
  return results.flatMap((result) => {
    if (!['nalezeno', 'ekvivalent', 'orientacni'].includes(result.overeni_ceny.stav)) return [];
    const candidate = selectedCandidate(matchData, result.polozka_index);
    const produkt = candidate ? `${candidate.vyrobce} ${candidate.model}`.trim() : null;
    const sources = result.overeni_ceny.zdroje?.length
      ? result.overeni_ceny.zdroje
      : result.overeni_ceny.zdroj_url && /^https?:\/\//i.test(result.overeni_ceny.zdroj_url)
        ? [{
            url: result.overeni_ceny.zdroj_url,
            dodavatel: result.overeni_ceny.dodavatel ?? null,
            cena_bez_dph: result.overeni_ceny.web_cena_bez_dph ?? null,
            cena_s_dph: result.overeni_ceny.web_cena_s_dph ?? null,
            dostupnost: result.overeni_ceny.dostupnost ?? null,
            poznamka: result.overeni_ceny.poznamka ?? null,
          }]
        : [];

    return sources.map((source) => ({
      tender_id: tenderId,
      polozka_index: result.polozka_index,
      polozka_nazev: result.polozka_nazev,
      produkt,
      dodavatel: source.dodavatel,
      url: source.url,
      cena_bez_dph: source.cena_bez_dph,
      cena_s_dph: source.cena_s_dph,
      dostupnost: source.dostupnost,
    }));
  });
}

async function main(): Promise<void> {
  const tenderId = getArg('tender-id');
  if (!tenderId) {
    console.error('Chybí --tender-id=<id>');
    console.error('Použití: npx tsx src/verify-prices.ts --tender-id=<id> [--limit=N] [--only-index=i]');
    process.exit(1);
  }
  const limit = parseIntArg('limit');
  const onlyIndex = parseIntArg('only-index');

  const matchPath = join(ROOT, 'output', tenderId, 'product-match.json');
  let matchData: ProductMatch;
  try {
    matchData = JSON.parse(await readFile(matchPath, 'utf-8')) as ProductMatch;
  } catch (err) {
    console.error(`Nelze načíst ${matchPath}: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  let analysis: TenderAnalysis | undefined;
  try {
    analysis = JSON.parse(await readFile(join(ROOT, 'output', tenderId, 'analysis.json'), 'utf-8')) as TenderAnalysis;
  } catch {
    console.warn('  analysis.json chybí nebo je nečitelný — přesné modely se ověří, ekvivalenty budou zakázány.');
  }

  console.log(`\nOvěřování cen web-searchem — zakázka ${tenderId}`);
  if (limit !== undefined) console.log(`  limit: ${limit}`);
  if (onlyIndex !== undefined) console.log(`  jen položka index: ${onlyIndex}`);

  const { results, summary } = await verifyAllPrices(matchData, {
    tenderId,
    analysis,
    limit,
    onlyIndex,
    onProgress: (m) => console.log('  ' + m),
  });

  if (summary.preruseno_kvuli_kreditu) {
    // Fail-closed: při vyčerpaném kreditu nezapisujeme ani dílčí úspěchy z tohoto běhu.
    console.error(`\n${ANTHROPIC_CREDIT_ERROR_MESSAGE}`);
    console.log(`Přerušeno po ${results.length} z ${summary.total} položek (preruseno_kvuli_kreditu: true).`);
    process.exitCode = 1;
    return;
  }

  // MERGE overeni_ceny do položek (ostatní pole nedotčená).
  //
  // POZOR na lost-update: web search běží MINUTY a `matchData` je snapshot z počátku běhu.
  // Mezitím může operátor v UI potvrdit ceny (`cenova_uprava`) — jednotlivě i hromadně přes
  // bulk endpoint — což zapisuje do stejného souboru. Kdybychom zapsali zpět starý snapshot,
  // tato potvrzení (money-path!) by tiše zmizela. Proto těsně před zápisem soubor znovu
  // načteme (čerstvá kopie) a mergujeme overeni_ceny jen do ní. Okno mezi tímto re-readem
  // a rename je milisekundy (místo minut), takže souběžná potvrzení zůstanou zachována.
  let fresh: ProductMatch;
  try {
    fresh = JSON.parse(await readFile(matchPath, 'utf-8')) as ProductMatch;
  } catch (error) {
    // Fail-closed: při chybě čerstvého čtení nesmíme zapsat starý snapshot a
    // riskovat ztrátu potvrzené ceny ani přilepení výsledku k jinému kandidátovi.
    throw new Error(`Čerstvé načtení product-match.json před merge selhalo; ověření nezapisuji: ${error instanceof Error ? error.message : String(error)}`);
  }

  mergePriceVerifications(fresh, results);

  // Atomický zápis (tmp + rename) — nikdy nezanechá poškozený soubor
  const tmpPath = `${matchPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(fresh, null, 2), 'utf-8');
  await rename(tmpPath, matchPath);

  // Nákupní znalost ukládáme odděleně od matchingu. Bez DB jde o no-op; skutečná
  // chyba skladu je pouze warning a nesmí zneplatnit úspěšné webové ověření.
  const acceptedResults = results.filter((result) => {
    const stored = result.polozka_index === -1
      ? fresh.overeni_ceny
      : fresh.polozky_match?.find((item) => item.polozka_index === result.polozka_index)?.overeni_ceny;
    return stored?.kandidat_fingerprint === result.overeni_ceny.kandidat_fingerprint;
  });
  const findings = findingsFromResults(tenderId, fresh, acceptedResults);
  try {
    await upsertFindings(findings);
  } catch (err) {
    console.warn(`Webové nálezy se nepodařilo uložit do skladu: ${(err as Error).message}`);
  }

  // Souhrn
  console.log('\n--- Souhrn ---');
  console.log(`  Ověřeno položek: ${summary.total}`);
  console.log(`  Nalezeno: ${summary.nalezeno}  |  Orientační: ${summary.orientacni}  |  Nenalezeno: ${summary.nenalezeno}  |  Chyba: ${summary.chyba}`);
  console.log(`  Fáze 1 hit: ${summary.faze1_nalezeno}  |  Fáze 2 hit: ${summary.faze2_nalezeno}  |  Nenalezeno: ${summary.nenalezeno}`);
  console.log(
    `  Reálný nákup vyšší než AI odhad: ${summary.realny_nakup_vyssi_nez_ai}` +
    `  |  Průměrně o: ${summary.prumerny_narust_procent !== null ? `${summary.prumerny_narust_procent.toFixed(1)} %` : 'nelze spočítat'}`,
  );
  if (summary.prekracuje_strop > 0) console.log(`  Překračuje cenový strop: ${summary.prekracuje_strop}`);
  console.log(`  Web searchů: ${summary.searches}`);
  console.log(
    `  Tokeny: ${summary.inputTokens} in / ${summary.outputTokens} out  |  Náklad: ${summary.costCZK.toFixed(2)} CZK`,
  );
  console.log(`\nZapsáno do: ${matchPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
