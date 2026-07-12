# Runbook prvního podání

> Provozní návod pro první reálné podání nabídky přes vz.ludone.cz — konkrétní kliky,
> ne teorie. Navazuje na `00-README.md` (milník M1 „první bezvadně podaná nabídka") a
> `02-roadmapa.md` (Fáze 1, balíky 1.1–1.6). Sedí na kód k 2026-07-12 (`submit-gate.ts`,
> `podani.ts`, `priloha-checklist.ts`, `price-sanity.ts`, `governance.ts`,
> `ProductMatchView.tsx`, `ItemPriceCalculator.tsx`, `DocumentList.tsx`,
> `SubmissionCockpit.tsx`, `CompanySettings.tsx`).
>
> **Tvrdý invariant majitele platí i tady:** každá položka nabídky musí projít
> individuálním lidským potvrzením. Žádný krok níže to neobchází — ani „Použít reálné
> ceny", ani hromadné „Potvrdit zkontrolované" (to potvrdí jen položky, které jsi
> předtím rozbalil a odškrtl ručně, ne vše naslepo).

---

## 1. Než začneš (jednorázová příprava, dělá se jednou na firmu)

### 1.1 Firemní údaje
`Nastavení → Firmy` (`CompanySettings.tsx`): název firmy, IČO, DIČ, sídlo, jednající
osoba, telefon, e-mail, bankovní účet, datová schránka, zápis v rejstříku, výchozí
přirážka k nákupu (%, dnes 10 % fallback). Bez vyplněného IČO/sídla/jednající osoby
budou krycí list a čestná prohlášení obsahovat prázdná pole nebo placeholdery.

### 1.2 Kvalifikační doklady firmy
Ve stejné záložce, pod formulářem firmy, je 6 slotů pro nahrání dokladů:

| Slot | Label v UI | Násobný? |
|---|---|---|
| `vypis_or` | Výpis z obchodního rejstříku | ne |
| `rejstrik_trestu` | Výpis z rejstříku trestů | ne |
| `potvrzeni_fu` | Potvrzení finančního úřadu | ne |
| `potvrzeni_ossz` | Potvrzení OSSZ | ne |
| `profesni_opravneni` | Profesní oprávnění | ne |
| `ostatni` | Ostatní | ano (více souborů) |

U každého slotu klikni „Nahrát" (u `ostatni` „+ Nahrát" pro další soubor) a **vyplň
datum platnosti** (`platnost_do`). Bez platnosti systém doklad eviduje jako `nezadano`
a nehlídá expiraci — ale hlavně: **který slot je pro konkrétní zakázku povinný, určuje
až AI analýza té zakázky** (mapování kvalifikačních požadavků ZD → sloty). Zjistíš to
v záložce `Dokumenty` dané zakázky (checklist příloh, viz krok 2.6) — ne tady předem.
Doklad, který AI analýza označí jako povinný a je nenahraný nebo prošlý, **tvrdě
blokuje finalizaci** (viz kapitola 3).

Platnost se hlídá s 30denním předstihem (`EXPIRY_WARNING_DAYS`) — doklad se 29 dní
před koncem platnosti zobrazí jako „expiruje", po konci jako „po platnosti" (což
finalizaci blokuje stejně jako chybějící doklad).

### 1.3 Registrace dodavatele na NEN — **systém to neřeší**
Aplikace negeneruje ani neobsluhuje účet dodavatele na Národním elektronickém nástroji
(NEN) ani na jiném portálu profilu zadavatele. Před prvním podáním musíš mít:
- aktivní účet dodavatele na NEN (případně na portálu, kde je zakázka vypsaná —
  E-ZAK, Tender arena, Josephine…),
- způsob autentizace/podpisu, kterým portál vyžaduje podání (u NEN typicky stačí
  autentizované podání přes účet dodavatele — tzv. fikce podpisu dle §211/7 ZZVZ;
  ověřeno právně jako dostatečné, viz `00-README.md` bod 5),
- přehled o formátových a velikostních limitech příloh konkrétního portálu (liší se
  portál od portálu, systém to nekontroluje).

Nástroj připraví **balík dokumentů**, nikdy ho sám nepodává — nahrání na portál a
odeslání je vždy ruční krok (krok 2.11 níže; automatizace je až Fáze 5 roadmapy).

### 1.4 Governance — zkontroluj, že nic neblokuje předem
`Nastavení → Governance / Kill-switch`: všech 5 přepínačů (Příjem a převzetí zakázek /
AI joby / Generování / Finalizace / Evidence podání) by mělo být zapnuto, a denní strop
AI nákladů (default 2 000 Kč) by neměl být už vyčerpaný z předchozí práce ten den. Pokud
je něco vypnuté, v hlavičce appky uvidíš chip „Provoz omezen".

---

## 2. Krok za krokem: od zakázky k balíku

### 2.1 Najít/převzít zakázku
`Monitoring` (feed z NEN). U položek ze zdroje NEN je tlačítko **„Převzít a
zpracovat"** — založí zakázku, stáhne přílohy ZD z NEN a rovnou spustí pipeline (řetěz
se sám zastaví na lidském checkpointu před generováním, viz níže). Tlačítko
**„Převzít"** jen založí zakázku a stáhne nic navíc — dokumenty ZD nahraješ ručně.
Go/no-go skóre u položky feedu je vodítko, rozhoduje vždy člověk.

### 2.2 Zkontrolovat analýzu a části
Záložka `Analýza` zakázky: zkontroluj, že AI správně vytáhla předmět, kvalifikační
požadavky a hodnotící kritéria ze zadávací dokumentace. **U vícedílné zakázky** je tu
sekce „Části zakázky" s checkboxy — vyber jen ty části, které skutečně chceš podat, a
klikni **„Uložit výběr"**. Pokud výběr změníš PO nacenění, systém to pozná (viz
kapitola 3) a bude chtít znovu spustit krok Produkty.

### 2.3 Spustit nacenění
Karta „Zpracování zakázky" → „Spustit kroky" spustí pipeline v pořadí Extrakce → AI
analýza → Produkty → Dokumenty → Validace. Run-all řetěz se **automaticky pauzne**
těsně před krokem Dokumenty (generate) a čeká na lidské potvrzení cen — to je záměrný
checkpoint, ne chyba. Po převzetí z monitoringu se stačí vrátit do záložky `Ocenění`.

### 2.4 „Ověřit ceny (web)"
Záložka `Ocenění` (`ProductMatchView.tsx`) → tlačítko **„Ověřit ceny (web)"**. Spustí
asynchronní job, který pro každou položku dohledá na webu reálné nákupní zdroje (až 3
odkazy „kde nakoupit" na položku). Výsledky se cachují (`warehouse_web_findings`), takže
opakovaný běh na podobné položky je levnější. Toto je jen podklad — **nic
nepotvrzuje**.

### 2.5 „Použít reálné ceny"
Jakmile má aspoň jedna položka ověřený zdroj, objeví se tlačítko **„Použít reálné ceny
(N)"**. Po potvrzení dialogu hromadně předvyplní nákupní i nabídkovou cenu z ověřených
zdrojů (respektuje balení a minimální odběr) a **přepočítá cenové kontroly předem** —
takže případnou ztrátovou cenu uvidíš hned v tabulce, ne až jako chybu při potvrzení.
`potvrzeno` zůstává u všech položek `false` — jde jen o předvyplnění, ne o potvrzení.

### 2.6 Projít KAŽDOU položku (jádro invariantu)
Toto je krok, který nejde obejít ani zkrátit:
1. **Rozbal řádek položky** (klik na řádek) — teprve tím se zobrazí specifikace,
   vybraný produkt, zdroj ceny a marže (`ItemPriceCalculator.tsx`). Checkbox
   „Zkontrolováno" je do té doby zamčený (tooltip „Nejdřív si položku zobrazte").
2. Zkontroluj: sedí produkt na specifikaci ze ZD? Sedí zdroj ceny? Je marže tam, kde ji
   chceš? Pokud je položka označená HARD `cena_pod_nakupem` (červený box „Nabídková
   cena je pod reálným jednotkovým nákupním nákladem… Bez auditované výjimky nelze
   cenu potvrdit ani nabídku podat."), buď uprav cenu nahoru, nebo — pokud máš reálný
   důvod (např. „mám lepší nákup u svého dodavatele") — zaškrtni **„Potvrdit i přes
   ztrátu — důvod"** a napiš důvod (min. 10 znaků, jde do audit trailu). Tohle NENÍ
   cesta, jak obejít kontrolu — je to výjimka, za kterou se podepisuješ.
3. Odškrtni checkbox **„Zkontrolováno"** u položky.
4. Opakuj pro všechny položky, pak klikni **„Potvrdit zkontrolované (N)"** (hromadné
   tlačítko potvrdí jen ty, co jsi odškrtl — ne celý seznam), nebo potvrzuj položku po
   položce tlačítkem „Potvrdit ceny" / „Aktualizovat" přímo v rozbaleném řádku.

Souhrn nahoře v záložce ukazuje „Zkontrolováno M / N položek" — dokud nesedí M = N,
nabídku nejde finalizovat (viz kapitola 3).

### 2.7 Vygenerovat dokumenty
Krok „Dokumenty" (generate) v pipeline — buď automaticky pokračuje run-all po
potvrzení cen, nebo ho spustíš ručně v kartě „Zpracování zakázky". Generuje krycí
list, cenovou nabídku, technický návrh, čestné prohlášení a vyplní tendrové šablony.

### 2.8 Kontrola validace
Krok „Validace" (validate) doplní `field-validation.json` a spec-compliance report.
V záložce `Dokumenty` uvidíš banner „Dokumenty jsou připraveny k odeslání" (zeleně)
nebo „Některé dokumenty vyžadují kontrolu" (žlutě, s badge důvěryhodnosti u
konkrétního dokumentu). Otevři a přečti dokumenty očima zadavatele — validace je
poradní, ne neomylná.

### 2.9 Finalize = balík + manifest
Záložka `Dokumenty` → tlačítko **„Připravit balík k podání"** (aktivní, jen když
validace prošla na všech dokumentech). Zavolá `POST /tenders/:id/finalize`, který:
- znovu přepočítá **submit-gate** nad aktuálními daty (viz kapitola 3 — je to poslední
  a nejtvrdší brána),
- uloží **bid snapshot** (cena, nákup, marže, skóre, pásmo win-price, podíl ověřených
  cen, flagy, AI náklad) — bez toho by nešlo později spárovat výsledek s daty pro
  kalibraci,
- vytvoří **immutable ZIP balík** s manifestem (sha256 hash, verzování) v adresáři
  `podani/`,
- posune CRM stav zakázky na `pripravena` (**ne** na `odeslana` — to je až krok 2.12).

### 2.10 Stáhnout balík
Objeví se `SubmissionCockpit` s tlačítkem **„Stáhnout balík (vN)"** a otiskem obsahu
(sha256, zkopírovatelný). Stáhni ZIP — to je přesně to, co jde na portál.

### 2.11 Podat na profilu zadavatele / NEN — **ruční krok, systém ho nedělá**
Přihlas se na NEN (nebo příslušný portál dle zakázky), najdi danou zakázku, nahraj
dokumenty ze staženého balíku (podle formátových požadavků portálu — může chtít
jednotlivé soubory, ne ZIP) a odešli nabídku před lhůtou. Systém nemá napojení na
žádné podávací API (viz roadmapa Fáze 5, `5.2`/`5.3` — budoucí práce).

### 2.12 „Zaznamenat podání"
Zpátky v `SubmissionCockpit` vyplň formulář:
- **Portál*** — kam jsi podal (např. „NEN", „profil zadavatele", i e-mail, pokud tak
  zakázka vyžaduje),
- **Čas podání*** — kdy portál podání přijal,
- **Evidenční číslo** — nepovinné polem, ale silně doporučené (dohledatelnost),
- **Poznámka** — nepovinné.

Tlačítko **„Zaznamenat podání"** volá `POST /tenders/:id/podano` — teprve tím se CRM
stav přepne na `odeslana`. Opakované odeslání se stejnou evidencí je bezpečné
(idempotentní), jiná evidence u už podané nabídky je odmítnuta (existující záznam
nejde přepsat).

---

## 3. Co tě zastaví (a co s tím)

Tabulka pokrývá kontroly ze `submit-gate.ts` (`computeSubmitGate`) i governance
guardy, které blokují dřívější kroky.

| Kontrola | Co znamená | Jak ji odbavit |
|---|---|---|
| **Nepotvrzené ceny** („N z M položek nemá potvrzenou cenu") | Aspoň jedna položka nemá `cenova_uprava.potvrzeno = true` | Vrať se do `Ocenění`, rozbal položku, zkontroluj a potvrď (krok 2.6). Není zkratka — platí i pro jednu zapomenutou položku. |
| **HARD cena pod nákupem** (`cena_pod_nakupem` / `below_cost`) | Nabídková cena je nižší než reálný ověřený nákup (nebo než nákupní cena, kterou má položka uloženou) | Buď zvedni cenu nad nákup, nebo zaškrtni „Potvrdit i přes ztrátu — důvod" s reálným zdůvodněním (≥10 znaků) — jde do audit trailu (kdo/kdy z JWT, nelze podvrhnout klientem). |
| **HARD overcap** | Cena přesahuje per-item cenový strop (`cena_max_s_dph`) ze ZD | Sniž cenu pod strop, nebo prověř, jestli má položka správně dohledaný strop v analýze. |
| **HARD extreme_outlier** | Položka bez cenového stropu tvoří >60 % nabídky A zároveň je >30× medián ostatních položek (u nabídek s ≥5 položkami) | Skoro vždy jde o halucinovanou cenu nebo špatně napárovaný produkt — prověř produkt a cenu ručně, neschovávej se za výjimku. |
| **HARD zero_price** | Položka má nabídkovou cenu ≤ 0 Kč | Doplň cenu. |
| **Chybějící/expirovaný povinný kvalifikační doklad** | AI analýza označila požadavek ZD jako povinný a příslušný slot (§1.2) nemáš nahraný nebo je po platnosti | Nahraj doklad v `Nastavení → Firmy` (nebo přímo do přílohy zakázky), nebo — pokud opravdu nejde stihnout — zaznamenej auditovanou výjimku (role admin/analytik, důvod ≥10 znaků) v checklistu příloh záložky `Dokumenty`. Výjimka **nikdy** neobchází cenové gaty, jen tuto jednu kontrolu. |
| **Stale dokumenty** („Dokumenty neodpovídají aktuálním cenám") | Cena se změnila/potvrdila POZDĚJI, než byl vygenerován nejstarší dokument | Spusť znovu krok „Dokumenty" (generate), případně i „Validace". |
| **Změna výběru částí po nacenění** | V záložce Analýza jsi po kroku Produkty přepnul, které části zakázky podáváš | Spusť znovu krok „Produkty" (match), aby se přepočítal snapshot výběru. |
| **Zbytkové placeholdery v DOCX** („doplní účastník") | Šablona nemá `{{}}` proměnné, fill/reconstruct engine nenahradil všechno | Otevři konkrétní dokument, doplň ručně nebo nahlas jako issue do backlogu kvality (šablony mívají 30–40 % miss-rate, viz `02-roadmapa.md`). |
| **Field-validace neprošla / chybí** | Krok „Validace" ještě neproběhl nebo některý dokument nemá `overall: pass` | Spusť/opakuj krok „Validace" v pipeline. |
| **Governance kill-switch vypnutý** | Jeden z 5 přepínačů (ingest/AI joby/generování/finalizace/podání) je vypnutý | `Nastavení → Governance / Kill-switch` (jen role admin) — zapni přepínač zpátky. Chip „Provoz omezen" v hlavičce zmizí. |
| **Denní strop AI nákladů** | Součet dnešních AI nákladů dosáhl `denni_ai_limit_czk` (default 2 000 Kč) | Zvyš limit v Governance, nebo počkej do dalšího dne — blokuje jen AI joby (spustit pipeline, Ověřit ceny), ne stažení/finalize samotné. |
| **already_submitted** (409 na finalize) | Zakázka už má zapsanou evidenci podání — nový balík nejde připravit | Pro upravenou nabídku založ novou zakázku/revizi; hotové podání se nepřepisuje. |
| **different_evidence** (409 na /podano) | Zkoušíš zaznamenat jinou evidenci, než už je uložená | Existující evidenci nelze přepsat přes toto API — pokud je chyba, potřebuje ruční zásah v datech. |

---

## 4. Kontrolní seznam před odesláním

Než balík nahraješ na portál, projdi vlastníma očima:

- [ ] Všechny položky mají potvrzenou cenu s auditní stopou („Zkontrolováno M/M" v Ocenění)
- [ ] Ceny odpovídají reálnému nákupu (web-verify zdroj nebo ručně dohledaná cena) — ne jen syrový AI odhad
- [ ] Marže je tam, kde ji chceš (company default, nebo vědomě upravená za položku)
- [ ] Žádná položka není pod nákupem bez skutečného, konkrétního auditovaného důvodu
- [ ] Kvalifikační doklady firmy jsou nahrané a platné, nebo mají auditovanou výjimku s reálným zdůvodněním
- [ ] Vybrané jsou právě ty části zakázky, které chceš podat (u vícedílné zakázky)
- [ ] Soupis položek a celková cena v cenové nabídce číselně sedí (kontrola v `Dokumenty`)
- [ ] DPH sazby a režim v dokumentech odpovídají realitě zakázky
- [ ] Žádné zbytkové placeholdery („doplní účastník") — banner „Dokumenty jsou připraveny k odeslání" je zelený
- [ ] Do lhůty zbývá dost času i na technický upload (portál bývá pomalý v posledních hodinách)
- [ ] Volné přílohy vyžadované konkrétní ZD mimo 6 standardních slotů (např. specifický formulář zadavatele) jsou doplněné — checklist příloh je nekryje automaticky
- [ ] ZIP, který nahráváš na portál, je přesně ten stažený z cockpitu (žádné ruční úpravy po finalizaci)

---

## 5. Po podání

Jakmile zadavatel rozhodne, otevři záložku **`Výsledek`** dané zakázky a zapiš:
- **Výsledek** — výhra / prohra / zrušeno,
- **Vítězná cena bez DPH** (u výhry = tvoje cena; u prohry cena vítěze, pokud je
  dohledatelná),
- **Naše cena bez DPH** (součet z Ocenění),
- **Počet uchazečů**,
- **Vítěz** (název dodavatele),
- **Poznámka** — poučení pro příště, důvod prohry.

**Proč na tom záleží:** při finalizaci (krok 2.9) se uložil bid snapshot — přesný
otisk toho, jak nabídka v okamžiku podání vypadala (ceny, marže, skóre, pásmo
win-price, podíl ověřených cen). Zápis výsledku je druhá polovina páru, bez které
snapshot k ničemu není. Celá kalibrační smyčka (Fáze 3 roadmapy — přesnost go/no-go
skóre, price-to-win model) čeká na tato data; dnes je `crm_vysledky` prázdná (0
podaných nabídek). Zapisuj **i prohry a zrušené zakázky**, ne jen výhry — jinak bude
win-rate widget i kalibrace zkreslené jen přeživšími případy.

---

## 6. Náklady

Orientačně, na jednu zakázku:
- **Analýza + nacenění**: ~10–130 Kč AI nákladů, podle velikosti zadávací dokumentace
  a počtu položek (sledováno per zakázka, `cost-tracker.ts`; částka u konkrétního
  vygenerovaného dokumentu je vidět přímo u něj v záložce `Dokumenty`).
- **Ověřit ceny (web)**: dražší při prvním běhu (živé web_search dotazy), opakovaný
  běh nebo podobná položka jinde je výrazně levnější díky cache
  (`warehouse_web_findings`).
- **Denní strop**: `Nastavení → Governance / Kill-switch`, `denni_ai_limit_czk`,
  default **2 000 Kč**. Po dosažení limitu se AI joby (pipeline kroky, Ověřit ceny)
  blokují do dalšího dne nebo do zvýšení limitu — finalizace a stažení balíku
  blokovány nejsou.
