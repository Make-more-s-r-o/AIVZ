# Ranní report VZ — noc 2026-07-11 → 12

## 1) TL;DR

Máš **master plán** (v2, po tvrdé oponentuře) a **šest nasazených PR**, z nichž dva zavírají díry, které by tě reálně stály peníze. Nejdůležitější věta noci:

> **Codexova oponentura našla, že tvůj vlastní invariant („lidská kontrola u položek, které jsou v nabídce") dnešní kód porušoval** — jedním klikem na „Potvrdit vše" šlo potvrdit desítky závazných cen, aniž je člověk viděl. Opraveno a živě ověřeno na produkci.

Skóre: **~60 % → ~66 %** (detail §5).

## 2) Master plán (docs/plan/, 2 055 řádků)

Napsaly Fable agenti, pak ho **Codex adversariálně oponoval a REJECTNUL** (14 nálezů: 2 critical, 6 high, 6 medium). Nálezy jsou zapracované, syrová oponentura zůstává v `99-oponentura-codex.md` kvůli auditní stopě.

| Dokument | Co v něm je |
|---|---|
| `00-README.md` | Exec shrnutí, **tvá rozhodnutí**, „TEĎ HNED" (5 kroků), changelog v1→v2 |
| `01-business-model.md` | Trh, hodnota, konkurence, příjmový model, GTM, rizika |
| `02-roadmapa.md` | Fáze F0–F5 k autonomní mašině, měřitelná výstupní kritéria |
| `03-implementacni-plan.md` | Vlny A–F, tasky s ID, konkrétní soubory, akceptační kritéria, money-path značky |
| `99-oponentura-codex.md` | Oponentura (verdikt REJECT, 14 nálezů) |

**Co oponentura změnila (nejpodstatnější):**
- **Primární business obrácen**: ne vlastní obchodování („kupujeme a dodáváme"), ale **placený asistovaný bid service** (managed service). Vlastní obchodování jen jako experiment s **tvrdým stropem kapitálové expozice** — jinak si přibereš financování zásob, logistiku, reklamace a záruky, které dnešní ekonomika nezná.
- **Single-bidder opraven na 40 %** (EU Single Market Scoreboard 2024; plán tvrdil ~48 %) a „adresovatelný trh = 40–45 tis. nabídek" vyhozen jako neopodstatněný — nahrazen postupem, jak spočítat bottom-up SAM.
- **Fáze 1 přejmenována** z „První vyhraná koruna" na **„První bezvadně podaná nabídka"** — výhra, kladná marže a inkaso jsou tři samostatné milníky (šlo je totiž „splnit" bez jediné výhry).
- **Kill-switch a právní práce předsunuty** dopředu (kill-switch už nasazen, viz níže).

## 3) Nasazeno v noci (PR #62–#68)

1. **#63 — Invariant lidské kontroly (nejdůležitější).** Každá potvrzená cena nese serverovou auditní stopu (kdo/kdy z JWT — **klientem podvržená identita je ignorována**, ověřeno útokem). Bulk potvrdí jen položky s explicitní attestací; checkbox „Zkontrolováno" se odemkne až po rozbalení řádku (operátor musí vidět specifikaci, produkt, nákup, zdroj, marži). Změna produktu nebo ceny potvrzení **ruší**.
2. **#65 — Governance kill-switch.** Přepínače (ingest / AI joby / generování / finalizace / podání) + **denní strop AI nákladů (2 000 Kč)**. Guardy vrací 503, chip „Provoz omezen" v hlavičce, audit kdo/kdy.
3. **#66 — Hard gate na kvalifikační doklady.** Chybějící doklad = formální vyřazení nabídky. Dosud jen varování. Živě ověřeno: finalize pilotu **blokován** („Chybí povinný kvalifikační doklad: Výpis z OR, Profesní oprávnění"). Auditovaná per-slot výjimka existuje, ale nikdy neobejde cenové gaty.
4. **#62 — „Použít reálné ceny".** Hromadně předvyplní nákup z ověřených zdrojů (respektuje balení a minimální odběr) — ale `potvrzeno` zůstává **vždy false**. Navíc se po ověření přepočítají sanity flagy, takže ztrátovou cenu vidíš **předem**, ne až jako 409.
5. **#68 — Bid snapshot při finalize.** Migrace 018: v okamžiku přípravy balíku se uloží, **jak nabídka vypadala** (cena, nákup, marže, skóre, win-price pásmo, podíl ověřených cen, flagy, AI náklad) + hash v manifestu. Bez toho by se nástroj nikdy nenaučil — výsledek by neměl s čím spárovat.
6. **#67 — Plán v2** (viz §2).

## 4) Pilot: [Nákup drobného nářadí](https://vz.ludone.cz/#/tender/nakup-drobneho-naradi-podzim?tab=oceneni)

Ministerstvo obrany, lhůta **16. 7. 9:00**, 14 položek. Po dobití kreditu doběhlo ověření cen:

- **13/14 položek má reálnou nákupní cenu** (dřív 1/14) — 9 ověřených + 4 orientační.
- **Reálný nákup je o 70 % vyšší než AI odhad** (průměr; extrém: míchací kelímek AI 15 Kč vs. reálně 40,50 Kč = +170 %).
- **Gate to chytá**: pokus o potvrzení ceny pod nákupem vrátil 409 se jménem zdroje (BAUHAUS).
- **Finalize je blokovaný** kvůli chybějícím kvalifikačním dokladům firmy.

**Co musíš udělat ty, aby pilot šel podat:** (a) nahrát kvalifikační doklady firmy (výpis z OR, profesní oprávnění) s platností, (b) projít 14 položek, u každé odškrtnout „Zkontrolováno" a potvrdit cenu (doporučuji nejdřív kliknout „Použít reálné ceny").

## 5) Skóre: ~60 % → **~66 %**

| Dimenze | Před | Teď | Proč |
|---|---|---|---|
| Průchodnost | 68 | 68 | beze změny |
| Kvalita | 68 | 76 | verify 13/14, loss gate viditelný předem, kvalifikační gate |
| UX | 60 | 63 | per-item kontrola, „Použít reálné ceny", governance UI |
| Provoz | 50 | 62 | kill-switch, denní strop AI, opravený credit watchdog |
| Business | 46 | 52 | bid snapshot (odblokovaná kalibrace), plán v2 s obráceným modelem |
| Autonomie | 40 | 42 | governance jako předpoklad bezpečné autonomie |

## 6) Autonomní rozhodnutí této noci

1. **Invariant lidské kontroly jsem povýšil na tvrdý** (loss gate = HARD blok, ne varování; bulk bez attestace nepotvrdí nic) — vyplývá z tvé věty „musíme tomu věřit".
2. **Plánovací agenti = Fable, implementace = Codex Sol** dle tvého pokynu; oponentura plánu i kódu vždy Codex.
3. Testovací potvrzení ceny na pilotu jsem **vrátil zpět** — nechci ti do money-path zanést cenu potvrzenou strojem.
4. Smazal jsem Playwright a Spotify cache (disk byl podruhé plný, 100 %) — obojí se regeneruje. **Disk je stále úzké hrdlo, ukliď ho.**
5. Kredit dobitý → ověřovací běhy stály ~130 Kč; denní strop nastaven na 2 000 Kč.

## 7) Co dál (z plánu, §00-README „TEĎ HNED")

Kód už není hlavní brzda — brzdou jsi teď **ty**:
1. **A-00 Připravenost entity** — rozhodnout managed service vs. dealer experiment; kvalifikace, registrace dodavatele na NEN, sourcing, strop kapitálové expozice.
2. **Kvalifikační doklady firmy** — bez nich neprojde žádné podání.
3. **Placené concierge validace** — 2–3 externí dodavatelé, měřit ochotu platit.
4. Právní konzultace (odpovědnost, NEN účet/zmocnění) — nejdelší latence, zadat brzy.
5. Podat pilot ručně dle runbooku → první reálný výsledek → kalibrace (snapshot už se ukládá).
