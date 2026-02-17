# AI a české veřejné zakázky: strategická mapa příležitostí

**Nejlepší obchodní příležitostí pro malou českou IT firmu se zkušenostmi s veřejnými zakázkami je postupný přístup začínající AI-powered poradenstvím pro VZ (okamžité příjmy) a přecházející v českojazyčný AI SaaS pro přípravu nabídek — produktovou kategorii, ve které neexistuje žádný životaschopný konkurent.** Český trh veřejných zakázek ročně protočí téměř **1 bilion CZK** přes roztříštěné digitální systémy, přesto žádný nástroj na trhu nepomáhá dodavatelům skutečně *psát a vyhrávat* nabídky pomocí AI. Mezinárodní platformy jako Altura (financování €12,9M) a Brainial dominují západní Evropě, ale nemají žádnou integraci s českými portály ani českojazyčné schopnosti. Mezitím státní bezplatný portál zakazky.gov.cz ničí hodnotu základního monitoringu zakázek a posouvá tržní příležitost směrem k nástrojům pro přípravu nabídek a business intelligence. Právní riziko je nízké — žádná česká ani EU regulace neomezuje použití AI při přípravě nabídek — a technologický stack je dostatečně vyspělý na to, aby se MVP dalo postavit za méně než 1,5M CZK.

---

## Český ekosystém VZ: biliónová roztříštěná krajina

České veřejné zakázky dosáhly v roce 2024 hodnoty **993 miliard CZK** (12,4 % HDP), přičemž 15 310 zakázek bylo registrováno v oficiálním systému ISVZ v hodnotě 676 miliard CZK. Zbývajících ~317 miliard CZK protéká přes VZMR (veřejné zakázky malého rozsahu), které zcela unikají centrálnímu sledování. Od dubna 2025 zvýšené limity VZMR (dodávky/služby na **3M CZK**, stavební práce na **9M CZK**) tlačí ještě více výdajů do této neprůhledné zóny — což vytváří jak datovou výzvu, tak obchodní příležitost.

Platformovou krajinu dominuje **QCM s.r.o.**, která kontroluje **42,7 %** všech profilů zadavatelů prostřednictvím svých systémů E-ZAK a PVU a obsluhuje 175 000+ registrovaných dodavatelů. Zbývající trh se dělí mezi Tender arenu (11,2 %), NEN (8,2 % — povinný pro ústřední státní orgány), profilzadavatele.cz (21,2 %) a Otidea (8,3 %). Pro dodavatele tato roztříštěnost znamená kontrolu více systémů k nalezení příležitostí — problém, který se snaží řešit agregátory.

Agregátorová vrstva zahrnuje tři klíčové hráče. **Tendry.cz** (od Datlabu) nabízí AI-powered „Chytré sledování" od 750 CZK/měsíc, čerpající z 25 000+ zdrojů. **Verejna-soutez.cz** (Tender Service Group) poskytuje vícezemní monitoring s AI asistentem pro dokumenty za neveřejné roční předplatné. **Hlídač státu** funguje jako bezplatná občanská platforma pro transparentnost s komplexním REST API (Swagger dokumentace, token-based auth, licence CC BY 3.0) pokrývajícím zakázky, smlouvy, dotace a politické vazby.

Nejdisruptivnějším nedávným vstupem je **zakazky.gov.cz** — státem financovaný jednotný portál (NPO/NextGenerationEU) aktuálně v pilotním provozu. Agreguje VZ ze všech elektronických nástrojů do jediného vyhledávacího rozhraní s **bezplatným AI-powered vyhledáváním** („Chytré AI vyhledávání"), AI souhrny dokumentů a plánovanou AI chatbot funkcionalitou. Tento portál v kombinaci s bezplatnými notifikacemi pro dodavatele zásadně podkopává business case pro placené základní monitorovací nástroje.

### AI nástroje již přítomné na českém trhu

Čtyři české produkty již zahrnují AI pro veřejné zakázky, i když žádný neřeší psaní nabídek:

**Qlex** (QCM, 8 000–40 000 CZK/rok) je RAG-based právní znalostní asistent pokrývající ZZVZ, rozhodnutí ÚOHS a metodiky MMR. Jeho nejnovější verze 1.2.0 přidala sémantické vyhledávání („SemantiQ"). Přibližně 100 specialistů ÚOHS jej používá a 43% tržní podíl QCM poskytuje vestavěnou distribuci. Nicméně Qlex je čistě právní Q&A nástroj — nemonitoruje zakázky, neanalyzuje dokumenty a nepomáhá psát nabídky.

**Tenderix** (založen Dominikem Žlebkem a Michalem Jirků) se prezentuje jako „první AI ve veřejných zakázkách v ČR." Postavený na ChatGPT a natrénovaný na ~9 000 zakázkových dokumentů včetně rozhodnutí ÚOHS a soudních rozsudků, poskytuje Q&A v přirozeném jazyce s citacemi zdrojů. Zůstává malý a v rané fázi bez veřejného ceníku.

**„Chytré sledování" od Tendry.cz** využívá AI k učení se z historie nabídek firmy a párování relevantních zakázek. **Verejna-soutez.cz** nabízí AI asistenta pro Q&A nad dokumenty v rámci svého monitorovacího předplatného.

Klíčové je, že **žádný z těchto nástrojů nepomáhá dodavatelům připravovat nabídky, extrahovat požadavky ze zadávací dokumentace ani provádět kontrolu souladu s konkrétními podmínkami zakázky**. To je ta mezera.

---

## Mezinárodní konkurenti nemají český play

Systematický přehled 15+ mezinárodních AI procurement platforem odhaluje konzistentní vzorec: **žádná neposkytuje smysluplné pokrytí českého trhu VZ**. Altura (Amsterdam, €12,9M Series A od Octopus Ventures) pokrývá Benelux, UK a Německo. Brainial (Utrecht, od €17 500/rok) obsluhuje holandské enterprise klienty. Tenderbolt a AITenders se zaměřují výhradně na Francii. Tendium pokrývá Skandinávii plus nadlimitní zakázky přes TED. Stotles obsluhuje UK/Irsko. Americké nástroje (1up.ai za $250–850/měsíc, AutoRFP.ai za $899–1 450/měsíc) cílí výhradně na soukromý sektor.

Jediné částečné české pokrytí přichází přes TED (Tenders Electronic Daily), který zachycuje české nadlimitní oznámení. To ale pomíjí většinu českých zakázek — podlimitní a VZMR, které se na TED nikdy nedostanou. **48%+ míra jediného uchazeče** v českých VZ (jedna z nejhorších v Evropě) naznačuje, že dodavatelé mají problém zakázky najít a reagovat na ně, což posiluje příležitost pro lepší nástroje.

Dvě vznikající platformy — Tendify (EU-wide, beta/waitlist) a Tendery.ai (Berlín, 700K+ EU příležitostí) — tvrdí široké evropské pokrytí, ale nevykazují důkazy o hluboké integraci s českými portály. **Minerva** (useminerva.com) uvádí ČR jako pokrytý trh pro vyhledávání zakázek, ale vypadá jako early-stage.

Konkurenční moat pro český nástroj stojí na třech pilířích: **hluboká integrace s českými portály** (NEN, E-ZAK, PVU, VVZ), **nativní českojazyčné AI** pro právní/zakázkovou terminologii a **znalost českého zákona o zadávání VZ** (zákon 134/2016 Sb.) zabudovaná v produktu. Žádný mezinárodní hráč toto nedokáže rychle replikovat.

---

## Technická architektura: vyspělý a dostupný stack

Vybudování AI-powered VZ nástroje je technicky proveditelné s malým týmem a skromným rozpočtem. Doporučená architektura kombinuje osvědčené open-source komponenty s managed AI API.

**Data ingestion** by měl začít s Hlídač státu API (REST, JSON, zdarma pod CC BY 3.0 nebo komerční licencí) a ISVZ open data exporty (CSV, XML). Systém NEN také nabízí dokumentované veřejné API na podpora.nipez.cz. Dohromady pokrývají drtivou většinu formálních českých VZ bez nutnosti scrapingu. Pro VZMR a profily zadavatelů nová vyhláška č. 345/2023 Sb. nařizuje strojově čitelnou publikaci v XML/XSD od července 2024 — strukturovaná data, která lze programově parsovat.

**Zpracování dokumentů** vyžaduje hybridní pipeline. Pro nativní PDF (většina zadávacích dokumentací) **pymupdf4llm** nabízí nejrychlejší extrakci s LLM-ready markdown výstupem. Pro naskenované dokumenty nebo složité tabulky **Azure Document Intelligence** poskytuje vynikající české OCR za ~$1,50 za 1 000 stran. Tesseract 5 s českým jazykovým balíčkem nabízí bezplatnou alternativu s 85–95% přesností na čistých skenech.

**AI engine** by měl používat **Claude Sonnet 4.5** jako primární model ($3/$15 za milion input/output tokenů, 1M context window) — dobře zvládá český právní text a context window pojme celé zadávací dokumentace. Pro rychlou klasifikaci a triáž úloh postačí **Claude Haiku 4.5** ($1/$5). Batch API poskytuje 50% úsporu nákladů a prompt caching přináší až 90% úspor na opakovaném právním kontextu.

Pro RAG knowledge base pokrývající zákon 134/2016 Sb. a rozhodnutí ÚOHS je **pgvector** (PostgreSQL extension) pragmatická MVP volba — běží na stávající infrastruktuře bez dalšího servisu. **Cohere embed-multilingual-v3.0** ($0,10/M tokenů) poskytuje nejlepší česky optimalizované embeddingy. Knowledge base by zahrnovala ~500K tokenů jádrového textu zákona plus ~2M tokenů metodik a rozhodnutí ÚOHS.

**Workflow automation** přes self-hosted **n8n** (zdarma, nejlepší AI/LLM integrace, data sovereignty) zvládá monitoring zakázek, e-mailové notifikace a processing triggery při minimálních nákladech.

| Úroveň škálování | Měsíční náklady na infrastrukturu |
|---|---|
| **MVP** (1 VPS + pgvector + LLM API) | **1 755–3 393 CZK** ($75–145) |
| **Growth** (managed DB + vyšší LLM objem) | **8 775–20 592 CZK** ($375–880) |
| **Scale** (AWS/Azure + full stack) | **24 102–75 114 CZK** ($1 030–3 210) |

Náklady na LLM API pro analýzu dokumentů jsou pozoruhodně nízké: zpracování 500 zadávacích dokumentací měsíčně pomocí Claude Sonnet 4.5 stojí přibližně **5 250–10 500 CZK** ($225–450). S batch processingem a cachingem to klesá pod 3 000 CZK.

Kompletní vývoj produktu pro tým 2–3 lidí zabere **16–24 týdnů** ve třech fázích, s celkovými náklady na vývoj odhadovanými na **1,3–2,3M CZK** ($55K–100K).

---

## Pět produktových směrů — skórování a pořadí

Každý produktový směr byl vyhodnocen podle pěti kritérií: potenciál příjmů, náročnost vývoje (invertováno — nižší náročnost = vyšší skóre), time to market, competitive moat a připravenost trhu.

**Produkt D: Hybridní poradenství + AI nástroj má nejvyšší skóre 7,8/10.** Generuje příjmy od prvního dne prostřednictvím poradenství při přípravě nabídek VZ (30 000–90 000 CZK za zakázku), zatímco interně budovaný AI nástroj postupně snižuje náklady na dodávku a zvyšuje průchodnost. Trh VZ poradenství obsluhuje tisíce zadavatelů a dodavatelů, s roztříštěnou konkurencí malých firem jako TENDR CZ, Tendera (1 000+ dokončených řízení, 10+ miliard CZK v administrovaných zakázkách) a SMS-služby (od 20 000 CZK za VZMR). Žádná z nich nepoužívá AI, což AI-powered poradenství dává strukturální nákladovou výhodu **40–60 %** na rutinních úkolech.

**Produkt B: AI Bid Writing Assistant je na druhém místě s 6,8/10.** Obsazuje nejsilnější competitive moat — nulová česká konkurence pro AI-asistované psaní nabídek — s adresovatelným příjmem ~45M CZK/rok od IT, konzultačních a servisních firem, kde kvalita písemného návrhu přímo určuje win rate. Bariérou je doba vývoje (12–18 měsíců pro robustní MVP) a potřeba vybudovat důvěru prostřednictvím prokázaných výsledků. Hlavní value proposition je přesvědčivá: snížení průměrné přípravy nabídky ze **42 hodin na 15–20 hodin** ušetří 10 000–20 000 CZK na nabídku.

**Produkt C: Enterprise nástroj pro časté uchazeče je třetí s 5,0/10.** S ~1 000–2 500 firmami, které podávají 20+ nabídek VZ ročně (především stavebnictví, IT, facility management), dosahuje potenciál příjmů na zákazníka 60 000–200 000 CZK/rok. Ale enterprise sales cykly 3–12 měsíců a 18–24 měsíců vývoje z toho dělají příležitost pro Fázi 3.

**Produkt A: VZ Monitoring SaaS je čtvrtý s 4,6/10.** Státní bezplatný zakazky.gov.cz s AI funkcemi fatálně podkopává tento směr. Jakýkoli monitorovací produkt musí nabídnout podstatně více než to, co MMR poskytuje zdarma — vysoká laťka omezující diferenciaci na pokrytí VZMR a pokročilou analytiku.

**Produkt E: Analytická/Intelligence platforma je pátá s 4,4/10.** Datlab (založen 2012, podpořen Tilia Impact Ventures) drží desetiletou datovou výhodu s vládními vztahy, zindex.cz žebříčky a databází Tenderman pokrývající zakázky od roku 2006. Konkurovat Datlabu přímo na analytice je nerozumné.

| Kritérium (váha) | A: Monitoring | B: Bid Writer | C: Enterprise | D: Poradenství | E: Analytika |
|---|---|---|---|---|---|
| Potenciál příjmů (25 %) | 4 | 8 | 7 | 8 | 5 |
| Nízká náročnost vývoje (15 %) | 7 | 4 | 3 | 8 | 4 |
| Time to market (20 %) | 6 | 5 | 3 | 9 | 4 |
| Competitive moat (20 %) | 2 | 9 | 7 | 6 | 3 |
| Připravenost trhu (20 %) | 5 | 7 | 5 | 8 | 6 |
| **Vážené skóre** | **4,6** | **6,8** | **5,0** | **7,8** | **4,4** |

---

## Právní a regulatorní prostředí favorizuje akci

**Žádný český zákon neomezuje použití AI při přípravě nabídek do veřejných zakázek.** Zákon č. 134/2016 Sb. (ZZVZ) neobsahuje žádná ustanovení týkající se AI a ani ÚOHS, ani MMR nevydaly k tématu žádné stanovisko. Stanovisko České advokátní komory, že „AI nemůže poskytovat právní služby," se týká právního poradenství, nikoli přípravy zadávací dokumentace. Otevřená tržní přítomnost Tenderixu od roku 2024 dále demonstruje regulatorní přijatelnost.

**EU AI Act** (nařízení 2024/1689, v platnosti od srpna 2024) klasifikuje AI systémy podle úrovně rizika. AI nástroj pomáhající dodavatelům s přípravou nabídek spadá pod **minimální/omezené riziko** — provádí přípravné úkoly a nenahrazuje lidské rozhodování v kontextu veřejných orgánů. Článek 6 odst. 3 výslovně vyjímá systémy, které provádějí přípravné úkoly k hodnocení. Povinnosti pro high-risk systémy (platné od srpna 2026, s možným odkladem na prosinec 2027 dle českého vládního návrhu) by se týkaly pouze AI systémů, které automaticky hodnotí nebo skórují nabídky na straně zadavatele.

**Přístup k datům je právně robustní.** Česká zakázková data z VVZ/ISVZ představují otevřená data podle zákona č. 106/1999 Sb. Implementace eForms (vyhláška č. 345/2023 Sb., účinná od února 2024) nyní vyžaduje strukturovanou, strojově čitelnou XML/XSD publikaci profilů zadavatelů — díky čemuž jsou česká VZ data přístupnější pro AI nástroje než kdy dříve. API Hlídače státu poskytuje zpracovaná, propojená data pod licencí CC BY 3.0.

**GDPR vyžaduje pečlivý design, ale je zvládnutelné.** VZ dokumenty obsahují osobní údaje (kontaktní osoby, životopisy v kvalifikačních dokumentech, jména hodnotitelů). Doporučený přístup je minimalizace dat — anonymizovat osobní údaje před AI zpracováním, implementovat účelové omezení a jako právní základ použít oprávněný zájem (čl. 6 odst. 1 písm. f)). DPIA je vhodná při rozsáhlém zpracování. Desetiletá povinnost uchovávání VZ dokumentů odpovídá typickým archivačním lhůtám.

---

## Jak agentic AI změní procurement do roku 2028

**90 % procurement leaderů** plánuje implementovat AI agenty do 12 měsíců (ProcureCon 2025 CPO Report). Gartner předpovídá, že do roku 2028 bude 90 % B2B procurementu zprostředkováno AI agenty a přes AI výměny poputuje **$15+ bilionů**. To představuje zásadní posun od copilot-style asistence k autonomnímu provádění workflow.

Pro české VZ je konkrétně trajektorie jasná: AI agenti budou řešit příjem/klasifikaci nových zakázek, automatický pre-screening souladu s kvalifikací firmy, generování prvních návrhů technických nabídek a kontinuální monitoring dodatků a termínů zakázek. **68 % právních profesionálů** již používá alespoň jeden AI nástroj s hlášenými 40–45% úsporami času při revizi smluv — a analýza českých zadávacích dokumentací zahrnuje podobné úkoly.

Česká vláda aktivně digitalizuje veřejné zakázky přes více iniciativ: zakazky.gov.cz (AI vyhledávání a souhrny), strategie NAIS 2030 (19 miliard CZK pro národní AI) a projekt Czech AI Factory (~1 miliarda CZK se superpočítačem KarolAIna). CRR (Centrum pro regionální rozvoj) již nasadilo ANAKONDU — první vládní AI aplikaci pro administraci dotací. Toto institucionální momentum vytváří příznivé prostředí pro AI procurement nástroje.

Standardizace eForms napříč členskými státy EU (včetně ČR od února 2024) poskytuje strukturovaná, strojově čitelná data, která dramaticky zjednodušují AI integraci. Budoucí reforma EU veřejných zakázek, očekávaná v Q4 2026, pravděpodobně dále zdůrazní digitální nástroje a přístup SME — potenciálně vyžadující schopnosti, které mohou AI nástroje poskytnout.

---

## Doporučená strategie: tři fáze od poradenství k platformě

### Fáze 1 (měsíce 1–6): AI-powered VZ poradenství — cíl 2,5M CZK příjmů

Začít jako poradenská firma pro přípravu nabídek VZ, která interně využívá AI k rychlejšímu, levnějšímu a kvalitnějšímu dodávání než tradiční konkurenti. Cenit jednotlivé zakázky na 30 000–80 000 CZK za řízení. Investovat ~500K–1M CZK do vybudování interního AI toolkitu: analyzátor dokumentů (pymupdf4llm + Claude Sonnet), kontrola souladu (RAG proti zákonu 134/2016 Sb.) a knihovna šablon budovaná z každé dokončené zakázky. Poradenský model buduje zákaznické vztahy, doménovou expertízu a trénovací data potřebná pro produktovou fázi. Cíl příjmů: **2,5M CZK** v 1. roce z ~40–60 zakázek.

### Fáze 2 (měsíce 6–18): AI Bid Writing SaaS — cíl 7M CZK příjmů

Produktizovat interní nástroje do self-service SaaS. Klíčové funkce: nahrát zadávací dokumentaci → AI extrahuje požadavky, upozorní na problémy se souladem, navrhne přístup, připraví návrhy technických částí nabídky. Freemium model s bezplatnou analýzou dokumentů pro budování user base, placené funkce psaní a kontroly souladu za **1 500–3 000 CZK/měsíc**. Cílit na IT firmy, konzultační společnosti a středně velké stavební firmy, které připravují 5–20 nabídek ročně. Pokračovat v poradenské praxi pro složité/vysokohodnotové zakázky a přesouvat zákazníky na self-service. Investice: **3–5M CZK** do vývoje produktu. Cíl příjmů: **7M CZK** ve 2. roce (3M poradenství + 4M SaaS).

### Fáze 3 (měsíce 18–36): Enterprise platforma — cíl 16M+ CZK příjmů

Rozšířit se na full-cycle platformu pro časté uchazeče (20+ VZ/rok): monitoring, analytika, AI psaní, řízení nabídek, týmová spolupráce a knowledge base z minulých nabídek. Enterprise pricing na 60 000–200 000 CZK/rok. Přidat competitive intelligence funkce (kdo co vyhrává, za jakou cenu, cenové benchmarky) s využitím otevřených dat Hlídače státu a ISVZ. Cílit na top 500–1 000 častých uchazečů ve stavebnictví, IT a facility managementu. Investice: **5–10M CZK** navíc. Cíl příjmů: **16M CZK** ve 3. roce, se škálováním na **42M CZK** do 5. roku.

| Rok | Poradenství | SaaS | Celkem |
|---|---|---|---|
| 1 | 2,0M CZK | 0,5M CZK | **2,5M CZK** |
| 2 | 3,0M CZK | 4,0M CZK | **7,0M CZK** |
| 3 | 4,0M CZK | 12,0M CZK | **16,0M CZK** |
| 5 | 2,0M CZK | 40,0M CZK | **42,0M CZK** |

### Shrnutí nákladů na vývoj

| Položka | Odhadované náklady |
|---|---|
| Fáze 1 MVP (interní AI nástroje) | 500K–1M CZK |
| Fáze 2 SaaS produkt | 3–5M CZK |
| Fáze 3 Enterprise platforma | 5–10M CZK |
| Měsíční infrastruktura (MVP) | ~2 500 CZK |
| Měsíční LLM API náklady (500 docs) | ~7 500 CZK |
| **Celková investice do 3. roku** | **8,5–16M CZK** |

---

## Závěr: okno příležitosti je otevřené, ale zavírá se

Český trh VZ představuje vzácnou souhru podmínek: bilionový roční trh, roztříštěná digitální infrastruktura, nulová AI konkurence pro psaní nabídek, silné základy otevřených dat, příznivé právní prostředí a vládou řízená digitalizace vytvářející poptávku. Dvojí zkušenost firmy s veřejnými zakázkami i IT vývojem je přesně ta kombinace, kterou je třeba — hluboká doménová znalost je skutečný moat, ne samotná technologie.

Klíčový strategický vhled je, že **stát zpřístupňuje vyhledávání zakázek zdarma, zatímco skutečná bolest — a ochota platit — leží v přípravě nabídek**. Každá mezinárodní platforma závodí o pokrytí monitoringu a discovery. Žádná nepomůže české stavební firmě připravit soulad splňující technický návrh pro obecní stavební zakázku v češtině s odkazem na správné paragrafy zákona 134/2016 Sb. To je ten produkt, který je třeba vybudovat.

Přístup „nejdříve poradenství" eliminuje klasický cold-start problém SaaS: generuje okamžité příjmy, buduje doménovou expertízu, která živí AI, vytváří referenční zákazníky a validuje product-market fit před významnou technologickou investicí. Přechod od služby k produktu je ověřená cesta pro doménově specifické AI businessy. Je třeba jednat rychle — Qlex (podporovaný 43% tržním podílem QCM) i Tenderix rozšiřují své schopnosti a dobře financovaní mezinárodní hráči jako Altura by mohli cílit na CEE trhy do 18–24 měsíců.
