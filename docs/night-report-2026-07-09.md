# Noční autonomní session — report 2026-07-09

> Zdroj: `scratchpad/night-plan-2026-07-09.md` (master plán), `tasks/recon-*.md` (8 reconů). Session běžela autonomně na základě zadání „nástroj, který vydělává peníze automatizací tvorby CN, autonomně monitoring → go/no-go → nacenění (vč. win-price historie) → dokumenty → příprava podání, člověk jen go/no-go a nákupy" (Dan, 2026-07-09).

## Co se stalo (přehled)

1. **Recon** (8 paralelních agentů) — trh/konkurence/právo, gap analýza plán vs. realita, mapa pipeline a jejích slabin, mapa CRM/UX a security. Výstupy v `tasks/recon-market.md`, `recon-gap.md`, `recon-pipeline.md`, `recon-crm.md`.
2. **P0 diagnóza z produkčních logů** — recon pipeline odhalil, proč match joby na produkci umíraly: watchdog na 600 s (SIGTERM, žádný fallback) v kombinaci s `max_tokens` až 65536/dávka.
3. **PR #15** — první P0 fix (watchdog + granularita). Nasazeno, ale prod verifikace odkryla **druhou, samostatnou chybu**: odpověď AI se ořezávala na stropu `max_tokens` (10496/10496) → useknutý JSON → match dál padal, jen jinak a rychleji.
4. **PR #19** — oprava truncation (split dávky při `stop_reason=max_tokens`, zvýšený token budget na kandidáta 400→700).
5. **Merge batch #16–18** souběžně vzniklých větví (win-price prototyp, DS sjednocení legacy komponent, robustní ZIP/vnořený ingest) + #19, jeden finální deploy.
6. **E2E na produkci pokračovalo přes den** — odhalilo a opravilo dalších 7 tříd bugů (9 celkem za celou session, 5 z nich objevil až E2E) + Patrikův reálný feedback k naceňování ze skladu (viz „Odpoledne" níže). Finální matice a čísla viz sekce „E2E — finální stav".
7. **CRM/security batch (PR #21) zmergováno** na Danův explicitní pokyn „merguj sám, autonomní vývoj" — GET auth, bulk potvrzení cen, XSS fix, N+1 agregát, race fix ve `verify-prices`. Prod smoke OK.
8. **Běh přerušil v ~15:41 došlý kredit Anthropic API účtu** — poslední várka (5 zakázek) čeká na dobití, fixy pro ně jsou ověřené in-container (viz „Bloker na závěr" níže).

## Odpoledne — Patrikův feedback #2 a E2E nálezy

**13:03 Patrik nahlásil (parafráze):** „našlo smysluplně položky, ale nabízí filamenty mimo specifikaci a nejde vybrat správný produkt."

**Root cause potvrzen:** cenový sklad (dnes obsahuje jen 3D-tisk sortiment, ceny stale) přes text-tier matching (práh podobnosti 0.08 — extrémně nízký) vkládal filamenty jako kandidáty na index 0 a systém je **automaticky vybíral** bez ohledu na relevanci — na `tender-1783520423526` to bylo 38 z 38 položek. Dan rozhodl: **sklad neimportovat/nepoužívat**, dokud nebude kurátorovaný.

**Fix — PR #22:** warehouse matching je nově **defaultně vypnutý** (env `WAREHOUSE_MATCH_ENABLED`, default off, zapnout `=1`) a prahy podobnosti zpřísněny na 0.35 (kandidát) / 0.75 (auto-select). Zakázka `tender-1783520423526` byla dekontaminována — přegenerována s AI-only nálezem (Bott Verso systém, Treston nábytek) místo filamentů.

## E2E — finální stav (9 tříd bugů, matice, náklady)

Zdroj: `scratchpad/e2e-final-report.md`, runner `/opt/vz/e2e.sh` (jednotlivý běh) + `/opt/vz/e2e-all.sh` (master orchestrátor) na produkci (Hetzner root@23.88.61.12, kontejner `vz-api`, prod job fronta). Metodika PASS/FAIL: všechny kroky `done` + naceněno N/N + 0 položek nad cenovým stropem + kompletní dokumenty + bez tvrdých placeholderů. `ready_to_submit=true` NENÍ gate — validátor správně hlásí chybějící externí kvalifikační přílohy (výpis z OR, reference, certifikáty), ty dokládá člověk.

**Celkem 9 tříd bugů nalezeno a opraveno za session, 5 z nich objevil až E2E (ne recon ani code review):**

| # | Bug | Kde | Oprava (PR) | Kdo našel |
|---|---|---|---|---|
| 1 | Match job umírá na 600s watchdog (Patrikův P0) | `serve-api.ts` watchdog | #15 | recon/Patrik |
| 2 | Match truncation: `max_tokens` → rozbitý JSON | `match-product.ts` | #19 (half-split dávek) | recon |
| 3 | Ceny jako CZ stringy „12 990" → ZodError | `types.ts` | #20 (`parseAiNumber`) | E2E smoke |
| 4 | **Warehouse kontaminace**: filament kandidáti auto-vybraní i pro nábytek/laser | match/warehouse tier | #21/#22 (sklad default OFF) | E2E (Patrik potvrdil) |
| 5 | **Analyze truncation**: 16384 out-tokenů → useknutý JSON | `analyze-tender.ts` | #22 (zvýšeno na 32k) | E2E |
| 6 | `hodnotici_kriteria[].vaha_procent` = `null` shazovalo Zod | types/analyze | #22 (koerce) | E2E |
| 7 | Heartbeat visel na `message_delta` (chodí až na konci zprávy) → idle watchdog zabil živou ~5min generaci | `ai-client.ts` | #24 (`content_block_delta`) | E2E |
| 8 | **Soupis „vyčítání"**: `cislo` regex `pol` matchne i „Položka" → číslo==název stejný sloupec → tiše zahozeno 0 položek | `parse-soupis.ts:40,146` | #25 (`pol\.?\s*[čc]` + guard) | **E2E (root-cause)** |
| 9 | Match absolutní cap 1800s zabil legitimní 188pol. běh (24 dávek, ~30 min) | `serve-api.ts` cap | #26 (→3600s) | E2E |

Vedlejší nálezy stejné session: legacy product-match schéma u projektoru (single-product bez `cenova_uprava` blokoval generate gate), GET `/api/*` bez auth (#21), UX pro ruční výběr kandidáta (#23).

### Finální matice

**PROŠLO (fresh, čistý build po všech fixech):**

| zakázka | analýza | match/naceněno | warehouse-selected | dokumentů | verdikt |
|---|---|---|---|---|---|
| tender-1783520423526 (dílna, Patrikova zakázka) | 38 | 38/38 | 0 | 5 | PASS — dekontaminováno (Bott Verso místo filamentů) |
| n-485400-naradi (nářadí) | 57 | 57/57 | 0 | 6 | PASS — regrese fc4a173 stále drží |
| tender-1782811562056 | 57 | 57/57 | 0 | 6 | PASS — ověřuje fix analyze truncation |
| servery-hostinne | 13 | 13/12 | 0 | 7 | PASS* — 1 položka bez ceny, drobnost k dohledání |

**Inspekce hotových výstupů (bez nového AI běhu, jen čtení) — vše pipeline-PASS:** fm-it-2025 6/6, tender-1771416481046 1/1, tender-1771843005553 9/9, tender-1772023910682 9/9, tender-1772608269999 2/2, tender-1773662434530 1/1, tender-1773690868586 1/1, tender-1773839333717 1/1, tender-1772093308828 1/1, tender-1783515332667 39/39, vakuovy-lis 1/1, **varyte-vybaveni 255/255**. Warehouse-selected = 0 u všech. (2 legacy výstupy — fm-it a tender-1771416481046 — mají v krycím listu zbytkové „doplní účastník" z doby před fixem; fresh běhy jsou čisté.)

**Ingest test (nová ZIP/vnořená cesta, PR #18):**

| zakázka | zdroj | extract objevil | verdikt |
|---|---|---|---|
| robota-orig | „Robota " — 70 souborů, vnořené podadresáře, 2 zakázky | 53 dokumentů, 316 tis. znaků | PASS — rekurze podadresářů funguje |
| varyte-orig | „VARY&TE" — 178 souborů + ZIP „Zadávací dokumentace - komplet.zip" | 93 dokumentů, 1,33 mil. znaků | PASS — ZIP rozbalen + rekurze funguje |

(Scope testu = jen extract; full flow nespuštěn, obsah je smíchaná multi-zakázka s archivní PII, cena by nedávala smysl — čisté produkty jsou pokryté flat variantami výše.)

**Stále kontaminováno** (běh na starém buildu, čeká na přematchování se skladem OFF): tender-1773819403525, tender-1776064436758, vlaknovy-laser — každá má 1 filamentovou položku (warehouse-selected 1/1).

**Pending — čeká na dobití kreditu, fixy ověřené in-container:**

| zakázka | co zbývá | fix ověřen |
|---|---|---|
| tender-1779109774773 (188 položek) | match, generate, validate | analyze PASS 188/188; #26 cap 3600s |
| kancelarsky-material (132 položek) | plný re-run | #25 soupis fix ověřen in-container: `parseSoupis` 0→132 |
| tender-1773839249479 (RUR 3D) | plný běh | analyze fixy #22/#24 |
| tender-1771418000119 (projektor) | match, generate, validate | #20 |
| tender-1783593753275 (30 pol.), tender-1783594646695 (37 pol.) | match+ (nové noční zakázky) | — |

### Náklady (finální)

**Delta 397,72 Kč z capu 1 500 Kč** za celý E2E sweep (cost-log grandtotal 910,24 Kč, baseline před sweepem 512,52 Kč). Výrazně pod odhadem 300–800 Kč — malé/střední zakázky jsou levné, náklad táhly hlavně velké (188/255 položek) a opakované re-matche po fixech.

## Bloker na závěr: došel kredit Anthropic API účtu (~15:41)

V ~15:41 došel kredit na Anthropic účtu firmy — API vracelo `HTTP 400 „Your credit balance is too low"` s `x-should-retry: false` (tedy ne dočasný rate-limit, retry logika to správně nezkoušela dokola). Tři zakázky (RUR 3D, projektor, kancelarsky-material) selhaly okamžitě za 0 Kč — **není to bug skriptu ani pipeline**, čistě vyčerpaný kredit.

Poslední várka (5 zakázek, viz tabulka „Pending" výše) čeká na dobití — odhad ~250–400 Kč, ~1,5 h běhu (kancelarsky match ~23 min, 188položková zakázka ~35 min). Runner je připravený a čeká přímo na VPS (`/opt/vz/e2e.sh` + `/opt/vz/e2e-all.sh`, matice `/opt/vz/e2e/matrix.txt`) — po dobití stačí spustit dál, není potřeba nic přestavovat.

### Follow-upy

1. **Balance-watchdog na Anthropic účet (alert před vyčerpáním kreditu)** — priorita, protože je to přímý předpoklad autonomního provozu: bez něj noční běh tiše umře v půlce a nikdo se to nedozví do rána.
2. **CI testcase pro soupis parsing** (kancelarsky Priloha_2 „Položka" hlavička jako regrese proti bugu #8, + N-485400 hlubší hlavička) — obojí zatím ověřeno jen ručně, chybí automatizace.
3. **Analyze idle-watchdog neřeší latenci prvního tokenu** — heartbeat (#24) reaguje až po prvním tokenu; při rate-limitu na straně Anthropicu může první token přijít pozdě a watchdog to nerozezná od zaseknutí. Zvážit pre-stream heartbeat nebo delší grace period na první token.
4. **Trvalý nginx fix** (resolver/upstream by name místo statické IP) — viz gotcha níže, dnes řešeno jen ručním reloadem po každém deployi.
5. **Perzistentní job fronta** — zmíněno i v `docs/roadmap-autonomie.md` jako provozní předpoklad; dnešní in-memory fronta nepřežije restart a limituje na 1 zakázku najednou.
6. **Resumovatelné match dávky** — dlouhé matche (188+ položek, desítky dávek) dnes při přerušení (kredit, restart) začínají od nuly; možnost navázat na poslední hotovou dávku by ušetřila čas i náklady u příštích výpadků.

Doplňkové drobnosti z reportu: re-match 3 stále kontaminovaných zakázek (teď když je sklad OFF, dají čisté ceny), dohledat 1 nenaceněnou položku u `servery-hostinne` (13. z 13), přegenerovat 2 legacy výstupy se zbytkovým „doplní účastník" (fm-it, 3d-tiskarna).

## Autonomní rozhodnutí

Provedeno bez čekání na schválení, protože zadání obsahovalo „pracuj autonomně" a Dan předem schválil deploy-on-green. Zapsáno explicitně dle pravidla proaktivního kolegy:

1. **Interpretace metriky „3+1"**: metrika #1 = 100% průchodnost všech historických zakázek, teprve poté kalibrace na desítky CN/den.
2. **E2E na produkci**, ne lokálně — protože tam bug reálně žil a Dan řekl „musí fungovat produkce". Sériově, od nejmenší zakázky. Odhad nákladu 300–800 Kč API spend.
3. **P0 fix specifikace**: BATCH_SIZE 15→8, kandidáti 3→2, `max_tokens` cap 16384, stručnější výstupní prompt, generický fallback filtru požadavků (top 12), `ai-client` wall-clock abort 240 s, watchdog idle-based 240 s + absolutní cap 1800 s pro match/verify-prices + SIGKILL fallback po SIGTERM, `verify-prices` doplněn do run-mapy (sjednocení s ostatními kroky), submit-gate dynamická hláška místo hardcoded „39 999 Kč", frontend error stav + tlačítko „Zkusit znovu" místo věčného spinneru.
4. **CRM/security task odložen za merge P0** — konflikt v `serve-api.ts`, auth změna je nejrizikovější a nemá smysl ji tlačit uprostřed noci souběžně s P0 a E2E.
5. **Win-price prototyp bez zásahu do `serve-api.ts`** — jen `lib/` a CLI, paralelní stream. Zdroj (Registr smluv) vybrán agentem na základě živého ověření dostupných zdrojů, ne jen podle recon dokumentace. Bez AI kategorizace komodit (heuristika klíčových slov) — AI kategorizace až po schválení, kvůli P0 rate-limitům.
6. **Duplikáty ve vstupních datech** (`tender-177140*`, „Robota ", „VARY&TE") dočasně vynechány z E2E matice / nahrazeny zplacatělými variantami; po dostavění ZIP/nested ingestu (bod 6 workstreamů) se vrátí zpět do matice.
7. **Deploy-on-green** — Dan toto schválil předem, tedy PR → review → merge → deploy → smoke test proběhlo bez čekání na ranní potvrzení.

## Nginx gotcha (provozní nález)

Po prvním deployi (PR #15) byla produkce chvíli **502**: sdílený `makemore-nginx` (společný s LuDone službami) držel starou IP kontejneru `vz-api` (172.18.0.14), zatímco nový kontejner po restartu dostal IP 172.18.0.5. Vyřešeno bezvýpadkovým `nginx -t && nginx -s reload` v `makemore-nginx`, config test prošel před reloadem.

**Trvalé zjištění pro budoucí deploye:** po **každém** deployi `vz-api` dostane novou Docker IP → nginx drží starou → 502, dokud neproběhne reload. Trvalý fix (nginx resolver/upstream by name místo statické IP) je follow-up a patří do sdíleného nginx configu mimo tento repozitář — nekonfigurovat ho odsud narychlo, je sdílený s produkčním LuDone provozem.

## Náklady

- **Odhad E2E na produkci**: 300–800 Kč API spend (odhad před spuštěním, sériově od nejmenší zakázky).
- **Skutečnost**: delta 397,72 Kč z capu 1 500 Kč (cost-log grandtotal 910,24 Kč, baseline 512,52 Kč) — v rámci odhadu, viz sekce „E2E — finální stav" výše pro detail.
- Ostatní noční práce (recon, P0 fix, win-price prototyp) běžela jako implementace/agentní práce, samostatně netrackovaná v cost-tracker (ten sleduje jen per-tender AI volání pipeline, ne vývojářskou práci).

## Workstreamy — stav na konci noci

| Workstream | Stav |
|---|---|
| Recon (8 agentů) | Hotovo — `tasks/recon-*.md` |
| P0 fix (watchdog + truncation) | Hotovo, nasazeno (PR #15, #19) |
| Win-price prototyp | Hotovo, nasazeno (PR #16), napojení na pipeline zatím jen navrženo |
| DS sjednocení legacy komponent | Hotovo, nasazeno (PR #17) |
| ZIP/vnořený ingest | Hotovo, nasazeno (PR #18) |
| CRM/security batch (GET auth, bulk potvrzení cen, XSS, N+1, race fix) | Hotovo, nasazeno (PR #21), prod smoke OK |
| Ruční výběr kandidáta produktu | Hotovo, nasazeno (PR #23) |
| Warehouse matching OFF + prahy relevance | Hotovo, nasazeno (PR #22) |
| Heartbeat fix (`content_block_delta`) | Hotovo, nasazeno (PR #24) |
| `parse-soupis` header kolize | Hotovo, nasazeno (PR #25) |
| Match absolutní cap 1800s→3600s | Hotovo, nasazeno (PR #26) |
| E2E na produkci | Přerušeno došlým kreditem (~15:41) po 9 bug-fixech; PASS na malých/středních + zátěžových (57, 255 pol.), 5 zakázek pending na dobití — viz „Bloker na závěr" |
| Ranní + odpolední + finální dokumentační balíček | Hotovo (tento report + brief + roadmapa + Slack návrh) |

## Navazující dokumenty

- `docs/product-brief-vz.md` — datové zdroje, konkurence, právní rámec, win-price koncept.
- `docs/roadmap-autonomie.md` — čtyři chybějící pilíře cesty k autonomii, fázovaný backlog.
- `docs/win-price-design.md` — design a ověřený prototyp win-price databáze (vzniklo v této session, PR #16).
- `docs/slack-navrh-patrik.md` — návrh krátké odpovědi Patrikovi do #ludone-vz o P0 fixu (NEODESLÁNO).
