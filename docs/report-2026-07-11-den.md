# Denní report VZ — 2026-07-11 odpoledne (ultracode, cíl 70 %, Codex parťák)

## TL;DR

Tři nasazené vlny (PR #50, #52, #53) + živá ověření. **Poctivé skóre: ~48 → ~55 %.**
Na 70 % chybí hlavně to, co kód nedodá: reálná podání a výsledky (kalibrace loopu) — viz §5.

Nový režim spolupráce ověřen: **Codex gpt-5.6-sol jako parťák** — návrhář (wave 2 vzešla z jeho
plánu), implementátor (bulk) i oponent (3 adversariální review: 8 + 11 + 7 nálezů, všechny
verifikovány a opraveny). Fable jen orchestruje, verifikuje gates a dělá finální money-path soud.

## 1) Vlna 1 (PR #50 + #51) — NASAZENO a živě ověřeno

- **Monitoring feed ŽIVÝ**: NEN scrape bez credentials (stránkování /p:vz:page=N ověřené reálným
  voláním, cap 5 stran), migrace 014, sync→feed→převzetí zakázky→ignorace, go/no-go skóre,
  Hlídač fallback (token stále chybí — pro Dana). Prod: **sync natáhl 89 reálných zakázek**;
  po fixu prošlých lhůt (#51) feed ukazuje 63 aktuálních. Převzetí zakládá zakázku atomicky.
- **Inbox „Ke schválení"**: agregace napříč zakázkami (nepotvrzené ceny, HARD flagy, validation
  fails, vadná data) — prod: 23 zakázek k akci, správné řazení.
- **Paralelní fronta**: PIPELINE_MAX_CONCURRENT=2, per-tender serializace (čistá funkce + testy).
- **Win-price kategorizace**: 11 kategorií — prod re-run: **2 029 řádků překategorizováno**,
  „ostatni" 9 484 → 7 719 (zdravotnické 696, stavební 525, služby 393…).
- **JWT pryč z query stringu** (FE přes Authorization hlavičku; BE query zachován pro skripty).
- **Výběr částí (Danův požadavek)**: UI dostavěno (disabled při 0, chip Části X/Y, staleness
  varování) + **serverový guard**: změna výběru po nacenění → generate/submit 409.
- Oponentura Codex: REJECT 8 nálezů (4H+4M — mj. TOCTOU při převzetí, NEN jen 1. stránka,
  corrupt JSON mizel z inboxu) → vše opraveno, 157/157 testů.

## 2) Vlna 2 (PR #52) — NASAZENO

- **Submission cockpit**: finalize → immutable ZIP balík s manifestem (sha256, verzování),
  stav jen „pripravena"; „odeslana" až po zaznamenané evidenci podání (portál, čas, ev. číslo).
  Deadline alarm v inboxu (připraveno+nepodáno+lhůta<48 h). Konec falešně zeleného „odesláno".
- **Approval-aware resume**: run-all na lidském checkpointu nekončí chybou — stav
  `waiting_approval`, po potvrzení cen resume (jen na klik; gate fail-closed; **generate nově
  tvrdě padá nad nepotvrzenými cenami i při ručním spuštění**).
- **Bid skóre** (profit-aware, po nacenění): zisk Kč, přirážka vs. cíl (nákladová základna),
  kvalita shod, HARD flag=NOGO, win-price proximity; v detailu + inbox sloupec zisk.
- **ZIP intake + stale artefakty**: ZIP upload povolen (s limity), změna ceny → stale bannery
  a **finalize/submit-gate 409 na stale dokumenty** (critical nález oponentury).
- Oponentura Codex: REJECT 11 nálezů (1 critical + 6 high + 4 medium) → vše opraveno, 212/212.

## 3) Danův požadavek: nákupní linky + sklad + nákupní fáze (PR #53) — NASAZENO

- **„Kde nakoupit" při potvrzování**: price-verifier vrací až 3 nákupní zdroje; panel je ukazuje
  u Potvrdit s per-source „Použít cenu" (drží marži; volba se propisuje i do hromadného
  potvrzení a ukládá jako zdroj_nakupu).
- **Sklad nálezů**: migrace 015 warehouse_web_findings — každý web-nález se ukládá; matching
  sklad NEČTE (žádná kontaminace).
- **Tab „Nákup"**: migrace 016 crm_nakupy — seznam co koupit (odkazy, součty, objednáno),
  idempotentní seed z potvrzených cen s reconciliací, win banner.
- Oponentura Codex: 7 nálezů (2 high — desync draftu s hromadným potvrzením; append-only seed)
  → opraveno, 227/227 testů.
- Živý test verify: mechanismus OK, ale u specializovaného nářadí AI katalogová čísla web nezná
  (0/4 nalezeno, ~22 Kč) — hodnota linků poroste s kvalitou kandidátů (mainstream značky nachází).

## 4) Incident: únik reálných dokumentů do git větve (vyřešen)

Při řešení merge konfliktů jsem použil nescopovaný `git add -A` → do integrace wave 2 se dostalo
**299 souborů z input/** (reálné ZD vč. osobních údajů). Odhalila to Codex oponentura. Náprava:
větev přestavěna bez úniku, kontaminovaná větev na GitHubu smazána (PR z ní nikdy nevznikl,
repo privátní — expozice minimální), **.gitignore nově ignoruje celé input/**. Poučení v memory:
při konfliktech VŽDY scoped add.

## 5) Skóre: ~48 → **~55 %** (cíl 70 %)

| Dimenze | Ráno | Teď | Čím |
|---|---|---|---|
| Průchodnost | 63 | 68 | paralelní fronta, ZIP intake, resume místo error |
| Kvalita | 65 | 68 | stale gate end-to-end, generate hard-fail, parts guard |
| UX | 51 | 60 | inbox, monitoring stránka, parts UI, nákupní linky, win-rate widget |
| Provoz | 45 | 50 | JWT z FE query pryč, ZIP limity, atomicita podání, gitignore |
| Business | 36 | 46 | evidence podání, bid skóre se ziskem, kategorizace, nákupní fáze |
| Autonomie | 26 | 40 | živý monitoring feed s převzetím, approval-aware řetěz |

**K 70 % vede hlavně provoz, ne kód** (shodně já i Codex-návrhář): (1) pilotně podat 2–3 reálné
nabídky přes celý flow a zaznamenat výsledky (kalibrace win-rate/bid skóre daty), (2) outcome
watcher (auto-dohledání výsledků), (3) HLIDAC_TOKEN pro druhý zdroj feedu, (4) hlubší obsahová
responzivnost návrhu. Kódové kandidáty na další noc: auto-run-all po převzetí z monitoringu
(s waiting_approval checkpointem už bezpečné), cost observabilita per zakázka, typový dluh.

## 6) Autonomní rozhodnutí

1. JWT fix a win-price kategorizaci jsem vzal jako schválené (vyjmenované páky k 70 %).
2. NEN scrape jako primární zdroj feedu (Hlídač potřebuje token, který na prod není).
3. Prošlé lhůty se z feedu defaultně skrývají (?vse=1 je vrátí).
4. Kontaminovanou větev jsem smazal z GitHubu bez čekání (žádný PR z ní neexistoval).
5. Rekategorizaci win_prices jsem spustil na prod po dry-runu (2 029 změn, vratné přes re-run).
6. Živé verify jsem zastavil po 4 položkách (0 nálezů, náklad ~22 Kč — mechanismus ověřen,
   plošný běh počká na kvalitnější katalogová čísla kandidátů).
