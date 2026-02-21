# Bugs & TODOs — VZ AI Tool Pipeline

*Aktualizováno: 2026-02-21*

---

## HOTOVO (opraveno v této session)

### ✅ Template detection — chybné vzory
- **Problém:** `TEMPLATE_PATTERNS` používaly mezery a diakritiku, ale soubory mají podtržítka a ASCII
  - `"kryci list"` neodpovídal `"Kryci_list_nabidky-2.xlsx"`
- **Oprava:** normalizace v `isTemplate()` — replace `_` → mezera + strip diakritika přes `NFD`
- **Soubor:** `scripts/src/lib/document-parser.ts`

### ✅ Multi-part tender schema — předpokládaná hodnota
- **Problém:** AI vrátil `predpokladana_hodnota` jako objekt `{castA: X, castB: Y, mena: "CZK"}` místo čísla → ZodError
- **Oprava:** `z.preprocess` sečte číselné hodnoty z objektu, ignoruje string klíče
- **Soubor:** `scripts/src/lib/types.ts`

### ✅ AI retry resilience
- **Problém:** 2 retries s exponenciálním delay 1s/2s nestačilo pro API overload (529) nebo flaky network
- **Oprava:** zvýšeno na 4 retries, delay `min(2^attempt * 2000, 30000)` = 2s/4s/8s/16s
- **Soubor:** `scripts/src/lib/ai-client.ts`

---

## OTEVŘENÉ BUGY

### 🐛 BUG-01: Soupis-based zakázky — match timeout
- **Popis:** Zakázky s XLSX soupisy vybavení (Bill of Quantities) mají stovky položek. Analyze je sloučí do 3 abstraktních kategorií (Část A/B/C) místo extrakce jednotlivých řádků.
- **Dopad:** match-product.ts dostane 3 velké "položky" místo konkrétních produktů → match timeout nebo nesmyslné výsledky
- **Příklad:** `varyte-vybaveni` — 87 položek Část B, 127 položek Část C
- **Potřeba:**
  1. Nový `parse-soupis.ts` script — čte XLSX soupis a extrahuje seznam `{nazev, spec, mnozstvi, jednotka}` pro každý řádek
  2. `analyze-tender.ts` musí detekovat soupis soubory (isTemplate=false ale typ="soupis") a předat je jako položky místo souhrnu
  3. Batch matching — 200+ položek se musí zpracovat po dávkách (max ~20 najednou)
  4. Filter by category — IT firma by měla matchovat jen technologické položky, ne nábytek/nářadí

### 🐛 BUG-02: spawnSync ETIMEDOUT v serve-api.ts
- **Popis:** Při spuštění pipeline přes API (HTTP) dochází k timeoutu `spawnSync` dříve než projde AI volání
- **Příčina:** Při souběžném spuštění dvou AI kroků (pro 2 různé zakázky) se API volání navzájem zdržují kvůli rate limitům Anthropic
- **Dopad:** analyze/match selhávají s `ETIMEDOUT` i přes 10min SDK timeout
- **Workaround:** spouštět skripty přímo (ne přes HTTP API), nebo sekvenčně
- **Potřeba:**
  - Queue system — API zařadí kroky do fronty místo parallel spuštění
  - Nebo: async job system — POST vrátí job ID, klient polluje výsledek

### 🐛 BUG-03: kancelarsky-material analyze — persistentní ETIMEDOUT
- **Popis:** `kancelarsky-material` analyze opakovaně selhává s `ETIMEDOUT` i po vícero pokusech
- **Příčina:** neznámá — 50KB text, Anthropic API flaky v daný čas, nebo velký XLSX (cenová nabídka se stovkami řádků)
- **Workaround:** opakovat pokus

### 🐛 BUG-04: servery-hostinne — chybí generované dokumenty
- **Popis:** Generate vytvořil jen `cenova_nabidka.docx` a `technicky_navrh.docx`. Chybí: `cestne_prohlaseni.docx`, `seznam_poddodavatelu.docx`
- **Příčina:** Input folder neobsahuje template soubory (žádný "kryci list" ani "cestne prohlaseni") → generate nemá co vyplnit
- **Dopad:** Validation score 3/10 — chybí klíčové dokumenty
- **Potřeba:** Fallback — pokud tender nemá template, vygenerovat AI-based čestné prohlášení ze šablony v `templates/` adresáři projektu

### 🐛 BUG-05: Automatické potvrzení cen chybí
- **Popis:** Generate vyžaduje `cenova_uprava.potvrzeno = true` pro každou položku, ale match ho nenastavuje automaticky
- **Dopad:** Uživatel musí ručně potvrdit každou položku přes PUT endpoint nebo UI — brzdí testování
- **Řešení:** Přidat příznak `AUTO_CONFIRM_PRICES=true` v .env nebo parametr v API — match step automaticky nastaví `potvrzeno: true` s AI-recommended cenou

### 🐛 BUG-06: Množství v soupisu chybí
- **Popis:** Při extrakci soupisu XLSX se množství `[x]` načítá jako "x" místo číselné hodnoty
  - `[x] Držák na mikrofon` — množství neznámé
  - `[1x] Plátno` — množství 1 (správně)
- **Příčina:** Buňka množství v XLSX obsahuje vzorec `[object Object]` — ExcelJS nerozvinul vzorec
- **Potřeba:** Použít XLSX.js místo ExcelJS pro buňky se vzorci

---

## ARCHITEKTURÁLNÍ TODO

### 🏗️ TODO-01: Soupis XLSX parser
- Nový script: `scripts/src/parse-soupis.ts`
- Input: XLSX soupis soubor
- Output: `{polozky: [{nazev, specifikace, mnozstvi, jednotka, kategorie}]}`
- Kategorie: `nabytek | nastroj | it | av | elektro | ostatni`
- IT firma matchuje pouze: `it | av | elektro`

### 🏗️ TODO-02: Batch product matching
- Aktuální limit: ~10 položek najednou (token limit)
- Potřeba: rozdělit velké soupisy do dávek, sloučit výsledky
- Implementace v `match-product.ts` — detekuje pokud items > 15 → dávkuje

### 🏗️ TODO-03: Async job queue pro API
- Aktuální: `execSync` blokuje Node.js event loop
- Potřeba: `child_process.spawn` + job store (JSON file nebo Redis)
- Endpoint: `POST /api/tenders/:id/run/:step` → `{jobId: "..."}`
- Endpoint: `GET /api/jobs/:jobId` → `{status, progress, logs}`

### 🏗️ TODO-04: Global templates fallback
- Pokud tender nemá template soubory v `input/:id/`, použít globální šablony z `templates/`
- Šablony: `kryci_list.docx`, `cestne_prohlaseni.docx`, `seznam_poddodavatelu.docx`
- Doplnit AI-powered filling pro globální šablony

### 🏗️ TODO-05: .doc → .docx konverze
- Soubory `.doc` jsou přeskočeny parserem
- `kancelarsky-material` má `.doc` soubory
- Potřeba: auto-konverze přes LibreOffice při extrakci
- LibreOffice je nainstalováno: `/Applications/LibreOffice.app/Contents/MacOS/soffice --convert-to docx`

---

## VÝSLEDKY TESTOVÁNÍ (session 2026-02-21)

| Zakázka | Typ | Items | Pipeline | Skóre | Poznámky |
|---------|-----|-------|----------|-------|----------|
| 3d-tiskarna | 1 produkt | 4 | ✅ kompletní | 4/10 | Z minulé session |
| test3-projektor | 1 produkt | 1 | ✅ kompletní | 4/10 | Z minulé session |
| fm-it-2025 (VPS) | multi-IT | 6 | ✅ kompletní | 4/10 | Z minulé session |
| vakuovy-lis | 1 produkt | 1 | ✅ kompletní | **6/10** | Mayku Multiplier |
| vlaknovy-laser | 1 produkt | 1 | ✅ kompletní | **5/10** | Cloudray 50W |
| servery-hostinne | multi-IT | 2 | ✅ kompletní | 3/10 | Chybí templates v inputu |
| kancelarsky-material | soupis | ? | ❌ analyze fails | - | API timeout |
| varyte-vybaveni | 3-dílný soupis | 200+ | ❌ match timeout | - | Potřeba batch matching |

### Co funguje dobře:
- Jednoduchá 1-produktová zakázka (vakuovy-lis, vlaknovy-laser) → score 5-6/10
- Multi-produkt s explicitním seznamem (servery-hostinne) → funguje ale potřeba templates
- Template detection po opravě → správně rozpoznává všechny varianty názvů

### Co nefunguje:
- Soupis-based zakázky (varyte-vybaveni) → potřeba nový parser + batch matching
- Souběžná AI volání → ETIMEDOUT, nutná fronta
- .doc soubory → přeskočeny, nutná konverze
