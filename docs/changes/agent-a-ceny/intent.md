# Intent — Agentní rozhraní VZ a doložitelné ceny

- **change-id:** `agent-a-ceny`
- **tier (návrh):** **L**
- **datum:** 2026-09-03
- **stav:** čeká na schválení zadavatelem

## 1. Surový vstup zadavatele (doslovně, bez výkladu)

> „a ještě bych chtěl to připravit na agenty. bud udělat dokuementaci k api, nebo nějak MCP.
> Ale aby mohl agent stahovat zakázky a nahrávat je. mluvim o agentovi typu hermes."

> „prostě, bude pod přihlášením procházet VZ, podle nějakého klíče, VZ agregátory nemaj api,
> musíme dělat ručně. A pak nahrávat do toolu. později i validovat ty ceny asi. mohl by to
> i oplnit možná, ale to dnes nejde to najít. Nevím, nějak proymsli, aby se co nejvíce
> automatizovalo a produkt fungoval a doručoval výsledky."

> „no upřímně nevím, jak tam ty ceny ted vznikají, ale přijde mi že nesedí i když třeba
> odkazují na konrétní obchod, tak je za jinou cenu. není to dobře, nebvím jaká je ideální
> technická cesta. původně jem chtěl mít sklad cen, v kterém se budou hledat produkty,
> feedovat B2B a B2X obchody, ale to se nedotáhlo. Jsem pro cokoli, co bude fungovat
> a splní to co od toho čekám."

> „nevím jaké zdroje má nafeedované, nevím jak to funguje. myslím že ty feedy nejsou dobre
> a prání si je, ale může codex udělat nějakou researhi, odkud brát data, pak by se ílíp
> filtrovalo i uvnitř apikace."

Dřívější rozhodnutí ze stejné session: agent smí pracovat **„zatím prostě do cen"** — tedy
nikoli skrz ně.

## 2. Jaký problém dnes pozorovatelně existuje

**P1 — Ceny v nabídce nejsou ničím podložené.** Změřeno nad 978 cenovými kandidáty v
`output/*/product-match.json` ze 7 zakázek: pole `zdroj_ceny` je u všech volný text tvaru
„Odhad z distribuce / z e-shopů / z českého trhu"; v celém `output/` **není jediná URL**;
datový model kandidáta pole pro odkaz vůbec nemá; katalogové číslo má 203/978 (21 %).
Pole `dodavatele` přitom nese reálná jména obchodů (Alza.cz 378×, CZC.cz 215×, Hornbach 148×),
takže výstup **vypadá** podloženě, ačkoli se těch obchodů nikdo nezeptal.
Spolehlivost „střední" má 684/978. Z pilotu je doloženo, že **reálný nákup vyšel ~70 % nad
odhadem** — to je dnes hlavní překážka ziskovosti.

**P2 — Systém si zakázky sám nenajde.** `config/monitoring.json` má prázdná `klicova_slova`,
sync tedy posílá na NEN prázdný dotaz a přečte ~250 zakázek z ~278 500 v nestabilním pořadí.
Zakázka, kterou 3. 9. nahlásil uživatel, ve feedu vůbec nebyla.

**P3 — Zakázky z portálů bez API se nedají získat automaticky.** TenderArena je za Cloudflare
Turnstile (vedeno v `DAN-TODO.md` jako neřešitelné strojově), část agregátorů je za přihlášením.
Dnes to znamená ruční práci člověka.

**P4 — Pro stroj není kudy dovnitř.** Legacy `API_TOKEN` neprojde přes `requireJwt` na
`POST /api/monitoring/:id/prevzit`; akce statickým tokenem se zapisují s `actor: null`, takže
by v historii nešlo odlišit agenta od člověka; neexistuje cesta „dej URL zakázky → založ ji";
`POST /api/tenders/:id/attachments` navzdory názvu ukládá **přílohy do nabídky**, ne vstupní
dokumentaci — záměna by tiše vyřadila dokumenty z analýzy.

**P5 — Tiché selhání vypadá jako úspěch.** Doloženo 3. 9.: graceful degradace vrátila 10 z 18
dokumentů bez jediné chyby. Týž vzorec je i jinde (extract projde nad poloprázdným vstupem,
vyčerpaný AI strop není vidět na `/api/health`, chybějící `OPENAI_API_KEY` tiše zabíjí vektorový
tier). Repo navíc **nemá žádné checky na PR** — dva testy byly červené přímo na `main`.

## 3. Jaký výsledek má být po změně možný

1. Cena v nabídce **buď má doložený zdroj** (URL + datum + cena v okamžiku zjištění), **nebo se
   do nabídky nedostane**. Nepodložený odhad je viditelně označený a brána ho zastaví.
2. Externí agent (Hermes) se přihlásí vlastní identitou, **přinese zakázku** (odkazem, nebo
   souborem z portálu, kam se nedostaneme) a **přinese doložené ceny jako návrh**. Člověk je
   potvrzuje; agent na peníze nesahá.
3. Obory a zdroje jsou **konfigurace**, ne kód — feed přestane být slepý.
4. Neúplný vstup **nevypadá zeleně**.

## 4. Koho a čeho se to dotkne

Patrik (nosí zakázky ručně, potvrzuje ceny) · Dan (rozhoduje obory, nese odpovědnost za nabídku) ·
externí agent Hermes (nová nelidská identita) · NEN, Hlídač státu, ISVZ open data, e-shopy ·
`serve-api.ts`, monitoring, cenová vrstva, `types.ts`, SPA.

## 5. Hlavní cesta od vstupu k výsledku

`agent nebo člověk dodá zakázku` → `ingest s kontrolou úplnosti` → `analýza a rozpad na položky`
→ `ceny s doloženým zdrojem (sklad / ověřený e-shop / agent / člověk)` → `brána: nepodložená
cena neprojde` → `člověk potvrdí` → `dokumenty a podání`.

## 6. Omezení, která platí

- **Invariant lidské kontroly zůstává.** Agent nesmí potvrzovat ceny, finalizovat, ani označit
  „podáno". Money-path je člověk. (Navazuje na dřívější opravu, kdy kód tenhle invariant porušoval.)
- Agent utrácí AI rozpočet → potřebuje **vlastní strop odděleně od lidského** a musí být
  **odvolatelný za běhu**, ne rotací env a redeployem.
- Secrets nikdy do gitu. Ostrý zápis peněz, flip killswitche a prod migrace jsou stopky.
- NEN veřejné API existuje (Swagger `nen-ws.nipez.cz/PS01r/swagger/`), ale vyžaduje registraci
  a certifikáty — scraping je tedy legitimní cesta, ne nedopatření.
- ISVZ open data se aktualizují 5. dne v měsíci → použitelné na **kalibraci**, ne na živý feed.

## 7. Co vědomě NEPATŘÍ do rozsahu

Automatické podávání nabídek · agent na money-path · nákup dat třetích stran · přepis
`serve-api.ts` na routery · vlastní scraping e-shopů nad rámec doložení ceny · napojení na
oficiální NEN API (vyžaduje registraci a certifikáty — samostatné rozhodnutí).

## 8. Pozorovatelné signály úspěchu

- Podíl položek s doloženým zdrojem ceny **> 0 %** (dnes měřitelně 0 z 978) a rostoucí.
- Odchylka odhadu od skutečného nákupu **klesá** proti dnešních +70 % (měřeno bid snapshotem).
- Agent sám založí zakázku z odkazu a dodá ≥ 1 doloženou cenu, aniž by sáhl na money-path;
  v historii zakázky je jeho akce **odlišitelná** od lidské.
- Feed najde zakázku, kterou dnes nenajde (regresní případ: `N006/26/V00027380`).
- Neúplný ingest **zčervená** místo tichého „hotovo".
- Na PR běží testy a typecheck.

## 9. Otevřené otázky

| Q | Otázka | Blokuje | Může pokračovat |
|---|---|---|---|
| Q1 | Které obory má monitoring sledovat (kromě IT)? | naplnění konfigurace obory | infrastruktura oborů jako konfigurace |
| Q2 | Smí agent spouštět AI pipeline (utrácí rozpočet)? Jaký vlastní denní strop? | agentní spouštění analýzy | ingest a čtení agentem |
| Q3 | Jedna sdílená agentní identita, nebo jedna na účel? | tvar úložiště klíčů | zbytek auth vrstvy |
| Q4 | Má být `/mcp` veřejné, nebo omezené na IP/VPN? | expozice | vývoj serveru |
| Q5 | Blokovat podání při překročení stropu části, nebo jen varovat? | chování brány | výpočet stropu |
| Q6 | Krycí list: vždy vyplnit formulář zadavatele, nebo generovat vlastní? | generování dokumentů | zbytek dělených zakázek |

## 10. Rozhodnutí, která jsem udělal sám (vratná, technická)

- **MCP jako primární rozhraní**, OpenAPI popis jako vedlejší produkt ze stejných schémat.
  Důvod: Hermes nemá OpenAPI typ nástroje, volal by nás `curl`em z terminálu.
- **Soubory se do systému dostávají odkazem** (server si je stáhne sám — to už umíme), pro
  portály bez API **krátkodobý upload lístek** vydaný MCP nástrojem. Base64 v argumentu ne.
- **Sandbox Codexu je offline**, proto webová rešerše zůstala na hlavní session a Codex dostal
  jen analýzu kódu.

## 11. Návrh tieru: L

Doloženo dotčenými cestami: nový modul (`scripts/src/mcp/`) · user-visible UI (upload do zakázky,
ceny po částech) · autentizace a nová nelidská identita (`jwt-auth.ts`, `user-store.ts`, migrace)
· money-adjacent (provenience ceny řídí, co smí do nabídky) · více etap.
Kterákoli z prvních tří sama o sobě vylučuje S i M.
