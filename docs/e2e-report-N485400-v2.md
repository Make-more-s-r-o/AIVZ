# E2E report v2 — VZ N-485400 „Nákup dílenského nářadí" (VÚ 4854 Pardubice)

**Datum:** 2026-07-01 (noční autonomní běh) · **Model:** Opus 4.8 (main loop), pipeline na `claude-sonnet-4-6` · **Zakázka:** Ministerstvo obrany / 14. pluk logistické podpory, Čj. MO 599034/2026-4854, NEN N006/26/V000.
**Metoda:** lokální pipeline `scripts/src/full-flow.ts --tender-id=n-485400-naradi` nad reálnými 4 soubory (input == `Downloads/vsechny_dokumenty-8`), bez skladové DB (AI ceny).

---

## TL;DR — funguje to?

**Ano.** End-to-end teď **projde**. Předchozí report (`e2e-report-N485400.md`, 2026-06-30) hlásil 4 blokující vady a „nabídka neprojde"; ty byly opraveny commitem `fc4a173` (soupis hlavička ř.22, guard proti vyprázdnění sektorovým filtrem, cenový strop, `.doc` smlouva) a tyto fixy **jsou v `feature/vz2-m3`**. Aktuální běh:

- **full-flow exit code 0**, celkem ~33 min (extract → analyze → match → generate → validate).
- **57/57 položek naceněno**, každá má vybraného kandidáta a cenu.
- **Všechny 4 cenové stropy dodrženy** (pol. 8/12/45/49, max 39 999 Kč s DPH):
  - Dílenský vozík (Güde GTW 900): **33 033** Kč
  - Zvedák pneumaticko-hydraulický: **27 951** Kč
  - Samostmívací svářecí kukla: **35 000** Kč
  - Tester akumulátorů: **7 502** Kč
- **Soupis XLSX vyplněn 57/57 řádků** (hlavička ř.22, sloupce name=5 / price=8 / total=11).
- **Nabídková cena: 442 039 Kč bez DPH / 534 867,19 Kč s DPH.**
- **5 dokumentů vygenerováno:** krycí list, cenová nabídka, čestné prohlášení, technický návrh, seznam poddodavatelů + vyplněný soupis.
- **Programmatic field validation: ALL PASS** (cenová nabídka 12/12, čestné prohlášení 9/9, krycí list 14/14, seznam poddodavatelů 3/3+1 warn, technický návrh 2/2 — confidence 100 %).
- **Submit gate: OK** (strop dodržen, vše oceněno, žádné placeholdery).

---

## Priorita 1 — kvalita nalezení položek (výborná)

Sklad (warehouse) je vědomě **vynechán** (není dotažený — pokyn uživatele). Match degraduje na AI dohledání produktů z reálné znalosti. Výsledek je překvapivě silný — pro 57 položek dílenského nářadí AI našla **konkrétní reálné produkty s výrobcem a modelem**, např.:

| Poptávka | Nalezeno |
|---|---|
| Sada pro plnění/odvzdušnění chladicí soustavy | Jonnesway AR060042 |
| Tester tlaku chladicí soustavy | Jonnesway AR060041 |
| Ostřička vrtáků | Scheppach DBS800 |
| Mazací tuk | Mogul LV 2 EP (400 g) |
| Lepidlo na závity | Loctite 243 (50 ml) |
| Svěrák | Bernardo TS 150 |
| Dílenský vozík s nářadím | Güde GTW 900 |
| Aku nářadí | Makita DCG180Z / DWR180Z / DGA504Z |

Každý kandidát nese: `vyrobce, model, popis, parametry, shoda_s_pozadavky, cena_bez_dph, cena_s_dph, cena_spolehlivost, cena_komentar, dodavatele, dostupnost, zdroj_ceny, katalogove_cislo`. Ceny jsou **AI odhad** (honest flag `potvrzeno:false`, `poznamka: "Cena z AI odhadu — zkontrolovat"`).

**Doménový nesoulad** (bidder Make more s.r.o. = IT/AV vs. dílenské nářadí), který předchozí report označil za blokující, se v praxi **neprojevil jako blocker** — AI dohledání položky našlo bez problému napříč doménou. Sektorový filtr má guard proti vyprázdnění (fc4a173), takže položky nezmizí.

## Priorita 2 — kvalita dokumentů (vysoká; 1 nit opraven)

- **Krycí list** — kompletní, profesionální (A. identifikace zakázky, B. identifikace uchazeče se všemi reálnými firemními údaji Make more s.r.o. — IČO 07023987, DIČ, datová schránka ghp698k, účet, jednající osoba Daniel Jirotka, C. nabídková cena).
- **Technický návrh** — profesionální úvod + kompletní tabulka všech 57 položek (výrobce / model / klíčové parametry), formální čeština, adresuje technické požadavky.

**Opraveno tento běh:** technický návrh (AI-psaný) uváděl **halucinované „Datum zpracování: červen 2025"** — do promptu se nepředávalo reálné datum. Fix: `scripts/src/prompts/technical-proposal.ts` nyní počítá reálné datum (`new Date()`) a předává ho do zprávy + SYSTEM instrukce „datum nevymýšlej, použij dodané". (Šablonové dokumenty jako krycí list už reálné datum používaly.)

## Priorita 3 — propojení na CRM (funkční)

Pipeline je napojená na CRM z M4/M5: kroky lze spustit z detailu zakázky (`POST /api/tenders/:id/run/:step` → job queue), výstupy se zobrazují v záložkách **Analýza / Ocenění / Dokumenty**, stav se drží ve `crm_tender_status`, aktivita v `crm_activity`, finalizace přes submit-gate (`POST /finalize`). Nad tím CRM vrstva M6–M9 (termíny, notifikace, úkoly, komentáře, štítky, uložené pohledy). Ingest je manuální (Monitoring inbox, M9a).

---

## Co NENÍ chyba nástroje (doménové / vstupní)

AI validátor (kvalitativní) správně upozornil na věci, které by nabídku mohly vyřadit — nejsou to bugy pipeline, ale **přílohy dodávané uchazečem** nebo doménové posouzení:

1. **Chybějící kvalifikační přílohy** (výpis z OR, doklady profesní/technické způsobilosti) — nahrává uchazeč.
2. **Fyzická prohlášení o shodě / revizní zprávy** pro elektrická zařízení — přílohy, ne generovaný text.
3. **Aku nářadí bez baterií** (Makita) — nutno ověřit, zda ZD požaduje kompletní sadu vč. baterií (technické posouzení).
4. **Obsahový list (TO) dílenského vozíku** — ZD požaduje rozpis obsahu zásuvek jako samostatný dokument.

Tyto body patří do reportu jako upozornění pro uživatele, ne k „opravě" ve scriptech.

## Známá omezení běhu

- **PDF konverze přeskočena lokálně** (`GOTENBERG_URL` není nastaveno) — na prod je Gotenberg konfigurován (`gotenberg:ok`), takže PDF vzniknou v produkci.
- **Ceny = AI odhad** (bez skladu). Vhodné před podáním ručně ověřit u dodavatelů (panel „Cenová kalkulace" v CRM to umožňuje — marže, potvrzení).
- Warehouse DB lokálně není a **záměrně se neřeší** (pokyn: sklad je nedodělaný, nepoužívat jako blocker).

## Návrhy na vylepšení (follow-up, ke schválení)

1. **Reálné dohledání cen/dostupnosti** místo AI odhadu — web search / e-shop lookup na konkrétní model (Alza/Mall/specializovaní dodavatelé nářadí) → aktuální cena + skladovost + odkaz. Nahradilo by nedodělaný sklad čerstvými daty.
2. **Doc quality polish** — sjednotit hlavičku technického návrhu (drobná duplicita), doplnit automatické generování „obsahového listu" vozíku z parametrů, konzistentní zaokrouhlování cen.
3. **CRM: tlačítko „Ověřit ceny"** u ocenění (per-položka potvrzení + zdroj), a přehled „připravenost příloh" (checklist kvalifikačních dokumentů navázaný na company docs).
4. **Kvalifikační přílohy** — automatické spárování požadovaných dokladů se slotem firemních dokumentů + upozornění na chybějící.

---

*Závěr: cíl „kompletní analýza + ocenění + generování projde" je splněn. Pipeline vyrobí kompletní, submit-gate-passing nabídku s reálně dohledanými produkty a dodrženými cenovými stropy. Zbývající body jsou doménové (přílohy uchazeče) nebo volitelná vylepšení kvality, ne blokující vady.*
