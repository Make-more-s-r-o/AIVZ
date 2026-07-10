# Audit projektu VZ vůči cíli „autonomní stroj na peníze" — 2026-07-10

**Celkové hodnocení: ~30 % cesty k cíli.** Rozpad: „továrna na dokumenty" (upload → analýza → nacenění → podatelné DOCX) je hotová z ~75 % a reálně funguje. „Stroj na peníze" (monitoring → go/no-go → výherní cena s marží → podání → feedback výher) je hotový z ~12 % — chybí prakticky celý.

Audit provedlo 6 nezávislých Opus auditorů (evidence-based, prod SSH + kód + reálné dokumenty), syntéza Fable. Měřítko = Danův cíl: *nástroj, který vydělává peníze automatizací CN a maximalizuje výhry; člověk jen schvaluje go/no-go a nákupy; desítky kvalitních CN denně.*

## Skóre dimenzí

| Dimenze | Skóre | Jedna věta |
|---|---|---|
| Průchodnost pipeline | **47 %** | 22/25 zakázek má kompletní výstupy, ale sweep vyžadoval 12 fixů za běhu; 1 zakázka deterministicky rozbitá; in-memory 1-slot fronta je strop pro „desítky denně". |
| Kvalita výstupů | **40 %** | Dokumenty mechanicky výborné (DPH 153/153 řádků správně, IČO/DIČ kompletní) — ale cenová vrstva je proti cíli (marže 0 %, nekotvené odhady, 280k chyba v závazném soupisu). |
| Operátorský UX | **40 %** | Detail zakázky CRM-grade + nové bulk/výběr/error prvky; chybí run-all, schvalovací inbox, hromadné akce — „desítky denně" neutáhne. |
| Provozní zralost | **22 %** | DB bez zálohy, žádné alerty (kredit došel tiše), JWT v nginx lozích, deploy zabíjí joby; kladně: auth/RBAC základ. |
| Business připravenost | **17 %** | Unit-ekonomika skvělá (7–327 Kč/CN), právní cesta ověřena (§211/7) — ale 0 podaných nabídek, win_prices na prod 0 řádků, žádný win-rate feedback. |
| Autonomie | **15 %** | Monitoring neexistuje (ruční upload), go/no-go jen textový string, submit 0, billing watchdog 0. |

## Tři nejtvrdší nálezy

### 1. Validátor je divadlo — nečte dokumenty
`validate-bid.ts:51–134` dostává jen `analysis` + `product-match` + **názvy souborů** — vygenerované DOCX nikdy neotevře. Jeho nálezy „chybí IČO/DIČ" a „Výpočet DPH 21 % fail" jsou halucinace: audit dokumenty programaticky přepočítal — DPH správně 57/57 i 96/96 řádků, identifikace kompletní. Důsledek oběma směry: falešné faily podkopávají důvěru A skutečné vady (viz nález 2) validátor principiálně nemůže chytit. Včerejší E2E „PASS" měřil průchodnost (každý řádek má cenu), ne smysluplnost (ceny dávají smysl) — to je kalibrace, kterou je fér přiznat.

### 2. Cenová vrstva je v přímém rozporu s cílem „vydělávat"
- **Marže = 0 % u každé položky** (`match-product.ts:723`, `default_marze_procent || 0`): nabídková cena == „nákupní" cena, která je sama maloobchodní AI odhad. Výhra = nulový až záporný zisk.
- **Katastrofická chyba prošla do závazných dokumentů**: „Rázová redukce 3/4×1/2" (adaptér ~200 Kč) naceněna jako „kompletní sada nářadí" **280 000 Kč/ks × 5 = 1,4 M Kč = 78 % celého bidu** n-485400. Prošlo s `cena_spolehlivost: nizka` — a `potvrzeno: true` stamplo E2E (`e2e.sh` auto-confirm obešel lidský money gate; vlastní testovací nástroj vyrobil falešnou zelenou).
- **Win-price DB na prod má 0 řádků** (import běžel jen lokálně) a má 0 referencí v serve-api — deklarované jádro konkurenční výhody je v produkci neoperační.
- Spolehlivost cen: u dílny 0 % „vysoká" / 47 % „nízká"; web-search verify je jen návrhové pole.

### 3. Autonomní smyčka a feedback neexistují
Monitoring nových VZ: 0 řádků kódu (ingest = ruční upload). Go/no-go: textové ANO/NE/ZVÁŽIT bez skóre a ekonomiky. Podání: 0 integrace. Výsledky: žádná tabulka outcomes, **0 podaných nabídek** (CRM: žádná zakázka ve stavu `odeslana`), takže win-rate nelze ani začít měřit. Provozně: 1-slot in-memory fronta (restart = ztráta), žádný billing/health alert — včerejší vyčerpání kreditu prod tiše položilo.

## Co reálně funguje (podklad těch ~30 %)
- E2E průchodnost 21/22 historických zakázek (132/132, 57/57×2, 255/255, ZIP ingest) po 12 opravených třídách bugů — každý fix ověřen reálným prod během.
- Dokumenty mechanicky správné a kompletní (krycí list, cenová nabídka, tech. návrh, soupis fill, smlouvy .doc→.docx).
- CRM vrstva (stavy, úkoly, termíny, notifikace, štítky) + nové operátorské prvky (bulk potvrzení, výběr kandidáta, error stavy s retry).
- Unit-ekonomika: 7–327 Kč AI nákladů na CN — zanedbatelné vůči hodnotě zakázky.
- Právní cesta podání ověřena (§211/7 ZZVZ fikce podpisu).
- Win-price prototyp technicky funguje (51k smluv lokálně, dotazy na mediány) — „jen" není nasazen a napojen.

## Priority (nejkratší cesta k hodnotě)

**P0 — tento týden (bez nich je každá vygenerovaná nabídka rizikem):**
1. **Price sanity gate**: deterministické kontroly ceny (vs. per-item strop, vs. typ položky, řádové odchylky, podíl na bidu) + `potvrzeno` výhradně člověkem (odstranit auto-confirm z e2e.sh).
2. **Marže**: konfigurace per firma/kategorie + promítnutí do cen (dnes natvrdo 0).
3. **Validátor**: buď číst reálné DOCX, nebo přeznačit v UI na „AI advisory" (neprodávat jako validaci).
4. **Záloha vz-postgres** (jediná kopie všech CRM dat) + **billing/health alert** (Uptime Kuma na hostu už běží pro LuDone).
5. Dojet 188pol. zakázku (izolace vadné položky + partial-persistence dávek — fail nesmí zahodit 47 min práce).

**P1 — 2–3 týdny (start money-jádra):**
6. Win-price: import na prod, čištění outlierů, napojení pásma do Ocenění (informativní chip „historicky vyhrávalo X–Y").
7. Monitoring feed (Hlídač státu API) → inbox nových zakázek + go/no-go číselné skóre.
8. Run-all chaining + persistentní fronta; schvalovací inbox pro operátora.

**P2 — měsíc+:**
9. Feedback loop výsledků (tabulka outcomes, win-rate, ROI per zakázka).
10. Submit příprava (NEN/E-ZAK), paralelní zpracování, resumovatelné match dávky.

## Metodika
6 paralelních auditorů (Opus, přísný prompt „hodnoť vůči cíli, ne vůči včerejšku, vše podlož důkazem"), přístup: kód na main (PRs #15–#28), prod SSH read-only (vč. rozbalení a přepočtu reálných DOCX), e2e-final-report, cost-logy, DB dotazy. Detailní reporty per dimenze: session scratchpad `tasks/audit-*.md`. Syntéza a váhy: Fable (průchodnost 25 %, kvalita 20 %, autonomie 20 %, business 15 %, UX 10 %, provoz 10 % → vážený průměr ~32 %, zaokrouhleno na ~30 %).
