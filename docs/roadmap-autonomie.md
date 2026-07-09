# Roadmapa k autonomii: monitoring → go/no-go → win-price → podání

> Zdroj: gap analýza `tasks/recon-gap.md` (referenční commit main `b64ffe1`, doplněno o merge PR #16–19). Cíl (Dan, 2026-07-09): nástroj vydělávající peníze automatizací CN, autonomně monitoring → go/no-go → nacenění vč. win-price → dokumenty → submit příprava; člověk jen go/no-go a nákupy. Metrika „3+1": nejdřív 100% průchodnost historických zakázek, pak škálování na desítky CN/den.

## Kde jsme dnes

Strategické memo (`docs/strategy-2026-04/decision-memo.md`) doporučuje variantu B (Hybrid, agent+MCP) a v podstatě předjímá tento cíl. **Realita kódu je varianta A** — klasická webapp s deterministickými skripty (`extract → analyze → match → generate → validate`), spouštěnými ručně přes upload. To je hlavní strukturální gap, který roadmapa řeší postupně, ne skokem.

Hotové a funkční (nezpochybňovat, stavět na tom): pipeline jádro, submit-gate (deterministický cenový/kompletnostní guardrail), cenový sklad s 3-tier matchingem, CRM vrstva (M1–M10, stavy/úkoly/termíny/komentáře/RBAC), ops (Docker/GHCR/Hetzner).

## Čtyři chybějící pilíře nového cíle

| # | Pilíř | Stav dnes | Proč bez toho nejde „vydělávat" |
|---|---|---|---|
| 1 | **Automatický monitoring nových VZ** | Neexistuje. Jediný n8n workflow (`n8n-workflows/vz-monitor-hlidac.json`) je nenasazený (prázdné credentials), nenapojený na appku. `MonitoringPage.tsx` sám přiznává v komentáři: monitoring = ruční ingest inbox. Vstup zakázek je 100% ruční upload. | Bez automatického vstupu nejsou CN → žádné peníze. Blokuje „desítky CN denně". |
| 2 | **Go/no-go scoring šance na výhru** | Jen textové `doporuceni.rozhodnuti` (ANO/NE/ZVÁŽIT) z jednoho LLM volání. Žádné číselné skóre, žádná prioritizace fronty, žádné porovnání proti kapabilitám firmy. | Bez skóre operátor netuší, kam soustředit kapacitu — nutné pro škálování bez lineárního růstu lidské práce. |
| 3 | **Win-price feedback loop** | Cenová historie ve skladu = jen nákupní ceny ze scraperů, ne „za jakou cenu se vyhrálo". **Prototyp datové vrstvy vznikl dnes v noci** (`docs/win-price-design.md`, PR #16) — Registr smluv, 51 000 záznamů, funkční fulltext+trigram dotazy. Napojení na nacenění a go/no-go je zatím jen navrženo. | Přímý pákový efekt na win-rate i marži — jádro konkurenční výhody proti Tenderpool a spol. (viz `docs/product-brief-vz.md`). |
| 4 | **Submit příprava / portály** | Nula integrace NEN/Tenderarena/E-ZAK. Fáze `odeslana` je jen ruční změna stavu; `/finalize` nabídku pouze zamkne. | Největší kus lidského času (odhad z trhu 50–70 % úspory), ale i největší riziko — blokováno právně (§211/7 fikce podpisu dovoluje automatizaci, ale finální klik musí zůstat na člověku) a technicky (computer-use maturity). |

## Provozní předpoklady (bez nich se pilíře nepostaví bezpečně)

- **Perzistentní job fronta** místo dnešní in-memory jednoslotové (`serve-api.ts:191-274`) — jeden zaseknutý krok dnes blokuje pipeline pro všechny zakázky, restart/deploy smaže historii jobů a osiří běžící child procesy. Přesně tohle byl noční P0 bug (viz `docs/night-report-2026-07-09.md`).
- **Observabilita nákladů** — `cost-tracker` dnes loguje jen per-tender JSON, bez agregace, bez měsíčního stropu, bez alertingu. Při desítkách CN/den nutná kontrola AI/infra spend.
- **Bulk operátorský UX** — `ZakazkyPage` nemá checkbox-select ani bulk akce, `ProductMatchView` nemá „potvrdit vše", `/api/tenders` nemá stránkování a dělá N+1 dotazy na analýzu/cost. Bez toho operátor nezvládne desítky zakázek denně i kdyby zbytek fungoval.

---

## Fáze

### Fáze 0 — dnešní noc (2026-07-09)

Hotovo: P0 fix pipeline stability (watchdog timeout + truncation), robustní ZIP/vnořený ingest, win-price prototyp datové vrstvy, sjednocení design systému legacy komponent na tokeny. Detaily a stav ověření: **[doplní se: E2E výsledky]**.

### Fáze 1 (S–M, ~2–4 týdny): Monitoring feed + go/no-go základ

**Cíl:** nahradit ruční upload automatickým vstupem a přidat první číselné skóre.

1. Ingest z **Hlídač státu API v2** (token) jako primární feed → tabulka `tenders_feed`, doplnit TED API v3 pro nadlimitní. Pracnost M. Závislost: Hlídač token, rozhodnutí o komerční licenci.
2. CPV/NIPEZ filtr + jednoduché go/no-go scoring (fit s katalogem, ekonomika, kvalifikační proveditelnost) → do CRM jen relevantní zakázky se skóre. Pracnost M.
3. Auto-stažení zadávací dokumentace k relevantním zakázkám, napojení na stávající extract→analyze pipeline. Pracnost S.
4. Vyřešit komerční licenci Hlídače (poptat cenu) nebo zavést citační režim. Pracnost S (rozhodnutí), ale blokující pro #1.

**Metrika hotovosti:** nová relevantní zakázka se objeví v CRM se stavem `relevantni` a staženou dokumentací bez jediného ručního uploadu; skóre viditelné v UI.

### Fáze 1b (M, paralelně s Fází 1): Provozní předpoklady

5. Perzistentní + paralelní fronta (Postgres-backed, N workerů, retry/backoff, přežití restartu) místo in-memory seriálové. Pracnost M. Nutná podmínka hromadného provozu.
6. Observabilita nákladů — agregace cost-tracker napříč zakázkami, měsíční spend, strop + alerting. Pracnost S–M.
7. Konfigurovatelný cenový strop per-zakázka (dnes hardcoded 39 999 Kč v `submit-gate.ts`) + margin floor guardrail. Pracnost S — levná rychlá pojistka, dá se udělat kdykoli nezávisle.
8. **Obnova cenového skladu jako kurátorovaná win-price/katalogová DB s prahy relevance.** Dnešní sklad (2026-07-09) obsahuje jen stale 3D-tisk sortiment a byl defaultně vypnutý (`WAREHOUSE_MATCH_ENABLED`, viz noční fix PR #22) poté, co u reálné zakázky nabízel filamenty jako "match" na nesouvisející položky přes příliš nízký práh podobnosti (0.08). Než se sklad znovu zapne pro víc komodit, potřebuje: (a) kurátorovaný re-import napříč komoditami (ne jen 3D tisk), (b) přísné prahy podobnosti kalibrované na reálných datech (dnešní nouzový fix 0.35/0.75 je konzervativní výchozí bod, ne finální kalibrace), (c) koncepčně sladit s win-price databází (Fáze 2) — obě jsou v podstatě "historická cenová inteligence", jen jeden zdroj je nákupní ceny ze skladu/scraperů a druhý vítězné ceny z veřejných zakázek; stojí za úvahu sjednotit datový model. Pracnost M. Bez tohoto kroku zůstává match-product omezen na čisté AI hledání bez cenového srovnání proti vlastnímu katalogu.

**Metrika hotovosti:** deploy/restart nepřeruší rozpracovaný job; měsíční AI/infra náklad viditelný na jednom místě; libovolná zakázka má vlastní cenový strop bez zásahu do kódu; sklad se zapíná per-komodita s ověřenou přesností matchování (ne plošně jako dřív).

### Fáze 2 (L, navazuje na Fázi 0 prototyp): Win-price databáze do produkce

8. Dotáhnout prototyp (`docs/win-price-design.md` §7) na produkční kvalitu: backfill víceleté historie, počet uchazečů z VVZ/ISVZ award notice (párování přes IČO + evidenční číslo), AI kategorizace na CPV/NIPEZ místo klíčových slov, čištění dat (outliery, chybné roky), GDPR režim mazání znepřístupněných záznamů.
9. AI extrakce položkových cen z PDF příloh smluv → jednotkové ceny HW, ne jen celkové částky smlouvy.
10. API endpoint nad `findSimilarWins` + CRM panel „Historické vítězné ceny" u zakázky.

**Metrika hotovosti:** u libovolné zakázky operátor vidí cenové pásmo z historie s důvěryhodným zdrojem (ne jen trigram fuzzy match) do 2 s odezvy.

### Fáze 3 (M, závisí na Fázi 2): Nacenění řízené historií

11. Do `match-product`/`verify-prices` přidat win-price signál jako návrhové pole (analogicky k `overeni_ceny` — nikdy nepřepisuje `cenova_uprava` přímo).
12. Marže vs. win-probability trade-off panel pro člověka — vizualizace, kde v historickém pásmu naše cena leží.
13. Rozšířit go/no-go scoring o win-probability váhu (z Fáze 1 bodu 2).

**Metrika hotovosti:** cenová kalkulace u zakázky ukazuje doporučenou nabídkovou cenu s odhadem pravděpodobnosti výhry, člověk potvrzuje.

### Fáze 4 (L, právně nejcitlivější): Generování + příprava podání

14. Dotáhnout generování všech podatelných dokumentů na 100% reliabilitu (dnešní miss rate šablon 30–40 %, hybrid fill + review UI).
15. Příprava podání do NEN (§211/7 fikce podpisu): sestavit balík, poloautomat nejdřív (systém připraví, člověk podá ručně přes NEN), pak asistované podání přes computer-use dry-run. Nutná právní konzultace k modelu přístupu (účet NEN, zmocnění).
16. Bulk operátorský UX: checkbox-select + bulk akce na `ZakazkyPage`, „potvrdit vše" v `ProductMatchView`, server-side pagination na `/api/tenders`, zrušení N+1.

**Metrika hotovosti:** operátor dokáže za den zpracovat desítky zakázek od go/no-go po „připraveno k odeslání" bez blokujících ručních kroků kromě samotného odeslání.

---

## Kritická cesta a pořadí

**Money-path:** Fáze 1 → 1b (paralelně) → 2 → 3. Monitoring bez fronty a bez nákladové kontroly je riskantní; win-price bez produkční kvality dat je nedůvěryhodné; nacenění bez fungujícího go/no-go scoringu plýtvá kapacitou na špatné zakázky.

**Fáze 4 (submit) je největší úspora lidského času, ale i nejpomalejší** — blokovaná právní konzultací a computer-use maturitou. Nezačínat, dokud Fáze 1–3 neběží stabilně na produkci.

**Rychlé levné pojistky, dělat kdykoliv paralelně:** bod 6 (observabilita nákladů) a bod 7 (konfigurovatelný cenový strop) — nezávisí na ničem, nízké riziko, chrání ekonomiku provozu.

**Sanace mimo money-path** (nezvyšuje přímo zisk, ale snižuje riziko chyb): root `CLAUDE.md` refresh na reálný stack (**hotovo v této worktree** — viz aktuální verze v repu), verzování DB schématu do migrací (z velké části hotovo přes `scripts/migrations/`), odstranění mrtvého kódu (`TenderList.tsx`, `TenderDetail.tsx`, `ValidationReport.tsx`, orphaned `RegistraceFirmyPage`).
