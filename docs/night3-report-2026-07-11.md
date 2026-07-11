# Ranní report VZ — noc 3 (2026-07-11, ultracode autonomní běh)

## 1) TL;DR

Money-path je po této noci chráněný na vstupu, jednotný v marži a poprvé se **učí z výsledků**:

- **Flagship gate OVĚŘEN na reálných datech.** Re-run match na n-485400 halucinaci zreprodukoval
  („Kompletní sada dílenského nářadí" 280 000 Kč za adaptér) → `extreme_outlier` HARD →
  **potvrzení přes API vrátilo HTTP 409**. Včerejší pojistka není teorie, drží živě na produ.
- **Root-cause fix nasazen a živě přeměřen**: po fixu (prompt + zero-prefill + scale-mismatch
  guard) druhý běh škodu zmenšil **12×** (372 680 → 31 790 Kč s DPH/ks) a položku správně
  oflagoval („kandidát vypadá jako sada, položka je díl" + nízká spolehlivost). Nula HARD nálezů
  v celé nabídce (dřív 2).
- **Konec one-click nulového zisku**: default marže je všude company default (10 % fallback) —
  web-cena, hromadné potvrzení i cenový panel. Nepotvrzená marže 0 = otrávený default a přepíše
  se; potvrzenou nulu operátora respektujeme.
- **Stroj se poprvé učí**: tab „Výsledek" (výhra/prohra/zrušeno + ceny + počet uchazečů) →
  win-rate a odchylka od vítěze měřitelné (`/api/outcomes/stats`), vítězné ceny se propisují
  do win_prices (zdroj `vlastni_vysledek`).
- **Win-price data použitelnější**: dopočet ceny bez DPH z „jen s DPH" řádků (25 % dat) +
  vyčištěná vadná data → pásma reálně zhoustla: **server n 62→70, projektor n 145→180**.
- **e2e.sh už neobchází money-gate**: auto-confirm jen s explicitním `E2E_UNSAFE_AUTOCONFIRM=1`.

## 2) Nasazeno (PR #43 = integrace #39–#42, deploy zelený, prod ověřen)

| PR | Co | Ověření |
|---|---|---|
| #40 | Marže: GET `/api/tenders/:id/pricing-defaults` + FE sjednocení (web-draft, bulk, panel) | testy 7/7, prod endpoint vrací 10 |
| #39 | Root-cause halucinovaných cen: prompt (měřítko položky, `zadna_shoda`), zero-prefill bez shody → HARD `zero_price`, scale-mismatch guard (celá slova) | 8 unit testů, živý re-run níže |
| #41 | Win-price hygiena: migrace 013 (datumy mimo [2015, dnes] → NULL), sanitizace importu, dopočet bez DPH /1,21 | prod: vadná data 0/10 000, band n +13–24 % |
| #42 | Win-rate feedback: migrace 012 `crm_vysledky`, outcome endpointy, tab Výsledek, propis do win_prices | 7 unit testů, prod endpointy živé |

Verifikace integrace: 47/47 testů, FE build PASS, 0 nových tsc chyb, migrace 012+013 aplikované
automaticky, https://vz.ludone.cz 200 (bez nginx 502). Všechny 4 diffy prošly adversariálním
review (Fable); 1 nález (`//` komentáře v JSON šablonách promptu = riziko nevalidního JSON
výstupu modelu) opraven před mergem.

## 3) Živé ověření money-path na n-485400 (2 běhy match, ~56 Kč)

**Běh 1 (před fixem, build noci 2):** halucinace se reprodukovala — „Rázová redukce 3/4×1/2"
(adaptér, 5 ks) dostala kandidáta „Kompletní sada dílenského nářadí" 280 000 Kč (77,7 % nabídky,
313× medián). Gate: `extreme_outlier` HARD + 3 WARN → **potvrzení = HTTP 409**. Bonus: overcap
HARD na zvedáku (42 350 > strop 39 999). Marže 10 % předvyplněná.

**Běh 2 (po fixu):** stejná položka → kandidát „dílenský vozík s nářadím" 23 884 Kč bez DPH
(12× menší škoda), **scale-mismatch guard správně varuje** („kandidát vypadá jako sada/komplet,
ale položka je jednotlivý díl") + forcenutá nízká spolehlivost → `low_confidence_big` WARN.
Celkem 0 HARD nálezů (dřív 2), 9 položek s sada-mismatch upozorněním, potvrzeno=false všude.

**Nový nález (další root-cause vrstva):** položka 41 má v analysis.json PRÁZDNOU specifikaci —
název „…: viz popis níže" a popis se při extract/analyze ztratil. Model pak hádá z názvu.
Dokud se „viz popis níže" nedotáhne, budou tyhle položky vyžadovat ruční kontrolu (teď už jsou
aspoň viditelně oflagované a nepotvrzené). → priorita na příští noc.

## 4) Nové audit skóre: ~44 % → **~47 %** (+3)

| Dimenze | Předtím | Teď | Čím podloženo |
|---|---|---|---|
| Průchodnost | 63 | 63 | beze změny |
| Kvalita | 56 | 62 | 409 ověřeno živě; root-cause 12× menší škoda + flagy; marže jednotná |
| UX | 48 | 50 | tab Výsledek; hustší win-price pásma v Ocenění |
| Provoz | 43 | 45 | e2e guard (konec falešné zelené), čisté migrace |
| Business | 28 | 35 | win-rate měřitelná + učení z výsledků; win-price data +38 % využitelnost |
| Autonomie | 25 | 26 | drobné (outcome data = budoucí kalibrace go/no-go) |

Skóre je záměrně střízlivé: win-rate loop je nasazený, ale prázdný (0 podaných nabídek — plnit
ho musí reálný provoz), a root-cause fix snížil škodu, ale extraction gap („viz popis níže")
zůstává otevřený.

## 5) Incident: lokální Mac disk 100 % (ENOSPC, ~20 min)

~07:10 se disk Macu zaplnil na 100 % — VŠECHNY lokální nástroje mrtvé (selhal i 4bajtový zápis;
Playwright MCP padal na mkdtemp). Podle indicií to způsobila příprava macOS aktualizace
(MSUPrepareUpdate snapshot); systém si po ~15 min sám uvolnil ~13 GB. Danovi odešla push
notifikace (jen terminál — Remote Control pro mobil neaktivní).

Mitigace: implementace se přesunula na 3 pozadí agenty (worktree izolace s vlastním prostředím
— ENOSPC hlavní session je nezasáhl) a prod práce jela dál přes už navázané SSH. Efektivně
nulová ztráta času.

**PRO DANA:** disk je stále na 97 % (12 GB volno). Největší kandidáti na úklid:
`~/Library/Caches` 19 GB (Spotify 8,2 GB), Docker.app VM 13 GB, ms-playwright 1,8 GB.
Smazal jsem pnpm cache (~1 GB) a junk duplikáty `@types/* 2` + `scripts/package 2.json`.

## 6) Autonomní rozhodnutí této noci

1. e2e.sh guard = env-flag bypass (`E2E_UNSAFE_AUTOCONFIRM=1`), ne smazání — syntetická E2E
   průchodnost ho legitimně potřebuje; default je bezpečný. Záloha `/opt/vz/e2e.sh.bak-night3`.
2. Nepotvrzená marže 0 se přepisuje defaultem i u starých dat (cena jde jen NAHORU, overcap
   gate kryje strop); potvrzená 0 = vědomé rozhodnutí operátora.
3. `zadna_shoda` položky dostávají NULOVOU nepotvrzenou cenu (HARD blok) místo odhadu — víc
   ruční práce, žádná falešná cena v závazné nabídce.
4. win_prices: nemazal jsem řádky bez ceny (hodnota pro PDF backfill) ani >100 M (mohou být
   legitimní; medián je robustní) — jen nedůvěryhodné datumy → NULL.
5. Win-rate sémantika: výhra → do win_prices jde naše cena; prohra → vítězná; zrušeno/bez ceny
   → smazání feedback řádku.
6. Kolize číslování migrací (2 agenti × 012) vyřešena přečíslováním na 013 PŘED mergem.
7. **Chyba k přiznání:** 3 implementační agenti běželi bez `model:'opus'` overridu → jeli na
   Fable (~480 k subagent tokenů), Codex nepoužit vůbec. Porušení pravidla o šetření Fable.
   Zapsáno do memory, příště: agenti `model:'opus'`, bulk na Codex.

## 7) Co dál (seřazeno, návrh na příští noc)

1. **Extraction gap „viz popis níže"** — dotáhnout popis položky do specifikace (nový nález, §3).
2. **Spec-compliance kontrola** nabídky vs zadání (night2 §4.4) — nezačato.
3. **Win-rate widget** do Přehledu (endpoint stats už žije).
4. Typový dluh: 27 pre-existing tsc chyb odkrytých po úklidu junk `@types/* 2` (CI netypechecká
   backend — běží přes tsx; chyby jsou na main i před nocí 3).
5. Čeká na Danovo rozhodnutí: reálná default marže (%), JWT v query stringu, win-price
   kategorizace (95 % „ostatni") + PDF backfill.

---

## Dodatek — noc 3b (pokračování 2026-07-11 dopoledne)

**Cíl (nastaven autonomně):** kvalita nacenění + shoda se zadáním. Nasazeno PR #48 (integrace #45+#46+#47), deploy zelený, prod ověřen.

### Headline: extraction gap fix ověřen živě — cena položky 1000× přesnější

Položka 42 „Rázová redukce 3/4×1/2" (n-485400) napříč běhy:
| Běh | Kandidát | Cena bez DPH | Obrana |
|---|---|---|---|
| před fixy | „Kompletní sada dílenského nářadí" | 280 000 Kč | extreme_outlier HARD → 409 |
| po #39 (root-cause) | „dílenský vozík s nářadím" | 23 884 Kč | scale-mismatch WARN + nízká spolehlivost |
| po #45 (enricher) | **Gedore R68003012 (skutečná redukce)** | **280 Kč** | žádný flag potřeba — cena je správně |

Enricher (#45, Codex gpt-5.6-sol + Fable review): deterministicky připojuje popisové bloky „Položka č. N" k položkám se specifikací „viz popis níže" — s money-path guardem (shoda čísla A názvu, jinak neobohatit). Na produ obohatil 57/57 položek; specifikace položky 42 = přesně 3 odrážky ze zadání. Celková nabídka nyní 762 923 Kč s DPH, jediný HARD nález = korektní overcap na zvedáku (nad strop 39 999). Náklad ověřovacích běhů: ~169 Kč (2× analyze+match navíc oproti plánu, v limitu).

### Dále nasazeno
- **#47 spec-compliance (Opus + Fable review):** deterministická kontrola „vybraný kandidát plní povinné požadavky" ve validation-reportu — fail/warning pro operátora, ZÁMĚRNĚ neblokuje (splneno = noisy AI sebe-hodnocení; ověřeno, že gaty validation-report nečtou). Zavírá audit finding night2 §4.4.
- **#46 win-rate widget (Sonnet):** karta „Výsledky podání" v Přehledu (win-rate %, výhry/prohry/zrušené, odchylka od vítěze, empty stav).

### Skóre po noci 3b: ~47 → **~48**
Kvalita 62→65 (extraction fix s 1000× ověřením), UX 50→51 (widget), business 35→36 (spec-compliance viditelnost). Ostatní beze změny.

### Proces (naprava chyby z noci 3)
Delegace tentokrát dle pravidel: bulk implementace Codex gpt-5.6-sol (ChatGPT limit), spec-compliance Opus, widget Sonnet, Fable jen orchestrace + adversariální review. Codex bez git příkazů (commit po ověření gates dělá Claude — nulový konflikt).
