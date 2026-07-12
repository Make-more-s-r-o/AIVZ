# Plán VZ AI Tool — exec shrnutí a navigace

> **Verze 2 (po adversariální oponentuře Codexu, 2026-07-12).**
> Dokument plánu, část 0/N. Stav k 2026-07-11 (skóre ~55 % cesty k cíli).
> Shrnuje a naviguje `01-business-model.md`, `02-roadmapa.md`, `03-implementacni-plan.md`;
> oponentura a její vypořádání: `99-oponentura-codex.md` + §5 níže.
> Kontrola úplnosti (§4) provedena proti reálnému kódu na `main`
> (`scripts/src/`, `scripts/migrations/001–017`, `scripts/tests/`, `apps/web/src/`).

---

## 0. Tvrdý invariant majitele (nadřazen všemu v plánu)

> **„Hlavně ať je tam ta lidská kontrola u těch položek, které jsou v nabídce."** (Dan)

- **human_review_rate = 100 %, vždy, bez cenových prahů.** Každá položka nabídky projde
  individuálním lidským potvrzením; žádná fáze, task ani automatizace to nesmí obejít.
- Invariant je **nasazen v kódu (PR #63) a živě ověřen na produkci**: každé potvrzení
  ceny nese serverovou auditní stopu (kdo/kdy z JWT — klientské hodnoty se ignorují),
  bulk operace potvrzují jen položky s explicitní per-item attestací, slepé „Potvrdit
  vše" neexistuje, potvrzení se ruší při změně produktu/ceny i při HARD flagu
  `cena_pod_nakupem`.
- Důsledek pro škálování: lidský čas roste s počtem položek. Kapacitní čísla v plánu
  jsou kapacita stroje; reálné tempo podání určuje lidská kontrola a obchodní poptávka.

---

## 1. Exec shrnutí pro majitele

### Příležitost

Český trh VZ = 993 mld. Kč/rok, ~15 tis. zakázek ročně ve formálním režimu. Příprava
jedné nabídky stojí dodavatele 40–80 hodin převážně mechanické práce; průměr 2,8
nabídky na zakázku a **40 % řízení s jediným uchazečem [EU Single Market Scoreboard
2024]** říká, že konkurence v soutěžích je slabá. **Bottom-up adresovatelný trh (SAM)
zatím spočítaný nemáme** — dopočet „40–45 tis. nabídek ročně" z v1 byl top-down a
nepoužitelný; postup výpočtu je v 01 §1.1 (task T-08). Hypotézu „dodavatelé nestíhají
připravovat nabídky" validujeme rozhovory při prvních placených pilotech, ne citací
indikátoru.

Mezera: end-to-end od monitoringu po podatelnou nabídku s cenou ověřenou proti
reálnému nákupu (web-verify) a historickým výhrám (win-price z Registru smluv).
**Nebyl nalezen veřejně nabízený identický produkt** — monitoringy (Tenderpool a spol.)
nabídky negenerují; existuje ale bid-desk poradenství (ruční služba) a interní řešení
z veřejného webu nevidíme (01 §3). Klíčové zjištění, které je zároveň moat: **čisté AI
odhady cen jsou ~42 % pod trhem (extrém 263 %)** — bez verify vrstvy nikdo nemůže
bezpečně generovat nabídkové ceny, my ji máme nasazenou. Unit-ekonomika SLUŽBY:
COGS < 500 Kč na nabídku vs. hodnota 22–72 tis. Kč ušetřeného času. (Ekonomika
vlastního obchodování je jiná — nese financování zboží, DPH, dopravu, záruky a sankce;
01 §4.1.)

### Kde jsme (Fáze 0, ~55 %)

Nasazeno na vz.ludone.cz: celá pipeline (extract→analyze→match→generate→validate,
E2E 100 % na historických zakázkách), price sanity gate (HARD, živě ověřen — halucinace
280 000 Kč zablokována HTTP 409), marže company default, win-price pásma (~10 000
záznamů), web-verify s HARD gatem proti prodeji pod nákupem, **potvrzení cen s per-item
attestací a auditní stopou (PR #63 — invariant §0 nasazen)**, **governance kill-switch
(PR #65 — přepínače ingest/AI/generate/finalize/submission + denní strop AI nákladů
2 000 Kč, serverové 503 guardy, admin API, chip „Provoz omezen")**, monitoring feed
z NEN (89 zakázek živě), go/no-go skóre, schvalovací inbox, submission cockpit
(immutable balík + evidence podání), approval-aware run-all, outcome vrstva
(win-rate widget).

Poctivé limity: **0 reálně podaných nabídek** (win-rate = nezměřená teorie), podání je
manuální, verify u long-tail sortimentu ~0 % hit-rate, jediný zdroj feedu = křehký NEN
scrape, fronta 2 sloty, výsledky se nedohledávají automaticky, **připravenost podávající
entity (kvalifikace, sourcing, logistika, kapitál) zatím neřešena — nový A-00**.

### Kam jdeme (fáze 1–5)

1. **„První bezvadně podaná nabídka"** — ≥ 2 bezvadná reálná podání přes celý flow (M1).
   Výhra (M2), kladná contribution margin (M3) a první inkaso (M4) jsou samostatné
   milníky — přijdou s latencí a NEblokují postup do fáze 2.
2. **„Důvěryhodný poloautomat"** — verify hit-rate ≥ 70 %, operátor 5–10 nabídek/den.
3. **„Feedback smyčka"** — outcome watcher, kalibrace skóre daty; do backtestu jen
   historická cenová pozice + interval nejistoty (P(win) až po backtestu a minimu
   výsledků v segmentu).
4. **„Škálování"** — otvírá se na OBCHODNÍ kritérium (opakovaná platba / kladná
   contribution margin / reálná kapacita dodat), ne na počet vyrobených dokumentů;
   kapacita stroje ≥ 20 CN/den je technický důkaz, ne cíl sám o sobě.
5. **„Autonomie"** — asistované podání, auto-triáž, governance; člověk drží go/no-go,
   **per-item potvrzení každé položky (invariant §0)** a nákupy.

Business model po oponentuře: **PRIMÁRNĚ placený asistovaný bid service (managed
service)** — my obsluhujeme nástroj, klient schvaluje go/no-go a položky, platí per
nabídka. **Vlastní obchodování („Model 0") jen jako OMEZENÝ experiment s tvrdým stropem
kapitálové expozice** (A-00) — motor kalibrace, ne pilíř příjmů. SaaS foundation
(tenant izolace, role, fakturace) až po placené validaci; první externí zákazník jede
managed service bez přímého přístupu do systému.

### Nejbližší milník

**M1: první bezvadně podaná nabídka** (= výstup vlny A / fáze 1): ≥ 2 nabídky ve stavu
`odeslana` s evidencí podání, 0 formálních diskvalifikací, 100 % cen s reálným nákupním
zdrojem a per-item attestací. Vstupní brána: **A-00 připravenost entity a dodávky** —
bez ní se nepodává. Je to z ~70 % provoz, ne kód — **žádný další vývoj nenahradí první
podání**; bez něj jsou kalibrace i prodej akademické.

### Co potřebuje rozhodnout majitel (konsolidováno z 01+02+03)

| # | Rozhodnutí | Kde v plánu | Kdy |
|---|---|---|---|
| 1 | **A-00: potvrdit strategii** (primární = managed service; Model 0 = omezený experiment) + parametry experimentu: podávající entita, **tvrdý strop kapitálové expozice v Kč**, minimální contribution margin per zakázka | 01 §4.2, 03 A-00 | teď — blokuje podání |
| 2 | **Design partneři pro placené concierge validace**: 2–3 MSP dodavatelé ze sítě + pilotní cena per nabídka (~1 990 Kč/CN [ODHAD]) | 01 §5.1–5.2 | teď (paralelně) |
| 3 | **Výběr pilotní zakázky (nejprve 1, po retrospektivě +2) + provedení podání** | 03 A-06/A-07 | po A-00 |
| 4 | **HLIDAC_TOKEN** na prod + rozhodnutí o komerční licenci Hlídače | 03 A-05, T-06 | teď (S) |
| 5 | **Zadat právní konzultaci — tři okruhy**: (a) NEN účet/zmocnění/automatizace podání, (b) odpovědnost managed service/SaaS, (c) GDPR + licence dat + ToS scrapingu NEN a Registru smluv (okruh (c) nutný PŘED externím pilotem) | 03 A-09, T-06 | teď — nejdelší latence |
| 6 | Cenové body: pilotní per-bid cena concierge (viz #2); SaaS tiery až po placené validaci | 01 §4.2 | před prvním partnerem |
| 7 | Cílová marže per kategorie komodit (dnes 10 % fallback) + revize vah go/no-go po pilotech | 01 otázka 7, 03 C-05 | po pilotech |
| 8 | Škálování (vstup vlny E): splněno obchodní kritérium? + zdroje feedu, upsize VPS, denní AI strop (default 2 000 Kč z PR #65 — potvrdit/upravit) | 02 fáze 4, 03 vlna E | před vlnou E |
| 9 | Zapnutí auto-triáže (F-04) a režim podání (F-02) — výhradně Danovo go | 03 vstup vlny F | po kalibraci (≥ 50 outcomes) |
| 10 | Drobné: TTL verify cache a cap nákladů verify per položka | 03 vlna B | během vlny B |

---

## 2. Mapa dokumentů

| Dokument | Co obsahuje | Kdy číst |
|---|---|---|
| **00-README.md** (tento) | invariant, exec shrnutí, rozhodnutí majitele, nejbližší kroky, changelog v2 | vždy první; jediný dokument, který majitel MUSÍ přečíst celý |
| **[01-business-model.md](01-business-model.md)** | trh (čísla s citacemi, SAM poctivě otevřený — T-08), segment, hodnotová nabídka, konkurence CZ+EU vč. bid-desk poradenství, příjmové modely s doporučením (managed service primárně, Model 0 omezený experiment), go-to-market, rizika R1–R9 | při rozhodování o strategii, cenách, prodeji; před schůzkou s právníkem/partnerem |
| **[02-roadmapa.md](02-roadmapa.md)** | fáze 0–5 (dnešní stav → autonomie) s měřitelnými výstupními kritérii, milníky M1–M4, balíky práce, blokátory přechodů, doporučené pořadí + anti-pořadí | při plánování dalšího kroku; při otázce „proč děláme X před Y" |
| **[03-implementacni-plan.md](03-implementacni-plan.md)** | EXEKUČNÍ dokument: vlny A–F + průběžná stopa T, tasky s ID/soubory/akceptací/závislostmi, MONEY-PATH klasifikace, rozdělení práce, gates checklist | denní práce — člověk i agent si z něj bere další task; checkboxy se odškrtávají přímo v něm |
| **[99-oponentura-codex.md](99-oponentura-codex.md)** | syrový výstup adversariální oponentury v1 + vypořádání (nezapracované nálezy a proč) | auditní stopa; při pochybnosti „proč je to ve v2 jinak" |

Vztah: 01 říká PROČ a ZA KOLIK, 02 říká CO a V JAKÉM POŘADÍ, 03 říká JAK PŘESNĚ.
Podkladové dokumenty (audit, denní/noční reporty, product brief) jsou odkázané
v hlavičkách 01–03.

---

## 3. TEĎ HNED — nejbližších 5 kroků (protinávrh oponentury, přizpůsobený realitě)

1. **A-00 — Připravenost entity a dodávky** (Dan, rozhodnutí, S–M): potvrdit managed
   service jako primární business; pro dealer experiment: entita, kvalifikace +
   registrace dodavatele NEN, sourcing, logistika, DPH, pojištění, **strop kapitálové
   expozice**, minimální contribution margin. **Blokuje jakékoli reálné podání.**
2. **Placené concierge validace** (Dan + operátor): oslovit 2–3 externí komoditní
   dodavatele, domluvit placené asistované zpracování nabídky; měřit čas, opravy,
   zaplacenou cenu a opakovanou ochotu platit. Shánění partnerů běží PARALELNĚ —
   nesmí blokovat krok 3 (a naopak); viz vypořádání v 99.
3. **Jeden pilot dle schopnosti dodat** (A-06, po A-00): výběr podle reálné schopnosti
   dodat; per-item sourcing dossier (dostupnost, doprava, DPH, platnost ceny, dodací
   lhůta); v rámci stropu expozice.
4. **Kódové gaty pilotu**: hard completeness gate s auditovanou výjimkou (A-01),
   feature snapshoty (A-03). Pozn.: 100% per-item review s invalidací po změně (PR #63)
   i governance kill-switch s denním AI stropem (PR #65) už NASAZENY; hash balíku
   už v manifestu cockpitu.
5. **Podat JEDNU nabídku ručně** dle runbooku (A-02 → A-07), retrospektiva (A-08),
   opravit proces — teprve pak další 2 podání. Outcome watcher (A-04) sbírá od začátku.

Paralelní rychlé akce mimo pořadí: **A-05 HLIDAC_TOKEN** (minuty) a **A-09 právní
konzultace** (zadat hned — nejdelší latence celého plánu, tři okruhy vč. GDPR/dat).

---

## 4. Kontrola úplnosti

**Ověřeno a sedí (proti kódu na `main`, 2026-07-11):** migrace 001–017 existují, 018+
volné; všechny soubory a testy odkazované v tascích existují (`lib/monitoring/*` vč.
`hlidac-client.ts` a `tender-allocation.ts`, `podani.ts`, `outcomes-store.ts`,
`web-findings-store.ts`, `nakupy-store.ts/-seed.ts`, `winprice-*`, `cost-tracker.ts`,
`inbox.ts`, `go-no-go.ts`, `pipeline-job-state.ts`); `pdf-parse` je v dependencies;
FE komponenty (SubmissionCockpit, ItemPriceCalculator, MonitoringSettings, InboxPage…)
existují. Drobnost bez dopadu: plán uvádí „227+ testů", reálně ~320 asercí ve 33 souborech.

Nálezy „K DOPLNĚNÍ" z v1 této sekce jsou ve v2 zapracované přímo v dokumentech:
registrace NEN + cash-flow guard → **A-00**; most k SaaS → rozhodnutí „managed service,
foundation až po placené validaci" (03, za vlnou F); cenový sklad → explicitně mimo
rozsah (02 „Jak číst"); zlatý set → B-03 akceptace rozdělena v1/v2; legacy `?token=`
→ **T-09**. Sekce už neobsahuje otevřené body.

---

## 5. Co se změnilo po oponentuře (v1 → v2)

Adversariální oponentura (`99-oponentura-codex.md`, verdikt REJECT nad v1, 14 nálezů)
zapracována 2026-07-12:

- **Invariant (2× CRITICAL):** human_review_rate = 100 % bez cenových prahů zakotven
  ve všech fázích (02 fáze 5, 03 §0); „hromadné potvrzení cen" přepsáno na potvrzení
  s per-item attestací — **HOTOVO a nasazeno (PR #63)**, v plánu vedeno jako fakt
  (03 C-01).
- **Business (01):** single-bidder opraven na **40 %** (EU Single Market Scoreboard
  2024, s poznámkou o metodice); top-down „40–45 tis. nabídek" nahrazen přiznáním
  chybějícího SAM + bottom-up postupem výpočtu (nový task T-08); **primární doporučení
  = placený asistovaný bid service (managed service)**, Model 0 jen omezený experiment
  s tvrdým stropem kapitálové expozice (A-00); konkurenční tvrzení změkčeno na „nebyl
  nalezen veřejně nabízený identický produkt" + doplněno bid-desk poradenství a interní
  řešení.
- **Roadmapa (02):** Fáze 1 přejmenována na „První bezvadně podaná nabídka", milníky
  rozděleny (M1 podání / M2 výhra / M3 contribution margin / M4 inkaso — výhra
  neblokuje postup); škálovací kritérium fáze 4 přepsáno z „20 nabídek denně" na
  obchodní (opakovaná platba / contribution margin / kapacita dodat); P(win) až po
  backtestu a minimu výsledků v segmentu — do té doby jen historická cenová pozice
  + interval nejistoty.
- **Implementace (03):** nový **A-00 „Připravenost entity a dodávky"** jako tvrdý
  blokátor jakéhokoli reálného podání; A-01 checklist povýšen z advisory na **hard
  gate s auditovanou per-item výjimkou** + nezávislé dvojí čtení ZD před prvním
  podáním; **základní kill-switch předsunut do B-00 a mezitím NASAZEN (PR #65** —
  governance přepínače per doména + denní strop AI nákladů; nález tím VYŘEŠEN,
  F-01 na vrstvě staví limity/audit/anomálie); GDPR/licence dat/ToS scrapingu
  (T-06 + A-09 okruh c) **před první externí pilot**; SaaS foundation odložena za
  placenou validaci (první externí zákazník = managed service); nové tasky T-08
  (SAM) a T-09 (legacy `?token=`).
- Vědomé odchylky od doslovného znění nálezů: viz sekce „Nezapracované nálezy a proč"
  na konci `99-oponentura-codex.md`.
