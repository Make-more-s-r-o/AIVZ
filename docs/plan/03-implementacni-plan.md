# Implementační plán: exekuce roadmapy krok po kroku

> Dokument plánu, část 3/N. Stav k 2026-07-11 (skóre ~55 %). Navazuje na
> `docs/plan/01-business-model.md` (business model, Model 0 + tiered SaaS) a
> `docs/plan/02-roadmapa.md` (fáze 1–5). Podklad: `docs/audit-goal-2026-07-10.md`,
> `docs/report-2026-07-11-den.md`, `docs/night2-report-2026-07-11.md`,
> `docs/night3-report-2026-07-11.md`. Cesty k souborům ověřeny přímo v repu
> (`scripts/src/`, `scripts/migrations/001–017`, `scripts/tests/`, `apps/web/src/`).
>
> **Toto je EXEKUČNÍ dokument.** Čte ho člověk nebo agent a bez dalšího kontextu ví,
> co vzít jako další úkol, kterých souborů se dotkne, jak pozná hotovo a jaké gaty
> musí projít. Tasky jsou checkboxy — odškrtávat přímo v tomto souboru (PR, který
> task dokončuje, odškrtne i checkbox).

---

## 0. Jak číst tento plán

- **Vlny A–F** = pořadí exekuce. Tasky uvnitř vlny jsou navrženy tak, aby šly dělat
  **souběžně** (dotýkají se různých souborů; kde se potkávají v `serve-api.ts`, platí
  pravidlo integrace přes společnou integrační větev — viz §9). Další vlna se otevírá,
  až drží výstupní podmínka vlny předchozí.
- Každý task má: **ID · název · proč (fáze roadmapy + dimenze audit skóre) · soubory ·
  akceptační kritérium · závislosti · velikost (S = hodiny–den, M = dny, L = týden+) ·
  rizika**.
- **MONEY-PATH** = task mění kód, kterým protéká cena, potvrzení, generování závazného
  dokumentu nebo podání. Pro tyto tasky je **adversariální oponentura povinná**
  (Fable/Opus review nad diffem, ne jen testy) a diff NIKDY nemerguje autor-agent sám.
- **Migrace**: nové SQL soubory číslovat od `018_` výš (`scripts/migrations/`),
  aplikují se automaticky při startu (`db-migrate.ts`). Dva souběžné tasky NESMÍ
  vzít stejné číslo — číslo si task rezervuje zápisem do svého checkboxu při startu
  (poučení z kolize 2× 012 v noci 3).
- **Rozdělení práce** (konzistentní s tím, jak projekt jede — viz memory a night
  reporty): **Codex gpt-5.6-sol** = bulk implementace (šetří Claude limit, bez git
  příkazů — commit dělá Claude po ověření gates); **Opus** = money-path a security
  implementace; **Sonnet** = UI, mechanické, dokumentační; **Fable** = orchestrace,
  adversariální oponentura, finální money-path soud; **Dan** = rozhodnutí, provoz,
  právo, podání.
- Klíčová fakta, která plán formují: (1) **AI cenové odhady jsou ~42 % pod trhem
  (extrém 263 %)** → verify hit-rate je podmínka ziskovosti; (2) **k dalšímu posunu
  skóre vede hlavně PROVOZ** (první reálná podání), ne kód; (3) **latence výsledků VZ
  je týdny** → sběrné mechanismy (feature logging, outcome watcher) se staví DŘÍV,
  než je jejich fáze „na řadě".

---

## 1. VLNA A — Pilot enablement („první podaná nabídka")

**Fáze roadmapy:** 1. **Cíl vlny:** vše, co potřebuje Dan k podání 2–3 reálných nabídek
bez formální vady, plus sběrné mechanismy, které se zpětně dohnat nedají.

**Výstupní podmínka vlny (blokuje otevření vlny B jen zčásti — viz pozn.):**
≥ 2 nabídky ve stavu `odeslana` s evidencí podání a immutable balíkem; 0 diskvalifikací
pro formální vadu; 100 % potvrzených cen s reálným nákupním zdrojem; výsledky (jakmile
přijdou) zapsané v `crm_vysledky`. *Pozn.: kódové tasky vlny B lze začít hned po
dokončení kódových tasků vlny A — na samotné podání (provoz, lhůty v týdnech) se
s vývojem nečeká.*

### Tasky

- [ ] **A-01 — Checklist úplnosti balíku vs. ZD** · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F1.3; největší riziko pilotu = formální diskvalifikace, ne cena. Dimenze: kvalita, business.
  - **Soubory:** nový `scripts/src/lib/bid-completeness.ts` (deterministický výtah požadovaných
    dokumentů/příloh z `analysis.json` — kvalifikace, ČP, návrh smlouvy, soupis, doklady);
    endpoint v `scripts/src/serve-api.ts` (`GET /api/tenders/:id/completeness`); napojení do
    `scripts/src/lib/podani.ts` (finalize warning při neodškrtnutém checklistu — advisory,
    ne HARD, aby nešlo o nový blokátor bez kalibrace); UI v
    `apps/web/src/components/SubmissionCockpit.tsx` (odškrtávací seznam, stav per položka);
    test `scripts/tests/bid-completeness.test.ts`.
  - **Akceptace:** na zakázce n-485400 (existující analysis v `output/`) vrátí endpoint seznam
    požadovaných dokumentů shodný s ručním čtením ZD; cockpit zobrazuje checklist a finalize
    ukáže varování, dokud není odškrtán; unit testy na parser (min. 3 reálné analysis fixtures).
  - **Závislosti:** žádné. **Velikost:** M.
  - **Rizika:** analysis nemusí obsahovat všechny požadavky (extraction gap) → checklist musí
    umět ruční přidání položky operátorem; advisory režim záměrně (fail-closed by pilot zablokoval).

- [ ] **A-02 — Runbook ručního podání NEN / profil zadavatele**
  - **Proč:** F1.4; runbook je zároveň specifikace budoucí automatizace podání (F-02 ve vlně F). Dimenze: business, provoz.
  - **Soubory:** nový `docs/runbook-podani-nen.md` (krok za krokem: přihlášení, formáty příloh,
    limity velikosti, fikce podpisu §211/7, potvrzení, okamžitý zápis evidence podání do
    cockpitu); odkaz z `apps/web/src/components/SubmissionCockpit.tsx` (link na runbook u
    tlačítka evidence podání — S dodatek).
  - **Akceptace:** Dan podle runbooku projde podání nanečisto (testovací/zrušitelný krok na NEN
    sandboxu nebo dry-run po první stránku formuláře) a nenarazí na neznámý krok.
  - **Závislosti:** žádné. **Velikost:** S (dokument). **Kdo:** Sonnet draft + **Dan verifikace na NEN** (lidský vstup nutný — přístup k účtu).
  - **Rizika:** žádné kódové; právní rámec ověřen (§211/7).

- [ ] **A-03 — Logování feature vektorů go/no-go a bid skóre** (zpětně nejde dohnat — udělat HNED)
  - **Proč:** F2.5/F3.2; bez zalogovaných vstupů skóre v momentě podání nelze později kalibrovat. Dimenze: autonomie, business.
  - **Soubory:** `scripts/src/lib/go-no-go.ts` (export feature vektoru — dnes počítá vážené
    faktory, přidat serializaci vstupů); nová migrace `scripts/migrations/018_score_snapshots.sql`
    (tabulka `crm_score_snapshots`: tender_id, typ [gonogo|bid], features JSONB, skore, created_at);
    zápis snapshotu v `scripts/src/serve-api.ts` při (a) převzetí z monitoringu, (b) finalize
    v `scripts/src/lib/podani.ts`; test `scripts/tests/score-snapshot.test.ts`.
  - **Akceptace:** po převzetí zakázky z feedu a po finalize existují řádky v
    `crm_score_snapshots` s kompletním feature vektorem (ověřit SQL dotazem na prod);
    unit test na serializaci (žádný faktor nechybí).
  - **Závislosti:** žádné. **Velikost:** S. **Kdo:** Codex implementace, Fable review (dotýká se podani.ts).
  - **Rizika:** nízká — jen append-only zápis; NEměnit výpočet skóre samotný.

- [ ] **A-04 — Outcome watcher MVP (VVZ award notice)**
  - **Proč:** F3.1 předběžně; výsledky se zveřejňují s latencí týdnů → sběr musí běžet dřív, než začne fáze 3. Dimenze: business, autonomie.
  - **Soubory:** nový `scripts/src/lib/outcome-watcher.ts` (periodický sweep: pro zakázky ve
    stavu `odeslana` dohledat výsledek přes VVZ/ISVZ award notice párováním evidenční číslo +
    IČO zadavatele; stav „zatím neznámo" bez falešných závěrů); zápis přes existující
    `scripts/src/lib/outcomes-store.ts` (NErozšiřovat schéma, `crm_vysledky` z migrace 012 stačí);
    spouštění: interní interval v `scripts/src/serve-api.ts` po vzoru reminder sweepu
    (`terminy-store.ts`); test `scripts/tests/outcome-watcher.test.ts` s HTML/JSON fixtures.
  - **Akceptace:** watcher na fixture s known-výsledkem zapíše výhru/prohru + vítěznou cenu
    do `crm_vysledky`; na fixture bez výsledku nezapíše nic; běží automaticky (log v prod
    kontejneru potvrzuje sweep bez chyb 24 h).
  - **Závislosti:** žádné (tab Výsledek + outcomes-store už existují). **Velikost:** M. **Kdo:** Codex + Fable review.
  - **Rizika:** scraping VVZ = křehké; auto-zápis výsledku je zápis do money-dat → výsledky
    z watcheru označovat `zdroj='watcher'` a v UI umožnit lidskou korekci (outcomes-store
    už rozlišuje zdroj u propisu do win_prices).

- [ ] **A-05 — HLIDAC_TOKEN na prod** (lidský krok)
  - **Proč:** F1.7; druhý zdroj feedu — dnes jediný vstup = NEN scrape (křehký). Dimenze: provoz, autonomie.
  - **Soubory:** žádný kód — `hlidac-client.ts` + `hlidac-route.ts` v
    `scripts/src/lib/monitoring/` existují a čekají na token. Jen env `HLIDAC_TOKEN`
    v `/opt/vz` na Hetzneru (`docker/docker-compose.hetzner.yml` env sekce) + restart.
  - **Akceptace:** monitoring sync stáhne zakázky i z Hlídače (log/feed ukazuje zdroj hlidac);
    fallback ověřen vypnutím NEN klienta nanečisto.
  - **Závislosti:** **Dan** — registrace na hlidacstatu.cz, získání tokenu, rozhodnutí o komerční
    licenci (api@hlidacstatu.cz). **Velikost:** S. **Rizika:** licenční — CC BY 3.0 vs. komerční užití.

- [ ] **A-06 — Výběr 2–3 pilotních zakázek** (lidský krok, **MONEY-PATH rozhodnutí**)
  - **Proč:** F1.1; vše ostatní je bez podání akademické. Dimenze: business (hlavní páka 46 → výš).
  - **Postup:** Dan v MonitoringPage (`apps/web/src/pages/MonitoringPage.tsx`) vybere z feedu
    dle go/no-go skóre: malé komoditní dodávky do ~1 M Kč, **mainstream značky** (kvůli verify
    hit-rate — pilot nemá testovat long-tail), lhůta ≥ 10 dní, dostupný sortiment.
  - **Akceptace:** 2–3 zakázky převzaté do CRM, pipeline spuštěná, rozhodnutí zapsáno
    (komentář u zakázky: proč go).
  - **Závislosti:** žádné kódové (feed žije, 63 aktuálních zakázek). **Velikost:** S (rozhodnutí). **Kdo:** výhradně **Dan**.

- [ ] **A-07 — Pilotní provoz: 100% cenová jistota + lidské QA + podání** (provoz, **MONEY-PATH**)
  - **Proč:** F1.2 + F1.5 + samotné podání. Dimenze: business, kvalita.
  - **Postup:** (1) web-verify na každou položku pilotů (`POST` verify z Ocenění; kde nenajde →
    ruční dohledání nákupní ceny e-shop/poptávka a zápis přes „Použít cenu"); (2) všechny ceny
    potvrzeny přes gate s marží ≥ company default; (3) přečíst vygenerované DOCX/PDF očima
    zadavatele, porovnat s validation reportem, **každou ruční opravu zapsat jako issue do
    `docs/bugs-and-todos.md`** (= backlog vlny B/C); (4) finalize → immutable balík → ruční
    podání dle runbooku A-02 → evidence podání v cockpitu ihned.
  - **Akceptace:** = výstupní podmínka vlny A (≥ 2 `odeslana`, 0 formálních vad, evidence úplná).
  - **Závislosti:** A-01 (checklist), A-02 (runbook), A-06 (výběr). **Velikost:** M–L (provoz, ne kód). **Kdo:** **Dan/operátor**; agent jen asistuje (dohledávání cen, kontrola).
  - **Rizika:** lhůta propadne (deadline alarm v inboxu hlídat denně); cena mimo pásmo
    (mitigace: win-price pásmo + HARD gate pod nákupem — obojí nasazeno).

- [ ] **A-08 — Retrospektiva pilotů + měření času**
  - **Proč:** F1.6; baseline „minut na nabídku" pro limit 45 min ve vlně C; backlog ručních zásahů. Dimenze: kvalita, UX.
  - **Soubory:** nový `docs/pilot-retrospektiva-01.md` (1 strana per pilot: co drhlo, kolik minut
    kde, seznam ručních oprav s odkazy na issues).
  - **Akceptace:** dokument existuje pro každý pilot; každý ruční zásah má issue v
    `docs/bugs-and-todos.md`; změřený celkový čas operátora per nabídka.
  - **Závislosti:** A-07. **Velikost:** S. **Kdo:** Dan diktuje, Sonnet zapisuje.

- [ ] **A-09 — Zadání právní konzultace (dlouhá latence — zadat TEĎ)** (lidský krok)
  - **Proč:** F5.1 má týdny–měsíce latence; blokuje vlnu F. Dva okruhy: (a) model přístupu
    k NEN účtu dodavatele (zmocnění, podmínky užití, automatizace podání); (b) odpovědnostní
    klauzule pro budoucí SaaS („nástroj = podklad, podává a odpovídá zákazník"). Dimenze: business, autonomie.
  - **Akceptace:** poptávka odeslána právníkovi; otázky písemně (draft připraví agent do
    `docs/pravni-dotazy-podani.md`); odpověď = vstupní podmínka vlny F.
  - **Závislosti:** žádné. **Velikost:** S (zadání). **Kdo:** **Dan** (výběr právníka, odeslání).

### Rozdělení práce vlny A
| Kdo | Tasky |
|---|---|
| Codex (bulk) | A-03, A-04, části A-01 (parser + endpoint) |
| Opus/Fable (money-path + oponentura) | A-01 review, A-03/A-04 review (sahají do podani/outcomes) |
| Sonnet (UI/doc) | A-01 cockpit UI, A-02 draft, A-08 zápis |
| **Dan (nenahraditelný)** | A-05 token, A-06 výběr, A-07 podání, A-09 právník, A-02 verifikace na NEN |

---

## 2. VLNA B — Verify hit-rate a kvalita matchingu (podmínka ziskovosti)

**Fáze roadmapy:** 2 (jádro). **Cíl vlny:** verify hit-rate ≥ 70 % položek s reálným
nákupním zdrojem (dnes ~0 % u long-tail, mainstream OK) a měřitelná match precision.
Tohle je hlavní KÓDOVÁ práce nejbližších týdnů — přímý důsledek nálezu „AI odhady
−42 % pod trhem".

**Vstupní podmínka:** kódové tasky vlny A hotové (A-01, A-03, A-04). Pilotní podání
(A-07) může běžet souběžně. **Výstupní podmínka:** hit-rate ≥ 70 % na zlatém setu
(B-03), match precision změřená, auto-run-all žije.

### Tasky

- [ ] **B-01 — Povinná identifikace kandidáta (výrobce + model / katalogové číslo)** · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F2.1; živý test 0/4 verify nálezů byl způsoben vágními kandidáty bez skutečných
    katalogových čísel — verify je jen tak dobrý, jak dobrá jsou identifikační data. Dimenze: kvalita.
  - **Soubory:** `scripts/src/prompts/` (product-match prompt: povinná pole `vyrobce`, `model`,
    `katalogove_cislo` s instrukcí „NEVYMÝŠLET — pokud neznáš, nech prázdné a sniž spolehlivost");
    `scripts/src/match-product.ts` (schema + penalizace kandidátů bez identifikace: forcenutá
    `cena_spolehlivost: nizka`, nikdy `vysoka` bez modelu); `scripts/src/lib/price-sanity.ts`
    (nové WARN pravidlo `genericky_kandidat`); testy `scripts/tests/` (rozšířit
    `price-sanity.test.ts`, nový `match-identification.test.ts`).
  - **Akceptace:** re-run match na n-485400: ≥ 80 % kandidátů má vyplněného výrobce+model
    NEBO je viditelně flagnutý jako generický; žádný generický kandidát nemá `vysoka`
    spolehlivost; unit testy na penalizaci; **živý přeměřený běh na prod** (vzor night3 §3).
  - **Závislosti:** žádné. **Velikost:** M. **Kdo:** Opus implementace (prompt = money-path), Fable oponentura + živé ověření.
  - **Rizika:** prompt změna může zhoršit jiné vlastnosti matche → regression přes zlatý set
    B-03 (dělat B-03 první nebo souběžně); riziko halucinace katalogových čísel → instrukce
    „nech prázdné" + verify B-02 je ověří proti webu.

- [ ] **B-02 — Verify fallback řetěz** · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F2.2; hlavní páka na hit-rate ≥ 70 %. Dimenze: kvalita, business.
  - **Soubory:** `scripts/src/lib/price-verifier.ts` (1153 řádků — řetěz dotazů: 1. katalogové
    číslo → 2. výrobce+model → 3. generický ekvivalent kategorie; každý nález nese `uroven_jistoty`
    [presna_shoda|model|ekvivalent]; ekvivalent NIKDY neprochází jako automatický zdroj — jen
    návrh s vyznačením); `scripts/src/verify-prices.ts` (CLI průchod); kontrakt `overeni_ceny`
    zachovat (testy `product-match-overeni-schema.test.ts` musí projít beze změny sémantiky);
    UI badge úrovně jistoty v `apps/web/src/components/ItemPriceCalculator.tsx`;
    test `scripts/tests/price-verifier.test.ts` (rozšířit o řetěz).
  - **Akceptace:** na zlatém setu (B-03) hit-rate ≥ 70 % položek má aspoň 1 nákupní zdroj;
    úroveň jistoty se propisuje do UI a do `warehouse_web_findings`; „ekvivalent" nikdy
    automaticky nenastaví cenu (jen po explicitním „Použít cenu" operátora); náklad verify
    per položka změřen a zalogován přes `cost-tracker.ts`.
  - **Závislosti:** B-01 (bez katalogových čísel řetěz nemá vstup). **Velikost:** M–L. **Kdo:** Opus, Fable oponentura.
  - **Rizika:** web_search náklady rostou s délkou řetězu → cap 2–3 dotazy/položka; ekvivalentní
    produkt může nesplňovat spec zadání → propojit se spec-compliance výstupem (advisory flag).

- [ ] **B-03 — Zlatý set + měření match precision a verify hit-rate**
  - **Proč:** F2.1 měřicí část; bez čísla se B-01/B-02 nedají přijmout ani regresně hlídat. Dimenze: kvalita, provoz.
  - **Soubory:** nový `scripts/tests/fixtures/golden-set/` (20–40 položek z pilotů a historických
    zakázek s ručně ověřeným správným kandidátem + reálnou nákupní cenou — čerpat z A-07/A-08);
    nový `scripts/src/eval-match.ts` (CLI: spustí match+verify nad setem, spočítá precision,
    hit-rate, MAPE cen vs. ověřená realita); report do `output/eval/`; npm script `eval` v
    `scripts/package.json`.
  - **Akceptace:** `npm run eval` vypíše precision/hit-rate/MAPE; čísla PŘED a PO B-01+B-02
    zapsaná v PR popisu (důkaz zlepšení); set verzovaný v repu (bez osobních údajů — pozor,
    `input/` je v .gitignore záměrně, fixtures anonymizovat).
  - **Závislosti:** aspoň částečná data z A-07 (ručně ověřené ceny pilotů); jinak start
    z historických zakázek. **Velikost:** M. **Kdo:** Codex implementace, Sonnet sběr fixtures, Fable definice metrik.
  - **Rizika:** eval běhy stojí AI peníze (~des. Kč/běh) → spouštět ručně, ne v CI; malý set
    = šum → interpretovat směr, ne desetiny procent.

- [ ] **B-04 — Web-findings jako řízená cache**
  - **Proč:** F2.2 doplněk; opakované verify téže položky (re-run, podobné zakázky) nemá platit
    znovu. Dimenze: provoz (náklady), kvalita.
  - **Soubory:** `scripts/src/lib/web-findings-store.ts` (lookup podle katalogové číslo/
    výrobce+model + stáří nálezu); `scripts/src/lib/price-verifier.ts` (před web_search zkusit
    cache; nález starší než TTL — návrh 14 dní — jen jako hint, ne jako zdroj); **matching sklad
    nadále NEČTE** (zachovat oddělení — kontaminace matchingu cache nálezy je známý anti-pattern
    z PR #53); test `scripts/tests/web-findings-store.test.ts` (rozšířit).
  - **Akceptace:** druhý verify stejné položky do TTL nevolá web_search (ověřit cost logem);
    starý nález se zobrazí jako „historický nález" s datem, ne jako čerstvý zdroj.
  - **Závislosti:** B-02 (úroveň jistoty ve schématu). **Velikost:** S–M. **Kdo:** Codex, review Fable (money-adjacent: cache nesmí obejít HARD gate pod nákupem — gate počítá vždy z aktuálně použitého zdroje).
  - **Rizika:** stale cena z cache → TTL + viditelné datum + gate zůstává na potvrzení.

- [ ] **B-05 — Auto-run-all po převzetí z monitoringu**
  - **Proč:** F2.3; checkpoint `waiting_approval` už existuje a je fail-closed → nízké riziko,
    velká úspora klikání. Dimenze: autonomie, UX.
  - **Soubory:** `scripts/src/lib/monitoring/tender-allocation.ts` (po převzetí + úspěšném
    zd-download enqueue run-all jobu); `scripts/src/lib/pipeline-job-state.ts` (bez změny
    sémantiky — jen nový initiator `monitoring`); volitelný přepínač v
    `apps/web/src/components/MonitoringSettings.tsx` („spouštět pipeline automaticky",
    default ON); test `scripts/tests/monitoring-tender-allocation.test.ts` (rozšířit).
  - **Akceptace:** převzetí zakázky z feedu bez dalšího kliknutí doběhne do `waiting_approval`
    (nepotvrzené ceny čekají na člověka); generate se BEZ potvrzení nespustí (existující hard
    fail — regression test); ověřeno na prod na 1 živé zakázce.
  - **Závislosti:** žádné. **Velikost:** S. **Kdo:** Codex, Fable smoke na prod.
  - **Rizika:** automaticky spuštěné joby žerou AI kredit na irelevantních zakázkách →
    spouštět jen při převzetí (lidské rozhodnutí), NE plošně na celý feed (to až F-04 po kalibraci).

- [ ] **B-06 — Fill miss-rate metrika + review nevyplněných slotů**
  - **Proč:** F2.7; historicky 30–40 % miss-rate šablon; každý miss = ruční práce proti limitu
    45 min/nabídka. Dimenze: kvalita, UX.
  - **Soubory:** `scripts/src/lib/template-engine.ts` + `scripts/src/lib/reconstruct-engine.ts`
    (počítat vyplněné/nevyplněné sloty per dokument, výsledek do generate výstupu);
    `scripts/src/lib/doc-slots.ts` (evidence slotů); zobrazení v
    `apps/web/src/components/ValidationReport.tsx` nebo `DocumentList.tsx` (seznam nevyplněných
    slotů s kontextem — operátor vidí, CO musí doplnit ručně, místo hledání v DOCX);
    test `scripts/tests/` nový `fill-miss-rate.test.ts`.
  - **Akceptace:** po generate je u každého dokumentu vidět „vyplněno X/Y slotů" + seznam
    missů; metrika se loguje (podklad pro trend); na pilotních zakázkách miss-rate změřen.
  - **Závislosti:** žádné. **Velikost:** M. **Kdo:** Codex engine část, Sonnet UI, review Fable (dotýká se generovaných závazných dokumentů — čtení/reporting only, ne změna fill logiky → bez plné oponentury, pokud diff nemění co se vyplňuje).
  - **Rizika:** falešné missy (slot legitimně prázdný) → kategorie „nepovinný slot".

### Rozdělení práce vlny B
| Kdo | Tasky |
|---|---|
| Opus (money-path impl.) | B-01, B-02 |
| Codex (bulk) | B-03 harness, B-04, B-05, B-06 engine |
| Sonnet (UI/sběr) | B-02 badge, B-03 fixtures, B-06 UI |
| Fable (oponentura + živá verifikace) | B-01, B-02, B-04 review; živé prod přeměření B-01/B-02 |
| Dan | dodá ručně ověřené ceny pilotů do zlatého setu (z A-07); rozhodne TTL cache a cap verify nákladů |

---

## 3. VLNA C — Poloautomat: operátorský UX + observabilita

**Fáze roadmapy:** 2 (dokončení). **Cíl vlny:** jeden operátor zvládne 5–10 nabídek
denně; systém má čísla (cost, latence, throughput) místo pocitů.

**Vstupní podmínka:** vlna B hotová (hit-rate drží), backlog z pilotních retrospektiv
(A-08) zapracovaný do priorit. **Výstupní podmínka:** čas operátora ≤ 45 min/nabídka
(měřeno vs. baseline z A-08); prokázaný den s ≥ 5 připravenými nabídkami; cost/throughput
viditelné na jedné obrazovce.

### Tasky

- [ ] **C-01 — Inbox jako pracovní plocha (bulk akce)** · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F2.4; dnes vše žije v detailu jedné zakázky — limit pro 5–10/den. Dimenze: UX (60 → 75+).
  - **Soubory:** `scripts/src/lib/inbox.ts` (agregace akcí — přidat akční payloady);
    `scripts/src/serve-api.ts` (bulk endpointy: potvrdit ceny přes existující
    `price-confirmation.ts` — NIKDY neobcházet gate, spustit generate, finalize);
    `apps/web/src/pages/InboxPage.tsx` (výběr řádků, bulk tlačítka, řazení lhůta × skóre,
    potvrzovací dialog s částkami — vzor ludone-money-ux); testy `scripts/tests/inbox.test.ts`
    (rozšířit) + `price-confirmation.test.ts` (bulk cesta přes gate).
  - **Akceptace:** z inboxu lze bez otevření detailu: potvrdit ceny vybraných zakázek (gate
    409 se propaguje per zakázka, ne all-or-nothing), spustit generate, finalize; HARD flag
    zakázku z bulk potvrzení VYŘADÍ (nikdy tichý průchod); E2E Playwright scénář bulk potvrzení.
  - **Závislosti:** žádné tvrdé. **Velikost:** M. **Kdo:** Opus BE (bulk přes gate = money-path), Sonnet FE, Fable oponentura.
  - **Rizika:** bulk potvrzení je nejnebezpečnější UI v systému (one-click k mnoha závazným
    cenám) → dialog musí ukázat součet, počet nepotvrzených, HARD/WARN flagy; známý bug-vzor
    „desync draftu s hromadným potvrzením" (PR #53) — regression test povinný.

- [ ] **C-02 — Cost + throughput agregace**
  - **Proč:** F2.6; cost-tracker je per zakázka, chybí agregace/trend. Dimenze: provoz (50 → 70).
  - **Soubory:** `scripts/src/lib/cost-tracker.ts` (agregační funkce den/týden/měsíc/zakázka —
    test `costs-aggregate.test.ts` už existuje, rozšířit); endpoint
    `GET /api/costs/summary` v `scripts/src/serve-api.ts`; widget v
    `apps/web/src/pages/PrehledPage.tsx` (AI spend dnes/měsíc, Kč/CN, trend).
  - **Akceptace:** Přehled ukazuje spend dnes/tento měsíc a průměr Kč/CN; čísla souhlasí
    s ručním součtem cost logů na prod.
  - **Závislosti:** žádné. **Velikost:** S–M. **Kdo:** Codex BE, Sonnet FE.

- [ ] **C-03 — Denní AI strop s degradací**
  - **Proč:** F2.6/F4.4 předběžně; vyčerpaný kredit už jednou tiše položil prod (audit). Dimenze: provoz.
  - **Soubory:** `scripts/src/lib/cost-tracker.ts` (kontrola denního stropu z env
    `AI_DAILY_BUDGET_CZK`); `scripts/src/lib/ai-client.ts` (guard před voláním: nad 80 % stropu
    → Slack warn přes existující watchdog kanál, nad 100 % → nové joby se nezakládají,
    běžící checkpointované doběhnou); `scripts/src/lib/pipeline-job-state.ts` (nový stav/důvod
    `budget_paused`); test `scripts/tests/ai-budget.test.ts`.
  - **Akceptace:** simulovaný přešvih stropu (nízký testovací budget) → nový run-all se
    odmítne s čitelnou chybou v UI, Slack alert odešel; po půlnoci (reset) jde spustit.
  - **Závislosti:** C-02 (agregace = zdroj čísla). **Velikost:** M. **Kdo:** Codex, review Fable (fail-closed sémantika).
  - **Rizika:** strop nesmí zabít rozpracovaný job uprostřed match dávky → pauza na hranici
    kroku, ne uprostřed.

- [ ] **C-04 — Latence per pipeline krok**
  - **Proč:** F2.6; hrdla pro 5–10/den potřebují číslo. Dimenze: provoz.
  - **Soubory:** `scripts/src/lib/pipeline-job-state.ts` (timestampy start/end per krok — stav
    už je persistentní); expose v `GET /api/.../jobs` odpovědích; zobrazení v
    `apps/web/src/components/PipelineStatus.tsx` (trvání kroků).
  - **Akceptace:** u doběhlé zakázky vidím trvání extract/analyze/match/generate/validate;
    data zpětně dostupná pro C-02 widget.
  - **Závislosti:** žádné. **Velikost:** S. **Kdo:** Codex.

- [ ] **C-05 — Ruční revize vah go/no-go z pilotů** (lidský vstup)
  - **Proč:** F2.5; ještě NE auto-kalibrace (malý vzorek) — jen ruční sanity: stálo skóre
    za práci? Dimenze: business, autonomie.
  - **Soubory:** `scripts/src/lib/go-no-go.ts` (váhy vytáhnout do konfigurovatelné konstanty /
    env, aby revize neznamenala zásah do logiky); `scripts/tests/go-no-go.test.ts` (rozšířit
    o konfigurovatelnost); zápis rozhodnutí do `docs/pilot-retrospektiva-01.md`.
  - **Akceptace:** Dan porovnal skóre pilotů s realitou a váhy potvrdil/upravil; změna vah
    = config change s testem, ne rewrite.
  - **Závislosti:** A-08 (retrospektiva), A-03 (snapshoty). **Velikost:** S. **Kdo:** **Dan** rozhodnutí + Codex config refactor.

- [ ] **C-06 — Backlog z pilotů (placeholder — konkretizuje A-08)**
  - **Proč:** retrospektivy vygenerují konkrétní vady dokumentů/UX, které nelze naplánovat
    předem. Rezervovaná kapacita ~20 % vlny C. Dimenze: kvalita, UX.
  - **Postup:** issues z `docs/bugs-and-todos.md` označené `pilot` seřadit dle (minuty ušetřené
    per nabídka) / pracnost a odbavovat; každý fix = samostatný malý PR.
  - **Akceptace:** všechny `pilot` issues s dopadem > 5 min/nabídka zavřené nebo vědomě odložené.
  - **Závislosti:** A-08. **Velikost:** M (souhrnně). **Kdo:** Codex/Sonnet dle povahy.

### Rozdělení práce vlny C
| Kdo | Tasky |
|---|---|
| Opus | C-01 backend (bulk přes gate) |
| Codex | C-02, C-03, C-04, C-05 refactor, C-06 |
| Sonnet | C-01 FE, C-02 widget |
| Fable | C-01 oponentura (povinná), C-03 fail-closed review |
| Dan | C-05 revize vah; průběžný provoz 5–10/den (generuje data pro vlnu D) |

---

## 4. VLNA D — Feedback smyčka (stroj se učí)

**Fáze roadmapy:** 3. **Cíl vlny:** win-rate se měří automaticky, skóre a ceny se
kalibrují z reálných výher/proher.

**Vstupní podmínka:** ≥ 10–20 podaných nabídek se zapsaným výsledkem (výstup PROVOZU
vlny C — kalendářně to znamená, že vlna D kódově začíná dřív, ale AKCEPTUJE se až
s daty); feature snapshoty z A-03 se sbírají od vlny A. **Výstupní podmínka:** watcher
dohledá ≥ 80 % výsledků bez ručního zásahu; skóre má změřenou přesnost (bucket analýza);
P(win) panel v Ocenění; automatický rozpad delta vs. vítěz u proher.

### Tasky

- [ ] **D-01 — Outcome watcher: plné pokrytí**
  - **Proč:** F3.1; MVP z A-04 (VVZ) rozšířit na Registr smluv + NEN detail zakázky. Dimenze: business, autonomie.
  - **Soubory:** `scripts/src/lib/outcome-watcher.ts` (zdroje: Registr smluv API — klient
    logika příbuzná `scripts/src/fetch-win-prices.ts`; NEN detail přes
    `scripts/src/lib/monitoring/nen-client.ts`); dedup výsledků ze 3 zdrojů (priorita:
    ruční > VVZ > RS > NEN); testy rozšířit.
  - **Akceptace:** na podaných zakázkách z vln A–C dohledáno ≥ 80 % výsledků bez ručního
    zásahu (měřeno vůči ručně známým výsledkům); konfliktní zdroje řeší priorita, ne přepis.
  - **Závislosti:** A-04; reálné podané zakázky. **Velikost:** M. **Kdo:** Codex, Fable review.

- [ ] **D-02 — Kalibrační report skóre („skóre vs. realita")**
  - **Proč:** F3.2; go/no-go je zatím teorie — párování snapshotů (A-03) s outcomes. Dimenze: business, autonomie.
  - **Soubory:** nový `scripts/src/lib/score-calibration.ts` (bucket analýza: podíl výher per
    skóre pásmo; návrh úpravy vah — POUZE návrh, nikdy auto-apply); endpoint
    `GET /api/outcomes/calibration`; zobrazení v `apps/web/src/pages/PrehledPage.tsx`
    (vedle win-rate widgetu); test `scripts/tests/score-calibration.test.ts` na syntetických datech.
  - **Akceptace:** report ukazuje bucket analýzu z reálných dat; návrh nových vah vzniká
    s upozorněním „vzorek N=X, konzervativně"; váhy mění člověk přes C-05 mechanismus.
  - **Závislosti:** A-03, D-01, ≥ 10 outcomes. **Velikost:** M. **Kdo:** Codex + Fable review metodiky (statistika na malém vzorku svádí k nesmyslům).
  - **Rizika:** kalibrace na < 30 výsledcích může být horší než ruční váhy → plná automatika
    až od ~50 výsledků (tvrdě zakódovaný práh pro auto-návrhy).

- [ ] **D-03 — Price-to-win model (P(win) × marže panel)** · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F3.3; jádro konkurenční výhody — pozice naší ceny ve win-price pásmu → odhad
    P(win), operátor vidí trade-off marže × pravděpodobnost. Dimenze: business (46 → 65+).
  - **Soubory:** `scripts/src/lib/winprice-query.ts` + `scripts/src/lib/winprice-api.ts`
    (percentil pozice ceny v pásmu kategorie); nový `scripts/src/lib/price-to-win.ts`
    (empirická P(win) křivka z pásma + outcomes; **doporučená cena je VŽDY návrh, NIKDY
    auto-přepis** — potvrzení jde dál výhradně přes `price-confirmation.ts` gate);
    UI panel v `apps/web/src/components/ItemPriceCalculator.tsx` / záložce Ocenění v
    `apps/web/src/pages/TenderDetailPage.tsx` (slider marže → P(win) + očekávaný zisk);
    test `scripts/tests/price-to-win.test.ts`.
  - **Akceptace:** u zakázky s dostupným pásmem vidí operátor: naše cena je na X. percentilu,
    odhad P(win) Y %, očekávaná hodnota (P(win) × zisk) pro 3 scénáře marže; žádná cesta
    v kódu nezapisuje doporučenou cenu bez lidského potvrzení (oponentura to explicitně hledá);
    unit testy na percentily a hrany (prázdné pásmo, n < 5 → „nedostatek dat", ne falešné číslo).
  - **Závislosti:** D-04 zvyšuje kvalitu (hustší pásma), ale neblokuje. **Velikost:** L. **Kdo:** Opus, Fable oponentura povinná.
  - **Rizika:** falešná přesnost („P(win) 73 %" z n=8) → povinné zobrazení n a intervalu;
    UI nesmí vyvolat dojem garantované výhry.

- [ ] **D-04 — Win-price obohacení (PDF backfill + počet uchazečů)**
  - **Proč:** F3.4; dnes ~10k záznamů, 6,4k s cenou, položkové ceny chybí — hustší pásma =
    lepší P(win) i go/no-go proximity. Dimenze: business.
  - **Soubory:** `scripts/src/fetch-win-prices.ts` (stahování PDF příloh smluv z Registru);
    nový `scripts/src/backfill-win-prices.ts` (AI extrakce položkových cen z PDF —
    `pdf-parse` je v dependencies, extrakce přes `ai-client.ts` levným modelem); počet
    uchazečů z VVZ award notice (sdílet parser s outcome-watcherem D-01); migrace
    `019_winprice_items.sql` (položkové ceny jako child tabulka, NEpřepisovat agregáty);
    `scripts/src/lib/winprice-store.ts` (zápis); testy `winprice-derive.test.ts` rozšířit.
  - **Akceptace:** ≥ 1 000 smluv s položkovými cenami v DB; pásma pro top-3 kategorie
    (it_av, nářadí, servery) viditelně hustší (n před/po v PR popisu); dirty data
    (nesmyslné jednotkové ceny) filtrována sanity pravidly z `price-sanity.ts` vzoru.
  - **Závislosti:** žádné tvrdé (paralelizovatelné s D-01–03). **Velikost:** L. **Kdo:** Codex (bulk extrakce) + Sonnet (běhy/monitoring), Fable spot-check kvality extrakce.
  - **Rizika:** AI extrakce z PDF = nový zdroj chyb v cenových datech → záznamy značit
    `zdroj='pdf_backfill'` + spolehlivost, robustní mediány; **GDPR režim Registru smluv**
    (mazání znepřístupněných záznamů) — viz T-06, řešit před komerčním užitím dat.

- [ ] **D-05 — Ztrátová analýza (proč prohráváme)**
  - **Proč:** F3.5; levné, vysoká informační hodnota pro Dana. Dimenze: business.
  - **Soubory:** `scripts/src/lib/outcomes-store.ts` (u prohry: delta naše vs. vítězná cena,
    per položka kde dostupné z D-04); UI v tabu Výsledek (`apps/web/src/pages/TenderDetailPage.tsx`)
    + agregovaný řádek ve win-rate widgetu (`PrehledPage.tsx`); test `outcomes-stats.test.ts` rozšířit.
  - **Akceptace:** u každé prohry s known vítěznou cenou vidím % odchylku celkem (a per
    položka, kde data jsou); agregát „průměrná odchylka od vítěze" v Přehledu.
  - **Závislosti:** D-01 (výsledky), volně D-04. **Velikost:** S. **Kdo:** Codex + Sonnet UI.

### Rozdělení práce vlny D
| Kdo | Tasky |
|---|---|
| Opus | D-03 (money-path jádro) |
| Codex | D-01, D-02, D-04, D-05 |
| Sonnet | UI části D-03/D-05, běhy backfillu |
| Fable | D-03 oponentura povinná; D-02 metodika; D-04 spot-check |
| Dan | interpretace kalibračního reportu; rozhodnutí o úpravě vah; rozhodnutí GDPR/licence dat (T-06) |

---

## 5. VLNA E — Škálování (desítky denně)

**Fáze roadmapy:** 4. **Cíl vlny:** ≥ 20 CN/den (převzetí → submit-ready) při ≤ 2 h
lidského času; ≥ 3 zdroje feedu; deploy nepřeruší žádný job.

**Vstupní podmínka:** metriky vlny C drží ≥ 1 měsíc provozu; D-01 watcher běží;
**rozhodnutí Dana o zdrojích** (komerční licence Hlídač? TED? profily?).

### Tasky

- [ ] **E-01 — Postgres-backed worker fronta** · migrace + **oponentura povinná** (infra money-adjacent)
  - **Proč:** F4.2; dnešní 2-slot in-proc fronta je strop; deploy zabíjí joby (známý gap). Dimenze: průchodnost (68 → 85+), provoz.
  - **Soubory:** migrace `020_job_queue.sql` (jobs tabulka: stav, priorita = f(lhůta, go/no-go),
    retry count, worker lease s heartbeat); nový `scripts/src/worker.ts` (N workerů, samostatný
    proces, `FOR UPDATE SKIP LOCKED` claim, retry/backoff, graceful drain na SIGTERM);
    `scripts/src/lib/pipeline-job-state.ts` (adaptace na DB-backed stav — zachovat
    `waiting_approval` sémantiku BEZE změny); `scripts/src/serve-api.ts` (enqueue místo
    spawn; job status čte z DB); `Dockerfile` + `docker/docker-compose.hetzner.yml`
    (nová service `vz-worker`, sdílená DB a `output/` volume); testy: nový
    `scripts/tests/job-queue.test.ts` + stávající `pipeline-job-state.test.ts` musí projít.
  - **Akceptace:** deploy (restart obou kontejnerů) uprostřed běžícího match jobu → job po
    startu workera pokračuje/restartuje krok, nic se neztratí (živý test na prod);
    2 workery zpracují 4 zakázky paralelně s per-tender serializací; `waiting_approval`
    chování identické (regression E2E).
  - **Závislosti:** žádné kódové; rozhodnutí o upsize VPS pokud RAM nestačí (**Dan**). **Velikost:** L. **Kdo:** Opus návrh + implementace jádra, Codex obvod, Fable oponentura (ztráta/duplikace jobu = ztráta peněz nebo dvojité AI náklady).
  - **Rizika:** nejrizikovější infra změna plánu — dvojí spuštění téhož kroku (duplicitní AI
    spend, přepis výstupů) → lease + idempotence kroků; migrace za provozu → feature flag
    `QUEUE_BACKEND=pg|memory` s postupným přepnutím.

- [ ] **E-02 — Více zdrojů feedu (Hlídač aktivní + TED + profily zadavatelů)**
  - **Proč:** F4.1; NEN scrape = jediný, křehký vstup. Dimenze: autonomie, průchodnost.
  - **Soubory:** `scripts/src/lib/monitoring/hlidac-client.ts` (aktivace — token z A-05);
    nový `scripts/src/lib/monitoring/ted-client.ts` (TED API v3, nadlimitní, bez auth);
    nový `scripts/src/lib/monitoring/profily-client.ts` (XML dle vyhl. 345/2023 pro vybrané
    profily zadavatelů); `scripts/src/lib/monitoring/monitoring-sync.ts` (multi-source sync);
    dedup přes evidenční číslo + normalizovaný hash názvu v
    `scripts/src/lib/monitoring/monitoring-store.ts`; testy `monitoring-store.test.ts` rozšířit
    + nové fixtures.
  - **Akceptace:** feed obsahuje zakázky ze ≥ 3 zdrojů se zdrojovým badge; stejná zakázka
    ze 2 zdrojů = 1 řádek (dedup test); výpadek jednoho zdroje nezastaví sync ostatních.
  - **Závislosti:** A-05 (token); rozhodnutí Dana o TED/profilech (náklad vs. pokrytí). **Velikost:** M–L. **Kdo:** Codex (klienti = mechanické), Fable review dedupu (tichá ztráta zakázky = ušlý zisk → radši duplicita než ztráta).

- [ ] **E-03 — Ranní triáž view + hromadný operátorský režim**
  - **Proč:** F4.3; cíl: člověk rozhoduje go/no-go frontu za 10 minut, nekliká detaily. Dimenze: UX, autonomie.
  - **Soubory:** `apps/web/src/pages/InboxPage.tsx` + `MonitoringPage.tsx` (view „ranní triáž":
    nové zakázky seřazené dle skóre × lhůta, klávesy g/n/z = go/no-go/zvážit, dávkové převzetí);
    BE: bulk převzetí v `scripts/src/lib/monitoring/tender-allocation.ts` (atomicita per
    zakázka — TOCTOU vzor už řešen v PR #50, zachovat).
  - **Akceptace:** 20 nových zakázek lze roztřídit < 10 min bez otevření detailu (změřit);
    převzaté rovnou startují auto-run-all (B-05).
  - **Závislosti:** B-05, C-01. **Velikost:** M. **Kdo:** Sonnet FE, Codex BE.

- [ ] **E-04 — Model tiering (levná triáž)**
  - **Proč:** F4.4; při desítkách/den je spend řiditelný náklad — analyze/triáž levným modelem,
    money-kroky silným. Dimenze: provoz.
  - **Soubory:** `scripts/src/lib/ai-client.ts` (per-úloha model config: triáž/summary → haiku,
    match/generate → sonnet; env override `AI_MODEL_*`); `scripts/src/lib/cost-tracker.ts`
    (spend per model); vyhodnocení na zlatém setu B-03, že levný model NEdegraduje match.
  - **Akceptace:** triáž nové zakázky stojí < 2 Kč; eval na zlatém setu beze změny precision
    u money-kroků (ty tiering nemění).
  - **Závislosti:** B-03 (eval), C-02/C-03. **Velikost:** M. **Kdo:** Codex, Fable eval review.
  - **Rizika:** plíživá degradace kvality levným modelem → tiering NIKDY na match/pricing.

- [ ] **E-05 — SLA/throughput dashboard**
  - **Proč:** F4.5; jedna obrazovka zdraví mašiny — „kolik to žere / kolik to nese". Dimenze: provoz (50 → 70+).
  - **Soubory:** endpoint `GET /api/ops/dashboard` v `scripts/src/serve-api.ts` (agregace:
    fronta, latence per krok z C-04, verify hit-rate trend, denní počty CN, spend z C-02,
    outcome pipeline); nová sekce v `apps/web/src/pages/PrehledPage.tsx` nebo samostatná
    OpsPage; volitelně Slack denní digest přes existující watchdog.
  - **Akceptace:** obrazovka odpovídá na: kolik CN dnes/týden, kde je hrdlo, kolik stojí den,
    hit-rate trend; čísla ověřena proti DB.
  - **Závislosti:** C-02, C-04; data z provozu. **Velikost:** M. **Kdo:** Codex BE, Sonnet FE (dataviz dle interního stylu).

### Rozdělení práce vlny E
| Kdo | Tasky |
|---|---|
| Opus | E-01 jádro fronty |
| Codex | E-02, E-04, E-05 BE, E-03 BE |
| Sonnet | E-03 FE, E-05 FE |
| Fable | E-01 oponentura povinná, E-02 dedup review, E-04 eval |
| Dan | rozhodnutí: zdroje feedu (licence Hlídač, TED, které profily), upsize VPS, denní budget |

---

## 6. VLNA F — Autonomie (podání + auto-triáž + governance)

**Fáze roadmapy:** 5. **Cíl vlny:** člověk dělá jen go/no-go a schvaluje nákupy;
podání asistovaně (člověk kliká finální Odeslat), plná automatika jen kde je API
a track record.

**Vstupní podmínka (TVRDÁ):** právní konzultace z A-09 uzavřená (model přístupu
k NEN účtu); kalibrovaný go/no-go (D-02, ≥ 50 outcomes pro auto-triáž); stabilní
throughput z vlny E. **Bez uzavřené právní otázky se F-02/F-03 NEZAČÍNÁ.**

### Tasky

- [ ] **F-01 — Governance a fail-safe vrstva** (stavět PRVNÍ, před jakoukoli autonomní akcí) · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F5.6; autonomie bez brzd je u peněz nepřijatelná (stejný princip jako LuDone
    money-path: kill-switch, limity, audit). Dimenze: provoz, autonomie.
  - **Soubory:** nový `scripts/src/lib/autonomy-guard.ts` (env kill-switch
    `AUTONOMY_ENABLED`, denní limit počtu podání a součtu Kč bez schválení, anomálie alarm —
    cena mimo 2σ pásma prošla gatem); migrace `021_audit_log.sql` (append-only audit každé
    autonomní akce: kdo/co/kdy/vstupy); integrace do `podani.ts`, `tender-allocation.ts`,
    budoucí submit cesty; Slack alert přes watchdog; testy `autonomy-guard.test.ts`.
  - **Akceptace:** kill-switch flip → žádná autonomní akce neproběhne (503, NIKDY tichý
    fallback na provedení); limity vynuceny s testem; audit log neobsahuje mezery (každá
    akce F-02/F-04/F-05 zapisuje).
  - **Závislosti:** žádné kódové — schválně první task vlny. **Velikost:** M. **Kdo:** Opus, Fable oponentura.

- [ ] **F-02 — Asistované podání NEN (UI automatizace)** · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F5.2; NEN nemá veřejné podávací API → Playwright automatizace formuláře podle
    runbooku A-02; člověk kliká finální „Odeslat". Dimenze: autonomie (40 → 80), business.
  - **Soubory:** nový `scripts/src/lib/submission/nen-submitter.ts` (Playwright — dependency
    už v repu pro E2E; kroky z runbooku, dry-run režim = vyplnit vše, zastavit před odesláním,
    screenshot); evidence (screenshoty, čas) do cockpitu přes `podani.ts`; UI v
    `SubmissionCockpit.tsx` („Připravit podání" → review → člověk potvrdí v prohlížeči);
    kredence NEN výhradně env/secret, NIKDY DB ani git.
  - **Akceptace:** dry-run na reálné zakázce vyplní formulář kompletně a správně (lidská
    kontrola proti runbooku), screenshot evidence v balíku; ostré podání proběhne s člověkem
    u finálního kliku; F-01 audit log záznam.
  - **Závislosti:** **A-09 právní závěr (blokující)**, A-02 runbook, F-01. **Velikost:** L. **Kdo:** Opus, Fable oponentura + Dan u každého ostrého podání (ze zákona/z opatrnosti).
  - **Rizika:** změna NEN UI rozbije podání v nejhorší moment → dry-run před KAŽDÝM ostrým
    podáním + fallback ruční runbook; reputační riziko vadného podání → asistovaný režim
    natrvalo, dokud track record neřekne jinak.

- [ ] **F-03 — Průzkum API podání ostatních portálů (E-ZAK, Tender arena, Josephine)**
  - **Proč:** F5.3; pokrytí portálů rozhodne, kolik % podání jde plně automatizovat. Dimenze: autonomie.
  - **Soubory:** výstup = `docs/pruzkum-podani-portaly.md` (per portál: API ano/ne, podmínky,
    autentizace, pilot proveditelnost); kód až po závěru.
  - **Akceptace:** dokument s doporučením a odhadem pokrytí % našich zakázek per portál.
  - **Závislosti:** A-09. **Velikost:** M (research). **Kdo:** Sonnet/Codex research, Dan rozhodnutí kam investovat.

- [ ] **F-04 — Auto-triáž go/no-go nad kalibrovaným prahem** · **MONEY-PATH — adversariální oponentura povinná**
  - **Proč:** F5.4; skóre nad prahem → auto-příprava celého balíku; člověk schvaluje frontu
    „připraveno k podání" místo kroků. Dimenze: autonomie, business.
  - **Soubory:** `scripts/src/lib/monitoring/monitoring-score.ts` + `tender-allocation.ts`
    (auto-převzetí nad prahem z konfigurace, práh POUZE z kalibrace D-02 s n ≥ 50);
    `scripts/src/lib/inbox.ts` (fronta „připraveno k podání"); guard přes F-01 (denní limit
    auto-převzetí); `MonitoringSettings.tsx` (práh + on/off).
  - **Akceptace:** zakázka nad prahem doběhne bez lidského kliku do `waiting_approval`
    s kompletním balíkem; pod prahem se nic neděje; denní limit vynucen; simulace na
    historickém feedu ukazuje, kolik % by auto-triáž vzala (report pro Dana PŘED zapnutím).
  - **Závislosti:** D-02 (≥ 50 outcomes), B-05, F-01. **Velikost:** M. **Kdo:** Opus + Fable oponentura; **Dan zapíná** (business rozhodnutí).
  - **Rizika:** nekalibrovaný práh = plýtvání AI spend na špatné zakázky → tvrdá závislost na D-02.

- [ ] **F-05 — Nákupní podklady po výhře**
  - **Proč:** F5.5; druhý lidský checkpoint dle cíle (schvalování nákupů). Tab Nákup
    (`crm_nakupy`, migrace 016) existuje, chybí generování podkladů. Dimenze: business, UX.
  - **Soubory:** `scripts/src/lib/nakupy-store.ts` + `nakupy-seed.ts` (rozšíření: objednávkový
    podklad per dodavatel — položky, množství, zdroj_nakupu URL, součty); export
    (CSV/e-mail draft) v `scripts/src/serve-api.ts`; UI tab Nákup v `TenderDetailPage.tsx`
    („Připravit objednávky" → seskupení per dodavatel, člověk schvaluje).
  - **Akceptace:** po označení výhry vygeneruje tab Nákup podklady seskupené per dodavatel
    se součty; žádná objednávka se neodesílá automaticky (jen podklad); test
    `nakupy-seed.test.ts` rozšířit.
  - **Závislosti:** reálná výhra (data), jinak testovatelné synteticky. **Velikost:** M. **Kdo:** Codex + Sonnet UI, review Fable (peníze — součty).

### Rozdělení práce vlny F
| Kdo | Tasky |
|---|---|
| Opus | F-01, F-02, F-04 |
| Codex | F-05, F-03 research část |
| Sonnet | UI (cockpit, settings), F-03 doc |
| Fable | oponentura F-01/F-02/F-04 (všechno money-path) |
| **Dan (nenahraditelný)** | právní závěr (vstup vlny), každé ostré podání F-02, zapnutí F-04, schvalování nákupů F-05 |

---

## 7. PRŮBĚŽNÁ STOPA T — testy, provoz, dokumentace, právo

Tasky mimo vlnovou sekvenci — dělají se průběžně, některé mají deadline vázaný na vlnu.

- [ ] **T-01 — CI typecheck backendu** (do konce vlny B)
  - **Proč:** 27 pre-existing tsc chyb (night3 §7.4); backend běží přes tsx → CI typy nehlídá,
    chyby se hromadí. Dimenze: provoz.
  - **Soubory:** `scripts/package.json` (script `typecheck`: `tsc --noEmit`);
    `.github/workflows/deploy.yml` (krok typecheck před buildem); oprava 27 chyb po dávkách.
  - **Akceptace:** `tsc --noEmit` v scripts = 0 chyb; CI failne na nové typové chybě.
  - **Velikost:** M (opravy). **Kdo:** Codex (mechanické).

- [ ] **T-02 — E2E smoke po deployi** (do konce vlny C)
  - **Proč:** po deployi se opakuje nginx 502 (stale IP) a ruční kontrola; deploy zabíjí joby
    (do E-01). Dimenze: provoz.
  - **Soubory:** `.github/workflows/deploy.yml` (post-deploy krok: nginx reload na hostu +
    curl smoke `/api/health` + přihlášení + feed endpoint); volitelně Playwright smoke tag
    v `apps/web` e2e.
  - **Akceptace:** deploy pipeline sama detekuje 502/nezdravý stav a failne job (místo tiché
    zelené); nginx reload automatický.
  - **Velikost:** S. **Kdo:** Codex.

- [ ] **T-03 — Graceful drain před deployem** (interim než E-01; do konce vlny C)
  - **Proč:** deploy dnes zabíjí běžící joby (známý gap z memory). Dimenze: provoz, průchodnost.
  - **Soubory:** `scripts/src/serve-api.ts` + `scripts/src/lib/pipeline-job-state.ts`
    (SIGTERM handler: nové joby nepřijímat, běžící checkpointnout jako `interrupted` s resume
    infem — částečně existuje z persistent fronty); `.github/workflows/deploy.yml` (stop
    timeout zvýšit).
  - **Akceptace:** deploy během běžícího jobu → job po startu viditelný jako `interrupted`
    s tlačítkem resume, žádná ztracená data (test na prod v klidnou hodinu).
  - **Velikost:** S–M. **Kdo:** Codex, Fable review.

- [ ] **T-04 — Zálohy: restore test** (jednorázově, pak kvartálně)
  - **Proč:** pg_dump běží (cron 03:35, rotace 14), ale restore nikdo nezkusil — netestovaná
    záloha není záloha. Dimenze: provoz.
  - **Postup:** na Hetzneru restore posledního dumpu do dočasné DB, přepočet řádků klíčových
    tabulek (crm_*, win_prices, monitoring_*), zápis výsledku do `docs/bugs-and-todos.md`.
  - **Akceptace:** dokumentovaný úspěšný restore s počty řádků; runbook restore v
    `docs/runbook-restore.md`.
  - **Velikost:** S. **Kdo:** Codex/Fable (SSH), bez zásahu do prod DB (jen nová dočasná).

- [ ] **T-05 — Aktualizace CLAUDE.md a plán-checkboxů po každé vlně**
  - **Proč:** CLAUDE.md sekce „Na čem právě pracuji" a „Známé problémy" zastarávají; tento
    plán je živý dokument. Dimenze: provoz (bus factor).
  - **Akceptace:** po merge poslední PR vlny je CLAUDE.md aktuální a checkboxy vlny odškrtnuté
    (součást definition of done vlny).
  - **Velikost:** S per vlna. **Kdo:** Sonnet.

- [ ] **T-06 — GDPR / licenční režim dat (Registr smluv, Hlídač)** (před vlnou D akceptací; lidský krok)
  - **Proč:** win-price data obsahují údaje z Registru smluv (mazání znepřístupněných záznamů),
    Hlídač = CC BY 3.0 vs. komerční licence; před komercializací (SaaS) nutno vyřešit. Dimenze: business (riziko R6).
  - **Postup:** (a) implementovat re-sync mazání znepřístupněných záznamů RS (malý kód
    v `fetch-win-prices.ts`); (b) **Dan**: poptat komerční licenci Hlídače, rozhodnout režim.
  - **Akceptace:** znepřístupněný záznam RS zmizí z win_prices při dalším syncu (test);
    licenční rozhodnutí zapsáno v `docs/plan/01-business-model.md` follow-upu.
  - **Velikost:** S kód + rozhodnutí. **Kdo:** Codex + **Dan**.

- [ ] **T-07 — Bug intake provoz** (průběžně, běží)
  - **Proč:** Slack #ludone-vz + GitHub issues Make-more-s-r-o/AIVZ — bugy od Patrika/uživatelů
    mají přednost před plánem, pokud blokují money-path. Dimenze: kvalita, UX.
  - **Akceptace:** žádný money-path bug starší 24 h bez reakce.
  - **Kdo:** dle povahy (money-path → Opus + oponentura; UI → Sonnet).

---

## 8. Mapa závislostí mezi vlnami (souhrn)

```
VLNA A (pilot + sběr)  ──┬─ kód (A-01,03,04) ──► VLNA B (verify/match) ──► VLNA C (poloautomat UX)
                         │                                                        │
                         └─ provoz (A-06,07,08) ─── podané nabídky ──► výsledky ──► VLNA D (feedback)
                              A-05 token ────────────────────────────────► E-02   │
                              A-09 právník ─────────────────(týdny–měsíce)────────┼──► VLNA F
                                                                                  ▼
                                                      metriky C drží 1 měsíc ► VLNA E (škálování)
                                                      D-02 kalibrace (n≥50) ─► F-04 auto-triáž
```

Kalendářní realita: **latence výsledků VZ (týdny) a právní konzultace (týdny–měsíce)
jsou nejdelší cesty** — proto A-03, A-04, A-09 startují ve vlně A, i když „patří" do
fází 3 a 5. Kód vln B/C se dělá, zatímco provoz vlny A čeká na lhůty a výsledky.

---

## 9. JAK TENTO PLÁN NAPLŇOVAT

### Postup pro každý task (člověk i agent)

1. **Vezmi další nezablokovaný task nejvyšší priority** — nejnižší otevřená vlna, uvnitř
   vlny pořadí dle čísla; task je blokovaný, dokud nejsou hotové jeho „Závislosti".
   Lidské tasky (Dan) NEblokuj čekáním — eskaluj do reportu/Slacku a vezmi další kódový.
2. **Rezervace:** při startu zapiš k checkboxu tasku `⏳ <kdo> <datum>` (+ u migrace
   rezervované číslo). Zabraňuje kolizi souběžných agentů.
3. **Zadání:** z tasku sestav 1-úkolový prompt (output contract, soubory, akceptace).
   Bulk → Codex gpt-5.6-sol (bez git příkazů); money-path → Opus; UI → Sonnet.
4. **Větev:** `feature/<task-id>-nazev` (např. `feature/b-02-verify-fallback`). Víc tasků
   sahajících do `serve-api.ts` v jedné vlně → merge přes společnou **integrační větev**
   (`feature/vlna-X-integrace`), sériový merge do main se nevyplácí (poučení z nočních běhů).
5. **Implementace + testy:** každý task přidává/rozšiřuje testy v `scripts/tests/`
   (viz akceptace). Bez testu není hotovo.
6. **Gates (checklist níže)** — všechny zelené PŘED žádostí o review.
7. **Oponentura:** MONEY-PATH task → adversariální review (Fable/Opus) nad diffem, nálezy
   opravit a re-review. Ostatní tasky → standardní code review. Autor nikdy nemerguje sám sebe.
8. **PR → main → deploy** (GitHub Actions → GHCR → Hetzner). Po deployi **prod verify**
   (checklist níže) — u money-path tasků živé přeměření na reálné zakázce (vzor night3 §3).
9. **Odškrtni checkbox** v tomto souboru (v témže PR nebo follow-up commitu), zapiš
   odchylky/poznatky; reusable poznatek → skill/memory dle globálních pravidel.
10. **Konec vlny:** výstupní podmínka vlny změřena a zapsána (krátký report do `docs/`),
    T-05 (CLAUDE.md refresh), teprve pak otevřít další vlnu.

### Checklist gates (povinný pro každý PR)

- [ ] `cd scripts && npm test` — všechny testy zelené (aktuálně 227+; žádný skip nových)
- [ ] `cd scripts && npx tsc --noEmit` — žádná NOVÁ typová chyba (po T-01: nula absolutně)
- [ ] `cd apps/web && npm run build` — FE build PASS (tsc -b && vite build)
- [ ] migrace: nová = nové číslo (rezervované), idempotentní, transakční; NIKDY úprava
      už mergnuté migrace
- [ ] money-path diff: adversariální oponentura proběhla, nálezy vyřešeny, žádná cesta
      neobchází price gate / human confirm / kill-switch
- [ ] žádné secrets v diffu; žádné soubory z `input/` (scoped `git add`, nikdy `-A` při konfliktech)
- [ ] po deployi prod verify: `https://vz.ludone.cz` 200 + `/api/health` ok (po 502 → nginx
      reload na hostu), migrace aplikované (log), smoke dotčeného flow na reálné zakázce
- [ ] checkbox tasku odškrtnut + poznámka o odchylkách

### Eskalace a stop pravidla

- **Stop-the-line:** proklouznuvší špatná cena do potvrzeného stavu = incident → postmortem
  a nové gate pravidlo PŘED další prací (důvěra operátora je kapitál).
- Task bobtná nad 2× odhad → rozdělit, nedotahovat silou v jedné větvi.
- Cokoli, co mění chování potvrzování cen, generování závazných dokumentů nebo podání
  a NENÍ v plánu → nejdřív doplnit jako task (s MONEY-PATH klasifikací), pak dělat.

---

## 10. Otevřené body pro majitele (soustředěno z celého plánu)

1. **A-06/A-07:** výběr 2–3 pilotních zakázek + provedení podání — bez toho stojí business
   dimenze celá.
2. **A-05:** HLIDAC_TOKEN (+ rozhodnutí o komerční licenci Hlídače — souvisí s T-06).
3. **A-09:** zadat právní konzultaci (NEN účet/zmocnění; SaaS odpovědnostní klauzule) —
   nejdelší latence v plánu, blokuje vlnu F.
4. **C-05:** revize vah go/no-go po pilotech; potvrzení reálné cílové marže per kategorie
   (dnes 10 % fallback — otevřeno z night2 §5.1).
5. **E (vstup):** rozhodnutí o zdrojích feedu (TED, které profily zadavatelů) a případný
   upsize VPS pro worker kontejner; denní AI budget (C-03 env hodnota).
6. **F (vstup):** zapnutí auto-triáže (F-04) a režim podání (F-02) — výhradně Danovo go.
