# Plán VZ AI Tool — exec shrnutí a navigace

> Dokument plánu, část 0/N. Stav k 2026-07-11 (skóre ~55 % cesty k cíli).
> Shrnuje a naviguje `01-business-model.md`, `02-roadmapa.md`, `03-implementacni-plan.md`.
> Kontrola úplnosti (§4) provedena proti reálnému kódu na `main`
> (`scripts/src/`, `scripts/migrations/001–017`, `scripts/tests/`, `apps/web/src/`).

---

## 1. Exec shrnutí pro majitele

### Příležitost

Český trh VZ = 993 mld. Kč/rok, ~40–45 tisíc podaných nabídek ročně jen ve formálním
režimu. Příprava jedné nabídky stojí dodavatele 40–80 hodin převážně mechanické práce;
průměr 2,8 nabídky na zakázku a ~48 % řízení s jediným uchazečem říká, že dodavatelé
nestíhají — konkurence v soutěžích je slabá. **Nikdo v ČR nedělá nacenění a generování
podatelné nabídky** (Tenderpool a spol. = jen monitoring, který stát navíc rozdává
zdarma přes zakazky.gov.cz). Naše mezera: end-to-end od monitoringu po podatelnou
nabídku s cenou ověřenou proti reálnému nákupu (web-verify) a historickým výhrám
(win-price z Registru smluv). Klíčové zjištění, které je zároveň moat: **čisté AI
odhady cen jsou ~42 % pod trhem (extrém 263 %)** — bez verify vrstvy nikdo nemůže
bezpečně generovat nabídkové ceny, my ji máme nasazenou. Unit-ekonomika: COGS < 500 Kč
na nabídku vs. hodnota 22–72 tis. Kč ušetřeného času.

### Kde jsme (Fáze 0, ~55 %)

Nasazeno na vz.ludone.cz: celá pipeline (extract→analyze→match→generate→validate,
E2E 100 % na historických zakázkách), price sanity gate (HARD, živě ověřen — halucinace
280 000 Kč zablokována HTTP 409), marže company default, win-price pásma (~10 000
záznamů), web-verify s HARD gatem proti prodeji pod nákupem, monitoring feed z NEN
(89 zakázek živě), go/no-go skóre, schvalovací inbox, submission cockpit (immutable
balík + evidence podání), approval-aware run-all, outcome vrstva (win-rate widget).

Poctivé limity: **0 reálně podaných nabídek** (win-rate = nezměřená teorie), podání je
manuální, verify u long-tail sortimentu ~0 % hit-rate, jediný zdroj feedu = křehký NEN
scrape, fronta 2 sloty, výsledky se nedohledávají automaticky.

### Kam jdeme (fáze 1–5)

1. **„První vyhraná koruna"** — 2–3 reálná podání přes celý flow, výsledky do systému.
2. **„Důvěryhodný poloautomat"** — verify hit-rate ≥ 70 %, operátor 5–10 nabídek/den.
3. **„Feedback smyčka"** — outcome watcher, kalibrace skóre daty, price-to-win P(win).
4. **„Škálování"** — ≥ 20 CN/den, 3+ zdroje feedu, worker fronta přežívající deploy.
5. **„Autonomie"** — asistované podání, auto-triáž, governance (kill-switch, limity);
   člověk jen go/no-go a nákupy.

Business model: **Model 0 (sami podáváme, příjem = marže z výher) jako motor kalibrace
prvních 6–12 měsíců**, souběžně tiered SaaS (Start 4 990 / Business 9 990 / Pro
19 990 Kč/měs [ODHAD]) od design partnerů, per-bid (1 990 Kč/CN) jako vstupní brána.
Pořadí záměrně: nejdřív vlastní výhra, pak prodej.

### Nejbližší milník

**M-GTM-1: první reálně podaná nabídka** (= výstup vlny A / fáze 1): ≥ 2 nabídky ve
stavu `odeslana` s evidencí podání, 0 formálních diskvalifikací, 100 % cen s reálným
nákupním zdrojem. Je to z ~70 % provoz, ne kód — **žádný další vývoj nenahradí první
podání**; bez něj jsou kalibrace, success fee i prodej akademické.

### Co potřebuje rozhodnout majitel (konsolidováno z 01+02+03)

| # | Rozhodnutí | Kde v plánu | Kdy |
|---|---|---|---|
| 1 | **Primární business: Model 0 vs. SaaS** — a kterou provozní firmou podávat (kvalifikace, kapitál na nákup zboží, logistika dodání — Make more, nebo jiná entita?) | 01 §4.2, otázka 1 | teď (rámuje vše) |
| 2 | **Výběr 2–3 pilotních zakázek z feedu + provedení podání** | 03 A-06/A-07 | teď — hlavní blokátor |
| 3 | **HLIDAC_TOKEN** na prod + rozhodnutí o komerční licenci Hlídače | 03 A-05, T-06 | teď (S) |
| 4 | **Zadat právní konzultaci**: (a) NEN účet/zmocnění/automatizace podání, (b) SaaS odpovědnostní klauzule | 03 A-09 | teď — nejdelší latence, blokuje vlnu F |
| 5 | Cenové body SaaS: tiery + pilotní per-bid cena — potvrdit/upravit odhady | 01 otázka 3 | před design partnery |
| 6 | Design partneři: 2–3 konkrétní MSP dodavatelské firmy ze sítě — má je? Odkud? | 01 otázka 6 | po M-GTM-2 |
| 7 | Cílová marže per kategorie komodit (dnes 10 % fallback) + revize vah go/no-go po pilotech | 01 otázka 7, 03 C-05 | po pilotech |
| 8 | Škálování vstupu: zdroje feedu (TED, profily zadavatelů, licence), upsize VPS, denní AI budget | 03 vstup vlny E, C-03 | před vlnou E |
| 9 | Zapnutí auto-triáže (F-04) a režim podání (F-02) — výhradně Danovo go | 03 vstup vlny F | po kalibraci (≥ 50 outcomes) |
| 10 | Drobné: TTL verify cache a cap nákladů verify per položka | 03 vlna B | během vlny B |

---

## 2. Mapa dokumentů

| Dokument | Co obsahuje | Kdy číst |
|---|---|---|
| **00-README.md** (tento) | exec shrnutí, rozhodnutí majitele, nejbližší tasky, kontrola úplnosti | vždy první; jediný dokument, který majitel MUSÍ přečíst celý |
| **[01-business-model.md](01-business-model.md)** | trh (čísla s citacemi), segment (komoditní dodávky), hodnotová nabídka (40–80 h → 4–8 h; verify jako killer feature), konkurence CZ+EU, 5 příjmových modelů s doporučením (Model 0 + tiered SaaS), go-to-market (zákazník nula = my), rizika R1–R9 | při rozhodování o strategii, cenách, prodeji; před schůzkou s právníkem/partnerem |
| **[02-roadmapa.md](02-roadmapa.md)** | fáze 0–5 (dnešní stav → autonomie) s měřitelnými výstupními kritérii, balíky práce, blokátory přechodů (kdo odblokuje), doporučené pořadí + anti-pořadí | při plánování dalšího kroku; při otázce „proč děláme X před Y" |
| **[03-implementacni-plan.md](03-implementacni-plan.md)** | EXEKUČNÍ dokument: vlny A–F + průběžná stopa T, tasky s ID/soubory/akceptací/závislostmi, MONEY-PATH klasifikace, rozdělení práce (Codex/Opus/Sonnet/Fable/Dan), gates checklist, postup naplňování | denní práce — člověk i agent si z něj bere další task; checkboxy se odškrtávají přímo v něm |

Vztah: 01 říká PROČ a ZA KOLIK, 02 říká CO a V JAKÉM POŘADÍ, 03 říká JAK PŘESNĚ.
Podkladové dokumenty (audit, denní/noční reporty, product brief) jsou odkázané
v hlavičkách 01–03.

---

## 3. TEĎ HNED — nejbližší tasky (vlna A)

Dle doporučeného pořadí v 02 §„Doporučené pořadí prací" a 03 §9:

1. **A-06 — Výběr 2–3 pilotních zakázek** (Dan, rozhodnutí, S) — vše ostatní je bez
   podání akademické. Malé komoditní dodávky do ~1 M Kč, mainstream značky, lhůta ≥ 10 dní.
2. **A-01 — Checklist úplnosti balíku vs. ZD** (kód, M, MONEY-PATH) — největší riziko
   pilotu je formální diskvalifikace, ne cena. Jediný kódový blokátor podání.
3. **A-03 — Logování feature vektorů go/no-go** (kód, S) — zpětně nejde dohnat; bez
   snapshotů v momentě podání nelze později kalibrovat skóre. Migrace 018.
4. **A-04 — Outcome watcher MVP** (kód, M) — výsledky VZ se zveřejňují s latencí týdnů,
   sběr musí běžet dřív, než je fáze 3 „na řadě".
5. **A-09 — Zadat právní konzultaci** (Dan, S) — nejdelší latence celého plánu
   (týdny–měsíce), tvrdě blokuje vlnu F (podání).

Bonus s poměrem přínos/úsilí mimo kategorie: **A-05 — HLIDAC_TOKEN** (Dan, minuty) —
odblokuje druhý zdroj feedu, kód (`hlidac-client.ts`) už čeká.

---

## 4. KONTROLA ÚPLNOSTI — nálezy K DOPLNĚNÍ

Křížová kontrola 01↔02↔03 a plánu proti reálnému kódu (`main`, 2026-07-11).

**Ověřeno a sedí:** migrace 001–017 existují, 018+ volné (rezervace 018–021 v plánu
bez kolize); všechny soubory odkazované v tascích existují (`lib/monitoring/*` vč.
`hlidac-client.ts` a `tender-allocation.ts`, `podani.ts`, `outcomes-store.ts`,
`web-findings-store.ts`, `nakupy-store.ts/-seed.ts`, `winprice-*`, `cost-tracker.ts`,
`inbox.ts`, `go-no-go.ts`, `pipeline-job-state.ts`); odkazované testy existují
(`costs-aggregate`, `inbox`, `monitoring-tender-allocation`, `price-verifier`,
`nakupy-seed`, `outcomes-stats`, `winprice-derive`…); `pdf-parse` je v dependencies
(D-04); `output/n-485400-naradi` pro akceptaci A-01 existuje; FE komponenty
(SubmissionCockpit, ItemPriceCalculator, MonitoringSettings, InboxPage…) existují.
Drobnost bez dopadu: plán uvádí „227+ testů", reálně už ~320 asercí ve 33 souborech.

### K DOPLNĚNÍ (nálezy)

1. **Chybí lidský task „registrace dodavatele na NEN + kvalifikační doklady firmy".**
   A-02 (runbook) i A-07 (podání) mlčky předpokládají, že podávající firma má účet
   dodavatele na NEN a připravené kvalifikační doklady (výpis OR/ŽR, trestní
   bezúhonnost, reference, vzory ČP). To je předpoklad prvního podání s vlastní
   latencí a souvisí s rozhodnutím č. 1 (kterou entitou podáváme). → doplnit do vlny A
   jako lidský task (Dan), závislost A-07.
2. **Most business model → exekuce chybí pro SaaS větev.** 01 doporučuje „souběžně
   Model D (tiered SaaS) pro první externí platící zákazníky" a definuje milníky
   M-GTM-3/4, ale 02 ani 03 nemají ŽÁDNÝ task pro externí zákazníky (onboarding,
   fakturace, multi-user per firma) — a architektura je vědomě single-tenant
   (multi-tenant DEFER, viz CLAUDE.md). Pokud platí „SaaS až po M-GTM-2", zapsat to
   do 02 explicitně jako rozhodnutí; pokud „souběžně", chybí minimálně research task
   „co znamená pustit design partnera do dnešní single-tenant instance"
   (assistovaný režim z 01 §5.2 to obchází — ale nikde to není řečeno).
3. **Cenový sklad (warehouse matching) v plánu úplně chybí — zapsat vědomé vynechání.**
   Starší `docs/roadmap-autonomie.md` (Fáze 1b bod 8) popisuje, že sklad je fakticky
   vypnutý (`WAREHOUSE_MATCH_ENABLED`, jen stale 3D sortiment; flag ověřen
   v `match-product.ts`) a potřebuje kurátoraci. Nový plán 02/03 ho nezmiňuje vůbec.
   Dle priority Dana („sklad neřešit") jde nejspíš o záměr — doplnit do 02 větu
   „mimo rozsah, sklad zůstává vypnutý", aby to nevypadalo jako opomenutí.
4. **Cash-flow guard Modelu 0 (riziko R9) nemá task.** 01 slibuje mitigaci „go/no-go
   zohlední kapitálovou náročnost" a „limity na objem souběžných výher" — ověřeno
   v kódu: `go-no-go.ts` počítá faktory sektor/rozpočet/nacenění/win-price/lhůta,
   žádný kapitálový faktor, a žádný task ho nepřidává. Pokud bude primární Model 0,
   doplnit S task (faktor kapitálové náročnosti + limit souběžně vysoutěženého
   objemu) do vlny D nebo k F-05.
5. **Časová smyčka akceptace vlny B: zlatý set (B-03) vs. piloty.** Kódové tasky
   vlny B smí začít po kódu vlny A, ale akceptace B-01/B-02 se měří na zlatém setu,
   jehož nejcennější data (ručně ověřené ceny) vzniknou až z A-07/A-08 — provoz
   s latencí týdnů. Plán fallback „start z historických zakázek" má; doporučení:
   v B-03 explicitně rozdělit akceptaci na v1 (historická data — odblokuje vlnu B)
   a v2 (re-měření po pilotech — potvrdí hit-rate ≥ 70 % před vlnou C).
6. **Legacy `?token=` v BE zůstal bez tasku.** JWT byl odstraněn z FE query stringu
   (report 2026-07-11), ale backend query-parametr pro skripty zůstal — token
   v query = token v nginx lozích (otevřený bod z memory). Drobné; doplnit do
   průběžné stopy T (S task: skripty na Authorization hlavičku, query podporu vypnout).

Žádná jiná nepokrytá závislost mezi fázemi nenalezena: přechody 0→1→…→5 mají
blokátory vyjmenované v 02 (tabulka „Co blokuje postup"), dlouholatenční položky
(A-03, A-04, A-09) jsou správně předsunuté do vlny A a deploy-kills-jobs gap je
krytý interim taskem T-03 před finálním E-01.
