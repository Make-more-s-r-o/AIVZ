# VZ AI Tool — TODO průvodce implementací v3

## Praktický návod krok za krokem | Aktualizováno s Mini MVP + MCP servery

> **Co je nové v3:** Přidána FÁZE 0.5 (Mini MVP) — proof-of-concept na reálné zakázce. Přidány MCP servery (Hlídač státu, n8n, n8n-knowledge). Přidána kompletní konfigurace Claude Code. Aktualizovány všechny návaznosti.

> **Referenční zakázka pro Mini MVP:** 3D tiskárna pro tisk termoplastů (podo.fen.cz)

> **Pravidlo #1:** Dokonči Mini MVP PRVNÍ. Teprve pak buduj automatizaci.

---

## Přehled fází

```
FÁZE 0  (Dny 1-3)    Založení projektu — infrastruktura
FÁZE 0.5 (Dny 4-10)   ★ MINI MVP — jeden end-to-end průchod s reálnou zakázkou
FÁZE 1A (Dny 11-20)   Automatický monitoring zakázek
FÁZE 1B (Dny 21-32)   AI analýza dokumentů (automatizace)
FÁZE 1C (Dny 28-40)   Cenový engine + sklad
FÁZE 1D (Dny 15-38)   Frontend dashboard (paralelně)
FÁZE 1E (Dny 38-55)   Automatický generátor nabídek
FÁZE 2  (Měsíc 3-6)   SaaS + multi-tenant
```

---

## FÁZE 0: Založení projektu (Dny 1–3)

### Den 1: Účty a přístupy

```
□ Anthropic API klíč → console.anthropic.com ($50 kredit na start)
□ Google AI Studio API klíč → aistudio.google.com (zdarma)
□ Hlídač státu registrace → hlidacstatu.cz
  → Napiš na api@hlidacstatu.cz o MCP přístup (beta)
  → API token: api.hlidacstatu.cz → Autorizační token
□ Supabase účet → supabase.com → New Project "vz-ai-tool"
  → Region: EU Central (Frankfurt)
  → Zapiš: Project URL, anon key, service_role key
□ GitHub účet (pokud nemáš)
□ Lovable účet → lovable.dev
□ Node.js 18+ nainstalovaný (node -v)
□ Docker Desktop nainstalovaný (docker -v)
□ Supabase CLI: npm install -g supabase
□ Claude Code: npm install -g @anthropic-ai/claude-code
```

### Den 2: Lovable → GitHub repo + Supabase schema

```
KROK 1: Založení UI v Lovable
──────────────────────────────
□ lovable.dev → New project → "vz-ai-tool"
□ Prompt:

  "Vytvoř dashboard aplikaci pro správu veřejných zakázek v češtině.
   React + TypeScript + Tailwind + shadcn/ui.
   Stránky: 1) Dashboard (statistiky + seznam posledních zakázek),
   2) Feed zakázek (tabulka s filtry), 3) Detail zakázky (tabs),
   4) Nastavení. Sidebar navigace s lucide-react ikonami.
   Primární barva: tmavě modrá (#1e3a5f). Mock data zatím."

□ Settings → Integrations → Connect to GitHub
  (vytvoří repo github.com/tvuj-username/vz-ai-tool)
□ Settings → Integrations → Supabase
  (vlož Project URL + anon key)

KROK 2: Databázové schéma v Supabase
─────────────────────────────────────
□ Supabase Studio → SQL Editor → spusť inicializační SQL
  (viz sekce 4.1 v technicka-implementace-v2.md)
□ Storage → nové buckety: "dokumentace", "nabidky", "sablony"
```

### Den 3: Claude Code setup

```
KROK 3: Naklonuj repo + nastav Claude Code
───────────────────────────────────────────
□ git clone https://github.com/tvuj-username/vz-ai-tool.git
□ cd vz-ai-tool

□ Zkopíruj CLAUDE.md do kořene projektu
  (soubor je součástí tohoto balíčku)

□ Zkopíruj .mcp.json do kořene projektu
  → Nahraď VŠECHNY placeholder hodnoty svými klíči
  → Viz _setup poznámky v každém serveru

□ Vytvoř adresářovou strukturu:
  mkdir -p packages/shared supabase/functions n8n-workflows templates docs docker

□ Zkopíruj referenční dokumenty do docs/:
  docs/technicka-implementace-v2.md
  docs/strategicka-mapa.md
  docs/architektura-diagramy.html
  docs/todo-implementace-v3.md    (tento soubor)

□ Spusť Claude Code:
  claude

□ Ověř MCP servery:
  /mcp
  → Měly by být vidět: supabase, hlidac-statu, n8n, n8n-knowledge, github

□ Nastav memory:
  /memory add "VZ AI Tool: React+Supabase+n8n, vždy TypeScript"
  /memory add "DB: tenant_id na každé tabulce, RLS policies"
  /memory add "UI česky, kód anglicky, shadcn/ui komponenty"
  /memory add "n8n = async workflow engine, NIKDY jako API server"
  /memory add "Edge Functions = sync user-facing API (<2s)"
  /memory add "Dokumenty: Carbone.io šablony → Gotenberg PDF"

□ Test Hlídač státu MCP:
  "Vyhledej veřejné zakázky na 3D tiskárny v posledním měsíci"
  → Pokud funguje, máš přístup k datům o zakázkách přímo z Claude Code

□ Test Supabase MCP:
  "Ukaž mi seznam tabulek v databázi"
  → Pokud funguje, Claude Code vidí tvoji DB

✅ FÁZE 0 HOTOVÁ
```

---

## ★ FÁZE 0.5: MINI MVP (Dny 4–10)

### Cíl

Jeden kompletní průchod: vzít reálnou zakázku → přečíst ji → ocenit → vygenerovat nabídkové dokumenty. **BEZ automatizace**, ručně řízený flow. Ověřit, že AI dokáže zrychlit přípravu nabídky.

### Referenční zakázka

```
Název:     3D tiskárna pro tisk termoplastů
Zdroj:     podo.fen.cz / NEN / Hlídač státu
Položky:   1 ks (3D tiskárna)
Typ:       VZMR (veřejná zakázka malého rozsahu)
```

### Den 4: Získání a analýza zakázky

```
KROK 4: Stáhni zadávací dokumentaci
────────────────────────────────────
□ V Claude Code s MCP Hlídač státu:
  "Najdi zakázku '3D tiskárna pro tisk termoplastů' a ukaž mi
   všechny dostupné informace — zadavatel, popis, termíny,
   podmínky, dokumenty ke stažení."

□ Stáhni zadávací dokumentaci (PDF) z profilu zadavatele
  → Ulož do: templates/demo/zadavaci-dokumentace.pdf

□ Pokud PDF není dostupný přes MCP, stáhni ručně z:
  - NEN (nen.nipez.cz)
  - Profilu zadavatele
  - podo.fen.cz


KROK 5: AI analýza zadávací dokumentace
────────────────────────────────────────
□ Otevři Claude.ai (web chat) — NE Claude Code
□ Nahraj PDF zadávací dokumentace
□ Prompt:

  "Jsi expert na české veřejné zakázky (zákon 134/2016 Sb. ZZVZ).
   Analyzuj tuto zadávací dokumentaci a extrahuj:

   1. ZÁKLADNÍ ÚDAJE
      - Název zakázky, evidenční číslo
      - Zadavatel (název, IČO, kontaktní osoba)
      - Předmět plnění (co přesně chtějí)
      - Předpokládaná hodnota
      - Typ řízení (otevřené/VZMR/zjednodušené podlimitní)

   2. TECHNICKÉ POŽADAVKY
      - Specifikace 3D tiskárny (parametry, rozměry, materiály)
      - Požadované příslušenství
      - Záruční podmínky
      - Servisní požadavky

   3. KVALIFIKAČNÍ PŘEDPOKLADY
      - Profesní způsobilost
      - Technická kvalifikace (reference, certifikace)
      - Ekonomická kvalifikace (obrat, pojištění)

   4. HODNOTÍCÍ KRITÉRIA
      - Kritérium a jeho váha (%)
      - Co přesně se hodnotí

   5. TERMÍNY
      - Lhůta pro podání nabídek
      - Doba plnění
      - Záruční doba

   6. FORMA NABÍDKY
      - Jaké dokumenty musí nabídka obsahovat
      - V jakém formátu (papír/elektronicky/NEN)
      - Speciální požadavky na strukturu

   7. DOPORUČENÍ GO/NOGO
      - Je to pro nás vhodná zakázka? Proč ano/ne?
      - Identifikovaná rizika

   Odpověz strukturovaně v češtině."

□ Výstup ulož do: docs/demo/analyza-3d-tiskarna.md
□ Toto je tvůj REFERENČNÍ VÝSTUP — takto bude AI analýza
  vypadat v produkčním systému


KROK 6: Výběr produktu k nabídce
─────────────────────────────────
□ Na základě technických požadavků z analýzy
  najdi vhodnou 3D tiskárnu, která splňuje specifikaci.

□ V Claude Code / Claude.ai:
  "Na základě těchto technických požadavků:
   [vlož požadavky ze zadávací dokumentace]
   Najdi 3 konkrétní modely 3D tiskáren na českém trhu,
   které splňují všechny parametry.
   Pro každý model uveď: výrobce, model, klíčové parametry,
   orientační cenu v CZK, kde koupit."

□ Vyber JEDEN konkrétní produkt pro nabídku
□ Zapiš: výrobce, model, parametry, nákupní cena, prodejní cena (s marží)
□ Ulož do: docs/demo/produkt-3d-tiskarna.md
```

### Den 5–6: Generování nabídkových dokumentů

```
KROK 7: Vytvoř DOCX šablony
────────────────────────────
□ V Claude Code:
  "Vytvoř 4 DOCX šablony pro nabídku do veřejné zakázky.
   Použij python-docx knihovnu.
   Šablony ukládej do templates/.

   1. templates/kryci_list.docx
      - Krycí list nabídky
      - Placeholdery: {{nazev_zakazky}}, {{zadavatel}},
        {{dodavatel_nazev}}, {{dodavatel_ico}}, {{dodavatel_adresa}},
        {{nabidkova_cena_bez_dph}}, {{nabidkova_cena_s_dph}},
        {{datum}}, {{misto}}
      - Profesionální formátování, logo placeholder

   2. templates/cenova_nabidka.docx
      - Tabulka s položkami
      - Sloupce: č., název, specifikace, množství, j.cena, celkem
      - Součet bez DPH, DPH 21%, celkem s DPH

   3. templates/technicky_navrh.docx
      - Úvod, navrhované řešení, parametry nabízeného zařízení,
        dodací podmínky, záruční a servisní podmínky, harmonogram
      - Placeholdery pro AI generovaný text

   4. templates/cestne_prohlaseni.docx
      - Čestné prohlášení o splnění základní způsobilosti
        dle §74 zákona 134/2016 Sb.
      - Placeholdery: dodavatel, IČO, jednající osoba, datum"


KROK 8: AI vygeneruje obsah nabídky
────────────────────────────────────
□ V Claude.ai (web chat):

  PROMPT PRO TECHNICKÝ NÁVRH:
  "Jsi expert na psaní nabídek do veřejných zakázek v ČR.
   Na základě těchto informací napiš technický návrh řešení:

   ZAKÁZKA: [název, popis z analýzy]
   HODNOTÍCÍ KRITÉRIA: [kritéria a váhy z analýzy]
   NABÍZENÝ PRODUKT: [výrobce, model, parametry]
   DODAVATEL: Make more s.r.o., IČO: [doplň]

   Struktura technického návrhu:
   1. Úvod a porozumění požadavkům zadavatele
   2. Navrhované řešení (konkrétní produkt, proč splňuje požadavky)
   3. Technické parametry nabízeného zařízení (tabulka: požadavek vs. nabízeno)
   4. Dodací podmínky a harmonogram
   5. Záruční a pozáruční servis
   6. Reference a zkušenosti dodavatele
   7. Přidaná hodnota nabídky

   Piš odborně ale srozumitelně. Zaměř se na hodnotící kritéria.
   Délka: 3-5 stran."

□ Ulož výstup do: docs/demo/technicky-navrh-text.md


KROK 9: Naplň šablony a vygeneruj dokumenty
────────────────────────────────────────────
□ V Claude Code:
  "Vytvoř Python skript generate_demo_bid.py který:
   1. Načte DOCX šablony z templates/
   2. Naplní je daty:
      - Zakázka: [údaje z analýzy]
      - Dodavatel: Make more s.r.o. (demo data)
      - Produkt: [vybraná 3D tiskárna]
      - Technický návrh: [text z Claude]
      - Cena: [nákupní + marže]
   3. Uloží vyplněné DOCX do output/demo/
   4. Konvertuj DOCX → PDF přes Gotenberg nebo LibreOffice
   Použij python-docx pro vyplnění šablon."

□ Spusť: python generate_demo_bid.py
□ Zkontroluj výstup:
  - output/demo/kryci_list.docx (.pdf)
  - output/demo/cenova_nabidka.docx (.pdf)
  - output/demo/technicky_navrh.docx (.pdf)
  - output/demo/cestne_prohlaseni.docx (.pdf)
```

### Den 7–8: Validace a měření

```
KROK 10: Kontrola kvality nabídky
──────────────────────────────────
□ V Claude.ai — nahraj VŠECHNY vygenerované dokumenty:

  "Jsi kontrolor kvality nabídek do VZ. Zkontroluj tyto dokumenty:
   [nahraj 4 PDF/DOCX]

   Proti těmto požadavkům ze zadávací dokumentace:
   [vlož požadavky na formu nabídky z analýzy]

   Zkontroluj:
   1. Jsou všechny požadované dokumenty přítomny?
   2. Odpovídají technické parametry požadavkům zadavatele?
   3. Je cenová nabídka správně spočítaná (DPH, součty)?
   4. Je čestné prohlášení kompletní dle §74 ZZVZ?
   5. Chybí nějaký formální náležitost?
   6. Jaká je celková kvalita nabídky (1-10)?
   7. Co je třeba opravit?

   Buď přísný — skutečná chyba = vyřazení z řízení."

□ Oprav nalezené chyby
□ Opakuj kontrolu dokud score není 8+/10


KROK 11: Změř výsledky Mini MVP
────────────────────────────────
□ Zapiš časy (kolik minut/hodin trvala každá fáze):
  - Získání a čtení zadávací dokumentace: ___ min
  - AI analýza dokumentace: ___ min
  - Výběr produktu: ___ min
  - Generování technického návrhu (AI): ___ min
  - Generování dokumentů: ___ min
  - Kontrola kvality: ___ min
  - Opravy: ___ min
  - CELKEM: ___ min

□ Porovnej s odhadem manuální přípravy (40-80 hodin)
□ Zapiš learnings:
  - Co fungovalo dobře?
  - Co je třeba zlepšit?
  - Které kroky se dají automatizovat?
  - Které kroky VŽDY potřebují lidskou kontrolu?

□ Ulož výsledky: docs/demo/mini-mvp-vysledky.md

✅ FÁZE 0.5 HOTOVÁ — máš důkaz, že koncept funguje.
   Teď víš, co automatizovat a co nechat na člověku.
```

---

## FÁZE 1A: Automatický monitoring (Dny 11–20)

### Kde pracuješ: n8n GUI + Claude Code (s n8n MCP)

```
KROK 12: n8n workflow — Hlídač státu monitoring
────────────────────────────────────────────────
□ V Claude Code (s n8n-knowledge MCP):
  "Navrhni n8n workflow pro monitoring veřejných zakázek
   z Hlídače státu API. Workflow by měl:
   1. Schedule Trigger každých 30 minut
   2. HTTP Request na api.hlidacstatu.cz/api/v2/verejnezakazky/hledat
   3. Loop přes výsledky
   4. Check duplicit v Supabase (by external_id)
   5. Insert nových zakázek do tabulky zakazky
   6. Scoring relevance (Code node)
   7. Slack notifikace pro score > 70
   Vrať JSON workflow který mohu importovat do n8n."

□ NEBO vytvoj workflow ručně v n8n GUI (viz FÁZE 1A v předchozím TODO)

□ Claude Code s n8n MCP může workflow přímo nahrát:
  "Nahraj tento workflow na moji n8n instanci a aktivuj ho."

□ Testuj: Manual Execute → zkontroluj data v Supabase


KROK 13: AI scoring a filtrace
───────────────────────────────
□ Nový workflow "VZ Filter & Score" v n8n
□ Filtruj: CPV kódy (IT: 72xxx, 48xxx, 30xxx), keywords, hodnota
□ Gemini Flash triáž pro relevantní zakázky (score 30+)
□ Supabase update: relevance_score, status
□ Slack notifikace pro vysoké score

□ Export workflows do JSON → n8n-workflows/ → git commit

✅ FÁZE 1A HOTOVÁ
```

---

## FÁZE 1B–1E: Automatizace

Tyto fáze zůstávají stejné jako v předchozí verzi TODO s tím rozdílem, že:

1. **Máš zkušenost z Mini MVP** — víš co funguje a co ne
2. **MCP servery** ti pomáhají pracovat rychleji:
   - Hlídač státu MCP pro testování na reálných datech
   - n8n MCP pro správu workflows z Claude Code
   - Supabase MCP pro přímé dotazy na DB

### FÁZE 1B: AI analýza dokumentů (Dny 21–32)
```
□ Edge Function extract-pdf (Claude Code)
□ Systémový prompt pro analýzu ZD (iterace z Mini MVP!)
□ n8n workflow analyze_tender
□ Testuj na 10+ reálných zakázkách
```

### FÁZE 1C: Cenový engine (Dny 28–40)
```
□ DB schéma: products_canonical, suppliers, current_prices (Claude Code)
□ Edge Function match-product (Claude Code)
□ Import existujících produktů (skript)
□ n8n workflow price_items
```

### FÁZE 1D: Frontend dashboard (Dny 15–38, paralelně)
```
□ Dashboard + Feed (Lovable)
□ Detail zakázky s tabs (Lovable)
□ Produktový katalog (Lovable)
□ Nastavení filtrů (Lovable)
□ POZOR: Střídej Lovable (UI) a Claude Code (backend) dny
```

### FÁZE 1E: Automatický generátor nabídek (Dny 38–55)
```
□ DOCX šablony (z Mini MVP — vylepši na základě zkušeností)
□ Carbone.io + Gotenberg na VPS (Docker)
□ n8n workflow generate_bid
□ Frontend: tab "Nabídka" na detail stránce (Lovable)
□ AI kontrola kvality nabídky (z Mini MVP → automatizuj)
```

---

## Vývojová prostředí — pravidla

### Kdy co použít

```
┌────────────────────┬─────────────────────────────────────────────┐
│ ÚLOHA              │ NÁSTROJ                                     │
├────────────────────┼─────────────────────────────────────────────┤
│ Nový UI screen     │ Lovable → pak zavři → Claude Code pullne   │
│ Backend logika     │ Claude Code (Edge Functions, DB migrace)    │
│ n8n workflow design│ Claude Code (s n8n-knowledge MCP, JSON)     │
│ n8n deploy/test    │ n8n GUI (web editor) NEBO Claude Code+MCP  │
│ DB prohlížení      │ Supabase Studio (web) NEBO Claude Code+MCP │
│ AI prompt iterace  │ Claude.ai (web chat) — rychlé testování    │
│ API testování      │ Bruno / Insomnia                            │
│ Dokumentace        │ Notion (nebo docs/ v repo)                  │
│ VZ data průzkum    │ Claude Code + Hlídač státu MCP              │
│ Git operace        │ Claude Code (commituje, pushuje, PRs)       │
└────────────────────┴─────────────────────────────────────────────┘
```

### Střídání Lovable ↔ Claude Code

```
⚠️ NIKDY neměj oba otevřené na stejném kódu současně!

1. LOVABLE: pracuj na UI → ukonči → počkej až pushne do GitHubu
2. CLAUDE CODE: "git pull origin main" → pracuj na backendu → commit+push
3. LOVABLE: otevři → automaticky pullne změny → pokračuj
```

### Multi-agent strategie v Claude Code

```
Použij sub-agenty pro paralelní nezávislé úkoly:

"Rozděl práci na sub-agenty:
 1. Sub-agent: SQL migrace pro cenový sklad
 2. Sub-agent: Edge Function match-product
 3. Sub-agent: Testy pro obě funkce
 Každý pracuje nezávisle, výsledek commitne do vlastní větve."

Kdy ANO: 3+ nezávislé úkoly, každý > 5 minut
Kdy NE:  sekvenční práce, jednoduché tasky
```

### Efektivní prompty pro Claude Code

```
ŠPATNĚ: "Udělej backend pro cenový engine"

DOBŘE:  "Vytvoř Supabase Edge Function 'match-product'
         v supabase/functions/match-product/index.ts.
         POST {nazev: string, ean?: string, mpn?: string}.
         1. Exact match v products_canonical (EAN)
         2. Normalized MPN match (UPPER, bez pomlček)
         3. Fuzzy pg_trgm (similarity > 0.6)
         4. Vrať top 5: {product_id, name, confidence, price}
         Supabase JS client, error handling, TypeScript typy."

PRAVIDLA:
 CO (konkrétní soubor/funkce)
 KDE (cesta v projektu)
 JAK (kroky, logika)
 S ČÍM (knihovny, typy)
 CO VRÁTIT (formát)
```

---

## MCP servery — podrobný přehled

### 1. Supabase MCP
```
Co umí:  Přímý přístup k DB, create/read tabulek, execute SQL,
         generování migrací, testování RLS policies
Jak:     claude mcp add supabase -- npx -y @supabase/mcp-server-supabase@latest \
           --supabase-url "URL" --supabase-key "SERVICE_ROLE_KEY"
Příklad: "Ukaž mi všechny zakázky s relevance_score > 70"
         "Vytvoř migraci pro novou tabulku bid_documents"
```

### 2. Hlídač státu MCP (beta)
```
Co umí:  Vyhledávání VZ, detail zakázky, smlouvy, firmy,
         faktury — celá datová sada Hlídače státu
Jak:     claude mcp add hlidac-statu -- npx mcp-remote \
           https://mcp.api.hlidacstatu.cz \
           --header "Authorization: Token API_TOKEN"
Setup:   Registrace → mail na api@hlidacstatu.cz → potvrzení
POZOR:   Beta provoz — může se změnit/spadnout
Příklad: "Najdi všechny IT zakázky za poslední měsíc nad 500K CZK"
         "Ukaž detail zakázky na 3D tiskárnu pro tisk termoplastů"
```

### 3. n8n MCP (workflow management)
```
Co umí:  CRUD workflows, spouštění, monitoring executions,
         čtení credentials, správa tagů
Jak:     claude mcp add n8n -- npx -y @leonardsellem/n8n-mcp-server
         env: N8N_API_URL, N8N_API_KEY
Setup:   n8n → Settings → API → Create API Key
Příklad: "Seznam všech aktivních workflows na mé n8n instanci"
         "Spusť workflow 'VZ Monitor' a ukaž výsledek"
         "Deaktivuj workflow s ID 5"
```

### 4. n8n Knowledge MCP (node dokumentace)
```
Co umí:  Databáze 1000+ n8n nodů — properties, operations,
         konfigurace, příklady. Claude Code díky tomu ví
         jak správně konfigurovat n8n nodes v JSON.
Jak:     claude mcp add n8n-knowledge -- npx -y @czlonkowski/n8n-mcp@latest
Setup:   Žádný API klíč (offline databáze)
Příklad: "Jak se konfiguruje Supabase node v n8n pro INSERT?"
         "Jaké parametry má HTTP Request node?"
         "Navrhni n8n workflow JSON pro monitoring zakázek"
```

### 5. GitHub MCP
```
Co umí:  Repo management, issues, PRs, code search, Actions
Jak:     claude mcp add github -- npx -y @modelcontextprotocol/server-github
         env: GITHUB_PERSONAL_ACCESS_TOKEN
Příklad: "Vytvoř issue 'Implementovat cenový engine' s labelem 'feature'"
         "Ukaž otevřené PRs"
```

---

## Denní rutina

```
RÁNO (15 min):
  □ Slack #vz-monitoring → nové relevantní zakázky?
  □ n8n dashboard → proběhly workflow executions OK?
  □ Rozhodni: dnes FRONTEND (Lovable) nebo BACKEND (Claude Code) nebo N8N

HLAVNÍ PRÁCE (3-5 hodin):
  Frontend: Lovable → push → ZAVŘÍT → Claude Code pull
  Backend:  Claude Code → Edge Functions / DB / skripty
  n8n:      Claude Code (navrhni JSON) → n8n GUI (import + test)

ODPOLEDNE (1-2 hodiny):
  □ Testování na reálných datech
  □ AI prompt iterace v Claude.ai
  □ Bug fixing

KONEC DNE (15 min):
  □ Git: commit + push vše
  □ Aktualizuj CLAUDE.md sekci "Na čem pracuji"
  □ Poznámky co příště
```

---

## Když se zasekneš

```
PROBLÉM                              → ŘEŠENÍ
─────────────────────────────────────────────────────────────────
MCP server se nepřipojí              → /mcp v Claude Code, zkontroluj status
                                       Zkontroluj API klíče v .mcp.json
Hlídač státu MCP nefunguje           → Beta provoz, zkus později
                                       Fallback: API přímo přes HTTP
Lovable generuje špatný kód          → Buď konkrétnější, specifikuj komponenty
Claude Code nerozumí kontextu        → Zkontroluj CLAUDE.md, /memory
n8n workflow nefunguje                → Testuj node po node, execution logs
Supabase RLS blokuje dotazy          → SQL Editor test, zkontroluj JWT
AI výstup nekvalitní                 → Iteruj prompt v Claude.ai, few-shot examples
Lovable + Claude Code konflikt       → git stash, pull, stash pop
Všechno rozbité                      → git log → vrať se na poslední funkční commit
```

---

## Referenční dokumenty v tomto balíčku

```
vz-ai-tool/
├── CLAUDE.md                              ← Kontext pro Claude Code
├── .mcp.json                              ← MCP server konfigurace
├── docs/
│   ├── todo-implementace-v3.md            ← TENTO SOUBOR
│   ├── technicka-implementace-v2.md       ← Kompletní technická analýza
│   ├── strategicka-mapa.md                ← Business case
│   └── architektura-diagramy.html         ← 10 interaktivních diagramů
└── vz-ai-pitch.pptx                       ← Pitch pro CEO (11 slidů)
```
