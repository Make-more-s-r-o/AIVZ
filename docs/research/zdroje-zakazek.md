# Odkud VZ bere zakázky dnes a jak přidat další zdroje

Tento dokument popisuje pouze stav doložitelný repozitářem. Síťové chování portálů, aktuální počty výsledků a nasazení externích workflow nebyly ověřovány.

## A. Inventura dnešních zdrojů

### A.1 Stručná mapa toku

Aktuální Express monitoringový tok zná právě dva identifikátory zdroje, `nen` a `hlidac`, plus agregační volbu `both` (`scripts/src/lib/monitoring/monitoring-sync.ts:9-20`). Ruční synchronizace bez parametru volí NEN; hodinová synchronizace volí oba zdroje, spustí se také jednou při startu serveru a respektuje governance přepínač ingestu (`scripts/src/serve-api.ts:1096-1121`, `scripts/src/serve-api.ts:4928-4951`).

Registr smluv se v repozitáři objevuje jako zdroj historických vítězných/smluvních cen pro win-price, ne jako zdroj položek `monitoring_zakazky`; do počtu monitorovacích zdrojů jej proto nezahrnuji (`scripts/src/lib/winprice-store.ts:1-8`, `scripts/migrations/014_monitoring_zakazky.sql:1-4`). Exportované n8n workflow rovněž volá Hlídač, tedy nepřidává třetí původ dat (`n8n-workflows/vz-monitor-hlidac.json:22-45`).

Tok je:

1. `POST /api/monitoring/sync` nebo hodinový timer vytvoří pole textových dotazů z `klicova_slova`; prázdný seznam nahradí jedním `''` (`scripts/src/serve-api.ts:1111-1121`, `scripts/src/serve-api.ts:4937-4944`).
2. `collectMonitoringInputs` volá klienty sekvenčně pro každý výraz a mapuje jejich kandidáty na společný `FeedUpsertInput` (`scripts/src/lib/monitoring/monitoring-sync.ts:23-66`, `scripts/src/lib/monitoring/monitoring-store.ts:20-31`).
3. `upsertFeed` ukládá kandidáty do `monitoring_zakazky`; konflikt řeší podle `(zdroj, zdroj_id)` (`scripts/src/lib/monitoring/monitoring-store.ts:102-141`, `scripts/migrations/014_monitoring_zakazky.sql:7-22`).
4. `GET /api/monitoring/feed` načte omezenou množinu, skryje vyloučené názvy, dopočítá skóre, seřadí ji a znovu ořízne (`scripts/src/serve-api.ts:1149-1184`).
5. Při převzetí se vytvoří složka zakázky; dokumenty se stáhnou jen při explicitním `stahnout_zd: true` a pouze větví pro NEN nebo Hlídač (`scripts/src/serve-api.ts:1190-1225`, `scripts/src/serve-api.ts:1245-1284`).

### A.2 NEN

| Oblast | Dnešní implementace |
|---|---|
| Přístup | Klient parsuje server-rendered HTML na `https://nen.nipez.cz/verejne-zakazky`; neposílá přihlašovací údaj, jen HTML `Accept`, vlastní `User-Agent` a `Connection: close` (`scripts/src/lib/monitoring/nen-client.ts:1-17`, `scripts/src/lib/monitoring/nen-client.ts:107-111`). |
| Dotaz | Neprázdný fulltext se vloží do cesty jako `/p:vz:query=<URL-encoded výraz>`; prázdný dotaz segment úplně vynechá. Další strany používají `/p:vz:page=N` (`scripts/src/lib/monitoring/nen-client.ts:93-98`). |
| Návratová pole | Parser čte systémové číslo NEN, název, zadavatele, aktuální stav, lhůtu podání a detail URL (`scripts/src/lib/monitoring/nen-client.ts:70-85`, `scripts/src/lib/monitoring/nen-client.ts:164-190`). |
| Výběr | Ponechá jen položky se stavem přesně `Neukončen` a v rámci jednoho fetch běhu je deduplikuje systémovým číslem (`scripts/src/lib/monitoring/nen-client.ts:67-68`, `scripts/src/lib/monitoring/nen-client.ts:125-145`). |
| Strop | Výchozí maximum je 5 stran, přepsatelné kladným celočíselným `NEN_MAX_PAGES`; request má timeout 20 s a mezi stranami je 300 ms (`scripts/src/lib/monitoring/nen-client.ts:14-17`, `scripts/src/lib/monitoring/nen-client.ts:60-65`, `scripts/src/lib/monitoring/nen-client.ts:127-154`). Velikost jedné strany kód neurčuje. |
| Uložení | Uloží se `zdroj=nen`, ID, název, kategorie odvozená z názvu, zadavatel, lhůta, URL a celý kandidát v `raw`; `predpokladana_hodnota` se nastaví natvrdo na `null` (`scripts/src/lib/monitoring/monitoring-store.ts:230-242`). |

NEN seznamový klient tedy nemá CPV ani cenu. Poznámka u mapperu tvrdí, že se cena doplní z detailu při zpracování, ale monitorovací kód z detailu NEN načítá jen seznam dokumentů a feedový řádek už cenou neaktualizuje (`scripts/src/lib/monitoring/monitoring-store.ts:238-242`, `scripts/src/lib/monitoring/nen-client.ts:196-203`, `scripts/src/serve-api.ts:1253-1265`). Zdrojový stav zůstane jen v `raw`; databázový sloupec `stav` je interní stav `nova | prevzata | ignorovana` (`scripts/migrations/014_monitoring_zakazky.sql:9-20`).

#### Dokumenty z NEN

Přílohy se hledají na `<detail>/zadavaci-dokumentace` a dalších stranách `/p:pzd:page=N`. Používá se stejný výchozí strop 5 stran a deduplikace podle absolutní URL (`scripts/src/lib/monitoring/nen-client.ts:217-220`, `scripts/src/lib/monitoring/nen-client.ts:250-295`). Chyba pozdější strany vrátí dosud nasbírané přílohy; chyba první strany i legitimně prázdný seznam skončí jako stejné `[]` (`scripts/src/lib/monitoring/nen-client.ts:276-288`). Odkaz i každý redirect musí zůstat na přesném HTTPS hostu `nen.nipez.cz`, nejvýše přes tři redirecty (`scripts/src/lib/monitoring/nen-client.ts:20-57`).

Nedávná oprava stránkování je v aktuálním kódu přítomná: stránkovací URL se skutečně generuje a cyklus pokračuje do prázdné strany nebo maxima (`scripts/src/lib/monitoring/nen-client.ts:217-220`, `scripts/src/lib/monitoring/nen-client.ts:267-295`). Oprava však neodstraňuje výchozí limit pěti stran dokumentace, případně limit `NEN_MAX_PAGES` z prostředí (`scripts/src/lib/monitoring/nen-client.ts:60-65`, `scripts/src/lib/monitoring/nen-client.ts:258-264`).

#### Tiché díry NEN

- Výchozích pět stran bez explicitního parametru řazení, zdrojového `total` nebo perzistentního cursoru nezaručuje úplný průchod katalogem a kód nedokazuje, že jde právě o nejnovější položky (`scripts/src/lib/monitoring/nen-client.ts:60-65`, `scripts/src/lib/monitoring/nen-client.ts:93-98`, `scripts/src/lib/monitoring/nen-client.ts:120-156`).
- Parser závisí na `<tr class="gov-table__row">`, přesných textech `data-title` a konkrétním tvaru HTML. Změna značek může dát nula řádků; nula ukončí stránkování a celá operace přesto vrátí `ok: true` (`scripts/src/lib/monitoring/nen-client.ts:139-156`, `scripts/src/lib/monitoring/nen-client.ts:164-193`, `scripts/src/lib/monitoring/nen-client.ts:298-303`).
- Řádek bez ID nebo názvu se bez diagnostiky zahodí; bez detail odkazu se přijme obecná URL seznamu, ze které se později mechanicky skládá cesta, jejímž základem není URL detailu zakázky (`scripts/src/lib/monitoring/nen-client.ts:172-190`, `scripts/src/lib/monitoring/nen-client.ts:211-215`).
- Přesná podmínka `candidate.stav === 'Neukončen'` zahodí záznam s chybějícím stavem i s jiným zápisem stejného významu (`scripts/src/lib/monitoring/nen-client.ts:139-145`).

### A.3 Hlídač státu

| Oblast | Dnešní implementace |
|---|---|
| Endpoint | `https://api.hlidacstatu.cz/api/v2/verejnezakazky/hledat` (`scripts/src/lib/monitoring/hlidac-client.ts:1-2`). |
| Autentizace | Token se bere z `HLIDAC_TOKEN` a posílá jako `Authorization: Token <token>`. Bez tokenu se žádný HTTP request neprovede a funkce vrátí `[]` (`scripts/src/lib/monitoring/hlidac-client.ts:21-27`, `scripts/src/lib/monitoring/hlidac-client.ts:34-40`). |
| Dotaz | Nastaví `dotaz=<trimmed výraz>`, vždy `strana=1` a `razeni=1` (`scripts/src/lib/monitoring/hlidac-client.ts:29-32`). |
| Strop | Čte přesně jednu stránku. Nenastavuje velikost stránky, nečte počet výsledků ani stránkovací metadata a nemá cyklus na další strany (`scripts/src/lib/monitoring/hlidac-client.ts:29-52`). |
| Návratová pole | Kandidát obsahuje ID, název, zadavatele, odhadovanou hodnotu bez DPH, lhůtu, stav, URL, dokumenty a CPV (`scripts/src/lib/monitoring/hlidac-client.ts:4-19`, `scripts/src/lib/monitoring/hlidac-client.ts:62-89`). |
| Uložení | Uloží se ID, název, zadavatel, hodnota, normalizovaná lhůta a URL. Kategorie se znovu určí jen z názvu; CPV, `stavVZ` a případné dokumenty jsou dostupné pouze uvnitř `raw` (`scripts/src/lib/monitoring/monitoring-store.ts:245-257`). |

Oproti NEN poskytuje použitý parser navíc především `budget` a `cpv`; zadavatel, stav a lhůtu umějí oba klienti (`scripts/src/lib/monitoring/nen-client.ts:70-80`, `scripts/src/lib/monitoring/hlidac-client.ts:9-19`). Rozdíl se ale využije jen částečně: hodnota se stane prvotřídním DB polem, zatímco CPV se nepoužije ke kategorizaci, hledání ani filtrování (`scripts/src/lib/monitoring/monitoring-store.ts:245-257`, `scripts/migrations/014_monitoring_zakazky.sql:7-21`). Stav Hlídače se při ingestu nefiltruje; při čtení feedu se skryje jen řádek s parsovatelně prošlou lhůtou, zatímco `NULL` lhůta zůstává (`scripts/src/lib/monitoring/monitoring-store.ts:182-184`, `scripts/src/lib/monitoring/monitoring-store.ts:245-257`).

#### Dokumenty z Hlídače

Při převzetí se volá detail `https://api.hlidacstatu.cz/api/v2/verejnezakazky/{id}` se stejným tokenem, protože podle komentáře klienta bulk hledání dokumenty nevrací (`scripts/src/lib/monitoring/hlidac-client.ts:92-108`, `scripts/src/serve-api.ts:1267-1275`). Detail parser přijímá pouze lowercase `body.dokumenty`, uvnitř jen `directUrls`/`oficialUrls`, a z každého pole vezme první URL; jiné casingy a další URL se ztratí (`scripts/src/lib/monitoring/hlidac-client.ts:115-137`). Chybějící token, HTTP/síťová chyba i legitimně žádné dokumenty vrátí stejné `[]`; route pak ve všech případech jen oznámí, že Hlídač přílohy nevrátil (`scripts/src/lib/monitoring/hlidac-client.ts:100-125`, `scripts/src/serve-api.ts:1270-1274`).

Hlídač agreguje různé profily, ale downloader dnes povoluje jediný host `api.tenderarena.cz`; všechny ostatní hosty dokumentů přeskočí (`scripts/src/lib/monitoring/zd-download.ts:8-25`, `scripts/src/lib/monitoring/zd-download.ts:308-315`, `scripts/src/lib/monitoring/zd-download.ts:351-353`). U této větve se před fetchem ověří jen počáteční URL; na rozdíl od NEN nepoužívá ruční redirecty s opakovanou kontrolou cíle (`scripts/src/lib/monitoring/zd-download.ts:301-315`). HTML nebo prostý text bez použitelného `Content-Disposition` se vyhodnotí jako stránka/session či bot ochrana a přeskočí (`scripts/src/lib/monitoring/zd-download.ts:385-397`).

#### Proč se Hlídač nevyužívá více

- Ruční synchronizace defaultuje na `nen`. Hlídač je při této volbě jen fallback po chybě NEN nebo když po lokálním přesném filtru stavu `Neukončen` nezůstane žádná položka; úspěšný, ale na maximu stran oříznutý NEN fallback nespustí (`scripts/src/serve-api.ts:1096-1103`, `scripts/src/lib/monitoring/monitoring-sync.ts:37-55`, `scripts/src/lib/monitoring/nen-client.ts:139-145`).
- I při volbě `hlidac` nebo `both` se načte jen první stránka (`scripts/src/lib/monitoring/hlidac-client.ts:29-52`).
- Bez tokenu, při HTTP chybě, timeoutu i síťové chybě je návrat stejný `[]`; klient nemá ekvivalent NEN příznaku `ok` (`scripts/src/lib/monitoring/hlidac-client.ts:21-27`, `scripts/src/lib/monitoring/hlidac-client.ts:41-60`).
- Search parser přijímá jen top-level `Results`/`results`, bez ID položku tiše zahodí a zadavatele čte jen z objektu s `Jmeno`/`jmeno`; odlišný tvar odpovědi se projeví jako prázdný nebo ochuzený kandidát (`scripts/src/lib/monitoring/hlidac-client.ts:46-52`, `scripts/src/lib/monitoring/hlidac-client.ts:62-71`).
- Samostatný admin endpoint proto vrátí HTTP 200 s prázdným polem i při nedostupnosti zdroje (`scripts/src/lib/monitoring/hlidac-route.ts:4-8`, `scripts/src/serve-api.ts:1040-1041`).
- CPV se sice získá, ale zůstane pouze v `raw`; strukturovaný klasifikační signál se nevyužije (`scripts/src/lib/monitoring/hlidac-client.ts:77-89`, `scripts/src/lib/monitoring/monitoring-store.ts:245-257`).
- Hodinový timer naopak volí `both`, takže se o Hlídač pokusí při každém běhu; bez tokenu však jeho klient skončí před HTTP voláním (`scripts/src/serve-api.ts:4928-4951`, `scripts/src/lib/monitoring/hlidac-client.ts:21-27`).

### A.4 Společné ukládání, deduplikace a limity

Tabulka ukládá interní ID, zdroj a zdrojové ID, název, zadavatele, hodnotu, lhůtu, URL, `raw`, interní stav, navázané `tender_id` a čas vytvoření. Kategorie je dodatečný nullable `TEXT` sloupec bez DB `CHECK` nebo cizího klíče (`scripts/migrations/014_monitoring_zakazky.sql:7-25`, `scripts/migrations/017_monitoring_kategorie.sql:1-9`). `zdroj` je volný `TEXT`, takže databáze by nový source ID přijala bez migrace; tvrdé omezení na dva zdroje je aplikační. `tender_id` nemá cizí klíč ani unikátní omezení (`scripts/migrations/014_monitoring_zakazky.sql:9-21`, `scripts/src/lib/monitoring/monitoring-sync.ts:9-20`). Chybí prvotřídní CPV, datum zveřejnění, `last_seen_at`, měna, kanonické ID napříč zdroji a stav dokumentů (`scripts/migrations/014_monitoring_zakazky.sql:7-21`). `raw` není celá původní odpověď: mapper do něj ukládá už omezeného kandidáta vytvořeného klientem, takže přežijí jen pole, která klient explicitně naparsoval (`scripts/src/lib/monitoring/nen-client.ts:164-193`, `scripts/src/lib/monitoring/hlidac-client.ts:46-89`, `scripts/src/lib/monitoring/monitoring-store.ts:230-257`).

Deduplikace má tři různé úrovně:

1. NEN klient deduplikuje v rámci stránkování podle `zdroj_id` (`scripts/src/lib/monitoring/nen-client.ts:125-145`).
2. Sync sdílí pro oba zdroje mapu klíčovanou pouze `zdroj_id`, ne dvojicí `(zdroj, zdroj_id)`. Při náhodně stejném textu ID může dříve vložený NEN záznam potlačit bohatší záznam Hlídače (`scripts/src/lib/monitoring/monitoring-sync.ts:32-45`, `scripts/src/lib/monitoring/monitoring-sync.ts:58-64`).
3. DB naopak deduplikuje jen přes `(zdroj, zdroj_id)`. Stejná reálná zakázka s různými zdrojovými ID zůstane dvakrát; není zde fingerprint ani vazební tabulka zdrojových aliasů (`scripts/migrations/014_monitoring_zakazky.sql:21`, `scripts/src/lib/monitoring/monitoring-store.ts:115-126`).

Upsert aktualizuje metadata a `raw`, ale nikdy nepřepíše operátorův stav ani `tender_id` (`scripts/src/lib/monitoring/monitoring-store.ts:102-106`, `scripts/src/lib/monitoring/monitoring-store.ts:115-137`). Zpracovává položky jednu po druhé bez transakce, takže chyba uprostřed dávky zanechá částečný, byť opakovatelně opravitelný sync (`scripts/src/lib/monitoring/monitoring-store.ts:108-141`). `zdroje_pouzite` znamená spíš „pokus o zdroj“: název se přidá před fetchem a může být uveden i při prázdném výsledku či chybě (`scripts/src/lib/monitoring/monitoring-sync.ts:39-45`, `scripts/src/lib/monitoring/monitoring-sync.ts:58-64`).

Čtení databáze má další tichou degradaci: `listFeed` pohltí libovolnou SQL chybu a vrátí `[]`, `getFeedItem` pohltí chybu a vrátí `null`. Výpadek nebo chybějící migrace se proto může tvářit jako prázdný feed či neexistující položka (`scripts/src/lib/monitoring/monitoring-store.ts:149-163`, `scripts/src/lib/monitoring/monitoring-store.ts:195-208`). Lazy backfill kategorie navíc nenajde staré řádky s `kategorie IS NULL`, pokud je už v SQL zapnut kategoriální filtr (`scripts/src/lib/monitoring/monitoring-store.ts:87-99`, `scripts/src/lib/monitoring/monitoring-store.ts:178-184`).

Společné limity downloadu jsou 30 úspěšně stažených souborů, 50 MiB na soubor a 200 MiB celkem (`scripts/src/lib/monitoring/zd-download.ts:28-34`, `scripts/src/lib/monitoring/zd-download.ts:328-348`, `scripts/src/lib/monitoring/zd-download.ts:408-456`). Podporují se jen PDF, DOC/DOCX, XLS/XLSX a ZIP; podpisy, certifikáty a obrázky se označí jako očekávaně ignorované, ostatní typy se přeskočí (`scripts/src/lib/monitoring/zd-download.ts:33-45`, `scripts/src/lib/monitoring/zd-download.ts:200-205`, `scripts/src/lib/monitoring/zd-download.ts:268-273`). Automatický pipeline se rozběhne jen po stažení alespoň jednoho dokumentu a pokud každý nalezený soubor byl stažen nebo explicitně ignorován bez blokujícího varování (`scripts/src/lib/monitoring/zd-download.ts:87-103`).

Položka se označí jako převzatá před stahováním, ale opakované převzetí pak ihned vrátí `alreadyTaken`. Neúspěšný nebo původně nevyžádaný download tak nelze zopakovat stejným endpointem (`scripts/src/serve-api.ts:1204-1208`, `scripts/src/serve-api.ts:1227-1230`, `scripts/src/serve-api.ts:1245-1284`). Samostatný dokumentový manifest s checksumy, zdrojovými URL a dílčími stavy se do DB neukládá; případné dokumenty ze search kandidáta Hlídače mohou zůstat jen v jeho `raw`. Auditní aktivita downloadu zaznamenává počet a `zdroj_id`, nikoli jednotlivé dokumenty (`scripts/src/lib/monitoring/hlidac-client.ts:72-88`, `scripts/src/lib/monitoring/monitoring-store.ts:245-257`, `scripts/src/serve-api.ts:1263-1265`, `scripts/src/serve-api.ts:1278-1280`).

Jméno převzaté zakázky se rezervuje atomickým `mkdir`: postupně se zkouší `slug`, `slug-feedId`, potom `slug-feedId-N`; `tender-meta.json` se zapisuje s příznakem `wx`, takže existující metadata se nepřepíší (`scripts/src/lib/monitoring/tender-allocation.ts:8-17`, `scripts/src/lib/monitoring/tender-allocation.ts:26-55`). Existující output složka bez `tender-meta.json` se však nepovažuje za kolizi a při chybě po jejím vytvoření se uklízí jen input rezervace, takže output složka může zůstat (`scripts/src/lib/monitoring/tender-allocation.ts:38-58`). Rezervace souborového jména také neatomizuje kontrolu feedového stavu: dva souběžné requesty mohou oba před změnou stavu načíst `nova`, rezervovat dva různé tendery a až potom zapisovat `prevzata` (`scripts/src/serve-api.ts:1204-1215`, `scripts/src/serve-api.ts:1227-1230`, `scripts/src/lib/monitoring/monitoring-store.ts:211-225`). Sled FS rezervace → CRM stav → audit → feed stav není jedna transakce, takže selhání uprostřed může zanechat osiřelou složku nebo CRM zakázku (`scripts/src/serve-api.ts:1210-1230`).

### A.5 API plocha

| Operace | Ochrana a chování |
|---|---|
| `GET /api/monitoring/hlidac?q=` | Živý Hlídač, JWT a role admin; handler přijme jen stringové `q`, jinak použije `''` (`scripts/src/serve-api.ts:1040-1041`, `scripts/src/lib/monitoring/hlidac-route.ts:4-8`). |
| `GET /api/monitoring/config` | Načtení instance-wide konfigurace, JWT (`scripts/src/serve-api.ts:1043-1050`). |
| `PUT /api/monitoring/config` | Zod validace a atomický zápis konfigurace, JWT, bez admin role na route (`scripts/src/serve-api.ts:1052-1060`, `scripts/src/lib/monitoring/monitoring-config.ts:69-79`). |
| `POST /api/monitoring/sync` | Hard-coded volby `nen | hlidac | both`, JWT a governance `ingest_enabled` (`scripts/src/serve-api.ts:1096-1138`). |
| `GET /api/monitoring/feed` | Default stav `nova`, volitelně `vse=1` a `kategorie`, JWT (`scripts/src/serve-api.ts:1149-1188`). |
| `POST /api/monitoring/:id/prevzit` | Rezervuje tender, volitelně stáhne dokumenty a spustí pipeline; JWT a governance ingest (`scripts/src/serve-api.ts:1190-1205`, `scripts/src/serve-api.ts:1210-1325`). |
| `POST /api/monitoring/:id/ignorovat` | Nastaví `ignorovana`; JWT (`scripts/src/serve-api.ts:1334-1345`). |

Nový zdroj dnes není konfigurace: musí se změnit union a větvení synchronizace, importy/wiring a whitelist API, source-specific normalizace a větev dokumentů (`scripts/src/lib/monitoring/monitoring-sync.ts:9-20`, `scripts/src/lib/monitoring/monitoring-sync.ts:36-65`, `scripts/src/serve-api.ts:1102-1121`, `scripts/src/lib/monitoring/monitoring-store.ts:228-258`, `scripts/src/serve-api.ts:1253-1284`).

Neplatný neprázdný parametr `stav` nevede k 400; přeloží se na `undefined` a stavový SQL filtr se vypne, takže endpoint může vrátit všechny interní stavy (`scripts/src/serve-api.ts:1152-1156`, `scripts/src/lib/monitoring/monitoring-store.ts:167-177`).

Endpoint `/ignorovat` nemá guard původního stavu: může přepnout i převzatou položku a `COALESCE` jí ponechá `tender_id`, takže vznikne `ignorovana` s vazbou na existující tender (`scripts/src/serve-api.ts:1334-1339`, `scripts/src/lib/monitoring/monitoring-store.ts:211-225`).

## B. Kategorizace a skórování

### B.1 Uzavřený výčet a jeho uložení

Aplikační výčet má 11 hodnot:

`it_av`, `naradi_dilna`, `zdravotnicke`, `vozidla`, `stavebni_prace`, `potraviny`, `energie`, `nabytek`, `kancelar`, `sluzby`, `ostatni` (`scripts/src/lib/winprice-store.ts:17-43`).

Komentář nad polem říká „kromě fallbacku `ostatni`“, ale pole `KOMODITA_KATEGORIE_VALUES` jej ve skutečnosti obsahuje (`scripts/src/lib/winprice-store.ts:30-43`). Monitoringový Zod enum přímo přebírá toto pole, takže neznámou kategorii v konfiguraci odmítne (`scripts/src/lib/monitoring/monitoring-config.ts:8-18`). Databáze však uzavřenost nevynucuje: migrace 017 přidává pouze nullable `TEXT` a index (`scripts/migrations/017_monitoring_kategorie.sql:1-9`).

### B.2 Jak se kategorie odvodí a kde je CPV

`categorizeCommodity` normalizuje text bez diakritiky na lowercase, sjednotí mezery, nejprve aplikuje priority overrides a potom v pevném pořadí hledá substringy z `CATEGORY_KEYWORDS`; první shoda vyhraje, jinak vrátí `ostatni` (`scripts/src/lib/winprice-store.ts:67-105`, `scripts/src/lib/winprice-store.ts:202-212`). Například `3d tisk` má explicitní prioritu `naradi_dilna` (`scripts/src/lib/winprice-store.ts:84-100`).

Oba monitorovací mappery předávají do klasifikátoru pouze `candidate.nazev` (`scripts/src/lib/monitoring/monitoring-store.ts:230-257`). NEN kandidát CPV vůbec nemá (`scripts/src/lib/monitoring/nen-client.ts:70-80`). Hlídač CPV načte do `candidate.cpv`, avšak mapper celý kandidát jen uloží do `raw` a samostatné CPV pole nevytvoří (`scripts/src/lib/monitoring/hlidac-client.ts:77-89`, `scripts/src/lib/monitoring/monitoring-store.ts:245-257`). Odpověď tedy zní: **CPV v monitoringu existuje jen potenciálně uvnitř `raw` z Hlídače; dnešní kategorie, filtry i skóre jej nepoužívají.**

Starší řádek bez platné kategorie se při čtení překategorizuje z názvu a `NULL` hodnota se best-effort uloží zpět (`scripts/src/lib/monitoring/monitoring-store.ts:61-99`). Neplatná nenulová hodnota se sice opraví v paměti, ale update používá `WHERE ... kategorie IS NULL`, takže ji v DB neopraví (`scripts/src/lib/monitoring/monitoring-store.ts:70-78`, `scripts/src/lib/monitoring/monitoring-store.ts:87-98`).

### B.3 Přesný výpočet quick go/no-go

Feed sestaví minimální `TenderAnalysis` z názvu, zadavatele, hodnoty a lhůty a připojí firemní `obory` a `keyword_filters` (`scripts/src/lib/monitoring/monitoring-score.ts:86-112`). Volá `scoreGoNoGo` bez product match a win-price pásma, takže ve feedu mohou být dostupné jen faktor sektoru, rozpočtu a lhůty; faktory nacenění a historické ceny chybějí (`scripts/src/lib/monitoring/monitoring-score.ts:41-44`, `scripts/src/lib/go-no-go.ts:141-188`).

Základní skóre je vážený průměr pouze dostupných faktorů, převedený na 0–100. Bez jediného faktoru je neutrálních 50 a `ZVAZIT` (`scripts/src/lib/go-no-go.ts:92-118`). Výchozí/aktuálně konfigurované váhy jsou sektor 20, rozpočet 20, nacenění 25, win-price 20 a lhůta 15 (`scripts/src/lib/go-no-go-config.ts:12-29`, `config/go-no-go.json:1-9`).

- Sektorový faktor je 1 při shodě detekovaného sektoru s `company.obory`, 0 při detekovaném jiném sektoru a 0,5, pokud nelze sektor určit; detekce hledá `keyword_filters` v předmětu, typu a položkách (`scripts/src/lib/go-no-go.ts:221-242`).
- Rozpočtový faktor používá natvrdo firemní strop 10 mil. Kč: 1 do 8 mil., 0,8 do 10 mil., 0,4 do 12,5 mil. a 0 nad tuto mez. Chybějící nebo nekladná hodnota se nezapočítá (`scripts/src/lib/go-no-go.ts:13-17`, `scripts/src/lib/go-no-go.ts:244-257`).
- Lhůta má hodnotu 1 nad 14 dní, 0,75 při 8–14 dnech, 0,45 při 3–7, 0,15 při 0–2 a 0 po termínu (`scripts/src/lib/go-no-go.ts:26-28`, `scripts/src/lib/go-no-go.ts:322-342`).

Monitoring potom aplikuje tři vlastní zásahy:

1. Výskyt vyloučeného slova v názvu okamžitě vrátí skóre 0 a `NOGO`; porovnání ignoruje velikost písmen i diakritiku (`scripts/src/lib/monitoring/monitoring-score.ts:47-53`, `scripts/src/lib/monitoring/monitoring-score.ts:162-173`).
2. Je-li `kategorie_zajmu` neprázdná, nové skóre je přesně `round(base × 0,4 + (shoda ? 60 : 0))`. Kategorie mimo zájem proto dosáhne nejvýše 40 a je vždy `NOGO` (`scripts/src/lib/monitoring/monitoring-score.ts:55-65`).
3. Známá hodnota pod monitoringovým minimem nebo nad maximem odečte 20 bodů; `null` hodnotu meze nepostihnou (`scripts/src/lib/monitoring/monitoring-score.ts:67-75`).

Výsledek se omezí na 0–100. `GO` je od 75, `ZVAZIT` od 45 do 74 a `NOGO` pod 45 (`scripts/src/lib/monitoring/monitoring-score.ts:77-83`, `scripts/src/lib/go-no-go.ts:13-14`). Současná konfigurace má prázdné kategorie i vyloučená slova a obě hodnotové meze `null`, takže dnes se žádný z těchto tří monitoringových zásahů neuplatní (`config/monitoring.json:1-7`).

Feature vector má vysvětlovací nesoulad: kategorii deklaruje s vahou 60, ale její `prispevek` ukládá jako 0, přestože výsledné skóre už kategorii zahrnuje (`scripts/src/lib/monitoring/monitoring-score.ts:115-159`).

### B.4 Kde vzniká NOGO a kde se skutečně ořezává feed

`NOGO` samo o sobě záznam nevyřadí. SQL nejprve aplikuje stav, volitelnou kategorii a defaultní filtr neprošlé lhůty, seřadí nejbližší termíny napřed a omezí kandidáty na 1000 (`scripts/src/lib/monitoring/monitoring-store.ts:167-192`, `scripts/src/serve-api.ts:1152-1169`). Až pak endpoint odstraní názvy s vyloučeným slovem, spočítá skóre, seřadí sestupně a vrátí prvních 200 (`scripts/src/serve-api.ts:1170-1184`). Vysoce relevantní řádek mimo prvních 1000 podle SQL pořadí se tedy nikdy neskóruje; nízké `NOGO` se může ztratit až post-scoring řezem 200, ale není filtrováno jen kvůli doporučení.

`kategorie_zajmu` rovněž není ingest filtr ani implicitní feed filtr; pouze převažuje skóre. Kategoriální SQL filtr se aktivuje jen explicitním query parametrem `kategorie` (`scripts/src/serve-api.ts:1160-1179`). Vyloučená slova se naopak při čtení skutečně odstraní ještě před skórováním, přestože scorer pro stejnou shodu umí vrátit 0/NOGO (`scripts/src/serve-api.ts:1174-1179`, `scripts/src/lib/monitoring/monitoring-score.ts:47-53`).

### B.5 Kolik nezávislých seznamů oborů/kategorií existuje

V aktuálním Express/pipeline rozhodovacím toku jsou **3 nezávislé semantické taxonomie**; to je také hodnota `nezavislychSeznamuOboru` použitá v závěrečném reportu:

| # | Seznam | Hodnoty a použití | Důkaz |
|---:|---|---|---|
| 1 | Komoditní taxonomie monitoringu/win-price | 11 kategorií, vlastní priority a keyword mapa; řídí uloženou kategorii a povolené `kategorie_zajmu`. | `scripts/src/lib/winprice-store.ts:17-43`, `scripts/src/lib/winprice-store.ts:91-212`, `scripts/src/lib/monitoring/monitoring-config.ts:8-18` |
| 2 | Firemní obory a filtry | Aktivní `IT`, `AV`; keyword skupiny `IT`, `AV`, `kancelarsky`, `nabytek`. Feed je používá pro sektorový faktor a malá výběrová řízení pro item filtr. | `config/company.json:16-54`, `scripts/src/lib/go-no-go.ts:221-242`, `scripts/src/match-product.ts:368-384` |
| 3 | Haiku sektorová taxonomie | Natvrdo `IT`, `AV`, `kancelarsky`, `nabytek`, `ostatni`; používá se pro zakázky od 20 matchovatelných položek. | `scripts/src/match-product.ts:104-137`, `scripts/src/match-product.ts:333-367` |

Tyto seznamy se významově rozcházejí. Monitoring slučuje IT a AV do `it_av`, zatímco další dva je dělí; monitoring má `naradi_dilna`, ale Haiku nikoli; firemní/Haiku ID `kancelarsky` neodpovídá monitoringovému `kancelar` (`scripts/src/lib/winprice-store.ts:17-28`, `config/company.json:17-52`, `scripts/src/match-product.ts:106-112`). Nejviditelnější konflikt je `3d tisk`: komoditní pravidlo jej prioritně řadí do `naradi_dilna`, Haiku prompt výslovně do IT (`scripts/src/lib/winprice-store.ts:91-92`, `scripts/src/match-product.ts:106-112`).

Sektorový filtr má navíc dvě implementace podle velikosti. Od 20 položek použije Haiku, přijme firemní obory a vždy IT; pokud by odpadlo vše, ponechá vše, ale u smíšené zakázky mimooborové položky skutečně zahodí (`scripts/src/match-product.ts:333-367`). Pod 20 položek hledá jen firemní keywords v názvu a filtr aplikuje pouze tehdy, když po něm alespoň jedna položka zůstane (`scripts/src/match-product.ts:368-384`). Proto dnes existující skupiny `kancelarsky` a `nabytek` nejsou přijímanými obory, protože `obory` obsahuje jen IT a AV (`config/company.json:17-18`, `config/company.json:40-53`).

Doslovných míst v repozitáři, která nesou seznam nebo mapování oborů, je nejméně osm: komoditní classifier, dvě company JSON, Haiku prompt, frontend union, frontend labels, warehouse hierarchie a n8n pravidla. Nejde však o osm nezávislých taxonomií: část jsou zrcadla, warehouse je účelově jiná hierarchie a nasazení n8n není doloženo. Proto se počet fyzických míst nesmí zaměnit s výše uvedenými třemi semantickými rozhodovacími seznamy (`scripts/src/lib/winprice-store.ts:17-43`, `config/company.json:16-54`, `config/companies/default.json:17-63`, `scripts/src/match-product.ts:104-112`, `apps/web/src/lib/api.ts:208-219`, `apps/web/src/lib/monitoring.ts:1-20`, `scripts/migrations/001_warehouse_schema.sql:249-281`, `n8n-workflows/vz-monitor-hlidac.json:22-72`).

Fyzické kopie a související seznamy jsou:

- produkce primárně čte `config/companies/default.json`, zatímco `config/company.json` je legacy zdroj/jeden z fallbacků; oba dnes obsahují kopii `obory` a `keyword_filters` (`scripts/src/lib/company-store.ts:16-18`, `scripts/src/lib/company-store.ts:62-98`, `scripts/src/lib/company-store.ts:118-124`, `scripts/src/match-product.ts:263-270`);
- frontend znovu opisuje jedenáctihodnotový TypeScript union a v jiném souboru jedenáct hodnot s labely (`apps/web/src/lib/api.ts:208-219`, `apps/web/src/lib/monitoring.ts:1-20`);
- warehouse má účelově jinou produktovou hierarchii, například nábytek, ruční/elektro nářadí a kancelářský materiál; musí mít explicitní mapování, nemá však nahrazovat oborovou taxonomii (`scripts/migrations/001_warehouse_schema.sql:249-281`);
- repo obsahuje také n8n workflow s vlastním hard-coded IT/CPV dotazem a dvěma relevance keyword seznamy. Není součástí Express monitorovacího toku a v exportu má prázdné credential ID, takže z kódu nelze tvrdit, že je nasazen; při případném nasazení je to další pravidlo k migraci (`n8n-workflows/vz-monitor-hlidac.json:22-61`, `n8n-workflows/vz-monitor-hlidac.json:65-72`).

## C. Návrh: zdroje jako konfigurace, ne větvení v kódu

### C.1 Cíl a hranice

„Přidat zdroj bez změny kódu“ má znamenat bez změny **jádra VZ**: nový zdroj se přidá záznamem v registru a nainstalovaným verzovaným adaptérem, případně jen deklarativním HTML/JSON driverem. Úplně nový síťový protokol může stále vyžadovat implementaci pluginu, ale nesmí vyžadovat nový `if`, import a mapper v `monitoring-sync.ts`, `serve-api.ts` a `monitoring-store.ts`; právě tato místa jsou dnes natvrdo svázaná s dvojicí zdrojů (`scripts/src/lib/monitoring/monitoring-sync.ts:9-20`, `scripts/src/lib/monitoring/monitoring-sync.ts:36-65`, `scripts/src/serve-api.ts:1102-1121`, `scripts/src/lib/monitoring/monitoring-store.ts:228-258`, `scripts/src/serve-api.ts:1253-1284`).

### C.2 Stabilní rozhraní adaptéru

Navržený kontrakt `SourceAdapterV1`:

```ts
interface SourceAdapterV1 {
  readonly id: string;
  readonly capabilities: {
    fulltext: boolean;
    cpv: boolean;
    detail: boolean;
    documents: 'none' | 'url' | 'stream' | 'push';
    cursor: boolean;
  };

  search(query: CanonicalSourceQuery, cursor?: string): Promise<SearchPage>;
  getDetail(ref: SourceRef): Promise<AdapterResult<CanonicalTenderDetail>>;
  listDocuments(ref: SourceRef): Promise<AdapterResult<DocumentRef[]>>;
  openDocument(ref: DocumentRef): Promise<AdapterResult<ReadableStream<Uint8Array>>>;
  health(): Promise<SourceHealth>;
}

interface SearchPage {
  items: CanonicalTender[];
  status: 'complete' | 'partial' | 'failed';
  next_cursor: string | null;
  exhausted: boolean;
  truncated: boolean;
  source_total: number | null;
  diagnostics: { requests: number; warnings: string[]; error: string | null };
}

interface CanonicalTender {
  source_id: string;
  external_id: string;
  title: string;
  buyer: { name: string | null; ico: string | null };
  estimated_value: { amount: number; currency: string } | null;
  bid_deadline: string | null;
  published_at: string | null;
  status: string | null;
  cpv: string[];
  detail_url: string | null;
  raw: unknown;
}

interface CanonicalSourceQuery {
  domains: string[];
  keywords: string[];
  cpv_prefixes: string[];
  published_since: string | null;
  open_only: boolean;
}

interface SourceRef { source_id: string; external_id: string }
interface DocumentRef extends SourceRef {
  document_id: string;
  name: string;
  mime: string | null;
  size: number | null;
  sha256: string | null;
}
interface CanonicalTenderDetail extends CanonicalTender { description: string | null }
interface AdapterResult<T> {
  status: 'complete' | 'partial' | 'unsupported' | 'failed';
  value: T | null;
  warnings: string[];
}
interface SourceHealth { ok: boolean; auth: 'ok' | 'missing' | 'invalid' | 'none'; detail: string | null }
```

Datové metody mají strukturovaně odlišit „žádná data“, „nepodporováno“, „částečný výsledek“ a chybu; povinný `search` používá stav v `SearchPage` a adaptér s `documents: 'none'` vrací z dokumentových metod `status: 'unsupported'`. Tím se odstraní dnešní záměna chyby Hlídače za `[]` a částečné dokumentace za úspěšnou sadu (`scripts/src/lib/monitoring/hlidac-client.ts:21-60`, `scripts/src/lib/monitoring/nen-client.ts:276-288`). Kategorie není odpovědností adaptéru: vznikne centrálně z CPV, názvu a jednotného registru oborů. Dnešní `FeedUpsertInput` je vhodný základ, ale postrádá CPV, publication/last-seen metadata a stav kompletnosti (`scripts/src/lib/monitoring/monitoring-store.ts:20-31`, `scripts/migrations/014_monitoring_zakazky.sql:7-21`).

Registry načte `adapter_ref` z manifestu, ověří verzi kontraktu a vytvoří instanci. `monitoring-sync` pak iteruje povolené zdroje a cursor, API validuje ID proti registru a převzetí deleguje dokumenty zpět adaptéru. NEN a Hlídač se jednorázově obalí tímto kontraktem; jejich parsování může zůstat uvnitř dnešních klientů (`scripts/src/lib/monitoring/nen-client.ts:115-164`, `scripts/src/lib/monitoring/hlidac-client.ts:21-60`).

### C.3 Jediná konfigurace zdrojů a oborů

Navrhuji jeden verzovaný soubor, například `config/procurement.json`, s tímto tvarem; příklad zkracuje zbývající dnešní kategorie, ale ukazuje rodiče, listové obory i profil:

```jsonc
{
  "schema_version": 1,
  "sources": {
    "nen": {
      "enabled": true,
      "adapter_ref": "builtin:nen-html@1",
      "schedule": "0 * * * *",
      "limits": { "max_pages": 5, "max_documents": 30 },
      "auth_ref": null
    },
    "hlidac": {
      "enabled": true,
      "adapter_ref": "builtin:hlidac-v2@1",
      "schedule": "0 * * * *",
      "limits": { "max_pages": 20, "max_documents": 30 },
      "auth_ref": "env:HLIDAC_TOKEN"
    }
  },
  "domains": {
    "it_av": {
      "label": "IT a audiovizuální technika",
      "aggregate_of": ["it", "av"]
    },
    "it": {
      "label": "IT",
      "parent": "it_av",
      "aliases": ["IT"],
      "keywords": {
        "search": ["výpočetní technika", "notebook", "server"],
        "classify": ["počítač", "monitor", "tiskárna", "software"],
        "exclude": []
      },
      "cpv_prefixes": ["30", "48", "72"],
      "score": { "keyword": 30, "cpv": 60, "exact_phrase": 10 }
    },
    "av": {
      "label": "Audiovizuální technika",
      "parent": "it_av",
      "aliases": ["AV"],
      "keywords": { "search": ["projektor", "audiovizuální technika"], "classify": ["videokonference", "ozvučení"], "exclude": [] },
      "cpv_prefixes": [],
      "score": { "keyword": 30, "cpv": 60, "exact_phrase": 10 }
    },
    "naradi_dilna": {
      "label": "Nářadí a dílna",
      "keywords": { "search": ["dílenské vybavení", "nářadí"], "classify": ["obráběcí stroje", "svářečka"], "exclude": [] },
      "cpv_prefixes": [],
      "score": { "keyword": 30, "cpv": 60, "exact_phrase": 10 }
    },
    "nabytek": {
      "label": "Nábytek",
      "keywords": { "search": ["nábytek"], "classify": ["židle", "stůl", "skříň"], "exclude": [] },
      "cpv_prefixes": [],
      "score": { "keyword": 30, "cpv": 60, "exact_phrase": 10 }
    }
  },
  "profiles": {
    "default": {
      "enabled_domains": ["it", "av", "naradi_dilna", "nabytek"],
      "min_value": null,
      "max_value": null
    }
  },
  "scoring": {
    "go_no_go_weights": {
      "sector": 20,
      "budget": 20,
      "priced_items": 25,
      "win_price": 20,
      "deadline": 15
    },
    "monitoring_category": {
      "base_share": 0.4,
      "match_bonus": 60,
      "out_of_range_penalty": 20
    }
  },
  "thresholds": { "go": 75, "consider": 45 }
}
```

CPV prefixy musí být datová položka s validací, nikoli nový switch v kódu. Uvedené IT prefixy pouze přenášejí hodnoty už přítomné v repo workflow; prefixy pro ostatní obory je nutné doplnit z externě ověřeného číselníku, ne odhadnout (`n8n-workflows/vz-monitor-hlidac.json:33-47`). Tajemství se do JSON neukládá, jen reference na secret provider; dnešní Hlídač už token správně čte z prostředí (`scripts/src/lib/monitoring/hlidac-client.ts:21-24`).

Generátor dotazů vezme aktivní obory profilu a podle `capabilities` adaptéru vytvoří:

- CPV dotaz jen pro zdroj, který CPV syntaxi deklaruje;
- zdrojově bezpečný fulltext z `keywords.search`, nikoli dnešní tentýž oříznutý fulltextový výraz předaný oběma systémům (`scripts/src/lib/monitoring/monitoring-sync.ts:23-41`, `scripts/src/lib/monitoring/nen-client.ts:93-98`, `scripts/src/lib/monitoring/hlidac-client.ts:29-32`);
- klientský post-filter ze stejného `keywords.classify`, když zdroj potřebný filtr neumí;
- skóre ze stejných datových vah a globálních prahů namísto dnešních fixních 60/40 a odděleného `go-no-go.json` (`scripts/src/lib/monitoring/monitoring-score.ts:55-83`, `config/go-no-go.json:1-9`).

První verze registru musí dnešní hodnoty vah a prahů pouze převzít. Jejich pozdější změna sice nemusí rozbít wire formát API, ale je behaviorálně breaking: mění pořadí feedu i `GO/ZVAZIT/NOGO`, a proto vyžaduje `scoring_version`, kalibraci a měřený rollout (`scripts/src/lib/monitoring/monitoring-score.ts:55-83`, `config/go-no-go.json:1-9`).

### C.4 Migrace tří seznamů na jeden

1. **Zavést registry beze změny významu.** Přenést jedenáct stávajících komoditních ID, jejich labels a keyword pravidla do `domains`; `it_av` dočasně zachovat jako rodiče kvůli uloženým DB hodnotám a API (`scripts/src/lib/winprice-store.ts:17-43`, `apps/web/src/lib/api.ts:208-219`).
2. **Přidat aliasy.** `IT` a `AV` mapovat na děti rodiče `it_av`, `kancelarsky` na `kancelar`; `naradi_dilna` doplnit do stejné taxonomie pro Haiku i profil. Tím se vyřeší dnešní rozdílné názvy a chybějící nářadí (`config/company.json:17-53`, `scripts/src/match-product.ts:106-112`).
3. **Generovat spotřebitele.** Z registru odvodit Zod validaci, API schéma/typy, frontend labels, Haiku prompt, lokální item filtr, feed classifier a query builder. Dnes jsou tyto údaje rozptýlené minimálně v `winprice-store.ts`, `monitoring-config.ts`, obou company JSON, `match-product.ts`, `api.ts` a `monitoring.ts` (`scripts/src/lib/winprice-store.ts:17-43`, `scripts/src/lib/monitoring/monitoring-config.ts:8-18`, `config/company.json:16-54`, `scripts/src/match-product.ts:104-112`, `apps/web/src/lib/api.ts:208-219`, `apps/web/src/lib/monitoring.ts:1-20`).
4. **Dual-read/dual-write.** Přidat `category_id`, `category_version` a prvotřídní `cpv`; staré `kategorie` zatím číst jako alias. Migrovat se musí uložené hodnoty v `monitoring_zakazky.kategorie`, `win_prices.komodita_kategorie` i `config/monitoring.json.kategorie_zajmu`; backfill musí být explicitní job nad všemi řádky, ne dnešní lazy čtení, které při kategoriálním filtru `NULL` řádky mine (`scripts/migrations/017_monitoring_kategorie.sql:1-9`, `scripts/migrations/011_win_price.sql:13-24`, `config/monitoring.json:1-7`, `scripts/src/lib/monitoring/monitoring-store.ts:87-99`, `scripts/src/lib/monitoring/monitoring-store.ts:178-184`).
5. **Přepnout a až potom odstranit legacy.** Po měření distribuce a API kompatibilitě odstranit `keyword_filters`, hard-coded Haiku seznam a ručně psané frontend enumy. Historic `it_av` řádky lze ponechat na rodiči nebo znovu klasifikovat z názvu/CPV s uloženou verzí pravidel.

Breaking je zejména případné přejmenování veřejných kategorií (`it_av`, `kancelar`) a změna hodnot uložených v DB/saved filtrech. Proto mají stávající ID v první verzi zůstat aliasy a API má po přechodnou dobu vracet staré i nové pole. Repo dnes obsahuje výchozí company konfiguraci i legacy kopii, ale datová migrace nesmí předpokládat jen tyto dva soubory: `getAllCompanies` načítá libovolný počet `config/companies/*.json` a company store umí vytvářet další. Migrátor proto musí projít všechny firmy přes company store, převést `obory`/`keyword_filters` a legacy soubor ponechat jen jako kompatibilní vstup (`scripts/src/lib/company-store.ts:62-98`, `scripts/src/lib/company-store.ts:104-115`, `scripts/src/lib/company-store.ts:127-148`).

### C.5 Externí agent jako push zdroj

Agent za přihlášeným portálem nemá předávat session cookie ani privátní download URL serveru. Má dodat normalizovaná metadata a skutečné bajty dokumentů nebo jednorázový objektový klíč. Dnešní `/api/tenders/upload-url` umí jen stáhnout veřejné HTTP(S) URL přímo do tender složky a volitelně zapsat `_metadata.json`; nevytvoří monitorovací položku ani audit zdrojového běhu (`scripts/src/serve-api.ts:1629-1655`, `scripts/src/serve-api.ts:1731-1742`).

Navržené rozhraní:

1. `POST /api/monitoring/source-runs` — nový service-account scope `monitoring:ingest`, `source_id`, čas startu, verze agenta; vrátí `run_id`.
2. `PUT /api/monitoring/sources/:source/items/:external_id` — idempotentní upsert `CanonicalTender`, hlavička `Idempotency-Key`, `observed_at`, zdrojová URL a auditní identita.
3. `POST .../:external_id/documents` — multipart nebo finalizovaný object-storage manifest `{name, mime, size, sha256, object_key}`; žádné cookies v `raw`.
4. `POST /api/monitoring/source-runs/:run_id/complete` — počty seen/created/updated, cursor a strukturované `complete | partial | failed`.

Push adapter implementuje stejné `search/detail/documents` rozhraní nad příchozí frontou: `search` vydá položky konkrétního runu, `getDetail` uložený payload a `openDocument` objekt podle checksumu. `monitoring:ingest` je nový autorizační scope, takže před zpřístupněním endpointů je nutné doplnit auth middleware, správu/rotaci service credentials a oddělený dokumentový staging. Agent nikdy nezapisuje přímo do PostgreSQL ani sdílené `input/` složky. Limity a typy dokumentů se použijí centrálně, místo aby každý zdroj obcházel dnešní ochrany 30/50/200 MiB (`scripts/src/lib/monitoring/zd-download.ts:28-34`, `scripts/src/lib/monitoring/zd-download.ts:317-348`).

Pro to jsou potřeba nové tabulky `monitoring_source_runs`, `monitoring_source_records`/aliasy a `monitoring_documents`; dnešní jediná tabulka nemá run, canonical fingerprint ani dokumentový manifest (`scripts/migrations/014_monitoring_zakazky.sql:7-25`). Cross-source deduplikace má zachovat všechny provenance záznamy, ale ukázat jednu kanonickou zakázku; současný unikátní klíč řeší jen identitu uvnitř jednoho zdroje (`scripts/migrations/014_monitoring_zakazky.sql:21`).

### C.6 Dopad a breaking změny

| Změna | Dotčené soubory / počet dnešních míst | Breaking |
|---|---|---|
| Adapter registry | Refaktor nejméně 7 hard-coded míst: union a dvě větve v `monitoring-sync.ts`, API whitelist/wiring a dokumentová větev v `serve-api.ts`, dva mappery v `monitoring-store.ts`, source guard/downloader v `zd-download.ts`; klienty `nen-client.ts` a `hlidac-client.ts` obalit (`scripts/src/lib/monitoring/monitoring-sync.ts:9-65`, `scripts/src/serve-api.ts:1102-1121`, `scripts/src/serve-api.ts:1253-1284`, `scripts/src/lib/monitoring/monitoring-store.ts:228-258`, `scripts/src/lib/monitoring/zd-download.ts:301-315`). | Ne, pokud `nen`, `hlidac`, `both` zůstanou kompatibilní aliasy; ano pro interní dependency API. |
| Kanonický datový model | `monitoring-store.ts`, nová SQL migrace, API typy a frontend; přidat CPV, source timestamps, fingerprint a completeness (`scripts/src/lib/monitoring/monitoring-store.ts:20-47`, `scripts/migrations/014_monitoring_zakazky.sql:7-21`, `apps/web/src/lib/api.ts:222-232`). | Navržený `CanonicalTender` je interní. Veřejný response mapper musí po dobu migrace zachovat dnešní plochá pole `zdroj`, `zdroj_id`, `nazev`, `zadavatel`, `predpokladana_hodnota` a `lhuta_nabidek`; přímé vystavení nových názvů/vnoření nebo odstranění `kategorie` je breaking. |
| Jeden registr oborů | Nejméně 7 logických spotřebitelů: classifier, config validace, company profil, go/no-go sektor, Haiku/lokální filtr, API typ a frontend labels (`scripts/src/lib/winprice-store.ts:17-43`, `scripts/src/lib/monitoring/monitoring-config.ts:8-18`, `config/company.json:16-54`, `scripts/src/lib/go-no-go.ts:221-242`, `scripts/src/match-product.ts:104-112`, `apps/web/src/lib/api.ts:208-219`, `apps/web/src/lib/monitoring.ts:1-20`). | Ano, pokud se bez aliasů přejmenuje `it_av`/`kancelar` nebo odstraní `keyword_filters`. |
| Push agent | Nové ingest routes v `serve-api.ts`, nový store, 2–3 SQL tabulky, objektový/document store; stávající `upload-url` lze sdílet jen po zpřísnění kontraktu (`scripts/src/serve-api.ts:1629-1742`). | Aditivní API ne; změna starého `upload-url` kontraktu by breaking byla. |

## D. Co přesně dělají prázdná klíčová slova

Aktuální soubor má `klicova_slova: []`, současně prázdné kategorie/vyloučená slova a nulové hodnotové meze (`config/monitoring.json:1-7`). Schéma prázdné pole povoluje, ačkoli neprázdnou položku trimuje a vyžaduje alespoň jeden znak (`scripts/src/lib/monitoring/monitoring-config.ts:15-21`).

V následujících počtech značí `M = MAX_NEN_PAGES`: kladné celé číslo z `NEN_MAX_PAGES`, jinak výchozích 5 (`scripts/src/lib/monitoring/nen-client.ts:60-65`). Počítám aplikační fetch volání stránek, nikoli případné další transportní requesty vzniklé redirectem. Jde o horní mez; NEN skončí dřív na první prázdné stránce nebo při chybě (`scripts/src/lib/monitoring/nen-client.ts:127-156`).

Při ručním syncu bez `q` nastane přesně toto:

1. Po úspěšném JWT a governance guardu endpoint zvolí defaultní zdroj `nen` a z prázdného pole vytvoří `queries = ['']` (`scripts/src/serve-api.ts:1099-1118`). Explicitní `q: ''` má stejný počet dotazů.
2. Collector řetězec ořízne, neodfiltruje ho a přes pole iteruje právě jednou (`scripts/src/lib/monitoring/monitoring-sync.ts:23-41`).
3. NEN nepřidá `p:vz:query`, takže začne na nefiltrovaném `/verejne-zakazky` (`scripts/src/lib/monitoring/nen-client.ts:93-98`, `scripts/src/lib/monitoring/nen-client.ts:120-134`).
4. Provede 1 až `M` stránkových fetch volání podle toho, kdy narazí na prázdnou stránku nebo chybu; z každé ponechá jen přesný stav `Neukončen` a deduplikuje ID (`scripts/src/lib/monitoring/nen-client.ts:60-65`, `scripts/src/lib/monitoring/nen-client.ts:127-156`).
5. Jestli NEN vrátí `ok=false` nebo žádné položky, s tokenem se provede jedno fallback search-fetch volání Hlídače s `dotaz=` a `strana=1`; bez tokenu vznikne varování a klient se v této fallback větvi nevolá (`scripts/src/lib/monitoring/monitoring-sync.ts:47-65`, `scripts/src/lib/monitoring/hlidac-client.ts:21-39`).
6. Upsertují se položky `sync.inputs`, které zůstaly po collector deduplikaci podle samotného `zdroj_id`. `kategorie_zajmu`, hodnotové meze ani vyloučená slova ingest nefiltrují; stávající operátorský stav/tender vazba se zachová (`scripts/src/lib/monitoring/monitoring-sync.ts:32-64`, `scripts/src/serve-api.ts:1111-1129`, `scripts/src/lib/monitoring/monitoring-store.ts:102-141`).

Hodinový auto-sync vytvoří stejné jednoprvkové `['']`, ale volí `both`: pokud projde DB a governance guardem, provede 1 až `M` NEN page-fetch volání a s tokenem právě jedno Hlídač search-fetch volání; bez tokenu se zavolá klientská funkce Hlídače, ta však skončí před sítí (`scripts/src/lib/monitoring/monitoring-sync.ts:37-64`, `scripts/src/serve-api.ts:4932-4951`, `scripts/src/lib/monitoring/hlidac-client.ts:21-39`). Při nedostupné DB nebo vypnutém ingestu je zdrojových fetch volání nula (`scripts/src/serve-api.ts:4932-4937`). Jde tedy po průchodu guardy o **jeden logický prázdný výraz**, ne o nula dotazů. Kód nedokládá 50 položek na stránku ani celkových přibližně 278 500 položek; dokládá pouze horní mez `M` serverových stran NEN (`scripts/src/lib/monitoring/nen-client.ts:60-65`, `scripts/src/lib/monitoring/nen-client.ts:120-156`).

Po uložení defaultní feed načte jen `nova` a neprošlé řádky, nejvýše prvních 1000 podle SQL pořadí; teprve ty skóruje a vrátí top 200 (`scripts/src/serve-api.ts:1152-1184`, `scripts/src/lib/monitoring/monitoring-store.ts:167-192`). Proto „zdroj něco vrátil“ ještě neznamená „operátor to uvidí“.

### D.1 Minimální rozumný startovní seznam

Pro IT, dílenské vybavení/nářadí a nábytek navrhuji vložit tento konkrétní seznam:

```json
"klicova_slova": [
  "výpočetní technika",
  "počítač",
  "notebook",
  "server",
  "monitor",
  "tiskárna",
  "síťové prvky",
  "software",
  "dílenské vybavení",
  "nářadí",
  "obráběcí stroje",
  "svářečka",
  "3D tiskárna",
  "nábytek"
]
```

Výrazy vycházejí z dnešních firemních a komoditních keyword pravidel, nikoli z tvrzení o možnostech portálů (`config/company.json:19-38`, `config/company.json:47-53`, `scripts/src/lib/winprice-store.ts:107-129`, `scripts/src/lib/winprice-store.ts:175-180`). Krátké hlučné výrazy `IT`, `PC` a `AV` nejsou v minimálním defaultu. Výtěžnost, skloňování a diakritickou toleranci musí ověřit měření zdrojů; klienti pouze předávají text a žádné takové chování negarantují (`scripts/src/lib/monitoring/nen-client.ts:93-98`, `scripts/src/lib/monitoring/hlidac-client.ts:29-32`).

Každý z 14 výrazů je samostatný fetch (`scripts/src/lib/monitoring/monitoring-sync.ts:29-41`). Znamená to až `14 × M` NEN page-fetch volání na jeden sync — 70 pouze při výchozím `M = 5` — a u `both` s tokenem navíc až 14 jednostránkových search-fetch volání Hlídače; transportních HTTP requestů může být kvůli redirectům více. Proto je nutné současně měřit počet volání, stran, výsledků, duplicit, truncation a latenci (`scripts/src/lib/monitoring/nen-client.ts:60-65`, `scripts/src/lib/monitoring/hlidac-client.ts:29-52`). Jako skórovací volbu dává smysl nastavit také `kategorie_zajmu` na `['it_av', 'naradi_dilna', 'nabytek']`, ale tato volba sama žádnou zakázku u zdroje nevyhledá (`scripts/src/lib/monitoring/monitoring-config.ts:15-21`, `scripts/src/lib/monitoring/monitoring-score.ts:55-65`).

## E. Etapizace

| Etapa | Výsledek a akceptační podmínka | Dopad / breaking |
|---:|---|---|
| 0. Oživit recall v discovery režimu | Vyplnit výše uvedených 14 `klicova_slova` a tři `kategorie_zajmu`; nastavit `auto_spustit_pipeline: false`, nepoužívat request override `spustit: true` a ručně evidovat kandidáty po jednotlivých dotazech. Dnešní config je prázdný a auto-start má zapnutý; explicitní request jej jinak umí přebít (`config/monitoring.json:1-7`, `scripts/src/lib/monitoring/monitoring-config.ts:43-49`, `scripts/src/serve-api.ts:1201-1204`). | Bez změny API a DB; až `14 × M` NEN page-fetch volání, tedy 70 při výchozím `M = 5`. Nové obory zatím neposílat do automatického zpracování. |
| 1. Udělat mezery viditelné | Zavést `SourceRun` metriku: query/domain, HTTP requests, stránky, source total, `truncated`, parse rejects, partial/error a token/auth stav. Nahradit tiché `[]` a pohlcené DB chyby strukturovaným stavem (`scripts/src/lib/monitoring/hlidac-client.ts:21-60`, `scripts/src/lib/monitoring/monitoring-store.ts:149-163`). | Aditivní DB/API; UI musí zobrazit degraded/partial. |
| 2. Doplnit pokrytí stávajících zdrojů | Hlídač stránkovat do cursoru/maxima. U NEN nejdřív ověřit stabilní řazení a dostupná časová pole; samotné číslo stránky není bezpečný checkpoint. Do té doby používat překryvné okno pouze nad prokazatelně stabilním časovým polem plus seen-ID, nebo celý průchod ověřeně stabilním oknem, a vždy signalizovat maximum/partial. Detail enrichment zapínat jen pro schopnosti skutečně doložené zdrojem: dnešní NEN detail dokládá pouze dokumenty, kdežto Hlídač parser už poskytuje hodnotu a CPV (`scripts/src/lib/monitoring/nen-client.ts:93-98`, `scripts/src/lib/monitoring/nen-client.ts:120-156`, `scripts/src/lib/monitoring/nen-client.ts:196-203`, `scripts/src/lib/monitoring/hlidac-client.ts:62-89`). | Změny obou klientů a syncu; větší provozní zátěž. Cursor/checkpoint povolit až po capability testu, jinak hrozí tiché přeskočení. |
| 3. Jeden zdroj pravdy pro obory | Zavést `config/procurement.json`, aliasy a dual-read; generovat classifier, query, score, company volby, Haiku prompt a frontend labels z jednoho registru. Dnes existují tři rozhodovací taxonomie a další fyzické kopie (`scripts/src/lib/winprice-store.ts:17-43`, `config/company.json:16-54`, `scripts/src/match-product.ts:104-112`, `apps/web/src/lib/monitoring.ts:1-20`). | Potenciálně breaking category IDs; zabránit aliasy a verzovaným backfillem. Teprve po této etapě zapnout automatické zpracování nových oborů. |
| 4. Opravit identitu a dokumenty | Přidat CPV, `last_seen_at`, source aliasy/fingerprint, document manifest a samostatný retry downloadu. Dnešní DB má jen `(zdroj, zdroj_id)` a převzetí blokuje opakované stažení (`scripts/migrations/014_monitoring_zakazky.sql:7-21`, `scripts/src/serve-api.ts:1204-1208`). | SQL migrace a aditivní API; kanonické sloučení vyžaduje audit kolizí. |
| 5. Adapter registry | Obalit NEN/Hlídač do `SourceAdapterV1`, odstranit core switche a načítat source manifest. Dnešní přidání zdroje zasahuje nejméně sedm hard-coded míst (`scripts/src/lib/monitoring/monitoring-sync.ts:9-65`, `scripts/src/serve-api.ts:1102-1121`, `scripts/src/serve-api.ts:1253-1284`, `scripts/src/lib/monitoring/monitoring-store.ts:228-258`). | Interní refaktor; veřejně zachovat alias `both`. |
| 6. Externí agent | Přidat scoped push ingest, run audit, idempotentní item upsert a upload dokumentů s checksumy; agent za loginem dodá bajty, ne session URL. Dnešní `upload-url` jen zakládá vstupní složku z veřejných URL (`scripts/src/serve-api.ts:1629-1742`). | Aditivní endpointy/tabulky; žádný přímý DB/FS přístup agenta. |

Pořadí je záměrné: etapy 0–2 jsou pro nové obory discovery/ruční triage, protože dnešní sektorové seznamy si odporují (`scripts/src/lib/winprice-store.ts:17-43`, `config/company.json:16-54`, `scripts/src/match-product.ts:104-112`). Automatické zpracování se pro ně zapne až po sjednocení taxonomie v etapě 3; potom se opraví identita/dokumenty a abstrahují zdroje. Jinak by nový adapter jen zopakoval dnešní tiché ořezy a nové keywords by mohly krmit nekonzistentní downstream filtr.

## Co nebylo ověřeno

- Nebyla použita síť, takže nebyla ověřena skutečná velikost stránky NEN, údaj „přibližně 250 z 278 500“, význam řazení Hlídače ani výtěžnost navržených výrazů; kód uvádí pouze limity a parametry (`scripts/src/lib/monitoring/nen-client.ts:93-156`, `scripts/src/lib/monitoring/hlidac-client.ts:29-52`).
- Nebyla dohledána konkrétní uživatelem hlášená zakázka; z kódu lze doložit mechanismus, kterým ji prázdný dotaz a stránkové stropy mohou minout, nikoli její skutečný stav na portálu.
- Nebylo ověřeno, zda je exportované n8n workflow nasazeno nebo aktivní; repozitář pouze obsahuje JSON s prázdným credential ID (`n8n-workflows/vz-monitor-hlidac.json:22-61`).
- Nebyly odhadovány CPV prefixy pro nářadí a nábytek; musí přijít z externě ověřeného číselníku. IT hodnoty v návrhovém příkladu jsou pouze převzaté z repo workflow (`n8n-workflows/vz-monitor-hlidac.json:33-47`).

## Souhrnná tabulka zjištění

| Zjištění | Důkaz | Dopad | Návrh |
|---|---|---|---|
| Express monitoring má dva zdroje. | `scripts/src/lib/monitoring/monitoring-sync.ts:9-20` | Každý další zdroj dnes vyžaduje kód. | Adapter registry a manifest. |
| Prázdná keyword konfigurace znamená jeden nefiltrovaný dotaz, ne vypnutí. | `config/monitoring.json:1-7`, `scripts/src/serve-api.ts:1111-1118`, `scripts/src/lib/monitoring/nen-client.ts:93-98` | Feed vidí jen omezené úvodní strany výsledků. | Ihned vložit konkrétní keywords; později generovat dotazy z oborů. |
| NEN končí defaultně na pěti stranách, případně na kladném `NEN_MAX_PAGES`. | `scripts/src/lib/monitoring/nen-client.ts:60-65`, `scripts/src/lib/monitoring/nen-client.ts:127-156` | Bez stabilního cursoru/řazení může minout relevantní zakázku. | Ne checkpoint čísla stránky; nejdřív ověřit capability, potom překryvné okno + seen-ID a `truncated` metriku. |
| Hlídač čte vždy jen `strana=1`. | `scripts/src/lib/monitoring/hlidac-client.ts:29-52` | Agregátor má tvrdý jednostránkový strop. | Implementovat stránkování přes adapter. |
| Hlídač chybu maskuje jako prázdný výsledek. | `scripts/src/lib/monitoring/hlidac-client.ts:21-60` | Operátor nerozliší nulu, chybějící token a výpadek. | Strukturovaný `SourceHealth/SearchPage`. |
| Hlídač přináší hodnotu a CPV, ale CPV se nepoužije. | `scripts/src/lib/monitoring/hlidac-client.ts:77-89`, `scripts/src/lib/monitoring/monitoring-store.ts:245-257` | Kategorizace zahazuje kvalitnější signál. | Prvotřídní `cpv[]` a CPV scoring/query. |
| Kategorie obou zdrojů vzniká jen z názvu. | `scripts/src/lib/monitoring/monitoring-store.ts:230-257`, `scripts/src/lib/winprice-store.ts:202-212` | Krátké či obecné názvy mají méně signálů a mohou skončit v `ostatni` nebo být chybně zařazeny. | Centrální classifier: CPV + název + verze pravidel. |
| Sync mapa a DB používají rozdílné deduplikační klíče. | `scripts/src/lib/monitoring/monitoring-sync.ts:32-64`, `scripts/migrations/014_monitoring_zakazky.sql:21` | Stejné textové ID může kolidovat; stejná zakázka s různými ID se duplikuje. | `(source,id)` v ingestu + canonical fingerprint/aliasy. |
| Feed se řeže 1000 před skóre a 200 po skóre. | `scripts/src/lib/monitoring/monitoring-store.ts:167-192`, `scripts/src/serve-api.ts:1164-1184` | Relevantní řádek mimo prvních 1000 se nikdy neskóruje. | Cursorované DB čtení nebo skóre materializovat při ingestu. |
| `NOGO < 45`, ale NOGO není serverový filtr. | `scripts/src/lib/monitoring/monitoring-score.ts:77-83`, `scripts/src/serve-api.ts:1174-1184` | Nízké položky jen propadnou řazením; výjimkou jsou vyloučená slova. | Oddělit `score`, `visibility` a explicitní policy. |
| Tři oborové taxonomie si odporují. | `scripts/src/lib/winprice-store.ts:17-43`, `config/company.json:16-54`, `scripts/src/match-product.ts:104-112` | `3d tisk` i názvy IT/AV/kancelář/nářadí mají různý význam. | Jeden verzovaný domain registry s aliasy. |
| Hlídačovy dokumenty se stáhnou jen z jednoho povoleného hostu. | `scripts/src/lib/monitoring/zd-download.ts:8-25`, `scripts/src/lib/monitoring/zd-download.ts:308-315` | URL s hostem jiným než `api.tenderarena.cz` se přeskočí. | URL policy jako vlastnost adapteru + auditované allowlisty. |
| Download nejde stejným převzetím retryovat. | `scripts/src/serve-api.ts:1204-1208`, `scripts/src/serve-api.ts:1227-1284` | Stejný endpoint už download nezopakuje; je nutná jiná cesta doplnění. | Samostatný idempotentní document-sync endpoint. |
| DB/parse chyby se mohou tvářit jako prázdno. | `scripts/src/lib/monitoring/monitoring-store.ts:149-163`, `scripts/src/lib/monitoring/nen-client.ts:139-156` | Tichý false-negative bez alarmu. | Run ledger, health a explicitní partial/error. |
