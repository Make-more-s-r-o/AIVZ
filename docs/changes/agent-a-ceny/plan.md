# Plán — agent-a-ceny (tier L)

status: draft
intent: ./intent.md
research: ../../research/ceny-provenience.md, ../../research/zdroje-zakazek.md

## Architecture Spine

Jedna věta drží celou změnu: **tvrzení bez důkazu nesmí projít dál.**
Platí to pro cenu (bez doloženého zdroje se nedostane do nabídky), pro ingest (neúplný vstup
nezezelená) i pro agenta (nelidská identita je v auditu odlišitelná a nesmí na peníze).

Technicky to znamená tři nosníky:
1. **Provenience jako datový typ**, ne volný text. Uzavřený výčet zdrojů, povinná URL/doklad,
   čas a cena v okamžiku zjištění. Vynuceno ve schématu, na zápisových endpointech a v bráně
   před generováním.
2. **Zdroj zakázek jako adaptér**, ne větvení v kódu. Obory a klíčová slova na jednom místě.
3. **Agent jako identita s rozpočtem**, ne sdílený token. Vlastní strop, odvolatelný za běhu,
   viditelný v historii.

## Etapy

| # | Etapa | Co vznikne | DoD — čím to ověřím | KDO |
|---|---|---|---|---|
| **E0** | Pojistky | PR workflow (test + tsc pro `scripts` i `apps/web`); baseline měření provenience | PR ukáže zelené checky; skript vypíše dnešní podíl doložených cen (očekáváno 0/978) | Codex |
| **E1** | Doložitelná cena | `PriceProvenance` v `types.ts`; producenti značí typ; `warehouse-matcher` čte `source_url`/`fetched_at`; `verify-prices` **do** `run-all`; brána v `price-confirmation` + `submit-gate` + `generate-bid`; migrace legacy na `odhad_modelu/informacni` | Sabotáž: cena bez provenience → `potvrzeno=true` selže; `generate` odmítne; legacy zakázka se dá číst, ne znovu vygenerovat | Codex impl. · **Opus review (money)** |
| **E2** | Zdroje a obory | `klicova_slova` naplněná; CPV z Hlídače uložené a použité v kategorizaci; Hlídač stránkuje; jeden verzovaný registr oborů místo tří seznamů; `SourceHealth` (partial/error ≠ prázdno) | Regrese: `N006/26/V00027380` se ve feedu objeví; chyba zdroje se pozná od nuly výsledků | Codex |
| **E3** | Kontrola úplnosti | Kontrakt `očekáváno/dostáno` per krok, uložený u zakázky, blokující další krok, viditelný v API i UI | Sabotáž: ingest s polovinou dokumentů → krok zčervená, ne „hotovo" | Codex |
| **E4** | Agentní identita | Odvolatelný klíč v DB (ne env), vlastní denní AI strop, `actor` v auditu, role bez money-path | Sabotáž: agentní klíč na `finalize`/`podano`/potvrzení ceny → 403; revokace bez redeploye funguje | Codex impl. · **Opus review (auth)** |
| **E5** | MCP server | `scripts/src/mcp/` na `/mcp`, sdílené service funkce s REST; nástroje: najdi/založ zakázku z URL, upload lístek, stav jobu, čti analýzu a položky, **navrhni cenu s proveniencí**; OpenAPI jako vedlejší produkt; `SKILL.md` pro Hermese | Hermes-like klient projde celou cestu na testovací zakázce a nesáhne na money-path | Codex impl. · **Opus review** |
| **E6** | Dělená zakázka | Ceny a stropy per část, tři smlouvy tři ceny, krycí list do formuláře zadavatele | Zakázka `n006-26-v00027380` vygeneruje tři různé ceny; překročení stropu hlásí | Codex |

DAG: `E0 → E1 → {E2, E3}` · `E1 → E4 → E5` · `E6` nezávisle po `E1`.
Hotspot `scripts/src/lib/types.ts` (E1, E3) a `serve-api.ts` (E1, E4, E5) — **nikdy dva joby naráz**.

## Hranice autonomie (co běh NESMÍ)

| Stopka | Co se udělá místo toho |
|---|---|
| Ostrý zápis peněz, potvrzení ceny za člověka | přeskočit, položka do „Čeká na tebe" |
| Flip killswitche ležícího OFF z dřívějška (`OFFERS_*`, `LUFAK_*`, položky v DAN-TODO) | nesahat, jen nabídnout v reportu |
| Rotace/čtení produkčních secretů | přeskočit; klíč agenta vzniká jen jako schéma, ne ostrá hodnota |
| Mazání dat, purge | přeskočit |
| Externí komunikace (Slack, e-mail) | přeskočit; report ráno |
| Napojení na oficiální NEN API (certifikáty, registrace) | mimo rozsah, do DAN-TODO |

Nasazení na produkci **je** předschválené (Danovo pravidlo): commit, PR, merge a deploy jedou samy
při zelených bránách. Migrace patří na obě DB před mergem.

## Rozhodnutí přijatá za zadavatele (vratná, k přehlasování ráno)

| D | Rozhodnutí | Proč |
|---|---|---|
| D1 | Obory: IT + dílenské vybavení/nářadí + nábytek. Seznam je konfigurace, ne kód. | Dan chtěl mimo IT; přesný výčet nechal na mně. Editovatelné bez zásahu do kódu. |
| D2 | Agent smí spouštět AI pipeline, ale s **vlastním denním stropem** odděleně od lidského, default konzervativní. | Bez pipeline by agent nedoručil nic; oddělený strop chrání rozpočet. |
| D3 | Jedna agentní identita na účel (ne sdílená), klíč v DB. | Odvolatelnost za běhu bez redeploye. |
| D4 | `/mcp` chráněné Bearer tokenem + rate limit; IP allowlist jako volba, ne default. | Dan nasazuje na veřejnou doménu; token + limit je minimum, VPN by blokovala Hermese. |
| D5 | Strop části: **varovat** hlasitě, blokovat až za konfiguračním přepínačem. | Tiché zablokování legitimní nabídky je horší než varování; strop bývá formulován různě (s/bez DPH). |
| D6 | Krycí list: přednostně vyplnit formulář zadavatele, vlastní builder jako fallback. | Vlastní dokument místo předepsaného formuláře je důvod k vyřazení. |

## Co běh NEDĚLÁ

E5 a E6 jdou na řadu jen pokud E0–E4 doběhnou zelené. Přepis `serve-api.ts` na routery ne.
Vlastní scraping e-shopů nad rámec doložení ceny ne.
