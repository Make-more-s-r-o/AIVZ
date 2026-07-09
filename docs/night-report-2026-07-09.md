# Noční autonomní session — report 2026-07-09

> Zdroj: `scratchpad/night-plan-2026-07-09.md` (master plán), `tasks/recon-*.md` (8 reconů). Session běžela autonomně na základě zadání „nástroj, který vydělává peníze automatizací tvorby CN, autonomně monitoring → go/no-go → nacenění (vč. win-price historie) → dokumenty → příprava podání, člověk jen go/no-go a nákupy" (Dan, 2026-07-09).

## Co se stalo (přehled)

1. **Recon** (8 paralelních agentů) — trh/konkurence/právo, gap analýza plán vs. realita, mapa pipeline a jejích slabin, mapa CRM/UX a security. Výstupy v `tasks/recon-market.md`, `recon-gap.md`, `recon-pipeline.md`, `recon-crm.md`.
2. **P0 diagnóza z produkčních logů** — recon pipeline odhalil, proč match joby na produkci umíraly: watchdog na 600 s (SIGTERM, žádný fallback) v kombinaci s `max_tokens` až 65536/dávka.
3. **PR #15** — první P0 fix (watchdog + granularita). Nasazeno, ale prod verifikace odkryla **druhou, samostatnou chybu**: odpověď AI se ořezávala na stropu `max_tokens` (10496/10496) → useknutý JSON → match dál padal, jen jinak a rychleji.
4. **PR #19** — oprava truncation (split dávky při `stop_reason=max_tokens`, zvýšený token budget na kandidáta 400→700).
5. **Merge batch #16–18** souběžně vzniklých větví (win-price prototyp, DS sjednocení legacy komponent, robustní ZIP/vnořený ingest) + #19, jeden finální deploy.
6. **[doplní se: E2E výsledky]** — průchodnost historických zakázek na produkci po deployi.
7. **[doplní se: CRM/security batch stav]** — auth/bulk UX práce odložena na ranní review (nejrizikovější změna, nemergovat uprostřed noci ani do rozjeté E2E).

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
| E2E na produkci | **[doplní se: E2E výsledky]** |
| CRM/security batch (auth, bulk UX) | **[doplní se: CRM/security batch stav]** — odloženo na ranní review |
| Ranní dokumentační balíček (tento report + brief + roadmapa + Slack návrh) | Hotovo |

## Navazující dokumenty

- `docs/product-brief-vz.md` — datové zdroje, konkurence, právní rámec, win-price koncept.
- `docs/roadmap-autonomie.md` — čtyři chybějící pilíře cesty k autonomii, fázovaný backlog.
- `docs/win-price-design.md` — design a ověřený prototyp win-price databáze (vzniklo v této session, PR #16).
- `docs/slack-navrh-patrik.md` — návrh krátké odpovědi Patrikovi do #ludone-vz o P0 fixu (NEODESLÁNO).
