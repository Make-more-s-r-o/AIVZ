# Business model a příležitost — VZ AI Tool

> **Verze 2 (po adversariální oponentuře Codexu, 2026-07-12).**
> Dokument plánu, část 1/N. Stav k 2026-07-11. Vychází z reálného stavu repa
> (pipeline nasazená na vz.ludone.cz, skóre autonomie ~55 % dle
> `docs/report-2026-07-11-den.md`), z auditu `docs/audit-goal-2026-07-10.md`,
> z researche `docs/product-brief-vz.md` a `docs/strategicka-mapa.md`
> a z webového dohledání aktuálních čísel (červenec 2026).
>
> Značení: **[OVĚŘENO — zdroj, rok]** = podloženo citovaným zdrojem nebo měřením
> v tomto projektu; **[ODHAD]** = kvalifikovaný odhad, který je potřeba ověřit.

---

## 1. Problém a trh

### 1.1 Velikost trhu českých veřejných zakázek

| Metrika | Hodnota | Zdroj / poznámka |
|---|---|---|
| Celková hodnota VZ v ČR za rok 2024 | **993 mld. Kč** (+68 mld. meziročně) | **[OVĚŘENO — MMR, Výroční zpráva o elektronizaci a stavu VZ za rok 2024; ČTK 2025]** |
| Podíl VZ na HDP | **12,4 %** | **[OVĚŘENO — tamtéž]** |
| Zakázky zadané přes ISVZ (formální režim ZZVZ) 2024 | **15 310 zakázek**, hodnota **567 mld. Kč** | **[OVĚŘENO — ČTK/ČeskéNoviny.cz z výroční zprávy MMR 2024]** |
| Zbytek mimo centrální evidenci (hlavně VZMR) | řádově **300+ mld. Kč** | **[ODHAD — dopočet z výroční zprávy; VZMR se centrálně nesledují]** |
| Průměrný počet nabídek na 1 zakázku | **2,8** | **[OVĚŘENO — data Evropské komise citovaná v ČTK 2025]** |
| Podíl řízení s jediným uchazečem | **40 %** (2024; jedna z nejhorších hodnot v EU) | **[OVĚŘENO — EU Single Market Scoreboard 2024, indikátor „single bidder"]**. Metodika: měřeno nad řízeními publikovanými v TED (nadlimitní režim) — jiná báze než národní statistika MMR. Starší research uváděl ~48 %; rozdíl jde za odlišnou bází a obdobím, ne za zlepšení trhu. |

Zdroje: [MMR — Výroční zpráva 2024](https://mmr.gov.cz/cs/microsites/nsvz/clanky/vyrocni-zprava-o-elektronizaci-a-stavu-verejnych-z),
[ČeskéNoviny.cz](https://www.ceskenoviny.cz/zpravy/hodnota-verejnych-zakazek-loni-vzrostla-mezirocne-o-68-miliard-kc/2713360),
[portal-vz.cz — výroční zprávy](https://portal-vz.cz/vyrocni-zpravy-a-souhrnne-udaje-o-verejnych-zakazkach/).

Interpretace čísel (střízlivě):

- Trh je obrovský v objemu peněz, ale **náš adresovatelný trh není 993 mld. Kč
  — a bottom-up SAM zatím spočítaný NEMÁME**. Dopočet z v1 („~15 tis. zakázek ×
  2,8 nabídky = 40–45 tis. nabídek ročně") byl top-down a nepoužitelný: míchá
  datové báze a neomezuje se na zakázky, které reálně umíme obsloužit. Postup
  výpočtu SAM (task T-08 v 03): z open dat VVZ/ISVZ (+ NEN export) vyfiltrovat
  zakázky (a) v CPV kódech komoditních dodávek, (b) v typech řízení, kde
  podáváme, (c) s položkovým soupisem v ZD (ověřit na ručním vzorku),
  (d) do velikosti, kterou uneseme dodat, (e) s kvalifikací, kterou splníme;
  výsledek = počet obsloužitelných zakázek/rok × průměr nabídek v tomto
  segmentu. **Do té doby čísla trhu nepoužívat jako obchodní argument.**
- **2,8 nabídky na zakázku a 40 % single-bidder řízení** říká spolehlivě jen
  jedno: konkurence v soutěžích je slabá → rozumná šance vyhrávat i bez
  agresivního podceňování. Že příčinou je časová náročnost přípravy
  („dodavatelé nestíhají"), je zatím **hypotéza** — validovat rozhovory
  s dodavateli při concierge pilotech a segmentovými daty, ne citací indikátoru.

### 1.2 Kdo dnes soutěží a proč je příprava drahá

- Velcí a střední dodavatelé s dedikovaným „tender týmem" — pro ně je příprava
  režijní náklad, který unesou.
- Malé a střední firmy (10–250 zaměstnanců) bez dedikované kapacity — nabídku
  připravuje jednatel/obchodník po večerech. Právě ty tvoří cílovku
  konkurenčního Tenderpoolu **[OVĚŘENO — tenderpool.cz, 2026]** a naši.
- Příprava jedné nabídky = 40–80 hodin: najít zakázku, přečíst zadávací
  dokumentaci (desítky až stovky stran), vytáhnout požadavky a kvalifikaci,
  nacenit položkový soupis (u dodávek desítky až stovky řádků), vyplnit krycí
  list, čestná prohlášení, návrh smlouvy, technický návrh, zkompletovat a podat.
  Většina času je mechanická extrakce a vyplňování — ne obchodní úvaha.

### 1.3 Který segment je pro automat nejvhodnější

| Segment | Vhodnost | Proč |
|---|---|---|
| **Komoditní dodávky s položkovým soupisem** (IT/AV technika, nářadí, vybavení dílen, kancelářský materiál, servery, projektory…) | **Nejvyšší** | Hodnotí se převážně nejnižší cena; nabídka = správně vyplněný soupis + formuláře; položky lze nacenit z katalogů/webu; přesně to, co pipeline dnes umí (ověřeno na reálných zakázkách v `input/` — nářadí, servery, projektor, laser, vakuový lis…) |
| Jednodušší služby (úklid, revize, servis) | Střední | Cena hraje hlavní roli, ale kalkulace je interní (mzdy), ne katalogová |
| Stavební práce | Nízká (zatím) | Výkaz výměr je obří, oceňování má vlastní SW (KROS, RTS), kvalifikace složitá |
| Intelektuální služby (projekty, právní, IT vývoj) | Nízká | Hodnotí se kvalita návrhu, reference, tým — generický text nevyhrává |

Závěr: **začínáme a zůstáváme u komoditních dodávek** — tam je automatizace
nejúplnější (od soupisu po podatelný dokument) a chyba je nejlépe hlídatelná
deterministickými gaty (cenové stropy, sanity check, marže). To odpovídá i
reálným datům z pipeline: 22/25 historických zakázek tohoto typu projde
end-to-end **[OVĚŘENO — audit 2026-07-10]**.

---

## 2. Hodnotová nabídka

### 2.1 Kde přesně nástroj šetří čas (40–80 h → 4–8 h)

| Krok | Ručně | S nástrojem | Stav v produktu |
|---|---|---|---|
| Nalezení zakázky | 2–5 h/týden procházení portálů | monitoring feed NEN + relevance skóre + převzetí jedním klikem | nasazeno (89 zakázek nataženo živě) |
| Přečtení ZD, extrakce požadavků | 8–20 h | extract + analyze (AI), go/no-go skóre | nasazeno |
| Nacenění položkového soupisu | 10–30 h | match + win-price pásma + web-verify nákupních cen + marže | nasazeno, s HARD gaty |
| Vyplnění dokumentů (krycí list, prohlášení, soupis, smlouva) | 8–15 h | generate (DOCX engine, free-text placeholdery) | nasazeno |
| Kontrola a kompletace | 4–8 h | validate + submit-gate + immutable balík s manifestem | nasazeno |
| Podání | 1–2 h | zatím ručně (cockpit s evidencí podání) | člověk |

Lidský čas se koncentruje do schvalovacích momentů: **go/no-go** a **individuální
potvrzení každé položky nabídky** (tvrdý invariant majitele — human review 100 %,
bez cenových prahů; nasazeno s per-item attestací a serverovou auditní stopou,
PR #63) — přesně tam, kde má člověk zůstat i právně a obchodně.
Zbytek (4–8 h) je kontrola výstupů a samotné podání.

Hodnota v penězích: při interní sazbě 600–1 000 Kč/h je úspora 36–72 h
= **22 000 – 72 000 Kč na jednu nabídku** **[ODHAD — sazba; hodiny doloženy
strukturou kroků výše]**.

### 2.2 Web-verify jako killer feature (podmínka ziskovosti, ne nice-to-have)

Měřením na reálných zakázkách bylo doloženo, že **čisté AI cenové odhady jsou
systematicky ~42 % pod reálným trhem, v extrému o 263 %** **[OVĚŘENO — živé
měření verify běhů na prod, 2026-07-11]**. Důsledek je zásadní:

- Nástroj, který jen „AI nacení soupis", generuje **ztrátové nabídky** — vyhraje
  právě proto, že je nejlevnější, a firma pak nakupuje dráž, než prodala.
  Vyhraná zakázka = garantovaná ztráta. To je horší než žádný nástroj.
- Naše odpověď je třívrstvá a už nasazená:
  1. **web-verify**: dohledání reálných nákupních zdrojů (až 3 linky „kde
     koupit") s cenou; HARD gate blokuje prodej pod ověřeným nákupem;
  2. **win-price pásma** z Registru smluv (10 000+ záznamů na prod,
     kategorizace do 11 komodit) — za kolik se historicky reálně vyhrávalo;
  3. **deterministické gaty**: extreme-outlier HARD (živě ověřen — halucinace
     280 000 Kč za adaptér ~280 Kč byla zachycena, potvrzení vrátilo HTTP 409),
     cenové stropy, povinná marže (company default 10 %), potvrzení výhradně
     člověkem.
- Druhá strana téže mince: protože AI podceňuje, **konkurenční nástroje bez
  ověření nákupních cen nemohou bezpečně generovat nabídkové ceny vůbec** —
  proto to nikdo v ČR nedělá (viz §3). Vrstva „reálná nákupní cena + historická
  vítězná cena + marže" je náš skutečný moat, ne samotné generování dokumentů.

### 2.3 Shrnutí hodnotové nabídky jednou větou

*Z 40–80 hodin na 4–8 hodin na nabídku, s cenou, která je ověřeně nad nákupem
a v pásmu historických výher — tedy nabídky, které lze vyhrát se ziskem, ne jen
podat.*

---

## 3. Konkurence

### 3.1 Česko

| Nástroj | Co dělá | Cena | Generuje nabídky? Naceňuje? |
|---|---|---|---|
| **Tenderpool** (tenderpool.cz) | AI monitoring: hodinově skenuje NEN, TenderArena, E-ZAK, FEN, Gemin, eVEZA, Tendermarket + profily; čte celou dokumentaci, relevance skóre 0–100 | **Business 4 850 Kč/měs** (4 120 Kč/měs ročně) **[OVĚŘENO — tenderpool.cz, 2026]** | **Ne** — sám deklaruje, že nabídky negeneruje, jen pomáhá najít a vyhodnotit |
| **Tendry.cz** (Datlab) | AI „Chytré sledování", 25 000+ zdrojů | od 750 Kč/měs **[OVĚŘENO — research 2026-04]** | Ne |
| **TenderMonitor** | jednoduchý monitoring CZ+EU | nízké stovky Kč/měs [ODHAD] | Ne |
| **vhodne-uverejneni.cz** | certifikovaný publikační/monitoring nástroj (strana zadavatelů) | ceník veřejný, nízké tisíce/rok | Ne |
| **Qlex** (QCM) | RAG právní asistent nad ZZVZ/ÚOHS | 8 000–40 000 Kč/rok **[OVĚŘENO — research 2026-04]** | Ne — jen právní Q&A |
| **Tenderix** | AI Q&A nad ~9 000 zakázkovými dokumenty | bez veřejného ceníku | Ne |
| **zakazky.gov.cz** (stát, MMR) | agregace všech el. nástrojů, **bezplatné AI vyhledávání a souhrny**, podání z jednoho místa | **zdarma** | Ne |
| **Bid-desk poradenství** (např. Veřejná-soutěž.cz a další tendroví poradci) | odborná příprava a kompletace nabídky jako lidská služba | individuálně, tisíce–desetitisíce Kč/nabídka [ODHAD] | **Ano, ručně** — služba, ne SW produkt; nejbližší substitut naší managed service |
| **Interní / zakázková řešení** větších dodavatelů | vlastní tender-desk automatizace | neveřejné | neznámo — z veřejného webu neviditelné |

Zdroje: [tenderpool.cz](https://tenderpool.cz/en), [tendermonitor.cz](https://tendermonitor.cz/),
[BusinessInfo — Zakázky GOV](https://www.businessinfo.cz/clanky/zakazky-gov-nabidky-do-verejnych-zakazek-nyni-podate-z-jednoho-mista/),
research `docs/strategicka-mapa.md` a `docs/product-brief-vz.md`.

Klíčové důsledky:

1. **Samotný monitoring je mrtvá kategorie.** Stát ho přes zakazky.gov.cz dává
   zdarma včetně AI vyhledávání. Prodávat monitoring za 5 000 Kč/měs bude čím
   dál těžší — Tenderpool si to může dovolit dnes díky kvalitě skóringu, ale
   strop kategorie je nízký. My monitoring potřebujeme jen jako **vstup trychtýře**,
   ne jako produkt.
2. **Nebyl nalezen veřejně nabízený identický produkt** (nacenění + generování
   podatelné nabídky jako SW). Tenderpool generování explicitně odmítá,
   Qlex/Tenderix jsou Q&A. Pozor na přesah: bid-desk poradenství dělá totéž
   ručně jako službu a interní/zakázková řešení větších dodavatelů z veřejného
   webu nevidíme — tvrzení „nikdo to nedělá" je neobhajitelné; tvrzení „nikdo
   to nenabízí jako produkt" drží (dva nezávislé researche, 2026-04 a 2026-07).
3. Cenová kotva existuje: pokud trh akceptuje **4 850 Kč/měs za pouhé nalezení**
   zakázky, pak nástroj, který zakázku najde, nacení se ziskem a připraví
   podatelné dokumenty, unese násobek.

### 3.2 EU/US (inspirace a validace kategorie)

- **GovDash** (US) — end-to-end discovery→proposal, Series B $30M (leden 2026);
  zákazníci vyhráli přes $5 mld. v 2025 **[OVĚŘENO — research 2026-07]**.
- **Altura** (NL, €12,9M) — Benelux/UK/DE, bez českého pokrytí.
- **Brainial** (NL) — od €17 500/rok, enterprise.
- **Tendium** (SE) — monitoring až psaní nabídky, Skandinávie.
- Efekt kategorie: proposal automation zkracuje čas na RFP o 50–60 %,
  mid-market dodavatelé škálují objem nabídek 3–4× bez náboru.

Žádný z nich nemá českou integraci (NEN, E-ZAK, čeština, ZZVZ) — a lokální
integrace + jazyk + právo je bariéra, kterou nelze rychle replikovat. Zároveň
ale ceny Brainialu (€17,5k/rok ≈ 36 000 Kč/měs) ukazují, kde je strop, pokud
prokážeme výhry.

### 3.3 Naše mezera (jedna věta)

**End-to-end od monitoringu po podatelnou nabídku s cenou ověřenou proti
reálnému nákupu a historickým výhrám — v ČR nebyl nalezen veřejně nabízený
identický produkt, a bez win-price + web-verify vrstvy ho nikdo nemůže
bezpečně postavit.**

---

## 4. Příjmový model

### 4.0 Unit-ekonomika (doložená)

Náklad na jednu kompletní cenovou nabídku (AI volání extract→analyze→match→
generate→validate + verify):

- **AI náklady: 7–70 Kč/CN typicky**, extrém ~330 Kč u zakázky se 188 položkami
  **[OVĚŘENO — cost-tracker na prod, audit 2026-07-10]**.
- Web-verify: ~5 Kč/položka (živé měření: 4 položky ~22 Kč) → desítky až nízké
  stovky Kč na celou nabídku **[OVĚŘENO — živý běh 2026-07-11]**.
- Infrastruktura: Hetzner VPS + Postgres + Gotenberg ≈ nízké tisíce Kč/měs
  celkem, na CN zanedbatelné.

**COGS na 1 nabídku < 500 Kč vs. hodnota pro zákazníka 22 000–72 000 Kč
(ušetřený čas) + hodnota výhry (zisk ze zakázky).** Poměr hodnota/náklad je
50–150×. Hrubá marže je u všech modelů níže >85 % — rozhodnutí tedy není
o nákladech, ale o tom, co trh zaplatí a co dokážeme dokázat.

**Pozor: tohle je ekonomika SLUŽBY** (nabídka jako výstup). Vlastní obchodování
(Model 0) nese navíc financování nákupu zboží před inkasem, DPH cash-flow,
dopravu, dostupnost, reklamace, záruky a smluvní sankce — viz §4.1.

### 4.1 Varianty

#### Model 0: Vlastní obchodování (bid-as-business, „dealer") — jen OMEZENÝ experiment

Sami (provozní firma) podáváme nabídky do komoditních zakázek; příjem = marže
z vyhraných zakázek. **Po oponentuře NE primární business, ale omezený
experiment s tvrdým stropem kapitálové expozice (A-00):** slouží kalibraci
(win-rate, reálná pracnost) a jako tréninkové kolo procesu.

- **Pro:** nulový sales cyklus; každá zakázka kalibruje win-rate a zlepšuje
  produkt; žádná odpovědnost vůči třetí straně.
- **Proti (a proč jen experiment):** vyžaduje provozní firmu (kvalifikace,
  reference, registrace dodavatele NEN); **skutečná ekonomika není COGS
  < 500 Kč** — nese financování nákupu zboží před inkasem (splatnost 30+ dní),
  DPH cash-flow, dopravu, dostupnost zboží, reklamace, záruky a smluvní
  sankce; win-rate neznámá (0 podaných nabídek); vlastní kapitál v ohrožení.
- **Mantinely experimentu (tvrdé, z A-00):** strop souběžné kapitálové expozice
  v Kč (určí Dan), minimální contribution margin per zakázka (po započtení
  dopravy a financování, ne jen katalogová marže), go/no-go zobrazuje
  kapitálovou náročnost a aktuální expozici vůči stropu.
- **Orientační ekonomika:** zakázky 0,3–2 M Kč, marže 10 % → hrubý zisk
  30–200 k/výhra PŘED odečtením logistiky a financování; win-rate nutno
  změřit [ODHAD].
- **Cílový „zákazník":** my sami (v rámci stropu).

#### Model A: SaaS paušál per firma

- **Pro:** předvídatelný MRR; jednoduchá administrace; kotva Tenderpool
  4 850 Kč/měs existuje.
- **Proti:** malá firma podávající 1–2 nabídky/měs váhá nad fixem; cena musí
  být obhájená úsporou, kterou zákazník ještě nezažil.
- **Orientační cena:** 7 900–14 900 Kč/měs (nad Tenderpoolem, protože děláme
  násobně víc) [ODHAD — validovat na design partnerech].
- **Cílový zákazník:** MSP dodavatel komodit, 5–20 nabídek ročně a víc.

#### Model B: Success fee (% z vyhrané zakázky)

- **Pro:** perfektní alignment — platíš, jen když vyděláš; snadný prodejní
  argument; u zakázky 1 M Kč je 2 % = 20 000 Kč, pořád zlomek ušetřené práce.
- **Proti:** příjem přichází až po výhře a podpisu (měsíce); **vymahatelnost**
  (jak prokážeme, že výhra šla přes nástroj; zákazník může podat mimo);
  win-rate neznáme → neumíme model nacenit ani my; účetně/právně komplikované;
  u rámcových smluv nejasný základ.
- **Orientační cena:** 1–3 % z hodnoty vyhrané zakázky, případně strop.
- **Cílový zákazník:** firma, která nám nevěří natolik, aby platila fix.

#### Model C: Kredit per nabídka (pay-per-bid)

- **Pro:** nulová bariéra vstupu; přesně kopíruje hodnotu („zaplatím za CN,
  kterou jsem dostal"); výborné pro validaci ochoty platit.
- **Proti:** nepredikovatelný příjem; nízký strop (500–2 000 Kč/CN × jednotky
  CN/měs = tisíce Kč/zákazník); motivuje šetřit místo podávat víc.
- **Orientační cena:** 990–1 990 Kč za kompletní zpracovanou nabídku
  [ODHAD]; COGS < 500 Kč → marže drží i tady.
- **Cílový zákazník:** first-touch, malé firmy, pilotní fáze.

#### Model D: Tiered dle objemu (paušál + zahrnuté nabídky + doplatky)

- **Pro:** kombinuje predikovatelnost A s férovostí C; standard SaaS praxe;
  roste se zákazníkem.
- **Proti:** složitější komunikace; potřebuje data o reálné spotřebě, která
  zatím nemáme.
- **Orientační tiery [ODHAD]:**
  - **Start** 4 990 Kč/měs — monitoring + go/no-go + 2 CN/měs;
  - **Business** 9 990 Kč/měs — 6 CN/měs, web-verify, win-price, cockpit;
  - **Pro** 19 990 Kč/měs — 15 CN/měs, priorita, více uživatelů;
  - další CN à 990 Kč.

### 4.2 Doporučení

**Primární model: placený asistovaný bid service (managed service) — my
obsluhujeme nástroj, klient schvaluje go/no-go a každou položku (per-item
attestace platí i pro klienta), platí per zpracovaná nabídka (operačně
Model C, s objemem přerůstá v Model D). Vlastní obchodování (Model 0) běží
souběžně JEN jako omezený experiment s tvrdým stropem kapitálové expozice
(A-00) — motor kalibrace, ne pilíř příjmů.**

Zdůvodnění:

1. **Managed service zpeněžuje to, co je dnes doložené** (úspora času,
   COGS < 500 Kč, hrubá marže > 85 %) a nevyžaduje kapitál, kvalifikaci ani
   logistiku — přesně ta rizika, která Model 0 přidává a která COGS nezahrnuje.
2. **Model 0 zůstává nejrychlejší cestou k win-rate datům**, ale s neověřenou
   dealerskou ekonomikou nesmí být primární: expozice je omezená stropem a
   každá zakázka projde A-00 checkem schopnosti dodat.
3. Success fee (B) odložit: bez znalosti win-rate ho neumíme nacenit my sami
   a vymahatelnost je slabá. Vrátit se k němu, až budou doložené výhry.
4. Tiered (D) nad čistý paušál (A): naše COGS je per-nabídka a hodnota taky —
   model to má kopírovat. Tiery ale nasadit až po placené validaci concierge
   pilotů (do té doby jen per-bid cena Modelu C).
5. **SaaS jako produkt (self-service, multi-tenant) až po placené validaci** —
   první externí zákazníci jedou managed service na naší instanci, bez přímého
   přístupu do systému (architektura je vědomě single-tenant).

Orientační cíl [ODHAD — sanity check, ne závazek]: 2–3 platící concierge
zákazníci s opakovanou platbou + dealer experiment v rámci stropu; teprve
pak tiery a MRR cíle (číslo SAM dodá T-08).

---

## 5. Go-to-market

### 5.1 Dvě souběžné stopy: placené concierge validace + vlastní experiment

1. **Placené concierge validace (primární business):** 2–3 externí komoditní
   dodavatelé (design partneři) — my obsluhujeme nástroj, oni schvalují
   go/no-go a každou položku, platí per podaná nabídka. Měříme: čas, počet
   ručních oprav, zaplacenou cenu, opakovanou ochotu platit.
2. **Vlastní podání (dealer experiment):** nejprve 1 pilotní zakázka, po
   retrospektivě další 2 — vše v rámci stropu expozice z A-00. Kalibruje
   win-rate, trénuje proces, dokazuje „umíme podat bezvadně".
   **Stopy se navzájem neblokují** — shánění partnerů nesmí zdržet vlastní
   pilot a naopak.
3. Outcome watcher běží od začátku — každá podaná nabídka (naše i klientská)
   se propíše do kalibrace skóre a win-price DB.

### 5.2 První externí zákazníci (design partneři)

- **Kdo:** 2–3 MSP dodavatelské firmy z okolí/sítě (IT technika, nářadí,
  vybavení) — ideálně firmy, které dnes VZ nesoutěží „protože na to není čas",
  nebo soutěží 1–2× ročně. Segment se 40 % single-bidder řízení je plný firem,
  které by soutěžit MOHLY — že nesoutěží kvůli pracnosti, je hypotéza
  k validaci právě v těchto pilotech.
- **Nabídka pilotu:** assistovaný režim — my obsluhujeme nástroj, oni schvalují
  go/no-go a ceny, platí per podaná nabídka (Model C, např. 1 990 Kč/CN, první
  zdarma). Nízké riziko pro obě strany, přímá validace ochoty platit.
- **Validace ochoty platit = peníze, ne slova:** pilot je úspěšný, až zákazník
  zaplatí druhou a třetí nabídku bez pobízení.

### 5.3 Milníky

| Milník | Definice | Signál |
|---|---|---|
| **M-GTM-1: První reálně podaná nabídka** (naše) | nabídka podaná na profil/NEN, evidence v cockpitu | pipeline funguje end-to-end mimo laboratoř |
| **M-GTM-2: První výhra přes nástroj** | oznámení o výběru + podepsaná smlouva | win-price/verify vrstva vede k vítězné a ziskové ceně |
| **M-GTM-3: První zaplacená nabídka** (externí zákazník) | faktura uhrazena za CN zpracovanou nástrojem | ochota platit validována |
| **M-GTM-4: První opakující se platba** | druhý měsíc téhož zákazníka / druhá zaplacená CN | retence, ne zvědavost |

Milníky jsou nezávislé — **výhra (M-GTM-2) není podmínkou prodeje ani postupu**
(mapování na milníky M1–M4 fáze 1 v 02). Prodáváme doložitelnou úsporu času a
bezvadný proces (managed service), ne slib výher; vlastní výhra prodej
akceleruje, až přijde — nečeká se na ni.

### 5.4 Co záměrně neděláme (zatím)

- Marketing/web/self-service onboarding — dokud není M-GTM-3.
- Stavební zakázky a intelektuální služby — mimo segment (§1.3).
- Enterprise (20+ nabídek/měs) — sales cyklus 3–12 měsíců, až s referencemi.

---

## 6. Rizika

| # | Riziko | Závažnost | Mitigace (stav) |
|---|---|---|---|
| R1 | **Právní: odpovědnost za chybnou nabídku.** Nabídka je závazný úkon; halucinovaná cena nebo chybné čestné prohlášení = škoda firmy (propadlá jistota, ztrátové plnění, vyloučení). | Vysoká | Deterministické HARD gaty (extreme outlier, prodej pod nákupem, stropy) živě ověřené (HTTP 409 na halucinaci 280 k); potvrzení cen výhradně člověkem; finální podání drží člověk. U SaaS nutné smluvně: nástroj = podklad, odpovědnost za podání nese zákazník. **[konzultace s právníkem — otevřeno]** |
| R2 | **Právní: model podání.** §211/7 ZZVZ (fikce podpisu) automatizaci umožňuje **[OVĚŘENO — epravo.cz, portal-vz.cz]**, ale přístup k účtu NEN dodavatele, zmocnění a podmínky užití NEN nejsou vyjasněné. | Střední | Zatím poloautomat (systém připraví balík, člověk podá) — dnešní stav. Právní konzultace před jakoukoli automatizací podání. |
| R3 | **Tržní: win-rate neznámá.** 0 podaných nabídek → celý business case stojí na nezměřené veličině. Průměr 2,8 nabídky/zakázku dává naivní očekávání ~35 %, ale skutečnost může být výrazně horší (cena není jediné kritérium, kvalifikace, formality). | Vysoká | Pilot 2–3 podání co nejdřív; outcome tab + win-rate widget už nasazeny; go/no-go skóre kalibrovat daty; do té doby žádné závazky typu success fee. |
| R4 | **Technická: kvalita matchingu a cen.** Doložené selhání: AI podceňuje o ~42 % (extrém 263 %); halucinace kandidátů (280 k za adaptér); u specializovaného sortimentu web-verify nenachází (0/4 u kat. čísel nářadí); „viz popis níže" extraction gap (opraven, ale třída problému trvá). | Vysoká | Vrstvená obrana nasazena (gate + verify + win-price + marže + člověk). Zbytkové riziko: položky, které projdou s věrohodně vypadající, ale špatnou cenou. Průběžné měření na reálných zakázkách je jediná mitigace. |
| R5 | **Závislost na NEN scrapingu.** Monitoring feed = scraping bez API; NEN může změnit strukturu nebo blokovat. Jediný zdroj feedu. | Střední | Hlídač státu API jako fallback připraven (chybí token — akce pro majitele); dlouhodobě ISVZ open data + TED + zakazky.gov.cz; scraping udržovat minimální a defenzivní. |
| R6 | **Závislost na Registru smluv (win-price).** Role stran nespolehlivá, chybí počet uchazečů, dirty data; GDPR režim (mazání znepřístupněných záznamů) zatím neřešen. | Střední | Hygiena dat běží (migrace 013, kategorizace); doplnit VVZ award notices; GDPR režim správce OÚ před komercializací dat. |
| R7 | **Stát rozdává monitoring zdarma** (zakazky.gov.cz s AI vyhledáváním) — eroze hodnoty vstupní části trychtýře; teoreticky může stát časem přidat i AI přípravu nabídek. | Nízká–střední | Naše hodnota není monitoring, ale nacenění+generování+verify; stát nebude dodavatelům počítat marže a nákupní ceny (střet role). |
| R8 | **Koncentrace na jednoho vývojáře + AI provoz.** Produkt vzniká vysoce autonomním AI vývojem; bus factor 1; AI náklady vývoje ≫ AI náklady provozu. | Střední | Dokumentace v repu (reporty, audity, plán); CI/CD + testy (227+); nezávislé na konkrétní osobě u provozu, ne u vývoje. |
| R9 | **Cash-flow u Modelu 0.** Vyhraná dodávka = nakoupit zboží před zaplacením zadavatelem (splatnost 30+ dní). | Střední (jen Model 0) | **A-00 (blokuje podání): tvrdý strop souběžné kapitálové expozice + minimální contribution margin per zakázka**; go/no-go zobrazuje kapitálovou náročnost a expozici vůči stropu; případně dodavatelský úvěr. |

---

## Otevřené otázky pro majitele

1. **Potvrzení strategie po oponentuře: primární = managed service, Model 0 =
   omezený experiment.** Parametry experimentu (A-00): která entita podává
   (Make more? jiná?), **tvrdý strop souběžné kapitálové expozice v Kč**,
   minimální contribution margin per zakázka.
2. **Kdy a čím proběhne vlastní pilot (1 podání, po retrospektivě +2)?**
   Výběr živých zakázek z feedu dle reálné schopnosti dodat + rozhodnutí
   o jistotě/kvalifikaci je čistě majitelovo. Podmínka: A-00 schválené.
3. **Pilotní cena concierge per-bid** (návrh 1 990 Kč/CN, první zdarma) —
   potvrdit před oslovením partnerů. SaaS tiery (Start/Business/Pro) až po
   placené validaci — teď nerozhodovat.
4. **Právní konzultace (dvě témata):** (a) odpovědnostní klauzule pro SaaS
   („nástroj = podklad, podává a odpovídá zákazník"); (b) model přístupu
   k podání za dodavatele (účet NEN, zmocnění, podmínky užití NEN).
5. **HLIDAC_TOKEN + komerční licence Hlídače státu** — pořídit token (fallback
   feedu) a poptat cenu komerční licence (api@hlidacstatu.cz) pro budoucí
   komerční užití dat.
6. **Design partneři:** má Dan v síti 2–3 konkrétní MSP dodavatelské firmy pro
   assistovaný pilot? Pokud ne, odkud je vzít (obchodní síť Make more, Slack
   komunita, oborové asociace)?
7. **Default marže:** dnes 10 % fallback — potvrdit reálnou cílovou marži per
   kategorie komodit (nářadí vs. IT technika mají jiné tržní marže).
