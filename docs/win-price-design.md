# Win-price inteligence — design prototypu

> Stav: **prototyp (noční běh 2026-07-09)**. Základ datové vrstvy „co za podobné HW/komodity kdy vyhrálo a za kolik". Napojení na nacenění a go/no-go je zde jen **navrženo**, neimplementováno.

## 1. Cíl

Postavit dotazovatelnou databázi historických **smluvních (vítězných) cen** z veřejných zdrojů, aby šlo k předmětu zakázky („server", „projektor", „vrtačka") dohledat, za kolik se podobné plnění reálně nakupovalo, a z toho odvodit **cenové pásmo** pro naši nabídku. To je jádro konkurenční výhody proti monitoring-only nástrojům (Tenderpool aj. — viz `tasks/recon-market.md`).

## 2. Zvolený zdroj a proč

Kandidáti (z recon-market.md): Registr smluv (denní XML dumpy), ISVZ OpenData (XML/CSV), Hlídač státu API v2, TED API v3.

**Zvolen: Registr smluv — denní XML dumpy z `https://data.smlouvy.gov.cz/`.**

Kritéria byla: obsahuje vítěznou/smluvní cenu + předmět + datum, bez autentizace. Ověřeno živě:

| Kritérium | Registr smluv | ISVZ OpenData | Hlídač v2 | TED v3 |
|---|---|---|---|---|
| Cena ve strukturovaném poli | ✅ `hodnotaBezDph` / `hodnotaVcetneDph` | ⚠️ jen předpokládaná/finální u award notice | ✅ (agreguje) | ✅ nadlimitní |
| Předmět plnění | ✅ `predmet` | ✅ | ✅ | ✅ |
| Datum | ✅ `datumUzavreni` | ✅ | ✅ | ✅ |
| Bez auth | ✅ | ✅ (ale doména www.isvz.cz měla certifikátový problém) | ❌ token + komerční licence pro produkt | ✅ |
| Granularita stažení | ✅ **denní dumpy ~1–8 MB** + měsíční agregát | ⚠️ po letech (velké) | REST (rate limity nedok.) | bulk |
| Počet nabídek (uchazečů) | ❌ není | ⚠️ v award notice bývá | částečně | ✅ eForms |

**Proč Registr smluv pro prototyp:**
- Živě ověřená, dobře dokumentovaná struktura (`index.xml` → `dump_YYYY_MM_DD.xml`), denní dumpy jsou malé → rychlý inkrementální import bez těžkého backfillu.
- Bez tokenu/licence (na rozdíl od Hlídače, který pro komerční produkt vyžaduje placenou licenci — CC BY 3.0 jinak).
- Obsahuje **skutečnou smluvní cenu** (ne jen předpokládanou hodnotu) + přílohy (PDF smluv) s hashem pro pozdější AI extrakci položkových cen.

**Omezení zdroje (řeší se dál):**
- **Nemá počet uchazečů** ani jednotkové ceny položek → ty přijdou z VVZ/ISVZ award notice (počet nabídek) a z AI extrakce PDF příloh (položky). Sloupec `pocet_uchazecu` je proto zatím vždy NULL.
- Není to čistě „veřejná zakázka" — Registr smluv obsahuje všechny smlouvy nad limit, ne jen výsledky zadávacích řízení. Párování na konkrétní VZ jde přes `evidencniCisloZakazky` (v datech ale řídké, ~0,1 %).
- **Dirty data:** reálně se v datech vyskytují chybně zadaná data uzavření (roky `0006`, `2206`, `2027`) a extrémní částky (jednotky mld. Kč u rámcových smluv). Prototyp je ukládá tak, jak jsou; čištění/outlier-ořez je TODO (viz §7).
- **GDPR:** Registr smluv obsahuje osobní údaje (u FO dodavatelů je jméno v `predmet`/`nazev`). Příjemce se stává správcem OÚ a musí mazat znepřístupněné záznamy. Prototyp respektuje `platnyZaznam` (znepřístupněné přeskakuje), ale plný režim mazání dle znepřístupnění ve zdroji je TODO.

## 3. Architektura

```
data.smlouvy.gov.cz/index.xml            (seznam dumpů: denní + měsíční)
        │  fetch-win-prices.ts --source=registr_smluv --from --to --limit
        ▼
  denní dump_YYYY_MM_DD.xml  ──parse (cheerio, xml mode)──► WinPriceRecord[]
        │                         ├─ zadavatel = <subjekt> (uveřejňovatel/kupující)
        │                         ├─ dodavatel = <smluvniStrana> (protistrana/vítěz)
        │                         ├─ predmet, datumUzavreni, hodnotaBezDph/VcetneDph, ciziMena
        │                         └─ komodita_kategorie = heuristika klíč. slovy (BEZ AI)
        ▼
  winprice-store.ts  ── upsert ON CONFLICT (zdroj, zdroj_id) ──►  Postgres win_prices
                                                                     (idempotentní)
        ▲
  winprice-query.ts  findSimilarWins() / priceBandForSubject()
        │  fulltext (tsvector simple) + trigram similarity (pg_trgm)
        ▼
  query-win-prices.ts  (CLI ruční dotaz)  ──►  [pozdější API endpoint, CRM panel]
```

### Soubory
- `scripts/migrations/011_win_price.sql` — tabulka `win_prices` + indexy (GIN fulltext, GIN trgm, datum, kategorie, dodavatel, GIN raw). Konzistentní se stylem migrací 001–010, aplikuje se přes `runMigrations()`.
- `scripts/src/lib/winprice-store.ts` — typy, `categorizeCommodity()`, idempotentní `upsertWinPrices()` (chunked), `getWinPriceStats()`.
- `scripts/src/fetch-win-prices.ts` — CLI fetcher (`--source --from --to --limit`), parser Registru smluv (cheerio).
- `scripts/src/lib/winprice-query.ts` — `findSimilarWins(predmet, {kategorie, limit, minSimilarity, onlyWithPrice})` + `priceBandForSubject()` (min/medián/průměr/max bez DPH).
- `scripts/src/query-win-prices.ts` — CLI pro ruční dotazy.

**serve-api.ts se záměrně NEUPRAVUJE** (paralelní stream). API endpoint (`GET /api/win-prices?predmet=…`) se přidá později jako tenký wrapper nad `findSimilarWins`.

### Schéma `win_prices`
`id, zdroj, zdroj_id (UNIQUE se zdroj), datum, zadavatel_ico/nazev, dodavatel_ico/nazev, predmet, komodita_kategorie, cena_bez_dph, cena_s_dph, mena, pocet_uchazecu, url, raw jsonb, created_at, search_vector (generated tsvector)`.

Idempotence: `UNIQUE (zdroj, zdroj_id)`, kde `zdroj_id` = `idVerze` (verze záznamu v Registru smluv). Re-import stejného dumpu záznamy neduplikuje.

## 4. Kategorizace komodit (heuristika, bez AI)

`categorizeCommodity(predmet)` mapuje předmět na `it_av | naradi_dilna | kancelar | ostatni` podle seznamu klíčových slov (viz `winprice-store.ts`). Vědomě jednoduché a levné — **žádné AI volání** (P0 rate-limit). Přesnost je hrubá (většina spadne do `ostatni`); přesnou kategorizaci/CPV-NIPEZ mapování řeší AI fáze (§7).

## 5. Ověřený běh (2026-07-09, embedded Postgres 18.4)

> Pozn.: cílová DB je docker `vz-qa-pg` (pgvector/pgvector:pg16, port 55432). V době běhu byl lokální Docker daemon zaseklý (nenastartoval VM ani po restartu Desktopu), proto byl prototyp ověřen proti **self-contained Postgres 18.4** (`embedded-postgres`) na stejném portu 55432. Migrace `011` používá jen `pg_trgm` (vestavěné), takže je na pgvector nezávislá; `CREATE EXTENSION vector` je jen v migraci `001`, které se win-price netýká.

Import: `fetch-win-prices.ts --from=2026-06-16 --to=2026-07-08` → **51 000 záznamů (35 426 s cenou)**, kategorie `ostatni=48580, it_av=1434, kancelar=781, naradi_dilna=205`.

Ukázkové dotazy (`query-win-prices.ts`):

```
„server"    n=163  medián 111 152 Kč  průměr 407 702 Kč  (min 3 088 – max 8 960 380)
   [0.39] Objednávka Server — DATASYS s.r.o. — 197 576 Kč bez DPH
   [0.37] Klimatizace server — JaS KLIMA s.r.o. — 79 654 Kč
„projektor" n=143  medián 122 700 Kč
   [0.30] Objednávka IT vybavení - projektor — 64 905 Kč
   [0.23] nákup interaktivní tabule + projektor — AV MEDIA SYSTEMS — 120 000 Kč
„vrtačka"   n=17   medián 156 920 Kč
   [0.22] chirurgická vrtačka — 137 500 Kč  |  [0.25] vrtáky — 78 523 Kč  |  „vrtaná studna" (false positive)
„notebook" [it_av]  n=25  medián 104 200 Kč  (min 14 805 – max 2 915 590)
```

Dotazy vracejí reálné, smysluplné výsledky. `vrtačka` zároveň ukazuje limit trigramů (fuzzy match „vrtaná studna") → v produkci ošetřit kategorií + CPV filtrem.

## 6. Návrh napojení (NEIMPLEMENTOVÁNO)

### Na `match-product` / `verify-prices`
Do pipeline přidat **win-price signál** vedle nákladové ceny ze skladu a web-search ověření (`price-verifier.ts`):
1. Pro každou položku/zakázku zavolat `priceBandForSubject(predmet, {kategorie})`.
2. Vrátit kontrakt `win_price_signal = { pocet, min, median, prumer, max, zdroj: 'registr_smluv', vzorky: SimilarWin[] }` — **návrhové pole, nikdy nepřepisuje `cenova_uprava`** (money-path potvrzuje člověk), stejný princip jako `overeni_ceny`.
3. UI: k naší kalkulované ceně zobrazit „historické vítězné pásmo" → uživatel vidí, jestli je nad/pod trhem.

### Na go/no-go scoring
Win-price krmí dvě váhy z návrhu scoringu (recon-market.md §e):
- **Ekonomika** — je naše nákladová cena + marže pod historickým mediánem? (šance uspět cenou)
- **Win-probability** — poloha naší ceny v historickém pásmu (percentil) → hrubý odhad pravděpodobnosti výhry. Zpřesní se, až budeme mít `pocet_uchazecu` (tlak konkurence).

## 7. Co dál (roadmapa datové vrstvy)

1. **Docker `vz-qa-pg`** — jakmile bude Docker zdravý, spustit migraci + import proti němu (pgvector image); jinak identické.
2. **Backfill historie** — stáhnout měsíční agregáty (`dump_YYYY_MM.xml`) za víc let; přidat granularitu měsíc do fetcheru (dnes bere jen denní dumpy).
3. **Počet uchazečů z VVZ/ISVZ** — award notices (eForms) nesou vítěze, konečnou cenu a počet nabídek → doplnit `zdroj='vvz'` a párovat na Registr smluv přes IČO dodavatele + evidenční číslo zakázky.
4. **AI kategorizace + CPV/NIPEZ** — nahradit heuristiku klasifikací na CPV kód (přesnější filtr než klíčová slova), pravděpodobně přes embeddings (pgvector už ve stacku).
5. **AI extrakce položkových cen z PDF příloh** — jednotkové ceny HW ze skutečně podepsaných smluv (odkazy `prilohy/priloha` s hashem) → unikátní dataset pro nacenění po položkách.
6. **Čištění dat** — validace `datum` (zahodit nesmyslné roky), outlier detekce cen (winsorizace pásma), měna přepočet na CZK.
7. **GDPR režim** — periodické mazání záznamů znepřístupněných ve zdroji; minimalizace ukládaných OÚ.
8. **API + CRM panel** — endpoint nad `findSimilarWins` a panel „Historické vítězné ceny" u zakázky.
