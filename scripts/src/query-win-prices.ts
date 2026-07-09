/**
 * CLI: ruční dotaz do win-price databáze — „za kolik se vyhrálo u podobných věcí".
 *
 * Použití:
 *   npx tsx src/query-win-prices.ts "server" [--kategorie=it_av] [--limit=10]
 *   npx tsx src/query-win-prices.ts "projektor" --band     # jen cenové pásmo
 */
import { config } from 'dotenv';
import { closePool } from './lib/db.js';
import { findSimilarWins, priceBandForSubject } from './lib/winprice-query.js';
import type { KomoditaKategorie } from './lib/winprice-store.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

function getArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function fmtCena(n: number | null, mena: string): string {
  if (n === null) return '—';
  return `${n.toLocaleString('cs-CZ')} ${mena}`;
}

async function main(): Promise<void> {
  // první poziční argument bez -- je hledaný předmět
  const predmet = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!predmet) {
    console.error('Použití: npx tsx src/query-win-prices.ts "<předmět>" [--kategorie=it_av] [--limit=10] [--band]');
    process.exit(1);
    return;
  }
  const kategorie = getArg('kategorie') as KomoditaKategorie | undefined;
  const limit = Number(getArg('limit') ?? '10');

  const band = await priceBandForSubject(predmet, { kategorie });
  console.log(`\n„${predmet}"${kategorie ? ` [${kategorie}]` : ''} — cenové pásmo (bez DPH, n=${band.pocet}):`);
  console.log(
    `  min ${fmtCena(band.min, 'CZK')} | medián ${fmtCena(band.median, 'CZK')} | ` +
      `průměr ${fmtCena(band.prumer, 'CZK')} | max ${fmtCena(band.max, 'CZK')}`,
  );

  if (hasFlag('band')) {
    await closePool();
    return;
  }

  const wins = await findSimilarWins(predmet, { kategorie, limit });
  console.log(`\nTop ${wins.length} podobných záznamů:`);
  for (const w of wins) {
    const cena = w.cena_bez_dph !== null
      ? `${fmtCena(w.cena_bez_dph, w.mena)} bez DPH`
      : `${fmtCena(w.cena_s_dph, w.mena)} s DPH`;
    console.log(
      `\n  [${w.similarity.toFixed(2)}] ${w.datum ?? '?'} · ${cena} · ${w.komodita_kategorie}`,
    );
    console.log(`     ${w.predmet.slice(0, 120)}`);
    console.log(`     zadavatel: ${w.zadavatel_nazev ?? '?'}  →  dodavatel: ${w.dodavatel_nazev ?? '?'}`);
    if (w.url) console.log(`     ${w.url}`);
  }

  console.log(
    '\nPozn.: role zadavatel/dodavatel je určena heuristikou z Registru smluv ' +
      '(pořadí stran není spolehlivé) — ověřte přes odkaz na smlouvu.',
  );

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
