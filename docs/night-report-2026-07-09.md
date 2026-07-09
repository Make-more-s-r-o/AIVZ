# Noční autonomní session — report 2026-07-09

> Zdroj: `scratchpad/night-plan-2026-07-09.md` (master plán), `tasks/recon-*.md` (8 reconů). Session běžela autonomně na základě zadání „nástroj, který vydělává peníze automatizací tvorby CN, autonomně monitoring → go/no-go → nacenění (vč. win-price historie) → dokumenty → příprava podání, člověk jen go/no-go a nákupy" (Dan, 2026-07-09).

## Co se stalo (přehled)

1. **Recon** (8 paralelních agentů) — trh/konkurence/právo, gap analýza plán vs. realita, mapa pipeline a jejích slabin, mapa CRM/UX a security. Výstupy v `tasks/recon-market.md`, `recon-gap.md`, `recon-pipeline.md`, `recon-crm.md`.
2. **P0 diagnóza z produkčních logů** — recon pipeline odhalil, proč match joby na produkci umíraly: watchdog na 600 s (SIGTERM, žádný fallback) v kombinaci s `max_tokens` až 65536/dávka.
3. **PR #15** — první P0 fix (watchdog + granularita). Nasazeno, ale prod verifikace odkryla **druhou, samostatnou chybu**: odpověď AI se ořezávala na stropu `max_tokens` (10496/10496) → useknutý JSON → match dál padal, jen jinak a rychleji.
4. **PR #19** — oprava truncation (split dávky při `stop_reason=max_tokens`, zvýšený token budget na kandidáta 400→700).
5. **Merge batch #16–18** souběžně vzniklých větví (win-price prototyp, DS sjednocení legacy komponent, robustní ZIP/vnořený ingest) + #19, jeden finální deploy.
6. **E2E na produkci pokračovalo přes den** — odhalilo a opravilo další 3 bugy (heartbeat na `message_delta`, `parse-soupis` header kolize, `vaha_procent` Zod pád) + Patrikův reálný feedback k naceňování ze skladu (viz „Odpoledne" níže). Finální tabulka: **[doplní se: finální E2E tabulka]**.
7. **CRM/security batch (PR #21) zmergováno** na Danův explicitní pokyn „merguj sám, autonomní vývoj" — GET auth, bulk potvrzení cen, XSS fix, N+1 agregát, race fix ve `verify-prices`. Prod smoke OK.

## Odpoledne — Patrikův feedback #2 a E2E nálezy

**13:03 Patrik nahlásil (parafráze):** „našlo smysluplně položky, ale nabízí filamenty mimo specifikaci a nejde vybrat správný produkt."

**Root cause potvrzen:** cenový sklad (dnes obsahuje jen 3D-tisk sortiment, ceny stale) přes text-tier matching (práh podobnosti 0.08 — extrémně nízký) vkládal filamenty jako kandidáty na index 0 a systém je **automaticky vybíral** bez ohledu na relevanci — na `tender-1783520423526` to bylo 38 z 38 položek. Dan rozhodl: **sklad neimportovat/nepoužívat**, dokud nebude kurátorovaný.

**Fix — PR #22:** warehouse matching je nově **defaultně vypnutý** (env `WAREHOUSE_MATCH_ENABLED`, default off, zapnout `=1`) a prahy podobnosti zpřísněny na 0.35 (kandidát) / 0.75 (auto-select). Zakázka `tender-1783520423526` byla dekontaminována — přegenerována s AI-only nálezem (Bott Verso systém, Treston nábytek) místo filamentů.

**Doplňkové fixy vzniklé z E2E matice, všechny opraveny a nasazeny:**

| PR | Bug | Dopad |
|---|---|---|
| **#23** | Chyběl ruční výběr kandidáta u položky | Nový endpoint `PUT product-match/select` + tlačítko „Vybrat tento produkt" v UI; přepnutí kandidáta smaže potvrzenou cenu (nutný re-confirm), aby se cena nesmontovala k jinému produktu. |
| **#24** | Heartbeat z PR #22 poslouchal jen `message_delta` (chodí až na konci celé zprávy) → idle watchdog zabíjel **živé** dlouhé generace analýzy jako by visely | Přepnuto na `content_block_delta` + průběžný odhad tokenů — watchdog nyní správně rozezná aktivní streaming od skutečného zaseknutí. |
| **#25** | `HEADER_PATTERNS.cislo` (holý vzor `pol`) matchoval i sloupec „Položka" → číslo a název položky se namapovaly na stejný sloupec → **tiše zahozeno všech 132 řádků** u `kancelarsky-material` | Zpřesněn regex; ověřeno 0/132 → 132/132, regresní test na N-485400 stále 57/57. |
| (součást #22) | `vaha_procent` s hodnotou `null` nebo textem „40 %" shazovalo Zod validaci | Schema tolerantnější k formátu vstupu z AI. |

**Stav E2E matice v době psaní:** 18+ zakázek PASS včetně zátěžových (57 a 255 položek). Finální dojezd běžel v době psaní (3× re-analýza vybraných zakázek, `kancelarsky-material` re-run po fixu #25, ZIP originály, projektor). **[doplní se: finální E2E tabulka]**

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
- **[doplní se: E2E výsledky]** — skutečně vynaložené náklady dle `cost-tracker` po doběhnutí testů.
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
| E2E na produkci | 18+ zakázek PASS, finální dojezd v běhu — **[doplní se: finální E2E tabulka]** |
| Ranní + odpolední dokumentační balíček | Hotovo (tento report + brief + roadmapa + Slack návrh) |

## Navazující dokumenty

- `docs/product-brief-vz.md` — datové zdroje, konkurence, právní rámec, win-price koncept.
- `docs/roadmap-autonomie.md` — čtyři chybějící pilíře cesty k autonomii, fázovaný backlog.
- `docs/win-price-design.md` — design a ověřený prototyp win-price databáze (vzniklo v této session, PR #16).
- `docs/slack-navrh-patrik.md` — návrh krátké odpovědi Patrikovi do #ludone-vz o P0 fixu (NEODESLÁNO).
