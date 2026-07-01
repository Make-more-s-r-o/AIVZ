# Zadání: VZ CRM — kompletní systém pro řízení nabídek do veřejných zakázek

> **Pro AI agenta (Claude Code / Claude.ai / Lovable):** Tento brief předáváš společně s odkazem na GitHub repozitář. **Repozitář je zdroj pravdy o aktuálním stavu aplikace** — stav v něm má přednost před popisem v tomto dokumentu, pokud se liší. Stav, který popisuji, je orientační; než cokoli změníš, repo si přečti a ověř. **Stavíš NA existující aplikaci, nepřepisuješ ji od nuly.** Drž stávající stack (React + TypeScript + Vite + Tailwind + shadcn/ui) a nesahej destruktivně na datovou/Supabase vrstvu. Iteruj na existujících komponentách.

---

## 1. GOAL & CONTEXT

Evolve this existing app into a **complete CRM for tracking the lifecycle and status of every public-tender bid (nabídka) the firm creates** — from the moment a tender is discovered, through analysis, pricing and document generation, to submission and the final won/lost outcome. The linked repository is the current state of the product; you build on top of it.

**Who uses it:** a small/mid-size Czech IT (+AV) firm that bids into Czech public tenders (veřejné zakázky). Today it has no capacity for manual bid preparation (40–80 h per tender). It needs one shared workspace where 2–6 people can see every live tender, who owns it, what stage it is in, what is due when, and whether the firm is winning or losing.

**What the app already does (build on it, do not replace):** it is an AI tool for Czech veřejné zakázky that (1) monitors and imports new tenders, (2) AI-analyzes the zadávací dokumentace (ZD) and produces a GO/NOGO/ZVÁŽIT recommendation, (3) prices the tender's line items against an internal price warehouse (cenový sklad) with match confidence and margin, and (4) generates the bid documents (krycí list, technický návrh, čestné prohlášení, seznam poddodavatelů, cenová nabídka). It also already has a price-warehouse module (catalog, import wizard, scraping, sources) and basic settings (firmy, uživatelé, heslo).

**The gap this brief closes:** today the app is a per-tender pipeline tool with file-based state and a thin nav. It is **not** a CRM — there is no portfolio view across all tenders, no manageable status pipeline, no deadlines/reminders, no tasks, no roles, no assignees, no activity history, no comments, no saved views, and no reporting on win-rate or pipeline value. **This brief turns it into that CRM** while preserving the existing pipeline and warehouse as features inside it.

---

## 2. CORE CONCEPT — pipeline, state machine a datový model

### 2.1 The lifecycle (canonical stages)

Every **zakázka** (tender — or each of its **části**, see 2.4) moves through one canonical lifecycle. The `status` field is the **one source of truth** for the CRM. Czech labels are the UI status names:

1. **Nová** (Monitoring) — discovered, not yet triaged.
2. **Relevantní** — passed filters + AI triáž, has a relevance score.
3. **Analyzovaná** (Analýza ZD) — AI analysis done; carries GO/NOGO/ZVÁŽIT.
4. **Oceněná** (Ocenění) — line items matched and priced from the cenový sklad.
5. **Připravená** (Příprava nabídky) — bid documents generated, checked, quality-scored.
6. **Odeslaná** (Podáno) — bid submitted to the contracting authority.
7. **Vyhodnocená** (Vyhodnocení) — authority is evaluating; awaiting result.
8. **Vyhráno** — terminal: won.
9. **Prohráno** — terminal: lost.
10. **Nepodáno / Zrušeno** — terminal: decided not to bid, or řízení canceled.

> Keep the existing 5-step processing pipeline (Extrakce → Analýza → Ocenění → Generování → Validace) as the **engine** that drives stage transitions inside a tender; map Extrakce+Analýza→Analyzovaná, Ocenění→Oceněná, Generování+Validace→Připravená. The lifecycle status is the business state shown across the CRM; the processing steps are the per-tender mechanics.

### 2.2 State machine — povolené přechody a předpoklady (závazné)

The drag-on-kanban and the **„Změnit stav"** dropdown share **one** transition engine. Rules:

- **Forward** by one stage when the **target precondition** holds. Forward skip is allowed only if the target precondition (which subsumes the intermediate ones) holds.
- **Backward** to any earlier non-terminal stage is allowed without precondition (oprava); it writes an aktivita.
- **Nepodáno / Zrušeno** is reachable from any non-terminal stage, requires a **důvod**.
- **Terminal stages** (Vyhráno / Prohráno / Nepodáno / Zrušeno) cannot be left except via explicit **„Znovu otevřít"** (RBAC: Manažer+).

**Preconditions to ENTER a stage:**
- **Relevantní:** relevance_score exists (triáž proběhla).
- **Analyzovaná:** an `analyzy` record with a doporučení (GO/NOGO/ZVÁŽIT) exists.
- **Oceněná:** all required `cenove_polozky` are `Ověřeno` or `Schváleno` and a cenová kalkulace exists.
- **Připravená:** a `nabidky` record ≥ `Koncept` exists and compliance_score is computed.
- **Odeslaná:** a `nabidky` record is `Finální` **and** „Připraveno k podání = Ano"; **requires explicit confirmation**.
- **Vyhodnocená:** tender is `Odeslaná`.
- **Vyhráno / Prohráno:** tender is `Odeslaná` or `Vyhodnocená` and a `vysledek` is set.

Illegal transition → guard toast **„Tuto změnu stavu nelze provést — {důvod}."** (e.g. důvod „chybí finální nabídka připravená k podání"), card snaps back, **no** aktivita written. A legal transition writes **exactly one** aktivita (autor + old→new + timestamp).

### 2.3 Sub-statuses (separate badge sets — never mixed with the lifecycle status)
- **Rozhodnutí (gate):** `GO` / `NOGO` / `ZVÁŽIT`.
- **Stav cenové položky:** `AI návrh` → `Ověřeno` → `Schváleno`.
- **Stav nabídky (dokumentu):** `Koncept` → `Revize` → `Finální` → `Odeslaná`.
- **Spolehlivost ceny:** `Vysoká` / `Střední` / `Nízká`.
- **Kontrola kvality položky:** `Prošlo` / `Varování` / `Neprošlo`.
- **Připraveno k podání:** `Ano` / `Ne`.

### 2.4 Vícečásťové zakázky (části) — first-class

In Czech VZ a bidder bids on, and wins/loses, **individual části independently**. Model `casti[]` as **child records** (`casti` table), each with its **own** lifecycle and outcome: `zakazka_id`, `cislo_casti`, `nazev`, `predpokladana_hodnota`, `lhuta_nabidek`, `status`, `rozhodnuti`, `assignee`, `vysledek` (vyhrali|prohrali|zruseno), `vysledek_poznamky`, `tenant_id`, `user_id`. A single-part tender has exactly one implicit část. The parent `zakazky.status` is a **roll-up** (parent is terminal only when all parts are terminal; otherwise it shows the least-advanced active part). **Reporting (win-rate, pipeline value, funnel) aggregates over the bid unit = the část, not the parent.** Item pricing groups by `cast_id` (already required in §3c).

### 2.5 Vážená hodnota — default pravděpodobnosti fází (konfigurovatelné v Nastavení)

`vážená hodnota = predpokladana_hodnota × pravděpodobnost fáze`. Defaults:

| Fáze | Pravd. | Fáze | Pravd. |
|---|---|---|---|
| Nová | 5 % | Odeslaná | 60 % |
| Relevantní | 10 % | Vyhodnocená | 70 % |
| Analyzovaná | 20 % | Vyhráno | 100 % |
| Oceněná | 35 % | Prohráno | 0 % |
| Připravená | 50 % | Nepodáno / Zrušeno | vyloučeno z pipeline |

These are editable in **Nastavení → Pipeline**. Open pipeline value sums non-terminal parts; weighted value uses the table above.

### 2.6 Role a oprávnění (RBAC) — závazné

Shared workspace → real per-action gating. Four roles (uložené u uživatele, výchozí `Zpracovatel`):

- **Administrátor** — vše: uživatelé a role, firmy, smazání zakázky/komentáře, všechny akce níže.
- **Manažer** — řídí zakázky: posun do **Odeslaná** / „Podáno", schválení ceny (`Ověřeno → Schváleno`), „Znovu otevřít" terminální fázi, přiřazování, editace firmy/IČO/DOC_SLOTS.
- **Zpracovatel** — pracuje na přiřazených zakázkách: analýza, ocenění (max `Ověřeno`), generování dokumentů, komentáře, úkoly, běžné posuny stavu mimo Odeslaná.
- **Pozorovatel** — read-only + komentáře.

Gated actions invisible/disabled in UI per role; the API enforces the same (don't gate in UI only). Mapping: běžný posun stavu = Zpracovatel+; Odeslaná / Schválit cenu / Znovu otevřít / editace firmy = Manažer+; uživatelé a role + smazání zakázky + smazání cizího komentáře = Administrátor (vlastní komentář smaže autor).

### 2.7 Data model (entities)

Build on the model already in the repo (`docs/technicka-implementace-v2.md`, `scripts/src/lib/types.ts`, `scripts/migrations/001_warehouse_schema.sql`). Existing core entities:

- **Zakázka** (`zakazky`) — `external_id`, `zdroj`, `nazev`, `zadavatel_nazev`/`zadavatel_ico`, `cpv_kody[]`, `predpokladana_hodnota`, `typ_zakazky`, `typ_rizeni`, `region`, `lhuta_nabidek`, `url_profil`/`url_dokumentace`, `relevance_score`, `ai_tags[]`, `ai_summary`, `status`, `rozhodnuti`, `assignee`, `tenant_id`, `user_id`, `created_at`, `updated_at` (+ children `casti`, viz 2.4).
- **Analýza** (`analyzy`) — `kvalifikacni_pozadavky`, `hodnotici_kriteria`, `terminy`, `technicke_pozadavky`, `polozky`, `rizika`, `doporuceni` (GO/NOGO/ZVÁŽIT + odůvodnění + klíčové body), `ai_model`, `ai_cost_czk`, `raw_ai_response` (audit, versioned).
- **Cenová položka** (`cenove_polozky`) — `nazev_polozky`, `mnozstvi`, `jednotka`, `produkt_id`, `match_confidence`, `match_score`, `nakupni_cena`, `jednotkova_cena`, `marze_procent`, `cena_spolehlivost`, `status`, `cast_id`.
- **Produkt / cenový sklad** (`products`, `product_prices_current`/`_history`, `product_suppliers`, `product_categories`, `data_sources`, `scrape_jobs`) — **already implemented — reuse it.**
- **Nabídka / dokumenty** (`nabidky`) — `celkova_cena(_dph)`, `technicky_navrh`, `metodika`, `kryci_list`, `compliance_check[]`, `compliance_score`, `dokumenty_paths[]`, `status`, `odeslana_at`, `vysledek`, `vysledek_poznamky`.
- **Firma / tenant** (`companies`) — `nazev`, `ico`, `dic`, `sidlo`, `iban`, `datova_schranka`, `jednajici_osoba`, `keyword_filters`, DOC_SLOTS. Multi-tenant anchor.
- **Člen týmu** — reuse existing user management; add `role` (viz 2.6) and `assignee` references.
- **Monitorovací filtr** (`monitoring_filtry`) — saved filter driving monitoring + triage + notifications.

**Nové entity, které musíš přidat** (today only implicit via `updated_at` / free-text — make them first-class; **timestamped Supabase migrations**, `tenant_id` + `user_id`, RLS, indexes on RLS-referenced columns; **never** hack file state):

1. **`casti`** — viz 2.4.
2. **`ukoly`** — `zakazka_id`, `cast_id?`, `nazev`, `popis`, `assignee`, `due_date`, `stav` (`K vyřízení`/`Probíhá`/`Hotovo`/`Blokováno`), `priorita`, `je_checklist` flag.
3. **`aktivity`** — append-only audit: `zakazka_id`, `cast_id?`, `typ` (status_change, assignment, comment, document, price_approval, deadline_edit, file_upload…), `autor_id`, `payload` (jsonb, incl. old→new), `created_at`.
4. **`komentare`** — `zakazka_id`, `autor_id`, `text`, `created_at`, `parent_id?` (vlákno), `mentions[]` (user IDs).
5. **`terminy`** — `zakazka_id`/`cast_id`, `typ` (lhůta nabídek / otevírání obálek / doba plnění / prohlídka místa / vlastní), `datum`, `pripominka_at[]`, `popis`. Derived from `analyzy.terminy` + `lhuta_nabidek` + user reminders.
6. **`ulozene_pohledy`** (saved views) — `user_id`, `nazev`, `definice` (jsonb: filtry + řazení + sloupce), `je_sdileny` (bool), `poradi`.
7. **`stitky`** + join **`zakazka_stitky`** — `stitky`: `nazev`, `barva`, `tenant_id`; join: `zakazka_id`, `stitek_id`. Drives the bulk action **„Přidat štítek"**.
8. **`notifikace`** — `user_id` (příjemce), `typ`, `text` (rendered Czech), `url` (deep link), `zakazka_id?`/`ukol_id?`/`komentar_id?`, `autor_id`, `precteno` (bool), `precteno_at`, `created_at`. **Dedup:** suppress duplicate **unread** rows for the same `(user_id, typ, entita)` within a short window (collapse rapid repeats); unread count = `precteno = false`.

> Multi-tenant rule from the repo stays for **all** eight new tables: `tenant_id` + `user_id`, RLS on every table, indexes on RLS-referenced columns, `(SELECT …)` wrapper on RLS subqueries.

---

## 3. FUNCTIONAL SPECIFICATION (the heart of the brief)

For each feature: what the user **can do**, what data **shows**, and **„Hotovo když"** (acceptance criteria for PR review).

### (a) Monitoring / import zakázek z více zdrojů
A **„Monitoring"** screen aggregating tenders from **TenderArena, NEN, Vhodné uveřejnění, e-zakazky.cz, Hlídač státu** (model directly on poptavky.naseit.cz — viz §6).
- **Zdroje (badges):** each tender shows `zdroj` as a chip (`Hlídač státu`, `NEN`, `TenderArena`, `Vhodné uveřejnění`, `e-zakázky`, `Ruční`).
- **Deduplikace:** dedup by `external_id` / IČO+název+lhůta; merge into one record listing both source links + marker **„Sloučeno z N zdrojů"**.
- **Relevance scoring:** AI triáž (relevance_score 0–100) + `ai_tags` + `ai_summary`; color the score (high = accent, low = muted); sort/filter by score.
- **Akce:** **„Zařadit do pipeline"** (Nová → Relevantní → start analýza), **„Skrýt / Nezájem"** (→ Nepodáno + reason), **„Ruční import"** (paste tender URL or upload ZD — keep the existing upload dropzone as this entry point).
- **Řádek:** název, zadavatel, CPV, předpokládaná hodnota, lhůta nabídek (relativně, **„za 9 dní"**), region, zdroj(e), relevance score, ai_tags.
- **Stavy:** loading = skeleton rows; empty = **„Žádné nové zakázky. Monitoring poběží automaticky."** + CTA „Ruční import"; error = **„Zdroj se nepodařilo načíst"** + retry, **plus per-source error chips so one failing source doesn't blank the screen.**
- **Hotovo když:** (1) duplicitní zakázka ze dvou zdrojů je jeden záznam s markerem „Sloučeno z N zdrojů"; (2) selhání jednoho zdroje neshodí obrazovku, ostatní se načtou; (3) každá akce mění status a zapisuje aktivitu.

### (b) AI analýza ZD
Keep the existing flow and `AnalysisView`. User opens a tender, clicks **„Analyzovat"** (or auto-runs at relevance > 80); the **Analýza** tab shows **GO / NOGO / ZVÁŽIT** pill + odůvodnění, zadavatel, předmět, kvalifikační požadavky, hodnotící kritéria (s váhami), technické požadavky (table), položky, termíny, rizika (se závažností), `ai_model`, `ai_cost_czk`.
- **Hotovo když:** (1) re-run versions, nepřepíše původní (`raw_ai_response` zachován); (2) tab ukazuje ai_model + ai_cost_czk; (3) chyba ukáže, který krok selhal, s retry jen na tom kroku.

### (c) Ocenění z cenového skladu
Keep `ProductMatchView` + `ItemPriceCalculator`. For each ZD item: top candidates with **match confidence** (`exact`/`similar`/`ai_estimate`/`manual`) + **match_score**, nákupní cena, navržená jednotková cena, **marže** (slider), DPH auto-calc, **spolehlivost ceny** (`Vysoká`/`Střední`/`Nízká`). Running **cenová kalkulace** (bez/s DPH, vážená marže) vs `predpokladana_hodnota` (over/under indicator).
- **Hotovo když:** (1) lze vyměnit produkt, přepsat cenu/marži a posunout `AI návrh → Ověřeno → Schváleno` (Schváleno jen Manažer+); (2) kalkulace se přepočítává živě a porovnává s rozpočtem; (3) položky vícečásťové zakázky jsou seskupené dle `cast_id`.

### (d) Generování nabídkových dokumentů
Keep `DocumentList` + deterministic builders + validation. **Dokumenty** tab lists DOCX/PDF (krycí list, technický návrh, metodika, čestné prohlášení, seznam poddodavatelů, cenová nabídka) with: document `status`, `compliance_score`, **„Checklist požadavků"** (požadavek / splněno / komentář), **„Připraveno k podání: Ano/Ne"** from validation `overall_score`. Akce: **„Vygenerovat"**, **„Přegenerovat"**, **„Stáhnout ZIP"**, upload qualification docs into DOC_SLOTS with missing/present manifest. **„Podáno"** sets `nabidky.status = odeslaná`, `odeslana_at`, fáze → Odeslaná (přes guardy).
- **Hotovo když:** (1) tab vypíše dokumenty se stavem + compliance_score + checklistem; (2) „Připraveno k podání" vychází z validačního skóre; (3) „Podáno" projde state-machine guardem a zapíše aktivitu.

### (e) Pipeline tracking (Kanban)
A **Kanban** of tenders (or částí) by lifecycle stage; drag a card between columns to change `status` (state machine §2.2). Detail header has a **stage stepper** + **„Změnit stav"** dropdown.
- **Hotovo když:** (1) legální drag zapíše **právě jednu** aktivitu (autor + old→new); (2) ilegální drag vrátí kartu zpět, **nezapíše** aktivitu, ukáže guard toast; (3) hromadná akce **„Změnit stav"** ctí **stejné** guardy jako kanban.

### (f) Termíny / lhůty + připomínky
Sources: `lhuta_nabidek` + `analyzy.terminy` + user reminders (`terminy` table).
- **Countdown:** relativní čas (**„za 3 dny"**, **„zítra"**, **„dnes"**, **„po termínu"**), sémantická barva (≤3 dny = warning, po = danger).
- **Připomínky:** configurable (7/3/1 den před lhůtou) → notifikace.
- **Kalendář/Lhůty** screen + dashboard widget **„Blížící se lhůty"**. Respect `monitoring_filtry.min_dnu_do_lhuty` — flag tenders with too little time.
- **Hotovo když:** (1) countdown má správnou barvu dle prahů; (2) připomínky generují notifikace; (3) kalendář i widget čtou stejný zdroj `terminy`.

### (g) Úkoly & checklisty
Per-tender/per-část tasks: assignee, due date, `stav`, priorita. Auto-seed a **checklist** from the analysis (kvalifikační doklady, compliance items, „nahrát výpis z OR", „doplnit reference"). Chip **„Úkoly: 3/7 hotovo"** on cards; **„Moje úkoly"** scoped to the logged-in user across tenders.
- **Hotovo když:** (1) checklist se auto-naseedne z analýzy; (2) karta ukazuje „Úkoly: 3/7 hotovo" a „Moje úkoly" filtruje dle přihlášeného; (3) dokončení úkolu zapíše aktivitu.

### (h) Tým / přiřazení / odpovědnost
Each tender/část/task has an **assignee** (avatar + name on cards, rows, detail rail); reassign via picker; **„Přiřazeno mně"** is a saved view. Reuse `UserManagement.tsx`; add `role` + `assignee` + an avatar/initials component. Optional `sledující` (watchers).
- **Hotovo když:** (1) reassign přes picker funguje a zapíše aktivitu; (2) „Přiřazeno mně" je uložený pohled; (3) akce omezené rolí jsou v UI skryté/disabled a vynucené i v API.

### (i) Historie / timeline aktivit
**Historie** tab = chronological, append-only feed: status changes, assignments, comments, generated/regenerated documents, price approvals, deadline edits, file uploads. Each entry: ikona, autor, akce, čas (relativně + absolutně na hover).
- **Hotovo když:** (1) čte z tabulky `aktivity` (ne z `updated_at`); (2) obsahuje všechny uvedené typy událostí; (3) každý záznam má ikonu/autora/akci/relativní+absolutní čas.

### (j) Poznámky & komentáře
**Komentáře** tab: threaded notes per tender, autor + čas, `@mention` (notifies the mentioned user). Keep existing free-text fields (GO/NOGO odůvodnění, `vysledek_poznamky`, položka odůvodnění) but surface a proper comment entity. Markdown-light.
- **Hotovo když:** (1) vláknové komentáře s autorem a časem; (2) `@mention` vytvoří `notifikace` záznam pro zmíněného s deep linkem.

### (k) Notifikace (in-app + e-mail)
- **In-app:** a bell in the top bar with unread count (`notifikace.precteno = false`). Klik na položku naviguje na záznam **a označí ji přečtenou**; **„Označit vše jako přečtené"**. Empty = **„Žádná upozornění."**
- **Czech texty položek (per event):** nová relevantní zakázka → „Nová relevantní zakázka: {název} (skóre {skóre})"; analýza dokončena → „Analýza dokončena: {název} — {GO/NOGO/ZVÁŽIT}"; nabídka připravena → „Nabídka připravena k podání: {název}"; blížící se lhůta → „Blíží se lhůta podání: {název} — {za 3 dny}"; přiřazení → „{autor} ti přiřadil(a) zakázku: {název}" / „…úkol: {název}"; @mention → „{autor} tě zmínil(a) v komentáři u {název}"; výsledek → „Výsledek zakázky {název}: Vyhráno" / „…: Prohráno".
- **E-mail:** respect `monitoring_filtry.email_notify` + `notify_frequency` (`instant`/`daily`/`weekly`). **Denní souhrn (8:00)** sekce: **„Nové relevantní zakázky ({n})"**, **„Dnešní a po termínu lhůty ({n})"**, **„Úkoly k řešení dnes ({n})"**, patička **„Otevřít VZ CRM"**. (Delivery itself stays in the existing n8n/Supabase layer — UI configures and displays it.)
- **Hotovo když:** (1) zvonek ukazuje počet nepřečtených, klik naviguje + označí přečteno; (2) identické události se deduplikují (žádný spam); (3) denní souhrn respektuje `notify_frequency` a má definované sekce.

### (l) Uložené pohledy, filtry, fulltext
- **Fulltext** (název, zadavatel, IČO, CPV, ai_tags) wired into a **Cmd+K** palette. Placeholder **„Hledat zakázky, akce, stránky…"**; empty results **„Nic nenalezeno."**
- **Filtry:** status, zdroj, assignee, region, CPV, typ zakázky, hodnota range, lhůta range, rozhodnutí, relevance score, štítek.
- **Uložené pohledy** (`ulozene_pohledy`): **„Moje aktivní"**, **„Blížící se lhůty"**, **„GO rozhodnuto"**, **„Vyhráno letos"** — persisted per user, shown as tabs/chips above the table; user can create/rename/delete their own.
- **Hotovo když:** (1) Cmd+K hledá zakázky a spouští akce; (2) uložené pohledy jsou per-user, lze je vytvořit/přejmenovat/smazat.

### (m) Reporting / dashboard
A **Přehled** with KPI cards + charts (Czech-first labels):
- **Úspěšnost nabídek** (vyhráno / (vyhráno + prohráno)) overall and by period; from `nabidky.vysledek` / `casti.vysledek` (+ `tender_product_matches.was_winning_bid` for pricing feedback).
- **Hodnota pipeline** (rozpracované zakázky) — summed `predpokladana_hodnota` of open parts, plus **Vážená hodnota** (§2.5 probabilities), broken down by stage.
- **Blížící se lhůty** — count + list with lhůta in next 7/14 days.
- **Trychtýř (funnel)** — počet zakázek/částí per stage (Nová → Vyhráno).
- **AI náklady** — sum of `ai_cost_czk` per period.
- Secondary: průměrná marže, počet podaných nabídek, počet úkolů po termínu.
- **Hotovo když:** (1) všechny KPI se počítají z reálných dat na úrovni části; (2) Vážená hodnota používá konfigurovatelné pravděpodobnosti fází; (3) žádný anglicismus v uživatelské kopii.

---

## 4. KEY SCREENS (functional — Czech copy, data, empty/loading/error, responsive)

> Introduce a **persistent left sidebar** (~240px, icon + label, **collapsible to icon-only ≤1280px, off-canvas drawer ≤1024px**) + a slim top bar (breadcrumbs + Cmd+K + bell + user menu). Replace the thin header/hash-nav feel. Sidebar: **Přehled · Monitoring · Pipeline · Zakázky · Kalendář · Cenový sklad · Nastavení**. Keep the existing hash-router unless trivially upgradable; do not break deep links. **Minimum supported viewport ≈ 1024px (notebook); below that, single-column stacked, never broken.** Mobile-native is a non-goal.

### Přehled (Dashboard)
KPI strip (Úspěšnost nabídek, Hodnota pipeline, Vážená hodnota, Podané nabídky, AI náklady) + **„Blížící se lhůty"** + **trychtýř** chart + **„Moje úkoly"** + **„Nedávná aktivita"**. Loading = skeleton cards. Empty = **„Zatím žádné zakázky. Spusťte monitoring nebo importujte ručně."** + CTA. Error = **„Nepodařilo se načíst přehled"** + retry.

### Pipeline (Kanban dle fáze)
Columns = lifecycle stages; **header = název fáze + počet + součet hodnoty** (**„Příprava nabídky · 4 · 2,3 mil. Kč"**). Card = název, zadavatel, hodnota (tabular-nums), lhůta (relativně + barva), status/rozhodnutí badge, assignee avatar, **„Úkoly 3/7"**. Drag advances stage (guards §2.2). Sticky column headers. **≤1280px:** horizontal scroll with snap, min column width ~280px. Empty column = **„Žádné zakázky v této fázi"**. Loading = skeleton cards.

### Zakázky (tabulka)
Dense data table (TanStack-style): sticky header, density toggle (kompaktní / komfortní / vzdušná), column show/hide, row selection, pinned first column (název), right-aligned money in tabular-nums, inline status badges, relative deadlines. **Uložené pohledy** as tabs + filter bar + fulltext. **Hromadné akce:** **„Přiřadit"**, **„Změnit stav"** (ctí guardy §2.2), **„Přidat štítek"**, **„Skrýt"**, **„Export CSV"**. **≤1280px:** hide secondary columns (region, CPV, ai_tags), keep název/zadavatel/hodnota/lhůta/stav/assignee, default density kompaktní, horizontal scroll preserved. Empty = **„Žádné zakázky neodpovídají filtru"** + **„Zrušit filtry"**. Loading = skeleton rows. Error = retry banner.

### Detail zakázky (taby)
Header: název (inline rename), status badge + stage stepper + **„Změnit stav"**, key meta, primary actions (Analyzovat / Ocenit / Vygenerovat / Podáno — gated by role). **Right metadata rail:** lhůta (countdown), předpokládaná hodnota, zadavatel + IČO, region, zdroj(e) (links), rozhodnutí, assignee, vybraná firma (keep existing selector), části (přepínač u vícečásťových). Tabs: **Přehled · Analýza · Ocenění · Dokumenty · Úkoly · Termíny · Historie · Komentáře**. (Map existing internal tabs — Pipeline/Analýza/Produkty/Dokumenty/Validace — onto this set; fold Pipeline+Validace into Přehled/Dokumenty.) Each tab has its own empty/loading/error. Loading the record = skeleton header + rail.

### Kalendář / Lhůty
Month/list toggle of all deadlines color-coded by urgency, filterable by assignee/status. Click event → tender detail. Empty = **„Žádné nadcházející termíny"**.

### Cenový sklad
**Keep the existing warehouse module functionally as-is** (dashboard, produkty, import, scraping, zdroje, detail produktu) — restyle to the new tokens and fix broken diacritics (§7). Accessed from the sidebar as a CRM feature.

### Nastavení
One **Nastavení** area: **Firmy** (companies CRUD + DOC_SLOTS), **Uživatelé a role** (RBAC §2.6), **Pipeline** (fáze + pravděpodobnosti §2.5), **Monitorovací filtry** (CPV, klíčová slova, vylučující slova, regiony, hodnota, typy, min. dní do lhůty, notifikace), **Notifikace** (in-app/email frequency), **Heslo**. Each with proper validation/empty/error states.

---

## 5. VISUAL DIRECTION (keep short)

Modern, light, clean SaaS — **Linear / Attio / Notion vibe**: generous whitespace, calm but data-dense tables, strong typographic hierarchy. shadcn/ui (`new-york` style) + Tailwind. **Light theme first, dark-mode-ready**: everything as semantic CSS-variable tokens (`--background`, `--foreground`, `--card`, `--border`, `--muted`, `--primary`, `--accent`, `--destructive`, `--success`, `--warning`, `--ring`) so dark mode is a class swap.

- **Neutrals border-first:** app bg ~`#FAFAFA`, cards white, hairline borders (~zinc-200) doing the structural work instead of heavy shadows; muted text zinc-500, ink near-black.
- **One accent** (cobalt/indigo, e.g. `#4F46E5`) — only primary buttons, active nav, links, focus rings, selected rows.
- **Semantic status colors mapped to the Czech statuses** (low-chroma tinted pills, ~700-weight text + optional leading dot): **Vyhráno** = emerald; probíhající/info (Analyzovaná, Oceněná, Připravená) = blue; **blížící se lhůta / Varování** = amber; **Prohráno / Neprošlo** = red; **Nová / Koncept** = zinc; each kanban stage gets its own muted pastel chip.
- **Typografie:** Inter (system fallback ok); monospace + `tabular-nums` for IDs, dates, money; `cs-CZ` / CZK formatting (keep existing).
- 4px grid, radius ~8px cards / 6px badges, soft shadows only on overlays and the dragged card. **Do not over-specify pixels.** Build reusable shadcn primitives (Button, Card, Table, Badge, Input, Tabs, Dialog, Select) so colors/recipes stop being copy-pasted; replace native `confirm()`/`alert()` with Dialog.

---

## 6. REFERENCE SYSTEMS

### A) CRM / pipeline UX (live products — mimic the feel)
- **Attio** — https://attio.com — co si vzít: flexibilní objektový/record model, čisté husté tabulky, uložené pohledy.
- **Pipedrive** — https://www.pipedrive.com — co si vzít: pipeline jako kanban se sloupci fází + vážená hodnota dealu.
- **Folk** — https://www.folk.app — co si vzít: lehké, přívětivé CRM, nízký vizuální šum karet.
- **HubSpot CRM** — https://www.hubspot.com/products/crm — co si vzít: detail záznamu s timeline aktivit a úkoly.
- **Linear** — https://linear.app — co si vzít: rychlé husté UI, klávesnice first, Cmd+K paleta, status workflow.
- **Notion** — https://www.notion.so — co si vzít: jeden dataset jako tabulka / board / kalendář.

### B) Open-source repos, knihovny a ukázky (otevři a nastuduj strukturu & komponenty)
- **Twenty CRM** (repo) — https://github.com/twentyhq/twenty — co si vzít: nejlepší strukturní reference pro objekty, pipeline a record pages v Reactu.
- **Dub** (repo) — https://github.com/dubinc/dub — co si vzít: čisté shadcn/ui + Tailwind dashboard patterny.
- **Cal.com** (repo) — https://github.com/calcom/cal.com — co si vzít: produkční shadcn UI, formuláře, nastavení.
- **Documenso** (repo) — https://github.com/documenso/documenso — co si vzít: shadcn app s dokumentovými workflow.
- **Tremor** (knihovna — neklonuj, jen nastuduj) — https://www.tremor.so — co si vzít: React+Tailwind KPI / dashboard / chart komponenty.
- **shadcn/ui examples** (ukázky/dokumentace — ne repo) — https://ui.shadcn.com/examples — co si vzít: kanonické dashboard, tasks-table a card patterny.

### C) Czech public-tender domain (datový svět + přímý konkurent)
- **poptavky.naseit.cz** — https://poptavky.naseit.cz — co si vzít: agreguje TenderArena, NEN, Vhodné uveřejnění, e-zakazky.cz — přímý vzor pro multi-source obrazovku **Monitoring**.
- **Hlídač státu** — https://www.hlidacstatu.cz — co si vzít: data o zakázkách a smlouvách (existující zdroj).
- **NEN** — https://nen.nipez.cz — co si vzít: Národní elektronický nástroj jako zdroj a cílový el. nástroj pro podání.
- **TenderArena** — https://www.tenderarena.cz — co si vzít: pole/atributy zakázky pro import a mapování.
- **Vhodné uveřejnění** — https://www.vhodne-uverejneni.cz — co si vzít: další zdroj profilů zadavatele.
- **e-zakazky.cz** — https://www.e-zakazky.cz — co si vzít: další zdroj zakázek pro dedup test.

---

## 7. CONSTRAINTS & NON-GOALS

- **Keep the stack:** React 18 + TypeScript + Vite + Tailwind + shadcn/ui. No framework swap (no Next.js); reject any Next-isms a generator suggests.
- **Do not break the data layer.** Iterate on the existing Supabase/PostgREST + file/Express layer. All new tables (`casti`, `ukoly`, `aktivity`, `komentare`, `terminy`, `ulozene_pohledy`, `stitky` + `zakazka_stitky`, `notifikace`) come as **timestamped Supabase migrations** with `tenant_id` + `user_id`, RLS, and indexes on RLS-referenced columns. Never edit production DB directly.
- **Enforce RBAC (§2.6) in the API, not only in the UI.** UI hides/disables gated actions; the backend rejects them too.
- **Build on existing components** (`AnalysisView`, `ProductMatchView`, `ItemPriceCalculator`, `DocumentList`, `WarehouseDashboard`, `CompanySettings`, `UserManagement`, `PipelineStatus`, `lib/api.ts`, `useHashParams`). Extract shared shadcn primitives instead of copy-pasting card/button/table/badge recipes; introduce design tokens (today `tailwind.config.js` theme.extend is empty).
- **Czech-first UI.** Every user-facing string in Czech with correct diacritics; **no English leaking into copy** (it is „Úspěšnost nabídek", not „Win-rate"; „Trychtýř", not „funnel"). **Fix the existing broken diacritics** in `ImportWizard.tsx` (Mapování sloupců, řádků, sloupců, Zrušit, Cílové pole, Ukázka dat, Výrobce, Katalogové číslo, URL obrázku, Import probíhá, Zpracovávám, Import dokončen, Nových, Přeskočeno, Další import), `ProductCandidateCard.tsx`/`ItemPriceCalculator.tsx` („Nízká"), and `WarehouseDashboard.tsx` Icecat message (obohaceno, produktů, nenalezeno). Code, commits, comments in English.
- **Závazná mikrokopie (jednotná napříč aplikací):** guard toast **„Tuto změnu stavu nelze provést — {důvod}."**; Cmd+K placeholder **„Hledat zakázky, akce, stránky…"** / empty **„Nic nenalezeno."**; prázdný zvonek **„Žádná upozornění."**; bulk **„Změnit stav"** MUSÍ ctít stejné guardy jako kanban (jinak se obě cesty rozejdou).
- **No backend scope creep.** No new AI services, scrapers, or email infra in this pass — wire the UI to what exists (Supabase Edge Functions / n8n / Express). Notifications/digests stay in the existing async layer; the UI configures and displays them.
- **Non-goals (now):** legal RAG Q&A, billing/Stripe, public sign-up, e-podání integration into the el. nástroj, mobile-native app. Keep them out but don't block them (multi-tenant + tokens stay in place).
- Lovable and Claude Code must not edit the same files simultaneously (git konflikty). Work on a feature branch, PRs for everything, never force-push `main`.

## 8. HOW TO PROCEED

1. **Read the repo first.** Map current routes, components, data flow (`App.tsx` hash router, `lib/api.ts`, warehouse module, tender pipeline, settings) and the two parallel data models (target Supabase schema in `docs/technicka-implementace-v2.md` vs the implemented file-based pipeline + the real warehouse SQL migration). Confirm what's real before changing anything.

2. **Propose before building.** Come back with: (a) the **information architecture** (sidebar + screens); (b) the **lifecycle/state-machine** mapping (5 processing steps → 10 stages + the transition matrix §2.2); (c) the **data-model delta** (eight new tables + migrations, RBAC, vážená-hodnota config, části roll-up); (d) a **screen plan** with build order. **Ask clarifying questions before large changes.** End with open questions.

3. **Seed with REAL Czech data — no lorem ipsum.** Source it from the existing `input/` tender folders (`input/3d-tiskarna/`, `input/vlaknovy-laser/`, `input/servery-hostinne/`, `input/kancelarsky-material/`, …) and the **Hlídač státu MCP**; commit a seed fixture (e.g. `supabase/seed.sql`) with ~15–25 records carrying real názvy, zadavatelé, IČO, CPV, částky and lhůty, so density and alignment read truthfully.

4. **Milestone 1 = závazný cíl prvního PR (acceptance gate — neřeš celý epos najednou):**
   - Design tokens (CSS variables) + shadcn primitives (Button, Card, Table, Badge, Input, Tabs, Dialog, Select) + **diacritics fix**.
   - App shell: left sidebar (collapsible) + top bar (Cmd+K + bell as static UI placeholders).
   - **Zakázky** table reading existing data (filters + ≥1 uložený pohled) + **Detail zakázky** tabs wrapping the existing `AnalysisView` / `ProductMatchView` / `DocumentList`.
   - **Gate (Hotovo když):** app builds with no Next-isms; the existing per-tender pipeline still runs through the new Detail; diacritics fixed; the seed renders at real density. Ship as the first PR before anything else.

5. **Then iterate in small PRs, one reviewable piece each:**
   - **M2** CRM data layer: migrations for the eight new tables + RLS + API wiring + RBAC.
   - **M3** Pipeline kanban (drag + state-machine guards + activity log) + bulk actions + štítky.
   - **M4** Termíny/Kalendář + reminders + Notifikace (bell, unread, dedup) + denní souhrn.
   - **M5** Úkoly & checklisty + assignees + RBAC gating in UI.
   - **M6** Přehled/reporting (Úspěšnost nabídek, Hodnota pipeline, Vážená hodnota, Trychtýř, AI náklady).
   - **M7** Restyle warehouse + settings to tokens.

6. **Every PR:** minimal diff, preserve existing file paths and deep links, real Czech data, and the per-feature **„Hotovo když"** criteria from §3 satisfied.