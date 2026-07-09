# Produktový brief: VZ 2.0 — automat na cenové nabídky do českých VZ

> Zdroj: noční research 2026-07-09 (`tasks/recon-market.md`). Značení: **[OVĚŘENO]** = potvrzeno z webového zdroje během researche, **[DOMNĚNKA]** = odhad vyžadující ověření. Data z července 2026 — před stavbou znovu ověřit živě (API i ceny se mění).

## Cíl produktu

Nástroj, který **vydělává peníze automatizací tvorby cenových nabídek (CN) do českých veřejných zakázek a maximalizuje počet výher**. Cílový běh je autonomní: monitoring nových zakázek → go/no-go rozhodnutí → nacenění (včetně win-price historie) → generování podatelných dokumentů → příprava podání. Člověk zůstává v smyčce jen u dvou kroků: **go/no-go rozhodnutí** a **schválení nákupů**. Metrika postupu je „3+1": nejdřív 100% průchodnost na historických zakázkách, pak škálování na desítky CN denně. Komoditně bez sektorového omezení — IT/AV, dílna/nářadí, kancelář, cokoliv naceněitelného z interního cenového skladu.

Dnešní realita kódu (`scripts/src/`): pipeline extract → analyze → match → generate → validate funguje, ale vstup je **100% ruční upload** dokumentace a **neexistuje** žádná databáze historických výsledků/vítězných cen. Obojí je pro nový cíl net-new stavba — viz `docs/roadmap-autonomie.md`.

---

## (a) Datové zdroje

Rozděleno na **monitoring** nových zakázek a **historii výsledků** (win-price inteligence — jádro konkurenční výhody).

| Zdroj | Monitoring | Historie/výsledky | Formát | API | Licence |
|---|---|---|---|---|---|
| **Hlídač státu** | silné [OVĚŘENO] | zakázky i smlouvy [OVĚŘENO] | JSON | REST API v2, token | CC BY 3.0 zdarma / komerční na dotaz |
| **ISVZ OpenData** | dávkově [OVĚŘENO] | oficiální zdroj pravdy [OVĚŘENO] | XML/CSV | dump ke stažení | otevřená data |
| **Věstník VZ (VVZ/eForms)** | formuláře [OVĚŘENO] | oznámení o výsledku [OVĚŘENO] | XML/eForms | přes ISVZ/TED | otevřená data |
| **Registr smluv** | ➖ (až po podpisu) | skutečné ceny + přílohy PDF [OVĚŘENO] | XML | denní dumpy, bez auth | otevřená data (GDPR!) |
| **TED (EU nadlimitní)** | silné [OVĚŘENO] | eForms [OVĚŘENO] | XML/JSON | API v3, bez auth | otevřená data |
| **Profily zadavatelů** | podlimitní [OVĚŘENO] | dle vyhl. 345/2023 [OVĚŘENO] | XML/XSD | dle profilu | otevřená data, roztříštěné |
| **NEN** | jen web [DOMNĚNKA] | jen web | HTML | veřejné čtecí API nenalezeno | — |
| **E-ZAK / Tender Arena / Josephine** | scraping [DOMNĚNKA] | částečně | HTML | ne veřejně | — |

**Klíčové body:**
- **Hlídač státu API v2** je nejrychlejší vstupní bod pro monitoring — agreguje víc zdrojů do jednoho JSONu. Zdarma verze = CC BY 3.0 s povinnou citací; pro komerční produkt bude téměř jistě potřeba **placená komerční licence** (cena neznámá, poptat na api@hlidacstatu.cz). [OVĚŘENO licenční model, DOMNĚNKA cena]
- **TED API v3** nevyžaduje autentizaci a nabízí bulk XML download — dobré pro nadlimitní zakázky a reuse.
- **NEN** (nen.nipez.cz) nemá dokumentovaný veřejný REST endpoint pro čtení/monitoring — v praxi se čte nepřímo přes ISVZ OpenData nebo scrapingem. Ověřit přímo u MMR/NIPEZ. [DOMNĚNKA]
- **Kombinace pro win-price:** VVZ/ISVZ award notice (vítěz + celková cena + počet nabídek) ⨝ Registr smluv (skutečná smlouva + PDF s položkami) ⨝ TED (nadlimitní). Párování přes IČO dodavatele + evidenční číslo zakázky + CPV/NIPEZ kód.
- Zdroje bez veřejného API (E-ZAK, Tender Arena, Josephine, Gemin, FEN, eVEZA) se propisují do centrálních registrů díky uveřejňovací povinnosti — čteme je nepřímo přes Hlídač/ISVZ, přímý scraping jen pro čerstvost/detail. [DOMNĚNKA — pokrytí ověřit]

---

## (b) Konkurence

### Česko

**Tenderpool** (tenderpool.cz) — **nejrelevantnější konkurent**. [OVĚŘENO] Hodinově skenuje ISVZ, NEN, Zakázky.gov, TenderArena, E-ZAK, FEN, Tendermarket, Gemin, eVEZA + profily; čte celou dokumentaci (PDF/DOCX/ZIP), skóruje relevanci 0–100 s auditovatelným odkazem na pasáž. Deklaruje 98% reliabilitu na 40 000+ tendrech. Cena: **Business 4 850 Kč/měs (4 120 Kč roční)**, Enterprise custom. 7denní trial, EU hosting, ISO 27001.

**Klíčová mezera:** Tenderpool sám deklaruje, že **negeneruje vlastní nabídky, pouze pomáhá najít a vyhodnotit**. To je přesně prostor, kam náš produkt cílí dál — nacenění + generování podatelných dokumentů + příprava podání.

Další CZ hráči: vhodne-uverejneni.cz (certifikovaný nástroj, ~33 % zadavatelů ho používá, spíš publikační/monitoring), TenderMonitor (jednoduchý monitoring CZ+EU), Tender Arena/Tendermarket (elektronický nástroj pro zadávání, ne AI příprava nabídek), zakazky.eu, BizMachine (monitoring pro velké firmy). [OVĚŘENO]

### EU/US GovTech — inspirace pro AI bid automation [OVĚŘENO]

- **GovDash** (govdash.com) — US federal: discovery → capture → proposal → post-award, „RFP shredding" do compliance matrix + drafty odpovědí. Series B $30M (leden 2026), zákazníci vyhráli přes $5 mld v 2025.
- **Rohirrim** (rohirrim.ai) — organization-specific GenAI natrénovaná na firemních výhrách a vlastní proposal metodologii.
- **Tendium** — EU public-sector, unified tool od monitoringu po psaní nabídky.
- Přehledy trhu: AutoRFP.ai, GovEagle, DeepRFP, Civio, Lucius AI.
- Efekt trhu: proposal automation zkracuje čas na RFP o 50–60 %, mid-market dodavatelé škálují objem nabídek 3–4× bez náboru — potvrzuje tezi „desítky nabídek denně".

**Závěr:** V ČR nikdo veřejně nedělá end-to-end od monitoringu po vygenerovanou podatelnou nabídku s win-price naceněním. Diferenciace: **nacenění z historie + generování dokumentů + příprava podání**.

---

## (c) Právní rámec podání

**Může nástroj podat nabídku elektronicky za firmu? Ano, technicky i právně schůdné, s výhradami.** [OVĚŘENO]

- **§211 odst. 7 ZZVZ (zák. 134/2016 Sb.):** úkon učiněný přes elektronický nástroj (NEN/E-ZAK/…) nebo datovou schránku se považuje za podepsaný — **fikce podpisu**. Nabídka podaná přes NEN nemusí mít kvalifikovaný elektronický podpis.
  Zdroje: epravo.cz/top/clanky/elektronicky-podpis-pri-zadavani-verejnych-zakazek-117277.html · portal-vz.cz/nezarazene/Elektronicky-podpis-nabidky-vs-elektronicky-podpis
- **Důsledek:** systém přihlášený pod účtem dodavatele může nabídku technicky sestavit a odeslat bez osobního kvalifikovaného podpisu → vysoká míra automatizace je legální.
- **Výjimky, kde podpis potřeba:** čestné prohlášení/dokument za člena týmu jednajícího sám za sebe vyžaduje alespoň prostý el. podpis té osoby; návrh smlouvy se doporučuje podepsat vyšším stupněm kvůli důkazní síle. Podává-li nabídku zmocněnec, ideálně všechny dokumenty el. podepsané dodavatelem, jinak zmocněnec drží podepsané originály + plnou moc.
- **Přístup k účtu:** podání běží pod přihlášením dodavatele do NEN → nutná smlouva/zmocnění a technické řešení přístupu. [DOMNĚNKA — model ověřit s právníkem a s podmínkami užití NEN]

**Co musí zůstat na člověku:**
1. **Go/no-go rozhodnutí** a **finální „Odeslat nabídku"** — peníze a závazek firmy.
2. **Schválení nákupů** u dodavatele.
3. Odpovědnost za pravdivost čestných prohlášení a kvalifikace zůstává na firmě.
4. **GDPR:** Registr smluv obsahuje osobní údaje → náš sklad musí mít režim správce OÚ (mazání znepřístupněných záznamů, minimalizace).
5. **Licence dat:** Hlídač CC BY 3.0 → citovat zdroj, nebo pořídit komerční licenci (pro komerční produkt doporučeno).

---

## (d) Win-price koncept

Detailní design a živě ověřený prototyp: `docs/win-price-design.md` (vzniklo v této noční session, PR #16).

**Shrnutí:** zvolen zdroj **Registr smluv** (denní XML dumpy z data.smlouvy.gov.cz) — bez auth, obsahuje skutečnou smluvní cenu + předmět + datum + odkaz na přílohu smlouvy. Prototyp naimportoval **51 000 záznamů za ~3 týdny** (16. 6. – 8. 7. 2026), 35 426 s cenou.

Ukázkové reálné výsledky dotazu na cenové pásmo (`query-win-prices.ts`, trigram + fulltext similarity):

| Dotaz | n | Medián bez DPH | Rozpětí |
|---|---|---|---|
| „server" | 163 | 111 152 Kč | 3 088 – 8 960 380 Kč |
| „projektor" | 143 | 122 700 Kč | — |
| „notebook" (kategorie it_av) | 25 | 104 200 Kč | 14 805 – 2 915 590 Kč |
| „vrtačka" | 17 | 156 920 Kč | fuzzy match riziko (viz níže) |

**Known limitations (viz win-price-design.md §5b, §7):**
- Role stran (zadavatel vs. dodavatel) v Registru smluv **není spolehlivá** — řeší heuristika `resolvePartyRoles()` s příznakem nespolehlivosti; nepoužívat `dodavatel_*` jako jistého vítěze bez ověření.
- Chybí počet uchazečů (přijde z VVZ/ISVZ award notice, TODO).
- Kategorizace komodit je zatím heuristika klíčových slov, ne AI/CPV — TODO.
- Dirty data (chybné roky, extrémní částky u rámcových smluv) — čištění TODO.
- GDPR režim mazání znepřístupněných záznamů — TODO.

Napojení na `match-product`/`verify-prices` a go/no-go scoring je **navrženo, neimplementováno** — win-price signál má být vedlejší, návrhové pole (analogicky k dnešnímu `overeni_ceny`), nikdy nesahá přímo na `cenova_uprava`.

---

## Otevřené otázky k ověření před další stavbou

1. Cena komerční licence Hlídač státu (poptat na api@hlidacstatu.cz). [DOMNĚNKA]
2. Aktuální endpointy a XSD ISVZ OpenData — obsahují počet nabídek a položkové ceny? [nutno ověřit]
3. Existuje neveřejné čtecí rozhraní NEN pro monitoring? (dotaz na MMR/NIPEZ) [DOMNĚNKA]
4. Model přístupu k podání za dodavatele (účet NEN, datová schránka, zmocnění) — konzultace s právníkem. [nutno ověřit]
5. Reálné pokrytí zdrojů — kolik % relevantních VZ chytí Hlídač vs. přímý scraping E-ZAK/Josephine. [DOMNĚNKA]

## Zdroje

- Hlídač státu API: hlidacstatu.cz/api/v1/doc · hlidacstatu.docs.apiary.io · github.com/HlidacStatu/API
- ISVZ OpenData: skd.nipez.cz/ISVZ/MetodickaPodpora/Napovedaopendata.pdf · isvz.cz · skd.nipez.cz
- VVZ: vvz.nipez.cz · NKOD data.gov.cz/datasety
- Registr smluv: smlouvy.gov.cz/stranka/otevrena-data · data.smlouvy.gov.cz
- TED API v3: docs.ted.europa.eu/api/latest/index.html · docs.ted.europa.eu/api/latest/search.html
- Profily / vyhl. 345/2023: portal-vz.cz/nipez/profil-zadavatele-4 · podpora.nipez.cz/cs/zadavatel/latest/profil-zadavatele
- NEN: nen.nipez.cz
- Právo (el. podpis §211/7): epravo.cz/top/clanky/elektronicky-podpis-pri-zadavani-verejnych-zakazek-117277.html · portal-vz.cz/nezarazene/Elektronicky-podpis-nabidky-vs-elektronicky-podpis
- Konkurence CZ: tenderpool.cz/en · vhodne-uverejneni.cz/cenik · tendermonitor.cz · tendersystems.cz/tenderarena.html
- Konkurence EU/US: govdash.com/blog/proposal-automation-tools-government-contractors · rohirrim.ai/government-contractors · autorfp.ai/blog/best-rfp-software
