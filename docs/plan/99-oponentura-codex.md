# Adversariální oponentura master plánu (Codex gpt-5.6-sol)

Verdikt: **REJECT** — 14 nálezů.

> Syrový výstup oponentury; nálezy jsou zapracované do 00–03. Držíme kvůli auditní stopě.

## Shrnutí

Technické jádro a odkazy na repo jsou převážně věrohodné, ale plán zaměňuje velikost celého trhu za dosažitelnou příležitost a staví primární business na neověřené dealerské ekonomice. Aktuální evropský zdroj uvádí 40 %, nikoli přibližně 48 % single-bidder řízení, a tento indikátor sám nedokazuje bolest z časové náročnosti přípravy. Nejzávažnější je rozpor s invariantem: prahy a bulk potvrzení umožňují obejít skutečnou kontrolu každé položky. Primární cestou má být placený assistovaný bid service, zatímco vlastní obchodování pouze omezený experiment s tvrdým limitem kapitálové expozice.

## Nálezy

### [CRITICAL] invariant · dokument 02
**Problém:** Fáze 5 připouští lidské schválení pouze u cen nad prahem, a tedy umožňuje průchod některých položek bez lidského potvrzení.

**Proč je to reálné:** Roadmapa výslovně uvádí lidský zásah mimo jiné jen pro schválení cen nad prahem, což odporuje invariantní kontrole každé položky.

**Návrh:** Stanovit human_review_rate 100 %, odstranit cenový práh pro povinnost potvrzení a vyžadovat individuální potvrzení každé položky se specifikací, zdrojem, nákupní cenou, prodejní cenou a marží.

### [CRITICAL] invariant · dokument 03
**Problém:** C-01 zavádí hromadné potvrzení cen napříč položkami a zakázkami bez zaručené individuální kontroly každé položky.

**Proč je to reálné:** Akceptace popisuje bulk potvrzení a souhrnný dialog, ale nevyžaduje aktivní per-item attestaci; jeden klik tak může potvrdit více závazných cen.

**Návrh:** Zakázat select-all potvrzení, vyžadovat samostatný reviewed_at a reviewed_by u každé položky a změnou ceny nebo zdroje potvrzení vždy invalidovat.

### [HIGH] business · dokument 01
**Problém:** Model 0 je doporučen jako primární business bez ověřené kvalifikace, kapitálu, logistiky a contribution margin.

**Proč je to reálné:** Plán má 0 podání a neznámý win-rate, zatímco vlastní obchodování přidává financování zásob, DPH, dopravu, dostupnost, reklamace, záruky a smluvní sankce, které COGS pod 500 Kč vůbec nezahrnuje.

**Návrh:** Primárně spustit placený managed bid service, vlastní obchodování omezit na malý experiment s předem stanoveným exposure limitem.

### [HIGH] business · dokument 01
**Problém:** Tvrzení o přibližně 48 % single-bidder řízení je pro rok 2024 nesprávné a jeho obchodní interpretace není doložena.

**Proč je to reálné:** Aktuální scoreboard Evropské komise uvádí pro Česko v roce 2024 hodnotu 40 % a ukazatel sám nevysvětluje, zda příčinou je časová náročnost přípravy nabídek.

**Návrh:** Opravit číslo na 40 %, uvést rozsah a metodiku TED a hypotézu o nestíhání validovat rozhovory a segmentovými daty.

### [HIGH] business · dokument 01
**Problém:** Dopočet 40 až 45 tisíc nabídek ročně není použitelný adresovatelný trh produktu.

**Proč je to reálné:** Násobí počet zadaných zakázek průměrem nabídek bez sjednocení datové báze a bez omezení na komoditní dodávky, kvalifikaci a skutečně obslužitelné zakázky.

**Návrh:** Vytvořit bottom-up SAM podle CPV, typu řízení, položkového soupisu, velikosti, počtu relevantních dodavatelů a frekvence jejich podávání.

### [HIGH] strategie · dokument 02
**Problém:** Fáze nazvaná první vyhraná koruna lze ukončit bez výhry, smlouvy, dodání nebo inkasa.

**Proč je to reálné:** Exit gate vyžaduje dvě odeslané nabídky a zapsané výsledky, nikoli výhru ani kladnou ekonomiku.

**Návrh:** Přejmenovat fázi na první bezvadně podaná nabídka a oddělit milníky procesní validace, první výhry, kladné contribution margin a prvního inkasa.

### [HIGH] exekuce · dokument 03
**Problém:** Před prvním vlastním podáním chybí task pro připravenost právnické osoby, kvalifikaci, sourcing, logistiku a kapitálovou expozici.

**Proč je to reálné:** Plán sám tato rizika uvádí v R9 a rozhodnutích majitele, ale A-07 na ně nemá tvrdou závislost ani akceptační checklist.

**Návrh:** Přidat A-00 entity and delivery readiness jako blokující závislost A-06 a A-07 včetně cash-flow limitu a minimální contribution margin.

### [HIGH] exekuce · dokument 03
**Problém:** A-01 ponechává nekompletní povinné dokumenty pouze jako advisory warning, přestože plán slibuje nulové formální diskvalifikace.

**Proč je to reálné:** Analysis může požadavek vynechat a operátor může finalize provést i s neodškrtnutým checklistem.

**Návrh:** Povinné checklist položky udělat hard gate s možností pouze auditované per-item výjimky a před prvním podáním provést nezávislé dvojí čtení ZD.

### [HIGH] strategie · dokument 02
**Problém:** P(win) a přepočet vah jsou plánovány na vzorku, který je pro segmentovaný model příliš malý.

**Proč je to reálné:** Deset až dvacet outcomes a ani obecný práh padesáti výsledků neposkytují spolehlivou kalibraci napříč kategoriemi, portály a velikostmi zakázek.

**Návrh:** Do dostatečného vzorku zobrazovat jen historickou pozici ceny a interval nejistoty; P(win) povolit až po backtestu a minimálním počtu případů v konkrétním segmentu.

### [HIGH] exekuce · dokument 03
**Problém:** SaaS je doporučen souběžně, ale plán nemá tenant izolaci, role, onboarding, fakturaci ani lifecycle zákaznických dat.

**Proč je to reálné:** Repo a plán pracují se single-tenant architekturou a implementační vlny neobsahují minimální SaaS foundation.

**Návrh:** První externí model provozovat jako managed service bez přímého přístupu klienta a samostatnou SaaS architektonickou větev otevřít až po placené validaci.

### [MEDIUM] business · dokument 01
**Problém:** Konkurenční závěr nikdo v ČR dělá pouze monitoring je formulován s neobhajitelnou jistotou.

**Proč je to reálné:** Tenderpool veřejně potvrzuje monitoring a analýzu, ale Veřejná-soutěž.cz nabízí i odbornou přípravu nabídky a veřejný web neodhalí interní ani zakázková řešení.

**Návrh:** Rozšířit konkurenci o bid-desk poradenství, zakázkovou automatizaci a interní nástroje a tvrzení změnit na nebyl nalezen veřejně nabízený identický produkt.

### [MEDIUM] exekuce · dokument 03
**Problém:** GDPR, licence dat a podmínky automatizovaného stahování NEN jsou řešeny příliš pozdě a neúplně.

**Proč je to reálné:** T-06 přichází až před akceptací vlny D a A-09 se soustředí na účet a podání, přestože sběr a komerční použití dat začínají dříve.

**Návrh:** Před externím pilotem dokončit data inventory, právní titul, retenci, mazání, licenci, DPA a samostatný právní závěr ke scrapingu a ukládání zadávací dokumentace.

### [MEDIUM] exekuce · dokument 03
**Problém:** Kill-switch a governance jsou odloženy až do vlny F, ačkoli bulk money-path a automatické joby vznikají dříve.

**Proč je to reálné:** B-05 a C-01 již automatizují drahé a závazné části workflow, ale společný stop mechanismus se plánuje až jako F-01.

**Návrh:** Přesunout základní kill-switch před B-05 a C-01 a samostatně řídit stop ingest, AI jobs, generate, finalize a submission.

### [MEDIUM] strategie · dokument 02
**Problém:** Škálovací kritérium 20 submit-ready nabídek denně měří produkci dokumentů místo obchodní hodnoty.

**Proč je to reálné:** Bez placených zákazníků nebo kapacity zakázky skutečně podat, financovat a dodat může vyšší throughput pouze zvyšovat náklady.

**Návrh:** Podmínit škálování opakovanou platbou, contribution margin, počtem skutečných podání a kapacitou sourcingu a plnění.

## Protinávrh pořadí prvních kroků

1. A-00: rozhodnout managed service versus omezený dealer experiment a ověřit entity, kvalifikaci, logistiku, pojištění, cash-flow limit a minimální contribution margin
2. Provést tři placené concierge validace s externími komoditními dodavateli a změřit čas, opravy, zaplacenou cenu a opakovanou ochotu platit
3. Vybrat jeden pilot podle reálné schopnosti dodat a vytvořit per-item sourcing dossier včetně dostupnosti, dopravy, DPH, platnosti ceny a dodací lhůty
4. Zavést 100% individuální human-review cen, invalidaci potvrzení po změně a hard completeness gate; současně uložit feature snapshot a hash balíku
5. Podat jednu nabídku ručně podle runbooku, udělat retrospektivu a opravit proces před dalšími dvěma podáními a outcome watcherem

---

## Nezapracované nálezy a proč (vypořádání v2, 2026-07-12)

Žádný nález nebyl odmítnut vcelku. Všech 14 nálezů je zapracováno v dokumentech 00–03
(changelog: 00-README §5). Dvě vědomé odchylky od doslovného znění:

1. **Protinávrh krok 2 — „tři placené concierge validace" PŘED vlastním podáním:**
   zapracováno jako SOUBĚŽNÁ stopa, ne tvrdá sekvence. Důvod: shánění platících design
   partnerů má neznámou latenci a žádnou technickou závislost na vlastním pilotu; riziko,
   před kterým nález primárně varuje (neomezená dealerská expozice), je mitigováno jinak —
   tvrdým stropem kapitálové expozice a min. contribution margin v A-00, které jakékoli
   podání blokují. Čekat s jediným kalibrujícím provozem (vlastní pilot) na uzavření
   prodejního cyklu by prodloužilo cestu k datům bez snížení rizika. Vnitřní pořadí
   vlastního pilotu (1 podání → retrospektiva → další 2) převzato beze změny.
2. **Bulk potvrzení (CRITICAL #2) — návrh „zakázat select-all":** zapracováno v duchu,
   ne doslova. Implementace (PR #63, nasazeno) bulk operaci zachovává, ale potvrzuje
   POUZE položky s explicitní per-item attestací (serverová auditní stopa kdo/kdy,
   invalidace při změně produktu/ceny, slepé „Potvrdit vše" odstraněno) — což je přesně
   vlastnost, kterou nález vyžadoval („samostatný reviewed_at/reviewed_by u každé
   položky"); samotné slovo „bulk" tedy zůstává pro UX dávkového ODESLÁNÍ už
   attestovaných položek, nikoli pro dávkovou KONTROLU.

Pozn. k nálezu „48 % vs. 40 % single-bidder": číslo opraveno na 40 % (EU Single Market
Scoreboard 2024) s poznámkou o metodice (TED báze); v 01 ponechána jedna věta
vysvětlující, odkud se vzalo starší ~48 % (jiná báze/období) — aby se při příštím
researchi čísla znovu nesmíchala. Není to obhajoba původní hodnoty.

Pozn. k nálezu „kill-switch až ve vlně F" (MEDIUM): nejenom zapracován, ale mezitím
VYŘEŠEN nasazením — PR #65 (`config/governance.json`: přepínače ingest / ai_jobs /
generate / finalize / submission + denní strop AI nákladů, serverové 503 guardy,
admin API, audit kdo/kdy). V plánu veden jako hotový fakt (03 B-00, C-03); F-01
na vrstvě staví limity podání, audit log autonomních akcí a anomálie.
