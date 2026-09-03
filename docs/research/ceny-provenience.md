# Provenience ceny ve VZ

Stav k 3. 9. 2026. Dokument je forenzní popis současného toku a návrh změny; produkční kód ani data v `output/` nebyly měněny. Vstupní měření 978 kandidátů v sedmi zakázkách, nulového počtu URL, pokrytí katalogovým číslem 203/978, rozdělení spolehlivosti 684/190/104 a pilotní odchylky přibližně +70 % přebírám jako dané a znovu je neověřuji (`/private/tmp/claude-501/-Users-dan-Dev-ClaudeCode-VZ/a508c55c-48a1-41de-837e-f306ff1e3465/scratchpad/rs/ceny.md:16-23`).

Hlavní závěr: současný systém dokládá, že člověk cenu potvrdil, nikoli odkud číslo pochází. Nejkratší platná cesta je modelový odhad → automatický cenový prefill → lidské potvrzení → dokumenty; URL ani jiný doklad na této cestě nejsou povinné (`scripts/src/lib/price-prefill.ts:142-155`; `scripts/src/lib/price-review.ts:8-21`; `scripts/src/lib/price-confirmation.ts:13-44`; `scripts/src/generate-bid.ts:112-123`).

## A. Forenzní analýza: kudy cena vzniká

### A.1 Společná poslední část všech cest

U vícepoložkové zakázky generátor nejprve vyžaduje potvrzenou `cenova_uprava`, potom pro každou položku vezme její `nabidkova_cena_bez_dph` a `nabidkova_cena_s_dph`; fallback na cenu kandidáta v kódu existuje, ale standardní generování před ním zastaví confirmation gate (`scripts/src/generate-bid.ts:95-124`; `scripts/src/generate-bid.ts:165-225`). Totály se propisují do modelu dokumentů, cenové nabídky a závazného soupisu XLSX (`scripts/src/generate-bid.ts:229-246`; `scripts/src/generate-bid.ts:307-323`; `scripts/src/generate-bid.ts:488-525`; `scripts/src/fill-soupis.ts:206-230`). Stejnou prioritu override → kandidát používá i obecný resolver dat (`scripts/src/lib/data-resolver.ts:217-284`).

Gate před generováním hledá pouze chybějící `cenova_uprava.potvrzeno`; původ ceny nekontroluje (`scripts/src/lib/price-confirmation.ts:13-44`). Submit gate přepočítá sanity nálezy a kontroluje potvrzení a auditující osobu, ale nevyžaduje URL ani `overeni_ceny`; u čistě legacy potvrzení bez auditní stopy může skončit jen varováním (`scripts/src/lib/submit-gate.ts:180-252`).

### A.2 Šest implementovaných cest

| Cesta | Kdo vyrobí číslo | Uložená provenience a odkaz | Co se stane bez provenience |
|---|---|---|---|
| 1. AI odhad produktu nebo příslušenství | Claude má vrátit orientační cenu, přestože prompt výslovně říká, že nemá přístup k aktuálním e-shopům (`scripts/src/prompts/product-match.ts:10-25`; `scripts/src/prompts/product-match.ts:59-72`). Odpověď se po parse vloží do `kandidati` (`scripts/src/match-product.ts:501-520`; `scripts/src/match-product.ts:627-654`). | Prompt žádá volný text `zdroj_ceny` a jména dodavatelů; vzorový JSON neobsahuje cenovou URL (`scripts/src/prompts/product-match.ts:102-127`; `scripts/src/prompts/product-match.ts:150-182`). Backend vyžaduje obě ceny, ale `zdroj_ceny` i obecné `reference_urls` jsou volitelné (`scripts/src/lib/types.ts:500-532`). | Kladná cena jednoznačněji pojmenovaného kandidáta se interpretuje jako nákupní cena, přidá se marže a vytvoří se nepotvrzený override; kontrola nečte zdroj ani URL (`scripts/src/lib/price-prefill.ts:98-155`; `scripts/src/lib/price-calculator.ts:20-39`). Po lidském potvrzení může pokračovat do nabídky (`scripts/src/lib/price-review.ts:8-21`; `scripts/src/generate-bid.ts:112-123`). |
| 2. AI odhad služby | Samostatný prompt nechá model vyrobit ceny služby bez a s DPH (`scripts/src/prompts/product-match.ts:185-223`). Kód z výsledku sestaví službového kandidáta (`scripts/src/match-product.ts:703-750`). | Kandidát služby dostane cenu, spolehlivost a komentář, ale nikoli `zdroj_ceny`, URL nebo dodavatele (`scripts/src/match-product.ts:734-746`). | Společný prefill přidá marži; služba je vyňata z guardu neidentifikovaného produktu, takže chybějící doklad není blokace (`scripts/src/match-product.ts:781-789`; `scripts/src/lib/price-prefill.ts:121-155`). |
| 3. Cenový sklad | Při zapnutí skladu číslo dodá nejlevnější řádek z `v_best_prices` (`scripts/src/lib/warehouse-matcher.ts:147-159`; `scripts/src/lib/warehouse-matcher.ts:218-237`; `scripts/src/lib/warehouse-matcher.ts:262-280`). | Matcher načte cenu, název zdroje a datum, ale nikoli existující `source_url`; kandidát obdrží jen volný text `zdroj_ceny`, interní ID a match metadata (`scripts/src/lib/warehouse-matcher.ts:15-37`; `scripts/src/lib/warehouse-matcher.ts:333-354`). Databázový store URL přitom ukládá (`scripts/src/lib/warehouse-store.ts:55-67`; `scripts/src/lib/warehouse-store.ts:521-592`). | Chybějící či starý zdroj sníží spolehlivost nebo změní text, ale nevytvoří blokaci; kladná cena pokračuje do společného prefillu (`scripts/src/lib/warehouse-matcher.ts:297-328`; `scripts/src/match-product.ts:671-701`; `scripts/src/match-product.ts:781-789`). |
| 4. Přímý lidský vstup nebo potvrzení AI prefillu | Operátor může změnit nákupní cenu a marži; klient dopočítá DPH a nabídku (`apps/web/src/components/ItemPriceCalculator.tsx:107-110`; `apps/web/src/components/ItemPriceCalculator.tsx:381-429`). Bez existujícího override UI předvyplní cenu vybraného kandidáta a zdroj nechá prázdný (`apps/web/src/components/ItemPriceCalculator.tsx:78-99`). | `zdroj_nakupu` se odešle pouze, pokud už existuje, a ve schématu je volitelný (`apps/web/src/components/ItemPriceCalculator.tsx:145-171`; `scripts/src/lib/types.ts:534-563`). Server doplní čas a identitu potvrzující osoby, nikoli původ částky (`scripts/src/lib/price-review.ts:8-21`). | Tlačítko vyžaduje kladnou cenu a případnou auditovanou výjimku při prodeji pod nákupem, nikoli zdroj (`apps/web/src/components/ItemPriceCalculator.tsx:549-568`). Single, bulk i per-item endpoint blokují jen hard sanity nálezy (`scripts/src/serve-api.ts:2258-2287`; `scripts/src/serve-api.ts:2323-2375`; `scripts/src/serve-api.ts:2398-2429`). |
| 5. Web verifier → individuální „Použít cenu“ | Web-search verifier hledá konkrétní produkt; zdroj přijme jen s bezpečnou přímou HTTPS URL, CZK a kladnou cenou (`scripts/src/lib/price-verifier.ts:141-182`; `scripts/src/lib/price-verifier.ts:316-418`). | Cena, URL, dodavatel, čas a až tři zdroje se uloží do `overeni_ceny`, nikoli do kandidáta (`scripts/src/lib/price-verifier.ts:486-539`; `scripts/src/lib/price-verifier.ts:1039-1079`). UI zvolený zdroj převede na nepotvrzenou `cenova_uprava` s `zdroj_nakupu.url` (`apps/web/src/lib/web-price.ts:46-75`; `apps/web/src/components/ItemPriceCalculator.tsx:181-191`). | Bez validní URL verifier zdroj nevytvoří (`scripts/src/lib/price-verifier.ts:359-418`). Individuální UI však dovolí po varování převzít orientační zdroj a neznámé balení nahradí hodnotou 1 (`apps/web/src/components/ItemPriceCalculator.tsx:181-190`; `apps/web/src/lib/web-price.ts:29-43`). Potom je stále nutné lidské potvrzení (`apps/web/src/components/ItemPriceCalculator.tsx:145-171`). |
| 6. Web verifier → hromadné „Použít reálné ceny“ | Server zvolí nejlevnější použitelný webový nález a dopočítá nabídku s marží (`scripts/src/lib/market-price-application.ts:76-121`). | Vyžaduje aktuální fingerprint, neorientační zdroj, známé balení a přijatelnou dostupnost; do nepotvrzeného override uloží URL a dodavatele (`scripts/src/lib/market-price-application.ts:83-121`; `scripts/src/lib/price-reality.ts:37-45`; `scripts/src/lib/price-reality.ts:72-90`). | Bez použitelného zdroje položku přeskočí; endpoint ani UI cenu samy nepotvrdí (`scripts/src/lib/market-price-application.ts:85-105`; `scripts/src/serve-api.ts:1936-1955`; `apps/web/src/components/ProductMatchView.tsx:193-215`). |

Hromadné potvrzení má prioritu webový draft → existující override → kladná cena AI kandidáta, takže může attestovat i odhady bez odkazu (`apps/web/src/components/ProductMatchView.tsx:260-302`; `apps/web/src/components/ProductMatchView.tsx:630-648`). Sanity kontrola používá override, jinak cenu kandidáta; tržní ochranu počítá jen z existujících `overeni_ceny.zdroje`, takže jejich absence srovnání vypne (`scripts/src/lib/price-sanity.ts:89-113`; `scripts/src/lib/price-sanity.ts:188-207`). Mezi hard kódy jsou strop, nula, prodej pod nákupem a extrémní outlier; chybějící provenience samostatný kód nemá a nízká spolehlivost či generický kandidát jsou jen varování (`scripts/src/lib/price-sanity.ts:160-206`; `scripts/src/lib/price-sanity.ts:240-303`).

Historická vítězná cena není sedmá automatická cesta: API vrací pouze informační pásmo a vzorky, UI je zobrazuje a matching je používá pro bid score, nikoli pro cenu kandidáta (`scripts/src/lib/winprice-api.ts:58-110`; `scripts/src/lib/winprice-query.ts:140-168`; `apps/web/src/components/ItemPriceCalculator.tsx:227-280`; `scripts/src/match-product.ts:816-826`). Předpokládaná hodnota zakázky může modelový odhad ukotvit, ale nekopíruje se přímo jako cena; cenový strop cenu také nevyrábí, pouze ji kontroluje (`scripts/src/prompts/product-match.ts:83-85`; `scripts/src/match-product.ts:501-508`; `scripts/src/lib/price-sanity.ts:160-167`).

Měřený stav odpovídá této architektuře: všech 978 kandidátů má jen text začínající „Odhad z…“, v `output/` není URL a v pilotu byl reálný nákup přibližně o 70 % výše (`/private/tmp/claude-501/-Users-dan-Dev-ClaudeCode-VZ/a508c55c-48a1-41de-837e-f306ff1e3465/scratchpad/rs/ceny.md:16-23`). Lidská auditní stopa proto v současném modelu prokazuje schválení čísla, nikoli jeho cenový doklad (`scripts/src/lib/types.ts:534-563`; `scripts/src/lib/price-review.ts:8-21`).

## B. Proč je cenový sklad funkčně prázdný

### B.1 Co sklad drží

| Objekt | Úloha |
|---|---|
| `products` | Katalog výrobce/modelu, EAN, MPN, parametrů, FTS textu a `embedding vector(1536)` (`scripts/migrations/001_warehouse_schema.sql:76-113`). |
| `product_prices_current` | Aktuální cena po produktu a zdroji, včetně `source_url` a `fetched_at` (`scripts/migrations/001_warehouse_schema.sql:140-153`). |
| `product_prices_history` | Historie změn cen (`scripts/migrations/001_warehouse_schema.sql:155-168`). |
| `v_best_prices` | Nejlevnější aktuální cena, kterou používá matcher (`scripts/migrations/001_warehouse_schema.sql:227-234`; `scripts/src/lib/warehouse-matcher.ts:147-159`). |
| `warehouse_web_findings` | Oddělená cache nálezů verifieru; warehouse matching ji nečte (`scripts/migrations/015_warehouse_web_findings.sql:1-18`; `scripts/src/lib/warehouse-matcher.ts:75-109`). |

### B.2 Jak se může plnit

Sklad nemá automatické naplnění při startu serveru; start pouze aplikuje migrace a čte statistiku (`scripts/src/serve-api.ts:4847-4890`). Implementované vstupy jsou:

1. Ruční REST vytvoření produktu a samostatný zápis ceny; store ukládá current i history (`scripts/src/serve-api.ts:4616-4630`; `scripts/src/serve-api.ts:4722-4745`; `scripts/src/lib/warehouse-store.ts:383-410`; `scripts/src/lib/warehouse-store.ts:521-600`).
2. Ručně spuštěný CSV/XLS/XLSX import s deduplikujícím upsertem produktu a volitelné ceny (`scripts/src/serve-api.ts:4667-4720`; `scripts/src/lib/csv-importer.ts:232-347`).
3. Explicitně spuštěný scraper registry, v níž je jediný aktivní shop `prusa`; čte čtyři 3D kategorie a importer zapisuje produkt i cenu s URL (`scripts/src/scrapers/registry.ts:6-22`; `scripts/src/scrapers/orchestrator.ts:142-160`; `scripts/src/scrapers/shops/prusa.ts:243-281`; `scripts/src/scrapers/importer.ts:30-77`).
4. Ruční Apify akce v UI/serveru; klient vyžaduje `APIFY_TOKEN` a upsertuje produkt i cenu (`apps/web/src/components/warehouse/WarehouseDashboard.tsx:478-495`; `scripts/src/serve-api.ts:4767-4811`; `scripts/src/lib/apify-client.ts:55-59`; `scripts/src/lib/apify-client.ts:204-245`). Mapování očekává klíče typu `alza`, zatímco endpoint předává databázové názvy typu `Alza.cz`; fallback proto směřuje neznámé názvy na Alza actor/doménu (`scripts/src/lib/apify-client.ts:12-20`; `scripts/src/lib/apify-client.ts:102-121`; `scripts/src/serve-api.ts:4788-4800`).
5. Samostatný import Apify datasetu načte nejvýše 1000 položek a posílá je do vzdáleného warehouse API (`scripts/src/import-apify-to-warehouse.ts:108-115`; `scripts/src/import-apify-to-warehouse.ts:192-306`). Samostatný 3D orchestrátor má devět jobů se součtem limitů 1800 stažených položek, ale deduplikace podle EAN, MPN či výrobce+modelu znamená, že nejde o 1800 unikátních produktů (`scripts/src/scrape-3d-market.ts:41-129`; `scripts/src/scrape-3d-market.ts:233-410`; `scripts/src/lib/warehouse-store.ts:461-503`).
6. Icecat pouze obohacuje už existující produkty s EAN/MPN a chybějícími parametry; nové produkty ani ceny nezakládá (`scripts/src/lib/icecat-client.ts:113-137`; `scripts/src/lib/icecat-client.ts:145-218`).

### B.3 Kolik záznamů lze obhájit

Migrační seed zakládá 29 kategorií a celkem 10 datových zdrojů, ale nevkládá žádný produkt ani cenu (`scripts/migrations/001_warehouse_schema.sql:252-281`; `scripts/migrations/001_warehouse_schema.sql:344-350`; `scripts/migrations/002_3d_manufacturer_aliases.sql:4-7`; `scripts/migrations/003_scraper_sources.sql:1-9`). Doložitelný stav čisté databáze po migracích je proto **0 produktů / 0 cen**; start serveru žádný import nepřidává (`scripts/src/serve-api.ts:4847-4890`).

Historický produkční sklad ale nebyl doslova prázdný: report z 9. 7. 2026 uvádí pouze zastaralý 3D sortiment a textové filamentové shody u 38/38 nesouvisejících položek (`docs/night-report-2026-07-09.md:16-22`). Aktuální počet řádků v produkční DB z repozitáře zjistit nelze a síťové či databázové ověření bylo zadáním zakázáno (`/private/tmp/claude-501/-Users-dan-Dev-ClaudeCode-VZ/a508c55c-48a1-41de-837e-f306ff1e3465/scratchpad/rs/ceny.md:5-11`). Číslo 1800 je pouze horní součet výstupních limitů jednoho nakonfigurovaného 3D běhu, nikoli počet unikátních záznamů v DB (`scripts/src/scrape-3d-market.ts:41-129`; `scripts/src/lib/warehouse-store.ts:461-503`).

### B.4 Proč se tři tiery v hlavní pipeline neuplatní

Společný blokátor je `WAREHOUSE_MATCH_ENABLED`: je pravdivý jen při hodnotě `1`, přímo podmiňuje celý vyhledávací cyklus a standardní produkční compose jej nepředává (`scripts/src/match-product.ts:43-49`; `scripts/src/match-product.ts:408-421`; `docker/docker-compose.hetzner.yml:11-22`).

**Exact.** Tier hledá jen podle EAN nebo MPN a bez nich ihned vrací prázdný výsledek (`scripts/src/lib/warehouse-matcher.ts:122-145`). Jediný caller v hlavní pipeline předává pouze název, specifikaci, technické požadavky a limit, nikoli EAN, MPN ani výrobce; exact je proto touto cestou nedosažitelný (`scripts/src/match-product.ts:412-419`).

**Text.** SQL přijme FTS shodu nebo trigram podobnost už nad 0,08, zatímco caller až následně zahazuje výsledky pod 0,35 (`scripts/src/lib/warehouse-matcher.ts:171-190`; `scripts/src/match-product.ts:423-433`). Jakmile existuje libovolná textová shoda, `searchWarehouse` ji vrátí a vector už nezkusí; caller po odfiltrování slabého výsledku vector fallback znovu nespouští (`scripts/src/lib/warehouse-matcher.ts:91-109`; `scripts/src/match-product.ts:428-433`). Povinné požadavky se navíc mění na tvrdé podmínky nad kanonickými parametry, ale importy často ukládají původní názvy nebo prázdný objekt (`scripts/src/lib/warehouse-matcher.ts:192-205`; `scripts/src/lib/requirement-parser.ts:97-168`; `scripts/src/lib/apify-client.ts:138-165`; `scripts/src/scrapers/importer.ts:39-55`). Historicky úzký 3D katalog je pro běžné zakázky doménově nerelevantní (`docs/roadmap-autonomie.md:45-52`).

**Vector.** Přesná podmínka `if (!process.env.OPENAI_API_KEY) return []` ukončí tier před výpočtem query embeddingu; i chybu neprázdného, ale nefunkčního klíče matcher zachytí a vrátí prázdné pole (`scripts/src/lib/warehouse-matcher.ts:246-258`). Produkční compose `OPENAI_API_KEY` nepředává a není ani v produkčním env vzoru (`docker/docker-compose.hetzner.yml:11-22`; `docker/.env.prod.example:1-9`). SQL současně hledá pouze mezi produkty s neprázdným embeddingem, ale importní cesty embeddingy negenerují; existuje jen ruční endpoint pro dodatečné vytvoření (`scripts/src/lib/warehouse-matcher.ts:262-280`; `scripts/src/lib/embedding-service.ts:89-117`; `scripts/src/serve-api.ts:4748-4756`). Důsledek je dvojí: bez klíče nevznikne query vektor a bez ručního backfillu chybí i prohledávaný vektorový korpus (`scripts/src/lib/warehouse-matcher.ts:246-280`; `scripts/src/lib/embedding-service.ts:89-117`).

Sklad tedy selhává před relevancí ve čtyřech vrstvách: je vypnutý, čistá DB je prázdná, exact nedostane identifikátory a vector nemá klíč ani automaticky vytvořený korpus (`scripts/src/match-product.ts:43-49`; `scripts/migrations/001_warehouse_schema.sql:252-281`; `scripts/src/match-product.ts:412-419`; `scripts/src/lib/warehouse-matcher.ts:246-280`). I po zapnutí může textový false positive zabránit vector fallbacku (`scripts/src/lib/warehouse-matcher.ts:91-109`; `scripts/src/match-product.ts:423-433`).

## C. Co dělá price-verifier a proč se nepoužívá plošně

### C.1 Kdo jej spouští

Produkční cesta je ruční: stránka renderuje `ProductMatchView`, operátor klikne na „Ověřit ceny (web)“, frontend odešle `POST /api/tenders/:id/run/verify-prices`, backend krok zařadí do fronty a spustí `verify-prices.ts` s `--tender-id` (`apps/web/src/pages/TenderDetailPage.tsx:354-359`; `apps/web/src/components/ProductMatchView.tsx:179-191`; `apps/web/src/lib/api.ts:1601-1611`; `scripts/src/serve-api.ts:330-340`; `scripts/src/serve-api.ts:524-567`; `scripts/src/serve-api.ts:3179-3215`). CLI načte `product-match.json` a jako jediný produkční caller volá `verifyAllPrices`; další vstup je přímé CLI a volitelný `eval-match --verify` (`scripts/src/verify-prices.ts:10-11`; `scripts/src/verify-prices.ts:96-139`; `scripts/src/eval-match.ts:71-85`).

Standardní `run-all` obsahuje jen `extract`, `analyze`, `match`, `generate`, `validate`; verifier v pořadí není a po matchingu řetězec přejde rovnou ke generate, kde se pouze pozastaví na lidském potvrzení (`scripts/src/lib/pipeline-job-state.ts:4-6`; `scripts/src/serve-api.ts:641-662`).

### C.2 Které položky ověřuje

UI/server předává pouze tender ID, takže bez CLI filtrů `--limit` a `--only-index` zkusí všechny způsobilé položky (`scripts/src/verify-prices.ts:97-106`; `scripts/src/verify-prices.ts:131-138`; `scripts/src/lib/price-verifier.ts:1140-1146`). Způsobilý je pouze aktuálně zvolený kandidát neslužbové položky s neprázdným výrobcem a modelem; legacy single-product formát se ověří jako kořen s indexem `-1` (`scripts/src/lib/price-verifier.ts:942-946`; `scripts/src/lib/price-verifier.ts:986-1033`). Nejprve se hledá přesný výrobek; ekvivalent až po neúspěchu a jen při autoritativní specifikaci nejméně 10 znaků (`scripts/src/lib/price-verifier.ts:829-850`).

### C.3 Co zapisuje

Přijatý nález obsahuje stav, typ shody, cenu, měnu, dodavatele, dostupnost, nejlevnější URL, čas, až tři strukturované zdroje a porovnání proti AI odhadu (`scripts/src/lib/price-verifier.ts:486-539`). Zdrojové schéma nese HTTPS URL, ceny, balení, měnu, DPH, dostupnost, parametrovou shodu a orientační/cache příznaky (`scripts/src/lib/types.ts:589-646`). `verifyAllPrices` přidá fingerprint zvoleného kandidáta, aby výsledek nebyl použit pro jiný produkt (`scripts/src/lib/price-verifier.ts:1201-1205`).

Merge zapisuje výhradně `polozky_match[].overeni_ceny`, případně kořenové `overeni_ceny`; `kandidati` ani `cenova_uprava` nemění (`scripts/src/lib/price-verifier.ts:1039-1079`). Store čte čerstvý soubor, přepočítá sanity, v případě potvrzené nabídky pod nově doloženým nákladem zruší potvrzení a zapisuje atomicky (`scripts/src/lib/price-verification-store.ts:17-39`; `scripts/src/lib/price-sanity.ts:188-206`). CLI navíc best-effort ukládá nálezy do `warehouse_web_findings` (`scripts/src/verify-prices.ts:164-176`; `scripts/src/lib/web-findings-store.ts:101-143`).

### C.4 Proč se URL nepropíše do kandidáta a proč v měřených datech není

`ProductCandidate.zdroj_ceny` je volný volitelný text modelového odhadu, zatímco URL verifieru patří do odděleného item-level `overeni_ceny` (`scripts/src/lib/types.ts:501-523`; `scripts/src/lib/types.ts:616-676`). Prompt dává `zdroj_ceny` význam popisu odhadu a uvádí vzor „Katalogová cena výrobce + odhad marže distribuce“ (`scripts/src/prompts/product-match.ts:59-67`; `scripts/src/prompts/product-match.ts:113-120`). Merge kandidáta úmyslně nemění a UI dál vykresluje původní text `zdroj_ceny` (`scripts/src/lib/price-verifier.ts:1039-1079`; `apps/web/src/components/ProductCandidateCard.tsx:52-61`).

Nulový počet URL v měřeném snapshotu vysvětluje kombinace čtyř vlastností:

1. verifier není v `run-all` (`scripts/src/lib/pipeline-job-state.ts:4-6`);
2. potvrzení ani generate/submit gate nevyžadují `overeni_ceny`, URL nebo povinný `zdroj_nakupu` (`scripts/src/lib/types.ts:534-563`; `scripts/src/lib/price-confirmation.ts:13-44`; `scripts/src/lib/submit-gate.ts:222-252`);
3. nový matching sestaví nový `ProductMatch` a přepíše soubor bez starého ověření (`scripts/src/match-product.ts:800-829`);
4. změna vybraného kandidáta maže `cenova_uprava` i `overeni_ceny` (`scripts/src/serve-api.ts:2440-2512`).

Současný verifier validní URL nezahazuje: bez ní nález vůbec nepřijme (`scripts/src/lib/price-verifier.ts:359-418`). Z absence URL proto lze dovodit jen to, že v aktuálním snapshotu nepřežil úspěšný verify běh; bez historických job logů nelze rozlišit, zda nikdy neproběhl, selhal, nebo byl později odstraněn rematchem či změnou kandidáta (`scripts/src/match-product.ts:800-829`; `scripts/src/serve-api.ts:2487-2494`).

### C.5 Existující cesta ověřené ceny do nabídky

Cesta existuje, ale není automatická. Individuální „Použít cenu“ vytvoří draft s URL a dodavatelem; hromadné „Použít reálné ceny“ přijme jen aktuální, neorientační, dostupný a známě balený zdroj (`apps/web/src/components/ItemPriceCalculator.tsx:312-372`; `apps/web/src/lib/web-price.ts:46-75`; `scripts/src/lib/market-price-application.ts:76-121`; `scripts/src/lib/price-reality.ts:37-89`). V obou případech musí člověk draft potvrdit, potom generátor použije čísla z `cenova_uprava` (`apps/web/src/components/ItemPriceCalculator.tsx:145-171`; `scripts/src/generate-bid.ts:190-214`). URL zůstane interně v `cenova_uprava.zdroj_nakupu`; dokumentový model z override přebírá jen produkt a dvě cenová čísla (`scripts/src/generate-bid.ts:165-214`).

### C.6 Rozdíly proti premise zadání

Premisa platí funkčně, nikoli ve dvou doslovných detailech. Backendový kandidát už má volitelné `reference_urls: string[]`, ale pole se nikde neplní, frontendový typ je nemá a nejde o provenienci konkrétní ceny (`scripts/src/lib/types.ts:521-523`; `apps/web/src/types/tender.ts:33-49`; `apps/web/src/components/ProductCandidateCard.tsx:52-78`). Zároveň již existuje ruční cesta, která ověřenou cenu a URL přenese do `cenova_uprava`; chybí její plošné spuštění a vynucení, nikoli úplně celý převod (`apps/web/src/lib/web-price.ts:46-75`; `scripts/src/lib/market-price-application.ts:76-121`).

## D. Návrh kontraktu provenience ceny

### D.1 Kanonický tvar

Navrhuji přidat povinné `cenova_provenience` jak ke každé kladné ceně kandidáta, tak jako neměnný snapshot k `cenova_uprava`, protože do dokumentů nakonec vstupuje override, nikoli původní kandidát (`scripts/src/lib/types.ts:500-563`; `scripts/src/generate-bid.ts:190-214`). `zdroj_ceny` zůstane pouze deprecated zobrazovací text pro čtení historie; autoritou nebude.

```ts
type PriceSourceType =
  | 'overeny_eshop'
  | 'cenovy_sklad'
  | 'historicka_vitezna_cena'
  | 'lidsky_vstup'
  | 'odhad_modelu';

interface PriceProvenance {
  verze: 1;
  typ: PriceSourceType;
  stav: 'dolozena' | 'informacni';
  url: string | null;
  doklad_ref?: string;              // neměnný interní doklad/nabídka
  zjisteno_at: string;              // ISO 8601
  platnost_do?: string;
  cena_v_okamziku: {
    bez_dph: number | null;
    s_dph: number | null;
    mena: 'CZK';
    sazba_dph: number | null;
    baleni_ks: number | null;
  };
  zjistil: {
    typ: 'web_agent' | 'system_import' | 'uzivatel' | 'model';
    id: string;
    jmeno?: string;
    model?: string;
    run_id?: string;
  };
  dodavatel?: string;
  kandidat_fingerprint: {
    verze: 1;
    algoritmus: 'sha256-canonical-json';
    hodnota: string;                 // 64 hex znaků
  };
  warehouse_product_id?: string;
  evidence_sha256?: string;
  poznamka?: string;
}
```

Pole `cena_v_okamziku` odděluje doložené pozorování nákupní ceny od pozdější marže a nabídkové ceny; dnešní kód obě vrstvy počítá odděleně v kalkulátoru (`scripts/src/lib/price-calculator.ts:20-39`). Současný fingerprint není hash, ale prostý text `výrobce|model|index` (`scripts/src/lib/candidate-fingerprint.ts:4-9`). Nový formát proto explicitně verzuje algoritmus; kanonický JSON má obsahovat normalizovaný výrobce, model, EAN/MPN nebo katalogové číslo a při chybějících identifikátorech index kandidáta. Tím zachová dnešní ochranu proti použití nálezu pro změněný produkt a zároveň odstraní nejasnost formátu (`scripts/src/lib/price-verifier.ts:1039-1079`; `scripts/src/lib/price-verifier.ts:1201-1205`).

### D.2 Uzavřený výčet a použitelnost

| `typ` | Podmínka `stav=dolozena` | Smí být přímým základem nabídky |
|---|---|---|
| `overeny_eshop` | Přímá HTTPS produktová URL, aktuální čas, shodný fingerprint, kladná CZK cena, známé balení a přijatelná dostupnost. Tyto kontroly vycházejí z přísnější současné bulk cesty (`scripts/src/lib/price-verifier.ts:316-418`; `scripts/src/lib/market-price-application.ts:83-121`; `scripts/src/lib/price-reality.ts:37-89`). | Ano, po lidském potvrzení. |
| `cenovy_sklad` | `source_url`, `fetched_at`, produktové ID a fingerprint; datum nesmí překročit konfigurovanou čerstvost. Dnes matcher URL z DB nečte, a to je nutné opravit (`scripts/migrations/001_warehouse_schema.sql:140-153`; `scripts/src/lib/warehouse-matcher.ts:147-159`). | Ano, po lidském potvrzení. |
| `lidsky_vstup` | Autentizovaný člověk, dodavatel a buď URL, nebo neměnný `doklad_ref` s hashem; samotná poznámka nestačí. Dnes server dokládá pouze identitu a čas kliknutí (`scripts/src/lib/price-review.ts:8-21`). | Ano, po lidském potvrzení jiné osoby nebo explicitním pravidle čtyř očí. |
| `historicka_vitezna_cena` | URL či ID historického vzorku a datum soutěže. Současná data jsou informační pásmo, nikoli aktuální nákupní cena (`scripts/src/lib/winprice-query.ts:140-168`; `scripts/src/match-product.ts:816-826`). | Ne; pouze benchmark, dokud není doplněn aktuální nákupní doklad. |
| `odhad_modelu` | Identita modelu, run ID, čas a původní text odhadu. Prompt přiznává absenci přístupu k aktuálním e-shopům (`scripts/src/prompts/product-match.ts:59-72`). | Ne; vždy `informacni`. |

Pravidlo kontraktu: každý nově zapsaný kandidát i rozpracovaný override s kladnou cenou musí mít syntakticky platnou provenienci. Modelový draft proto nese `odhad_modelu/informacni`; pouze tolerantní legacy čtení smí provenienci postrádat. `potvrzeno=true`, generate a submit navíc vyžadují `stav=dolozena` a typ povolený pro nabídku. Neúspěšný externí lookup nesmí být nahrazen modelovým odhadem pod typem „ověřený e-shop“.

### D.3 Kde se kontrakt vynutí

1. `scripts/src/lib/types.ts`: přidat `PriceProvenanceSchema`, povinný snapshot v nových kandidátech a override a oddělit tolerantní legacy read schema od přísného write schema; současné schéma připouští volné texty a volitelný zdroj (`scripts/src/lib/types.ts:500-567`).
2. Producenti: prompt a `match-product.ts` musí všechny AI ceny označit `odhad_modelu/informacni`; `warehouse-matcher.ts` musí načíst `source_url` a `fetched_at`; `price-prefill.ts` nesmí z informační ceny vytvořit potvrditelný draft (`scripts/src/prompts/product-match.ts:59-72`; `scripts/src/match-product.ts:627-654`; `scripts/src/lib/warehouse-matcher.ts:147-159`; `scripts/src/lib/price-prefill.ts:142-155`).
3. Web a server: `price-verifier.ts` a `market-price-application.ts` mají vytvořit kanonický snapshot; všechny tři price-write endpointy musí před `potvrzeno=true` volat jeden serverový semantic validator (`scripts/src/lib/price-verifier.ts:486-539`; `scripts/src/lib/market-price-application.ts:107-121`; `scripts/src/serve-api.ts:2258-2429`).
4. Gate: `price-confirmation.ts` má vracet „potvrzená a použitelně doložená“, `submit-gate.ts` má vypsat chybějící/propadlou provenienci po položkách a `generate-bid.ts` musí stejný invariant ověřit defense-in-depth před prvním zápisem dokumentu (`scripts/src/lib/price-confirmation.ts:13-44`; `scripts/src/lib/submit-gate.ts:180-252`; `scripts/src/generate-bid.ts:95-124`).
5. UI: karta kandidáta a kalkulátor mají ukázat typ, URL/doklad, dodavatele, čas, pozorovanou cenu a stav použitelnosti; `odhad_modelu` má být označen „nedoloženo — nelze potvrdit“. Ruční cena musí vyžadovat URL nebo nahrání dokladu, protože dnes potvrzovací tlačítko zdroj nekontroluje (`apps/web/src/components/ProductCandidateCard.tsx:52-78`; `apps/web/src/components/ItemPriceCalculator.tsx:145-171`; `apps/web/src/components/ItemPriceCalculator.tsx:549-568`).
6. Pipeline: pořadí má být `match → verify-prices → čekání na doplnění/potvrzení → generate`; dnešní `run-all` verifier vynechává (`scripts/src/lib/pipeline-job-state.ts:4-6`; `scripts/src/serve-api.ts:641-662`). Neúspěšné ověření má vést do čekání na doklad, nikoli do potvrditelného AI fallbacku.

### D.4 Migrace 978 existujících kandidátů

Migrace nesmí zpětně vyrábět URL ani tvrdit, že uvedení dodavatelé byli dotázáni; měření říká, že všech 978 zdrojů jsou textové odhady, žádná URL neexistuje a jména dodavatelů vznikla bez dotazu (`/private/tmp/claude-501/-Users-dan-Dev-ClaudeCode-VZ/a508c55c-48a1-41de-837e-f306ff1e3465/scratchpad/rs/ceny.md:16-23`). Navržený postup:

1. Dry-run inventář bez zápisu: počet kandidátů, override, existujících `overeni_ceny`, fingerprintů a potvrzených cen; report musí být samostatně schválen.
2. Každý legacy kandidát dostane `typ=odhad_modelu`, `stav=informacni`, `zjisteno_at=matchedAt`, pozorovanou cenu a původní `zdroj_ceny` v poznámce; dodavatelé se nepovýší na důkaz.
3. Jen existující `overeni_ceny.zdroje[]` s HTTPS URL, kladnou CZK cenou, časem, shodným fingerprintem, `orientacni !== true`, známým kladným balením, přijatelnou dostupností a konzistentní DPH lze převést na `overeny_eshop/dolozena`; současné struktury nesou potřebné zdrojové údaje a přísnější bulk cesta už nejasné zdroje odmítá (`scripts/src/lib/types.ts:589-646`; `scripts/src/lib/price-reality.ts:37-89`; `scripts/src/lib/market-price-application.ts:83-105`). Starý fingerprint se nejprve ověří současným algoritmem `výrobce|model|index` a teprve potom se z kandidáta spočítá nový verzovaný hash (`scripts/src/lib/candidate-fingerprint.ts:4-9`; `scripts/src/lib/price-verifier.ts:1201-1205`). Podle převzatého měření se převod v aktuálním `output/` týká nuly záznamů (`/private/tmp/claude-501/-Users-dan-Dev-ClaudeCode-VZ/a508c55c-48a1-41de-837e-f306ff1e3465/scratchpad/rs/ceny.md:16-23`).
4. Historické dokumenty zůstanou čitelné a auditované jako legacy; jejich nové generování nebo podání se zablokuje, dokud verifier či člověk nedodá doklad. Tolerantní read schema je již použitý vzor pro staré override (`scripts/src/lib/types.ts:565-567`).
5. Zápisová migrace poběží po tenderu atomicky, vytvoří zálohu/hash a vydá souhrn `převedeno / zůstává blokováno / chyba`; nebude se spouštět při běžném startu aplikace.

### D.5 Rozhraní externího agenta

Agent má dostat stabilní identitu položky a politiky, nikoli oprávnění potvrdit cenu:

```json
{
  "schema_version": 1,
  "request_id": "uuid",
  "tender_id": "string",
  "item": {
    "polozka_index": 0,
    "nazev": "string",
    "specifikace": "string",
    "mnozstvi": 1,
    "jednotka": "ks"
  },
  "candidate": {
    "fingerprint": {
      "version": 1,
      "algorithm": "sha256-canonical-json",
      "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    },
    "vyrobce": "string",
    "model": "string",
    "ean": null,
    "mpn": null
  },
  "policy": {
    "country": "CZ",
    "currency": "CZK",
    "max_age_hours": 24,
    "max_sources": 3,
    "require_direct_https_url": true,
    "require_known_package": true
  }
}
```

Odpověď má být čistý návrh evidence:

```json
{
  "schema_version": 1,
  "request_id": "uuid",
  "candidate_fingerprint": {
    "version": 1,
    "algorithm": "sha256-canonical-json",
    "value": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "status": "verified",
  "sources": [{
    "source_type": "overeny_eshop",
    "url": "https://shop.example/product",
    "dodavatel": "string",
    "nazev_produktu": "string",
    "observed_at": "2026-09-03T10:00:00Z",
    "price": {
      "bez_dph": 1000,
      "s_dph": 1210,
      "mena": "CZK",
      "sazba_dph": 21,
      "baleni_ks": 1
    },
    "dostupnost": "skladem",
    "splnuje_specifikaci": true,
    "shoda_parametru": ["string"],
    "evidence_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "observed_by": {"agent_id": "string", "model": "string", "run_id": "string"}
  }],
  "error": null
}
```

Povolené statusy mají být `verified | not_found | ambiguous | error`. Server musí odpověď znovu validovat a ověřit shodu `request_id` a verzovaného fingerprintu, HTTPS produktovou URL, čerstvost, kladnou CZK cenu, konzistenci DPH, balení a specifikaci. Dnešní parser pokrývá URL, CZK a kladnou cenu a merge kontroluje starý fingerprint; orientačnost, balení a dostupnost přísně odmítá až bulk aplikace, zatímco ověření externího `observed_at` a konzistence DPH jsou nové požadavky (`scripts/src/lib/price-verifier.ts:316-418`; `scripts/src/lib/price-verifier.ts:1039-1079`; `scripts/src/lib/market-price-application.ts:83-105`; `scripts/src/lib/price-reality.ts:37-89`). Agent nesmí vracet `potvrzeno`, marži ani finální nabídkovou cenu; server z evidence vytvoří nepotvrzený draft a člověk jej schválí, stejně jako dnešní bezpečnější bulk cesta (`scripts/src/lib/market-price-application.ts:107-121`).

### D.6 Dopad návrhu na kód

Počty níže jsou odhad logických zásahů, nikoli změny provedené v tomto researchi.

| Návrh | Soubory | Odhad míst |
|---|---|---:|
| Schéma, sémantický validator, verzovaný fingerprint a čtení historie | `scripts/src/lib/types.ts`, nový `scripts/src/lib/price-provenance.ts`, `scripts/src/lib/candidate-fingerprint.ts`, `apps/web/src/types/tender.ts` | 7 |
| Označení AI odhadů a oprava skladu | `scripts/src/prompts/product-match.ts`, `scripts/src/match-product.ts`, `scripts/src/lib/price-prefill.ts`, `scripts/src/lib/warehouse-matcher.ts` | 7 |
| Web verifier a adaptér externího agenta | `scripts/src/lib/price-verifier.ts`, `scripts/src/verify-prices.ts`, `scripts/src/lib/price-verification-store.ts`, `scripts/src/lib/market-price-application.ts`, nový `scripts/src/lib/external-price-agent.ts` | 8 |
| Serverové zápisy, kontroly reality/sanity a cenové brány | `scripts/src/lib/price-review.ts`, `scripts/src/lib/price-confirmation.ts`, `scripts/src/lib/price-reality.ts`, `scripts/src/lib/price-sanity.ts`, `scripts/src/lib/submit-gate.ts`, `scripts/src/generate-bid.ts`, `scripts/src/serve-api.ts`, `scripts/src/validate-bid.ts` | 13 |
| UI dokladu, náhledu a blokovaného stavu | `apps/web/src/lib/web-price.ts`, `apps/web/src/lib/market-price-preview.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/components/ProductCandidateCard.tsx`, `apps/web/src/components/ItemPriceCalculator.tsx`, `apps/web/src/components/ProductMatchView.tsx` | 9 |
| Povinné pořadí verifieru | `scripts/src/lib/pipeline-job-state.ts`, `scripts/src/serve-api.ts` | 3 |
| Legacy migrace a dry-run | nový `scripts/src/migrate-price-provenance.ts`, `scripts/src/lib/types.ts` | 4 |
| Regresní testy | `scripts/tests/price-review.test.ts`, `scripts/tests/price-confirmation.test.ts`, `scripts/tests/price-sanity.test.ts`, `scripts/tests/price-verifier.test.ts`, `scripts/tests/market-price-application.test.ts`, `scripts/tests/price-verification-store.test.ts`, `apps/web/tests/web-price.test.ts` a nové E2E gate testy | 12–16 |

Součet je přibližně 29 unikátních produkčních souborů včetně tří nových a nejméně 8 testovacích souborů; `serve-api.ts`, typy a validační pomocníci jsou dotčeni ve více nezávislých místech, proto nelze hodnoty ve sloupci „Odhad míst“ sčítat jako počet souborů (`scripts/src/serve-api.ts:2258-2429`; `scripts/src/serve-api.ts:3179-3215`).

## E. Odhad pracnosti

Odhad předpokládá jednoho vývojáře se znalostí repozitáře, existující verifier a současný souborový `product-match.json`; nejde o závazek ani o změřenou dobu.

| Pořadí | Etapa | Rozsah | Odhad | Nutnost |
|---:|---|---|---:|---|
| 1 | Rozhodnutí pravidel a akceptační scénáře | Čerstvost, uznané doklady, pravidlo čtyř očí, služby a chování legacy dokumentů | 0,5–1 člověkoden | Nutné |
| 2 | Kontrakt a validator | Backend/frontend typy, semantic validator, tolerantní čtení historie | 1,5–2,5 člověkodne | Nutné |
| 3 | Producenti a převody | AI jako informační zdroj, skladová URL, web snapshot, serverové price writes | 2,5–4 člověkodny | Nutné |
| 4 | Gate a pipeline | Confirmation, submit, generate defense-in-depth, zařazení verifieru a čekací stav | 2–3 člověkodny | Nutné |
| 5 | UI | Zobrazení důkazu, blokovaný odhad, formulář URL/dokladu, chybové stavy | 2–3 člověkodny | Nutné |
| 6 | Migrace | Dry-run, označení 978 odhadů, atomický backfill, rollback evidence | 1–2 člověkodny | Nutné před plošným zapnutím |
| 7 | Testy a rollout | Unit/API/E2E, audit existujících tendrů, feature flag, observabilita | 2–3 člověkodny | Nutné |

Nutné minimum pro tvrzení „cena v nabídce je doložitelná“ je přibližně **11,5–18,5 člověkodne** včetně migrace a rollout testů. Kritická posloupnost je kontrakt → producenti → serverový validator/gate → UI → migrace → rollout; samotná změna promptu nebo přidání URL do UI by invariant nevytvořily, protože dnešní generátor a submit gate provenienci nekontrolují (`scripts/src/lib/submit-gate.ts:180-252`; `scripts/src/generate-bid.ts:95-124`).

Nad rámec minima je implementace obecného externího agent adapteru a fronty (3–5 člověkodnů), zprovoznění a kurátorství skladu včetně embedding backfillu (5–10 člověkodnů), oprava a provozní zabezpečení scraperů (3–6 člověkodnů) a kalibrace historických vítězných cen jako benchmarku (2–3 člověkodny). Tyto práce zvyšují automatizaci a pokrytí, ale tvrdý invariant lze zavést už se současným verifierem a ručním doloženým vstupem (`scripts/src/lib/price-verifier.ts:316-539`; `apps/web/src/lib/web-price.ts:46-75`).

## Souhrnná tabulka

| Zjištění | Důkaz | Dopad | Návrh |
|---|---|---|---|
| AI je instruována cenu odhadnout bez přístupu k aktuálním e-shopům. | `scripts/src/prompts/product-match.ts:59-72` | Číslo není samo o sobě nákupní doklad. | Ukládat jako `odhad_modelu/informacni`; zakázat přímé potvrzení. |
| Kladný AI odhad se automaticky stane nákupním předvyplněním s marží. | `scripts/src/lib/price-prefill.ts:98-155` | Lidský klik může odhad propustit do dokumentů. | Předvyplnění bez doložené provenience ponechat jen jako nepotvrditelný návrh. |
| Potvrzení dokládá člověka a čas, ne zdroj částky. | `scripts/src/lib/types.ts:534-563`; `scripts/src/lib/price-review.ts:8-21` | Audit neumí zpětně prokázat nákupní cenu. | Povinný snapshot `cenova_provenience` v override. |
| Generate a submit gate nevyžadují cenový zdroj. | `scripts/src/lib/price-confirmation.ts:13-44`; `scripts/src/lib/submit-gate.ts:180-252`; `scripts/src/generate-bid.ts:95-124` | Cena bez URL či dokladu může skončit v závazné nabídce. | Jeden sdílený validator použitelnosti v write, submit i generate. |
| Skladová DB umí URL, matcher ji zahazuje. | `scripts/migrations/001_warehouse_schema.sql:140-153`; `scripts/src/lib/warehouse-matcher.ts:147-159`; `scripts/src/lib/warehouse-matcher.ts:333-354` | Ani skladový kandidát nemá strukturovaný cenový doklad. | Načíst a přenést URL, datum a source ID do kanonické provenience. |
| Čisté migrace vytvoří 0 produktů a 0 cen. | `scripts/migrations/001_warehouse_schema.sql:252-281`; `scripts/migrations/001_warehouse_schema.sql:344-350`; `scripts/migrations/002_3d_manufacturer_aliases.sql:4-7`; `scripts/migrations/003_scraper_sources.sql:1-9` | Bez ručního importu není co matchovat. | Oddělit zprovoznění skladu od invariantního gate; sklad není podmínkou první opravy. |
| Warehouse je defaultně vypnutý a exact nedostane EAN/MPN. | `scripts/src/match-product.ts:43-49`; `scripts/src/match-product.ts:412-419`; `scripts/src/lib/warehouse-matcher.ts:122-145` | První tier se v hlavní pipeline neuplatní. | Před zapnutím předat identifikátory a zavést měření relevance. |
| Vector bez `OPENAI_API_KEY` vrací prázdno a corpus se automaticky neembeduje. | `scripts/src/lib/warehouse-matcher.ts:246-280`; `scripts/src/lib/embedding-service.ts:89-117`; `docker/docker-compose.hetzner.yml:11-22` | Vector tier je ve standardním produkčním deployi mrtvý. | Klíč, explicitní backfill a monitoring řešit až při obnově skladu. |
| Verifier umí přímé HTTPS URL, ale není v `run-all`. | `scripts/src/lib/price-verifier.ts:316-539`; `scripts/src/lib/pipeline-job-state.ts:4-6` | Ověření závisí na ručním kliknutí. | Zařadit verify před čekání na potvrzení. |
| Verifier zapisuje `overeni_ceny`, nikoli kandidáta či override. | `scripts/src/lib/price-verifier.ts:1039-1079`; `scripts/src/lib/price-verification-store.ts:17-39` | URL sama nezmění číslo používané nabídkou. | Při „Použít“ vytvořit kanonický snapshot a vyžádat potvrzení. |
| Ruční individuální i hromadná cesta ověřené ceny už existuje. | `apps/web/src/lib/web-price.ts:46-75`; `scripts/src/lib/market-price-application.ts:76-121` | Není nutné stavět celý acquisition tok znovu. | Znovu použít jej za přísným validator/gate kontraktem. |
| Backend má `reference_urls`, ale nejde o používanou cenovou provenienci. | `scripts/src/lib/types.ts:521-523`; `apps/web/src/types/tender.ts:33-49` | Doslovná část původní premisy je nepřesná, funkční problém trvá. | Pole deprecovat nebo převést jen na obecné produktové reference. |
| Legacy snapshot má 978 odhadů a žádnou URL. | `/private/tmp/claude-501/-Users-dan-Dev-ClaudeCode-VZ/a508c55c-48a1-41de-837e-f306ff1e3465/scratchpad/rs/ceny.md:16-23` | Zpětné „doložení“ by bylo fabrikací evidence. | Označit vše jako informační odhad a vyžádat nové ověření či lidský doklad. |
