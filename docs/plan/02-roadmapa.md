# Roadmapa: od dneška k autonomní mašině na peníze

> Dokument plánu, 2026-07-11. Navazuje na `docs/audit-goal-2026-07-10.md` (6 dimenzí, baseline ~30 %),
> `docs/report-2026-07-11-den.md` (aktuální ~55 %), `docs/roadmap-autonomie.md` (pilíře) a
> `docs/product-brief-vz.md` (trh, právní rámec). Stav Fáze 0 je ověřen přímo v kódu na `main`
> (`scripts/src/`, `scripts/migrations/001–017`), ne opsán z reportů.
>
> **Cíl (Dan):** autonomní stroj na peníze — monitoring nových VZ → go/no-go → nacenění s marží
> a win-price → podatelné dokumenty → podání → feedback výher. Člověk jen schvaluje go/no-go
> a nákupy. Priorita = ZISK + FUNKČNOST; manuál je OK, autonomie se přidává postupně.

---

## Jak číst tento dokument

- **Fáze jsou řazené podle priority a závislostí**, ne podle kalendáře. Fáze N+1 se neotvírá,
  dokud nedrží výstupní kritérium fáze N (výjimky: „předběžné práce" vyznačené u pořadí na konci).
- Každá fáze má: cíl jednou větou, vstupní podmínku, **měřitelné výstupní kritérium**, balíky
  práce s odhadem (S = dny, M = ~týden, L = 2–3 týdny, XL = měsíc+), rizika a dimenze
  audit-skóre, na které hraje (průchodnost / kvalita / UX / provoz / business / autonomie).
- Klíčový poznatek, který formuje celou roadmapu: **AI cenové odhady jsou systematicky ~42 %
  (extrém 263 %) POD reálným trhem** — bez web-verify s reálným nákupním zdrojem je každá
  „vyhraná" zakázka kandidát na ztrátu. Verify hit-rate je proto podmínka ziskovosti, ne nice-to-have.
- Druhý poznatek: **k dalšímu posunu skóre vede hlavně PROVOZ, ne kód** (shodně audit i Codex
  oponentura). Fáze 1 je z větší části provozní disciplína, ne vývoj.

---

## Fáze 0 — DNES: co reálně funguje (ověřeno v kódu a na prod)

**Stav: ~55 % cesty k cíli** (audit ~30 % → 44 % → 48 % → 55 % za tři noci + den).
Rozpad dimenzí (report 2026-07-11): průchodnost 68, kvalita 68, UX 60, provoz 50, business 46, autonomie 40.

### Funguje a je nasazeno (vz.ludone.cz)

**Pipeline a kvalita cen**
- Pipeline extract → analyze → match → generate → validate (CLI i API, `full-flow.ts`),
  E2E průchodnost 100 % na historických zakázkách (188/188, 255/255 varyte).
- **Price sanity gate (HARD)** — `price-sanity.ts`, 6 pravidel vč. `extreme_outlier` a
  `cena_pod_nakupem`; potvrzení otrávené ceny = HTTP 409, submit-gate ready=false. Ověřeno živě
  (halucinace 280 000 Kč za adaptér byla zablokována; po root-cause fixech správná cena 280 Kč).
- **Marže**: company default (10 % fallback) jednotně ve všech cestách (panel, bulk, web-cena);
  nepotvrzená nula se přepisuje, potvrzená nula operátora se respektuje.
- **Win-price pásma**: migrace 011/013, ~10 000 záznamů z Registru smluv, 11 kategorií,
  hygiena dat (dopočet bez DPH, vadné datumy), pásma v UI Ocenění + faktor v go/no-go.
- **Web-verify cen** (`price-verifier.ts`, Anthropic web_search): reálné nákupní zdroje, až 3
  linky „kde nakoupit" s per-source „Použít cenu"; sklad nálezů (`warehouse_web_findings`, 015).
  HARD gate proti prodeji pod nákupem s auditovanou výjimkou (`override_pod_nakupem`).
- **Spec-compliance**: deterministická kontrola „vybraný kandidát plní povinné požadavky"
  ve validation reportu (advisory, neblokuje). Validátor čte reálné DOCX.
- Enricher „viz popis níže" (deterministické připojení popisových bloků k položkám) — extraction
  gap zavřen, ověřeno 1000× přesnější cenou na n-485400.

**Vstup a triáž**
- **Monitoring feed z NEN** (`lib/monitoring/`: nen-client, hlidac-client fallback, sync, score,
  zd-download, tender-allocation; migrace 014/017): nastavení zájmu, relevance skóre, převzetí
  zakázky + auto-stažení ZD + spuštění pipeline. Prod: 89 zakázek načteno, 63 aktuálních.
- **Go/no-go číselné skóre 0–100** (`go-no-go.ts`, vážené faktory vč. win-price proximity a
  ekonomiky) + **bid skóre po nacenění** (zisk Kč, přirážka vs. cíl, kvalita shod, HARD=NOGO).
- **Schvalovací inbox** (`inbox.ts`): agregace akcí napříč zakázkami (nepotvrzené ceny, HARD
  flagy, validation fails, deadline alarm <48 h).

**Výstup a podání**
- **Submission cockpit** (`podani.ts`): finalize → immutable ZIP balík s manifestem (sha256,
  verzování); stav `odeslana` až po zaznamenané evidenci podání (portál, čas, ev. číslo).
  Stale gate: změna ceny po vygenerování → 409 na finalize/submit.
- Generování dokumentů: krycí list, cenová nabídka, technický návrh, čestné prohlášení, fill
  tendrových šablon (reconstruct engine), .doc→.docx (LibreOffice), PDF (Gotenberg).
- **Platnost firemních dokladů** hlídaná (expirace v Nastavení firmy).

**Provoz a učení**
- **Approval-aware run-all**: řetěz se na lidském checkpointu PAUZNE (`waiting_approval`
  v `pipeline-job-state.ts`), po potvrzení cen resume na klik; generate tvrdě padá nad
  nepotvrzenými cenami. Persistentní fronta (přežije restart), PIPELINE_MAX_CONCURRENT=2.
- **Outcome vrstva existuje** (migrace 012 `crm_vysledky`, `outcomes-store.ts`, tab Výsledek,
  `/api/outcomes/stats`, win-rate widget, propis vítězných cen do win_prices) — ale je **prázdná**
  (0 podaných nabídek).
- **AI náklady** per zakázka (`cost-tracker.ts`), denní pg_dump zálohy, health/billing watchdog
  → Slack, JWT mimo FE query string, e2e auto-confirm už neobchází money-gate
  (`E2E_UNSAFE_AUTOCONFIRM` explicitní), `.gitignore` kryje `input/`.
- Nákupní fáze: tab „Nákup" (`crm_nakupy`, 016) — co koupit po výhře, idempotentní seed
  z potvrzených cen.

### Poctivé limity dneška (proti nim míří fáze 1–5)

1. **0 reálně podaných nabídek** → win-rate loop, bid skóre i go/no-go jsou nekalibrované teorie.
2. **Podání je manuální** (profil zadavatele / NEN) — cockpit připraví balík, člověk podává.
3. **Verify hit-rate u specializovaného sortimentu ~0** (živý test 0/4 u nářadí s katalogovými
   čísly, která web-search nezná) — mainstream značky nachází, long-tail ne.
4. **Jediný zdroj monitoringu = NEN scrape** (HTML, křehké); Hlídač fallback čeká na token.
5. Fronta = 2 sloty v jednom procesu; „desítky denně" neutáhne (deploy navíc zabíjí běžící joby).
6. Cost tracking je per zakázka; chybí agregace, stropy, throughput metriky.
7. Výsledky zakázek se nedohledávají automaticky (žádný outcome watcher).

---

## Fáze 1 — „První vyhraná koruna"

**Cíl:** jedna reálně podaná (a ideálně vyhraná) nabídka přes celý flow, s výsledkem zapsaným
do systému — důkaz, že mašina umí vydělat první korunu.

**Vstupní podmínka:** stav Fáze 0 (splněno dnes) + Dan vybere 2–3 pilotní živé zakázky
z monitoring feedu (go/no-go skóre je vodítko, rozhodnutí lidské).

**Výstupní kritérium (měřitelné):**
- ≥ 2 nabídky ve stavu `odeslana` s vyplněnou evidencí podání (portál, čas, ev. číslo) a
  immutable balíkem v cockpitu;
- 0 diskvalifikací pro formální vadu (neúplnost, chybějící doklad, špatný formát);
- 100 % potvrzených cen pilotních nabídek má reálný nákupní zdroj (verify nebo ruční dohledání)
  a marži ≥ company default;
- výsledek každé nabídky (výhra/prohra/zrušeno + vítězná cena + počet uchazečů) zapsán
  v `crm_vysledky`.

**Povaha fáze: ~70 % provoz, ~30 % kód.** Tohle je nejlevnější a nejrychlejší cesta k posunu
business skóre — žádný kód nenahradí první reálné podání.

### Balíky práce

| # | Balík | Velikost | Poznámka |
|---|---|---|---|
| 1.1 | **Výběr pilotů**: 2–3 živé zakázky z feedu — malé, komoditní, s dostupným sortimentem (mainstream značky kvůli verify hit-rate), lhůta ≥ 10 dní | S (provoz) | Rozhoduje Dan (go/no-go). Vybírat zakázky, kde verify NAJDE ceny — první pilot nemá testovat long-tail. |
| 1.2 | **100% cenová jistota pilotu**: web-verify na každou položku; kde verify nenajde, ruční dohledání nákupní ceny (e-shop, poptávka dodavateli); vše potvrzeno přes gate | M (provoz + drobný kód) | Přímý důsledek nálezu „AI odhady −42 % pod trhem". Bez toho hrozí výhra se ztrátou. |
| 1.3 | **Checklist úplnosti balíku vs. ZD**: deterministický seznam požadovaných dokumentů/příloh z analýzy ZD (kvalifikace, ČP, smlouva, soupis…) odškrtávaný v cockpitu; doklady s platností už hlídané | M | Největší riziko pilotu = formální vada, ne cena. Dnes kontroluje jen člověk bez opory. |
| 1.4 | **Runbook ručního podání NEN/profil**: krok za krokem (přihlášení, formát příloh, limity velikosti, potvrzení), evidence podání do cockpitu hned po odeslání | S (dokument) | §211/7 fikce podpisu — právně čisté. Runbook je základ pozdější automatizace (Fáze 5). |
| 1.5 | **Lidské QA vygenerovaných dokumentů**: přečíst DOCX/PDF očima zadavatele, porovnat se spec-compliance reportem, zaznamenat každou ručně opravenou vadu jako issue | S (provoz) | Seznam ručních oprav = backlog kvality pro Fázi 2. |
| 1.6 | **Zápis výsledků + retrospektiva**: outcome do tabu Výsledek; u prohry delta vs. vítěz; 1stránková retrospektiva per pilot (co drhlo, kolik minut kde) | S (provoz) | Naplní poprvé win-rate loop reálnými daty. Měření času = baseline pro Fázi 2. |
| 1.7 | **HLIDAC_TOKEN** — Dan získá token (příp. rozhodne o komerční licenci) a nasadí do prod env | S (rozhodnutí + config) | Odblokuje druhý zdroj feedu; kód fallbacku už existuje (`hlidac-client.ts`). |

### Rizika
- **Lhůty**: pilot může propadnout kvůli 3 dnům čekání — deadline alarm v inboxu hlídat denně.
- **Formální diskvalifikace**: nejpravděpodobnější způsob selhání; mitigace balík 1.3 + 1.5.
- **Cena mimo pásmo**: příliš vysoká = prohra, příliš nízká = ztrátová výhra; mitigace 1.2 +
  win-price pásmo + HARD gate pod nákupem.
- **Malý vzorek**: 2–3 nabídky nic nedokazují statisticky — fáze dokazuje PROCES, ne win-rate.
- **Výsledek se dozvíme pozdě** (týdny) — fáze se považuje za splněnou podáním + zápisem,
  na výhru se nečeká se startem Fáze 2.

**Hraje na dimenze:** business (nejvíc — z 46 výš je bez podání nemožné), kvalita (checklist,
QA), autonomie nepřímo (data pro kalibraci).

---

## Fáze 2 — „Důvěryhodný poloautomat"

**Cíl:** jeden operátor zvládne 5–10 nabídek denně s důvěrou — systém mu předkládá správné
kandidáty se skutečnými cenami a on převážně jen schvaluje.

**Vstupní podmínka:** Fáze 1 hotová (≥ 2 podání bez formální vady), seznam ručních zásahů
z retrospektiv 1.5/1.6 jako backlog.

**Výstupní kritérium (měřitelné):**
- verify hit-rate ≥ 70 % položek s reálným nákupním zdrojem (dnes ~0 % u long-tail);
- ≤ 10 % položek vyžaduje ruční zásah operátora po průchodu gate (změna kandidáta, ruční cena);
- 0 spec-compliance failů u podaných nabídek;
- čas operátora ≤ 45 min/nabídka (změřeno z pilotního baseline);
- prokázaný den s ≥ 5 podanými/připravenými nabídkami.

### Balíky práce

| # | Balík | Velikost | Poznámka |
|---|---|---|---|
| 2.1 | **Kvalita matchingu**: povinné pole výrobce+model/katalogové číslo u kandidáta, penalizace generických kandidátů, měření match precision na zlatém setu z pilotů | M | Verify je jen tak dobrý, jak dobrá jsou katalogová čísla kandidátů (živý test: 0/4 u vágních kandidátů). |
| 2.2 | **Verify fallback řetěz**: katalogové číslo → výrobce+model → generický ekvivalent s vyznačením úrovně jistoty; řízené čtení `warehouse_web_findings` jako cache (bez kontaminace matchingu) | M–L | Hlavní páka na hit-rate ≥ 70 %. |
| 2.3 | **Auto-run-all po převzetí z monitoringu**: převzetí zakázky rovnou spustí řetěz až po `waiting_approval` checkpoint | S | Checkpoint mechanismus už existuje a je fail-closed — nízké riziko, velká úspora klikání. |
| 2.4 | **Inbox jako pracovní plocha**: bulk akce přímo z inboxu (potvrdit ceny, spustit generate, finalize) bez otevírání detailu; řazení dle lhůty × skóre | M | Podmínka 5–10/den — dnes vše žije v detailu jedné zakázky. |
| 2.5 | **Ruční revize vah go/no-go**: porovnat skóre pilotů s realitou (stálo to za práci?), upravit váhy ručně; zalogovat feature vektor skóre při podání (příprava na Fázi 3) | S | Ještě ne auto-kalibrace — na to není vzorek. Logování featurů ale začít HNED. |
| 2.6 | **Cost + throughput observabilita**: agregace cost-trackeru (den/měsíc/zakázka), denní strop s degradací, latence per pipeline krok | S–M | Při 5–10/den už AI spend a hrdla potřebují číslo, ne pocit. |
| 2.7 | **Šablonová robustnost**: měřit miss-rate fill enginu na nových zakázkách, review UI pro nevyplněné sloty | M | Historicky 30–40 % miss-rate šablon; každý miss = ruční práce proti limitu 45 min. |

### Rizika
- Long-tail sortiment může mít strop hit-rate < 70 % → pak zúžit obchodní záběr na komodity,
  kde verify funguje (rozhodnutí pro Dana, ovlivňuje výběr zakázek).
- Důvěra operátora se láme jednou proklouznuvší špatnou cenou → gate pravidla rozšiřovat
  z každého incidentu (postmortem povinný).
- NEN scrape = křehký vstup (změna HTML = prázdný feed) → mitigace HLIDAC_TOKEN z 1.7.

**Hraje na dimenze:** UX (60 → cíl 75+), kvalita (68 → 75+), průchodnost, provoz.

---

## Fáze 3 — „Feedback smyčka"

**Cíl:** win-rate se měří automaticky a skóre/ceny se kalibrují z reálných výher a proher —
stroj se učí.

**Vstupní podmínka:** ≥ 10–20 podaných nabídek se zapsaným výsledkem (výstup provozu Fáze 2);
feature vektory skóre logované od 2.5.

**Výstupní kritérium (měřitelné):**
- outcome watcher automaticky dohledá výsledek ≥ 80 % podaných zakázek bez ručního zásahu;
- go/no-go skóre má změřenou přesnost na reálných datech (bucket analýza: podíl výher
  ve skóre pásmech) a váhy jsou aspoň jednou přepočteny z dat;
- u každé zakázky je doporučená cena s odhadem P(win) z historického pásma a operátor vidí
  trade-off marže × pravděpodobnost výhry;
- u každé prohry automatický rozpad delta vs. vítěz.

### Balíky práce

| # | Balík | Velikost | Poznámka |
|---|---|---|---|
| 3.1 | **Outcome watcher**: periodické dohledání výsledků (VVZ/ISVZ award notice, Registr smluv, NEN detail) párováním přes evidenční číslo + IČO; auto-zápis do `crm_vysledky` | M | Výsledky chodí se zpožděním týdny — proto začít sbírat CO NEJDŘÍV (viz pořadí na konci). |
| 3.2 | **Kalibrační smyčka skóre**: párování feature vektorů (z 2.5) s outcomes, přepočet vah go/no-go, report „skóre vs. realita" | M | Na 20 nabídkách jen konzervativně (směr vah, ne přesná čísla). |
| 3.3 | **Price-to-win model**: pozice naší ceny ve win-price pásmu → P(win); panel marže × P(win) v Ocenění; doporučená cena jako návrh (NIKDY auto-přepis) | L | Jádro konkurenční výhody (product brief §d). Vyžaduje hustá pásma → 3.4. |
| 3.4 | **Win-price obohacení**: PDF backfill položkových cen ze smluv Registru, počet uchazečů z VVZ, průběžný import nových smluv | L | Dnes 10k záznamů, ~6,4k s cenou; položkové ceny z PDF = skokové zlepšení pásem. |
| 3.5 | **Ztrátová analýza**: u prohry automatický per-položkový rozdíl vs. vítězná cena (kde je dostupná), agregovaný report „proč prohráváme" | S | Levné, vysoká informační hodnota pro Dana. |

### Rizika
- **Malý vzorek = šum**: kalibrace na < 30 výsledcích může být horší než ruční váhy → všechny
  auto-úpravy jako návrh s lidským schválením, plná automatika až od ~50 výsledků.
- Zveřejňování výsledků je pomalé a nekonzistentní napříč portály → watcher musí umět „zatím
  neznámo" bez falešných závěrů.
- GDPR režim Registru smluv (mazání znepřístupněných záznamů) — hlídat při backfillu.

**Hraje na dimenze:** business (hlavní páka na 46 → 65+), autonomie (kalibrovaný go/no-go je
předpoklad auto-triáže ve Fázi 5).

---

## Fáze 4 — „Škálování"

**Cíl:** desítky nabídek denně při konstantním lidském čase — mašina jede objem, člověk triáž.

**Vstupní podmínka:** metriky Fáze 2 drží ≥ 1 měsíc provozu; Fáze 3 smyčka běží (aspoň watcher
+ logging); rozhodnutí o zdrojích monitoringu (Hlídač licence, TED).

**Výstupní kritérium (měřitelné):**
- ≥ 20 CN/den zpracováno (převzetí → submit-ready) při ≤ 2 h lidského času denně celkem;
- ≥ 3 aktivní zdroje monitoringu (NEN + Hlídač + TED/profily), deduplikované;
- deploy/restart nepřeruší žádný job (fronta mimo API proces);
- AI spend pod nastaveným stropem s automatickou degradací, alert při 80 %.

### Balíky práce

| # | Balík | Velikost | Poznámka |
|---|---|---|---|
| 4.1 | **Více zdrojů feedu**: Hlídač v2 (token z 1.7), TED API v3 (nadlimitní, bez auth), profily zadavatelů dle vyhl. 345/2023 (XML); dedup přes evidenční číslo/hash | M–L | Kód klientů částečně existuje (`hlidac-client.ts`); TED a profily net-new. |
| 4.2 | **Postgres-backed worker fronta**: N paralelních workerů odděleně od API procesu, retry/backoff, priorita = f(lhůta, go/no-go), přežití deploye | L | Dnešní 2-slot in-proc fronta je strop; deploy zabíjí joby (známý gap). |
| 4.3 | **Hromadný operátorský režim**: inbox s klávesovými bulk akcemi, dávkové potvrzení napříč zakázkami, „ranní triáž" view (nové → go/no-go fronta na 10 min) | M | Návaznost na 2.4; cíl: člověk rozhoduje, neklika detaily. |
| 4.4 | **Cost stropy a degradace**: denní/měsíční budget, levnější model na triáž (haiku), stop-the-line při překročení | M | Navazuje na 2.6; při desítkách/den je spend řiditelný náklad, ne překvapení. |
| 4.5 | **SLA/throughput dashboard**: latence per krok, úspěšnost, fronta, hit-rate verify, denní počty — jedna obrazovka zdraví mašiny | M | Provozní dimenze (50 → 70+); zároveň podklad pro Dana „kolik to žere / kolik to nese". |
| 4.6 | **Infra oddělení**: worker kontejner vedle vz-api (sdílená DB), případně upsize VPS | M | Teprve tady — dřív by to byla předčasná optimalizace. |

### Rizika
- Kvalita klesá s objemem (gate a spec-compliance musí unést 20/den bez zahlcení inboxu
  falešnými flagy) → tuning precision gate pravidel z dat Fáze 2–3.
- Rate limity / kredit Anthropic → mitigace 4.4 + billing watchdog (existuje).
- Dedup napříč zdroji je záludný (stejná zakázka, různá ID) → konzervativně, raději duplicita
  ve feedu než tichá ztráta zakázky.

**Hraje na dimenze:** průchodnost (68 → 85+), provoz (50 → 70+), UX, autonomie.

---

## Fáze 5 — „Autonomie"

**Cíl:** člověk dělá jen go/no-go a schvaluje nákupy — vše ostatní včetně podání (kde to jde
legálně) provede mašina po explicitním schválení.

**Vstupní podmínka:** kalibrovaný go/no-go (Fáze 3, ≥ 50 outcomes), stabilní throughput
(Fáze 4); **právní konzultace k modelu přístupu k NEN účtu uzavřená** (zmocnění, podmínky užití).

**Výstupní kritérium (měřitelné):**
- ≥ 80 % nabídek projde od převzetí po submit-ready bez lidského zásahu (mimo go/no-go
  a schválení cen nad prahem);
- podání: systém sestaví a odešle nabídku po expl. kliknutí člověka „Odeslat" (asistované),
  na portálech s API plně automaticky po schválení;
- každá autonomní akce v audit logu, kill-switch funkční (otestovaný), denní limit Kč
  bez schválení vynucený;
- lidský čas ≤ 1 h/den na desítky nabídek.

### Balíky práce

| # | Balík | Velikost | Poznámka |
|---|---|---|---|
| 5.1 | **Právní model podání**: konzultace — zmocnění/přístup k NEN účtu dodavatele, podmínky užití nástrojů, odpovědnost za ČP; §211/7 fikce podpisu je ověřená opora | S (rozhodnutí, blokující) | Bez tohoto se 5.2/5.3 nezačíná. Může běžet paralelně už od Fáze 2. |
| 5.2 | **Asistované podání NEN**: automatizace formuláře (Playwright/computer-use) podle runbooku z 1.4, dry-run režim, člověk kliká finální „Odeslat"; screenshot evidence do cockpitu | L | NEN nemá veřejné podávací API — jde o UI automatizaci = křehké; proto asistovaně, ne bezobslužně. |
| 5.3 | **API podání kde existuje**: prověřit E-ZAK/Tender arena/Josephine možnosti; kde API není, zůstává 5.2 | L–XL | Pokrytí portálů rozhodne, kolik % podání jde plně automatizovat. |
| 5.4 | **Auto-triáž go/no-go**: skóre nad kalibrovaným prahem → auto-příprava celého balíku; člověk schvaluje frontu „připraveno k podání" místo jednotlivých kroků | M | Bezpečné až s kalibrací z Fáze 3; jinak mašina plýtvá na špatné zakázky. |
| 5.5 | **Nákupní automatizace**: z `crm_nakupy` objednávkové podklady (košíky/poptávky), člověk schvaluje nákup jedním klikem | M | Druhý lidský checkpoint dle cíle. Kód tabu Nákup existuje, chybí generování podkladů. |
| 5.6 | **Governance a fail-safe**: kill-switch podání, audit log, denní/týdenní limity (Kč, počet podání), alarm při anomálii (např. cena 2σ mimo pásmo prošla) | M | Podmínka důvěry — autonomie bez brzd je u peněz nepřijatelná (stejný princip jako LuDone money-path). |

### Rizika
- **Právní/reputační**: formálně vadné automatické podání poškozuje jméno firmy u zadavatelů;
  proto asistovaný režim jako default a plná automatika jen na portálech s API a po track recordu.
- **Křehkost UI automatizace**: změna NEN rozbije podání v nejhorší moment → dry-run před
  každým ostrým podáním, fallback na runbook člověkem.
- **Odpovědnost za čestná prohlášení** zůstává na firmě — obsah ČP nikdy negenerovat bez
  schválené šablony.

**Hraje na dimenze:** autonomie (40 → 80+), business, UX.

---

## Co blokuje postup do další fáze

| Přechod | Blokátor | Typ | Kdo odblokuje |
|---|---|---|---|
| 0 → 1 | Výběr 2–3 pilotních zakázek z feedu | rozhodnutí | **Dan** (go/no-go je jeho checkpoint) |
| 0 → 1 | Ruční dohledání cen tam, kde verify nenajde | provoz | operátor (Dan/pověřený člověk) |
| 1 → 2 | ≥ 2 podání bez formální vady + retrospektivy (backlog ručních zásahů) | provoz | operátor |
| 1 → 2 | HLIDAC_TOKEN na prod (druhý zdroj feedu, stabilita vstupu) | rozhodnutí + config | **Dan** (příp. komerční licence Hlídače) |
| 2 → 3 | ≥ 10–20 podaných nabídek s výsledky (vzorek pro kalibraci) | provoz + čas | provoz Fáze 2 (výsledky chodí se zpožděním týdnů) |
| 2 → 3 | Logování feature vektorů skóre od začátku Fáze 2 (balík 2.5) | kód (S) | vývoj — udělat brzy, zpětně nejde |
| 3 → 4 | Rozhodnutí o zdrojích: komerční licence Hlídač? TED? profily? | rozhodnutí | **Dan** (náklad vs. pokrytí) |
| 3 → 4 | Metriky Fáze 2 držené ≥ 1 měsíc (důkaz stability před objemem) | provoz | operátor + dashboard 2.6 |
| 4 → 5 | Právní konzultace: model přístupu k NEN účtu, zmocnění, podmínky užití | rozhodnutí + externí | **Dan** + právník (lze začít kdykoliv dřív) |
| 4 → 5 | Kalibrovaný go/no-go (≥ 50 outcomes) — bez něj auto-triáž plýtvá | data + čas | provoz Fáze 2–4 |

## Doporučené pořadí prací napříč fázemi

Řazeno podle poměru (dopad na zisk/funkčnost) / (pracnost), s ohledem na závislosti a na to,
že **latence výsledků VZ je týdny** — sběrné mechanismy se vyplatí spustit dřív, než je jejich
fáze „na řadě":

1. **Pilotní podání (F1.1–1.6)** — okamžitě; provoz, ne kód. Vše ostatní je bez prvního podání
   akademické. Kódová podpora jen 1.3 (checklist úplnosti balíku).
2. **HLIDAC_TOKEN (F1.7)** — jednorázové rozhodnutí Dana, odblokuje stabilitu vstupu.
3. **Logování feature vektorů go/no-go (F2.5)** — S, udělat hned; zpětně data nevzniknou.
4. **Outcome watcher (F3.1) předběžně** — začít sbírat výsledky co nejdřív kvůli latenci
   zveřejňování; stačí minimální verze (VVZ award notice podle ev. čísla).
5. **Verify hit-rate + kvalita matchingu (F2.1, 2.2)** — hlavní kódová práce nejbližších týdnů;
   podmínka ziskovosti (odhady −42 % pod trhem) i podmínka 5–10/den.
6. **Auto-run-all po převzetí (F2.3)** — S, checkpoint už je bezpečný, velká úspora klikání.
7. **Inbox bulk akce (F2.4)** + **cost/throughput observabilita (F2.6)** — poloautomat UX.
8. **Právní konzultace NEN (F5.1)** — externí, dlouhá latence → zadat už během Fáze 2.
9. **Kalibrace skóre (F3.2) a price-to-win (F3.3, 3.4)** — jakmile je vzorek outcomes.
10. **Postgres worker fronta (F4.2) a další zdroje feedu (F4.1)** — až metriky poloautomatu drží.
11. **Asistované podání (F5.2) a auto-triáž (F5.4)** — poslední, na ověřeném základě.

**Anti-pořadí (čemu se vyhnout):** nestavět podávací automatizaci před prvním ručním podáním
(runbook 1.4 je její specifikace); nekalibrovat skóre na < 10 výsledcích; neškálovat frontu,
dokud operátor nezvládne 5/den ručně (jinak se škáluje chaos); nerozšiřovat sortiment/záběr,
dokud verify hit-rate nedrží na současném.
