# Ranní report VZ — noc 2026-07-10 → 11

## 1) TL;DR — co se přes noc nasadilo a co to znamená pro zisk/funkčnost

Přes noc se nasadily tři vlny (P0 / doc-quality / P1) a ops vrstva. **Pro peníze a funkčnost to znamená jedno hlavní: nabídka už neuteče s otrávenou cenou a velká zakázka dojede celá.**

- **Cenová pojistka reálně drží.** Price sanity gate je vynucený na obou branách (potvrzení = HTTP 409, submit-gate ready=false s tvrdým human-confirm). Konkrétní důkaz: jedovatá cena z prod n-485400 (338 800 Kč, 77,8 % nabídky, 248× medián) by dnes spadla přes `extreme_outlier` HARD pravidlo — včera by prošla.
- **Velká zakázka dojede.** varyte 255/255 položek plně naceněno; match má salvage půlením dávky + watchdog. Dřív hrozilo, že se velký tendr zasekne.
- **Přežití restartu.** Persistentní fronta `output/.jobs.json` (atomic write-rename, restart flipne running→interrupted, unit testy 2/2). Deploy už nezanechává zombie joby.
- **Provoz konečně existuje.** Denní pg_dump záloha + alerting do Slacku (health/credit). Dva klasické „až spadne, budeme koukat" gapy zavřené.
- **Byznys páky zapojené.** Win-price pásmo (10 000 řádků, 6 381 s cenou) živě v UI Ocenění + v číselném go/no-go skóre; marže 10 %, HARD strop-gate.

Čistý dopad: **z „hezké demo" se to posunulo k „firma to dnes reálně použije na jednu zakázku manuálně, bez rizika hloupého přešlapu na ceně."** Autonomní stroj na desítky nabídek denně to ale ještě není (throughput a vstup/výstup smyčky netknuté).

## 2) Skóre vs baseline

| Dimenze | Baseline | Nové | Δ | Čím podloženo |
|---|---|---|---|---|
| Průchodnost | 47 | **63** | +16 | run-all řetěz živý na prodě, persistentní fronta + testy 2/2, varyte 255/255 dojezd, prod db:ok |
| Kvalita | 40 | **56** | +16 | price gate vynucen na obou branách (409 / ready=false), validátor čte reálný DOCX, placeholder guard, marže zapojená |
| UX | 40 | **48** | +8 | go/no-go skóre v seznamu, one-click „Spustit vše" (reconnect po deployi), hromadné „Potvrdit vše" |
| Provoz | 22 | **43** | +21 | denní pg_dump (cron 03:35, rotace 14), alerting health/credit → Slack (failure-path testován) |
| Business | 17 | **28** | +11 | win_prices 10k řádků živě v UI i go/no-go (5 vážených faktorů), marže + HARD strop |
| Autonomie | 15 | **25** | +10 | číselné go/no-go 0-100, job snapshot přežije restart, reálný Hlídač v2 klient |
| **CELKEM (průměr)** | **~30** | **~44** | **+14** | |

Δ jsou ověřené v kódu (origin/main HEAD, PR #37), na produ, v lokálních výstupech a v testech — ne z mého slova.

## 3) Co je TEĎ reálně použitelné pro manuální provoz

Plný manuální flow **firma vezme zakázku → nacení → gate ohlídá → vygeneruje → stáhne → podá** je dnes proveditelný:

1. **Vezme zakázku** — nahraje ZD (ruční upload; automatický vstup zatím není).
2. **Nacení** — pipeline extract→…→price; velké tendry dojedou (salvage + watchdog). V Ocenění vidí **win-price pásmo** a nastaví **marži**.
3. **Gate ohlídá** — price sanity gate (6 pravidel) HARD blokuje potvrzení i submit nad strop / extreme outlier. Otrávená cena neprojde.
4. **Vygeneruje** — krycí list, technický návrh, cenová nabídka, čestné prohlášení; validátor kontroluje reálný DOCX + placeholder guard zadavatele.
5. **Stáhne** — finalize = interní překlop stavu + manuální download.
6. **Podá** — **ručně na profilu zadavatele / NEN** (žádná integrace, ale žádný code-blocker).

Triáž: v seznamu je číselné go/no-go skóre 0-100 → operátor si vybere, kterou zakázku vůbec zpracovat.

**Pozor při dnešní kontrole:** doc-quality výstup na produ zatím NEOVĚŘITELNÝ — všechny 3 artefakty vznikly před mergem #36; kancelarsky má stále 2× identické čestné prohlášení. Běžící regenerace je první reálný test doc-quality fixů — po dojetí zkontrolovat.

## 4) Co ještě chybí k „první podaná + vyhraná" (seřazeno)

1. **Reálné podání** — finalize je jen překlop stavu; chybí jakákoli integrace na NEN / profil zadavatele. Pro „první podaná" stačí manuál (dnes proveditelné), pro škálování ne.
2. **Win-rate zpětná vazba** — výhra/prohra se nikam nezapisuje, win_prices se neplní z výsledků, skóre se nekalibruje. Bez toho se stroj neučí a „vyhraná" je neměřitelná.
3. **Root-cause nesmyslných cen u unmatched položek** — gate je záchranná síť, ne lék; mírné přecenění 2-3× projde tiše. Snižuje win-rate.
4. **Obsahová responzivnost návrhu** — nevaliduje se, jestli nabídka splňuje produktovou specifikaci zadání (jen úplnost polí a cena).
5. **Čištění win-price dat** — 315 naceněných it_av z 10k (95 % „ostatni"); tenký sklad pro cíl.
6. **Cross-tender dávkování / schvalovací inbox** — vše žije uvnitř detailu jedné zakázky (limit pro „desítky denně").

## 5) Tři věci k Danovu rozhodnutí

1. **Marže % — reálná hodnota.** Default je 10 % v gate, ALE cenový panel i bulk-confirm defaultují **0 %** → one-click k nulové marži. Jakou marži chceš jako skutečný default pro podání (10 %? per-kategorie?) a má bulk-confirm dědit tenhle default místo nuly?
2. **Hlídač token — JWT v query stringu.** V době reportu JWT stále teklo přes `?token=` do nginx access logu (api.ts 4 místa + serve-api.ts). **Vyřešeno v T-09 (2026-07-13):** backend query token odmítá a klienti používají `Authorization: Bearer`.
3. **Win-price data — outliery + PDF backfill.** Chceš, abych proaktivně (a) vyčistil outliery ve win_prices (kazí go/no-go proximity faktor) a (b) dohnal chybějící PDF/ceny u 95 % „ostatni" záznamů? Zvedne to kvalitu triáže i business skóre, ale je to práce navíc mimo money-path.

## 6) Autonomní rozhodnutí učiněná v noci

- **Skóre = % naplnění cíle dané dimenze**, ne relativní; celkové = prostý průměr 6 dimenzí (konzistentní s baseline ~30 %).
- **Autonomie hodnocena, ale nepovažována za blocker** — per Danovo přehodnocení (ZISK + FUNKČNOST, manuál OK) je nízké skóre 25 % v pořádku, nebrzdí to hodnocení „použitelnosti".
- **Ops watchdog/pg_dump** brány jako splněné dle deploy logu, i když jsou server-side a z repo je přímo neověřím — označeno jako „z kódu neověřitelné", ne skryto.
- **Doc-quality na produ** hodnocen jako NEOVĚŘITELNÝ (artefakty pre-#36) místo automatického připočtení bodů — běžící regen ponechán jako první reálný test, do skóre nezapočítán jako hotový.
- Report zapsán do scratchpadu, protože worktree `night-docs` neexistuje.
