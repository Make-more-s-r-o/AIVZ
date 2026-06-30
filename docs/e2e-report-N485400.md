# E2E test + bug report — VZ N‑485400 „Nákup dílenského nářadí" (VÚ 4854 Pardubice)

**Datum:** 2026‑06‑30 · **Tester:** Claude Code (Opus 4.8, max effort) · **Zakázka:** Ministerstvo obrany / 14. pluk logistické podpory, Čj. MO 599034/2026‑4854, NEN N006/26/V000.
**Metoda:** (1) lokální pipeline `scripts/src/*` nad reálnými 4 soubory, (2) multi‑agent code‑audit (37 Opus agentů, 27 nálezů ověřeno adversariálně), (3) živá app `vz.ludone.cz` — *čeká na připojení Chrome rozšíření*.

---

## TL;DR — funguje to?

**Ne, end‑to‑end to pro tuto zakázku neprojde.** Pipeline doběhne bez pádu, ale tichým selháním vyrobí **neúplnou a vyloučitelnou nabídku**. Čtyři nezávislé blokující vady, každá sama o sobě zničí nabídku:

1. **Soupis (závazná cenová nabídka) se vůbec nevyplní** — detekce hlavičky končí na řádku 10, ale tabulka má hlavičku na řádku 22 → `soupis_filled_*.xlsx` nevznikne, všech 57 jednotkových cen prázdných.
2. **Všech 57 položek se zahodí** sektorovým filtrem (Haiku ≥20 položek; nářadí ∉ obory IT/AV, chybí guard proti vyprázdnění).
3. **Návrh kupní smlouvy (.doc) se nikdy nedostane do nabídky** — discovery odmítá `.doc`, převedený docx se maže, `kupni_smlouva` chybí ve fallbacích.
4. **Cenový strop „nesmí přesáhnout 39.999 Kč s DPH" se nikde neparsuje ani nevynucuje** → překročení = automatické vyloučení.

Pro tuto konkrétní zakázku je navíc **doménový nesoulad**: bidder default = Make more s.r.o. (IT/AV), zakázka = dílenské nářadí. To není bug nástroje, ale ukazuje, proč filtr v bodě 2 vyhladí celou nabídku.

---

## Co je zakázka (ground truth)

| Pole | Hodnota |
|---|---|
| Zadavatel | Ministerstvo obrany, IČO 60162694; útvar VÚ 4854 Pardubice |
| Předmět | Nákup dílenského nářadí — **57 položek**, NIPEZ/CPV 44512000‑2 (různé ruční nástroje) |
| Kritérium | **Nejnižší nabídková cena s DPH (100 %)** |
| Lhůta | **16. 7. 2026 07:00**, elektronicky přes NEN |
| Doba plnění | do 30 prac. dnů od účinnosti smlouvy; místo VÚ 4854, Pražská 100, Pardubice |
| Cenové stropy | položky č. 8, 12, 45, 49: **„cena za kus nesmí přesáhnout 39.999 Kč s DPH"** |
| Přílohy | č.1 Závazná cenová nabídka (vyplnit a vrátit), č.2 Návrh KS (doplnit, podepsat), č.3 spec. položky 8 |

---

## Výsledek po fázích (lokální běh)

| Fáze | Stav | Poznámka |
|---|---|---|
| extract | ✅ projde | 4/4 dokumenty; `.doc→.docx` lokálně OK (LibreOffice present). Drobnosti: `pageCount=null` u PDF; PR_03 text proložený mezerami (pdf‑parse). |
| analyze | ⏳ běží | _doplní se za běhu_ |
| match | ⏳ čeká | hypotéza: drop 57 položek (C2) |
| generate | ⏳ čeká | hypotéza: chybí soupis_filled.xlsx (C1) + kupni_smlouva (C4) |
| validate | ⏳ čeká | hypotéza: ready_to_submit ignoruje prázdný soupis / stropy |

---

## Nálezy (audit, 27× CONFIRMED — 21 unikátních defektů)

### 🔴 CRITICAL

**C1 — Soupis se vůbec nevyplní (detekce hlavičky končí na ř. 10).** `scripts/src/fill-soupis.ts:58` (stejně `parse-soupis.ts:~62`). Hlavička tabulky je na řádku 22, scanner jede jen 1–10 → guard vrátí `{filledRows:0}` *před* zápisem → `soupis_filled_*.xlsx` nevznikne, 57 cen prázdných. *Reprodukováno přímým spuštěním.* **Fix:** skenovat ~30+ řádků / poznat hlavičku podle cenových sloupců; opravit i parse‑soupis.

**C2 — Haiku sektorový filtr zahodí všech 57 položek.** `scripts/src/match-product.ts:246`. Pro ≥20 položek běží pre‑klasifikace; filtr nechá jen `it`/`av`, nářadí (`ostatni`/`nabytek`) se bezpodmínečně vyřadí — **chybí guard proti prázdnému výsledku** (na rozdíl od keyword větve ř. 271). **Fix:** filtrovat jen když výsledek neprázdný; domain mismatch = lidský go/no‑go, ne tichý drop.

**C3 — Cenový strop 39.999 Kč se NIKDE neparsuje ani nevynucuje.** `fill-soupis.ts:176` + `match-product.ts:524` + `template-engine.ts:1680` + `validate-bid.ts:20`. AI ho nezná, generátor i fill zapíšou cokoli, validace nekontroluje. **Fix:** parsovat per‑item cap, nést na položce, předat do promptu jako tvrdé omezení, deterministicky odmítnout/flagnout překročení, `ready_to_submit=false`.

**C4 — Návrh kupní smlouvy (.doc) se nikdy nevyplní ani nedostane do nabídky.** `template-engine.ts:1399` (discovery odmítá `.doc`) + `document-parser.ts:146` (převedený docx se maže) + `generate-bid.ts:278` (`kupni_smlouva` chybí ve `FALLBACK_TYPES`). **Fix:** konvertovat `.doc→.docx` před discovery a soubor nemazat; přidat `kupni_smlouva` do fallbacků; tvrdě selhat, když očekávaná smlouva chybí ve výstupu.

### 🟠 HIGH

- **H1** `document-parser.ts:137` — LibreOffice hledán jen na natvrdo macOS cestě → na Linux VPS (produkce) se `.doc` smlouva tiše přeskočí. **Fix:** seznam cest + `which soffice`/`SOFFICE_BIN`, netiše.
- **H2** `match-product.ts:391` — truncated‑JSON recovery tiše zahodí položky z batche (neporovná N vs `batchItems.length`). **Fix:** assert počtu, re‑run chybějících / menší batch.
- **H3** `match-product.ts:528` — auto‑confirm nastaví `marze_procent:0` + `potvrzeno:true` všem → obejde review gate, závazná break‑even nabídka z AI odhadu. **Fix:** default `potvrzeno:false`, firemní marže.
- **H4** `template-engine.ts:1679` — položka bez ceny se vykreslí jako závazných „0,00 Kč" a sečte do totálu. **Fix:** `price<=0` → marker/selhání.
- **H5** `doc-validator.ts:176` — vyplněný soupis `*.xlsx` se nikdy nevaliduje (validátor jen `*.docx`). **Fix:** číst `soupis_filled_*.xlsx`, ověřit cenu na každém řádku + počet 57.
- **H6** `validate-bid.ts:241` — `ready_to_submit` se bere z AI verbatim, deterministická field‑validace (`allPass`) se jen loguje. **Fix:** `ready = ready && allPass`.

### 🟡 MEDIUM

- **M1** `fill-soupis.ts:139` (+`parse-soupis.ts:95`) — richText názvy → `String()` = „[object Object]" → mrtvý fuzzy fallback + rozbitý audit log. **Fix:** `cell.text`.
- **M2** `fill-soupis.ts:151` — párování řádek↔cena jen podle pozice, `polozka_index` se nečte, fuzzy mrtvý (M1) → posun o řádek = misprice. **Fix:** klíč P.č. (sloupec A) + assert počtu.
- **M3** `template-engine.ts:1678` — jednotka natvrdo „ks" (sada/balení/metr se ztratí). **Fix:** nést `jednotka`.
- **M4** `template-engine.ts:557` — `mergeRunsInParagraphs` slije formátování celé smlouvy do prvního stylu. **Fix:** mergovat jen kolem placeholderu.
- **M5** `doc-validator.ts:91` — nekontroluje se ocenění jednotlivých řádků, jen 2 souhrnné totály. **Fix:** per‑item check > 0.
- **M6** `validate-bid.ts:177` — JSON recovery ve validaci zahodí kritické problémy, `ready_to_submit` přežije. **Fix:** recovery → `ready=false` + syntetický problém.

### 🟢 LOW

- **L1** `fill-soupis.ts:181` — `sharedFormula` buňky se přepíšou statickým číslem (guard jen `'formula' in v`).
- **L2** `document-parser.ts:146` — leak převedeného `.docx` při chybě parse (unlink jen po úspěchu, bez else).
- **L3** `template-engine.ts:1684` — per‑item vs total rounding (~0,28 Kč přes 57 řádků).
- **L4** `template-engine.ts:958` — O(n³) normalized strategy může zaseknout stage na dlouhém odstavci.
- **L5** `template-engine.ts:162` — `fillTemplate` bez try/catch; vadný `{{}}` tag → dokument tiše vypadne.

---

## Runtime potvrzení (lokální E2E)

_Doplňuje se podle reálných výstupů `output/n-485400-naradi/` — viz sekce níže._

---

## Živá app vz.ludone.cz

⛔ Zatím neproběhlo — Chrome rozšíření Claude není připojené. Po připojení se ověří totéž přes UI (upload 4 souborů, běh kroků, stažení dokumentů) a porovná se s lokálním během. Pozn.: produkce běží na Linux VPS, kde **H1 (LibreOffice cesta)** pravděpodobně způsobí, že `.doc` smlouva vypadne už při extractu (na rozdíl od lokálu, kde LibreOffice je).

---

## Pořadí oprav (priorita)

1. **C1 + C4 + H1** — bez nich vzniká neúplná nabídka (chybí soupis i smlouva). Blokující.
2. **C2 + C3 + H3** — jinak vyloučitelná/ztrátová závazná nabídka (drop položek / překročení stropu / 0 % marže bez review).
3. **H2 / H4 / H5 / H6 + M1 / M2** — pojistky proti tichému misprice a falešnému „připraveno k podání".
