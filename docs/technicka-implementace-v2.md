# VZ AI Tool — Technická implementační analýza

## Dokument pro vývojový tým | Verze 2.0 | Únor 2026

> **Changelog v2.0:** Přidány sekce 15–20: Role n8n vs Supabase Edge Functions, integrace cenových feedů z distributorů, GitHub workflow a vývojová prostředí, CRM dashboard s emailem, white-label multi-tenant architektura, doporučená vývojová prostředí.

---

## 1. Executive Summary — Klíčová technická rozhodnutí

Tento dokument definuje technickou architekturu pro AI nástroj na české veřejné zakázky. Systém pracuje v cyklu: **monitoring → filtrování → analýza → oceňování → příprava nabídky**.

### Zvolená architektura (TL;DR)

| Vrstva | Technologie | Proč |
|---|---|---|
| **AI Engine** | Claude Sonnet 4.5 (primární) + Gemini 2.0 Flash (triáž) | Nejlepší poměr cena/kvalita pro češtinu, 200K context window |
| **Backend/DB** | Supabase (PostgreSQL + pgvector + Auth + Storage) | Rychlý start, pgvector pro RAG, Row Level Security pro SaaS |
| **Workflow Engine** | n8n (self-hosted na Hostinger VPS) | Již běží, AI nodes, scheduling, webhooky |
| **Frontend MVP** | Lovable → export React + Supabase | Nejrychlejší cesta k funkčnímu UI, exportovatelný kód |
| **Frontend Scale** | Next.js + Tailwind (via Claude Code) | Plná kontrola, SSR, API routes |
| **CRM integrace** | Tabidoo/LuDone via API | Existující business procesy, fakturace přes LuFak |
| **Dokumentace** | Notion | Již zavedené, knowledge base pro tým |
| **Komunikace** | Slack (n8n notifikace) | Real-time alerty na nové relevantní zakázky |
| **Hosting** | Hostinger VPS (n8n + služby) + Supabase Cloud (DB) + Vercel (frontend) | Cost-effective, oddělení concerns |

---

## 2. Porovnání AI API — Detailní analýza

### 2.1 Cenové porovnání (únor 2026)

| Model | Input $/1M tokenů | Output $/1M tokenů | Context window | Batch sleva | Prompt caching |
|---|---|---|---|---|---|
| **Claude Sonnet 4.5** | $3.00 | $15.00 | 200K | 50% | až 90% úspora |
| **Claude Haiku 4.5** | $0.80 | $4.00 | 200K | 50% | až 90% úspora |
| **Claude Opus 4.5** | $15.00 | $75.00 | 200K | 50% | až 90% úspora |
| **GPT-4o** | $2.50 | $10.00 | 128K | 50% | ~75% úspora |
| **GPT-4o-mini** | $0.15 | $0.60 | 128K | 50% | ~75% úspora |
| **o3-mini** | $1.10 | $4.40 | 200K | ne | ne |
| **Gemini 2.0 Flash** | $0.075 | $0.30 | 1M | ne | context caching |
| **Gemini 2.0 Pro** | $1.25 | $5.00 | 1M (2M preview) | ne | context caching |
| **Gemini 1.5 Pro** | $1.25 | $5.00 | 2M | ne | context caching |
| **Mistral Large** | $2.00 | $6.00 | 128K | ne | ne |
| **Mistral Small** | $0.10 | $0.30 | 32K | ne | ne |
| **DeepSeek V3** | $0.27 | $1.10 | 128K | ne | ne |
| **DeepSeek R1** | $0.55 | $2.19 | 128K | ne | ne |

### 2.2 Kvalita pro české VZ dokumenty

| Kritérium | Claude Sonnet 4.5 | GPT-4o | Gemini 2.0 Flash | Mistral Large | DeepSeek V3 |
|---|---|---|---|---|---|
| **Čeština — právní text** | ★★★★★ | ★★★★☆ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ |
| **Extrakce z PDF** | ★★★★★ | ★★★★☆ | ★★★★★ | ★★★☆☆ | ★★★☆☆ |
| **Strukturovaný output (JSON)** | ★★★★★ | ★★★★★ | ★★★★☆ | ★★★★☆ | ★★★★☆ |
| **Dlouhé dokumenty** | ★★★★☆ (200K) | ★★★☆☆ (128K) | ★★★★★ (1-2M) | ★★★☆☆ (128K) | ★★★☆☆ (128K) |
| **GDPR / data residency** | US (DPA dostupné) | US (DPA dostupné) | EU možné | EU (Francie) | Čína ⚠️ |
| **Poměr cena/výkon pro VZ** | ★★★★★ | ★★★★☆ | ★★★★★ | ★★★★☆ | ★★★★☆ (risk) |

### 2.3 Doporučená AI strategie — Multi-model approach

```
┌─────────────────────────────────────────────────────────────────┐
│                    AI MODEL ROUTING                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TRIÁŽ & KLASIFIKACE (vysoký objem, nízká cena)               │
│  → Gemini 2.0 Flash ($0.075/$0.30)                             │
│  → CPV matching, relevance scoring, keyword extraction          │
│  → ~0.18 CZK za zakázku                                       │
│                                                                 │
│  ANALÝZA DOKUMENTŮ (střední objem, střední cena)               │
│  → Claude Sonnet 4.5 ($3/$15) s prompt cachingem               │
│  → Extrakce požadavků, kvalifikace, hodnotících kritérií        │
│  → ~3.50 CZK za dokument (s cachingem právního kontextu)       │
│                                                                 │
│  PSANÍ NABÍDEK (nízký objem, vyšší cena — ale vysoká hodnota) │
│  → Claude Sonnet 4.5 ($3/$15)                                  │
│  → Technické návrhy, metodiky, krycí listy                     │
│  → ~15 CZK za sekci nabídky                                   │
│                                                                 │
│  CENOVÉ VYHLEDÁVÁNÍ (web search + analýza)                     │
│  → Gemini 2.0 Flash (levný) nebo Claude s web tools            │
│  → Hledání cen produktů, porovnání parametrů                   │
│  → ~1 CZK za položku                                          │
│                                                                 │
│  SLOŽITÁ PRÁVNÍ ANALÝZA (nízký objem, vysoká přesnost)         │
│  → Claude Opus 4.5 ($15/$75) — pouze na vyžádání              │
│  → Posouzení kvalifikačních podmínek, rizikový scoring         │
│  → ~50 CZK za hloubkovou analýzu                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.4 Měsíční náklady AI API (odhad pro Fázi 1)

| Operace | Objem/měsíc | Model | Náklad CZK |
|---|---|---|---|
| Triáž nových zakázek | 500 zakázek | Gemini Flash | ~90 |
| Analýza zadávací dokumentace | 50 dokumentů | Claude Sonnet | ~175 |
| Příprava nabídek | 10 nabídek × 5 sekcí | Claude Sonnet | ~750 |
| Cenové vyhledávání | 200 položek | Gemini Flash | ~200 |
| RAG dotazy (právní KB) | 100 dotazů | Claude Sonnet + caching | ~50 |
| **Celkem Fáze 1** | | | **~1 265 CZK/měsíc** |

S batch processingem a prompt cachingem lze snížit na **~800 CZK/měsíc**.

---

## 3. Architektura systému — Celkový pohled

### 3.1 High-level architektura

```
                    ┌──────────────────────────────┐
                    │        UŽIVATEL               │
                    │   (prohlížeč / Slack)         │
                    └──────────┬───────────────────┘
                               │
                    ┌──────────▼───────────────────┐
                    │      FRONTEND (Lovable/Next)  │
                    │   • Dashboard zakázek         │
                    │   • Upload dokumentů           │
                    │   • Cenový editor              │
                    │   • Generátor nabídek          │
                    │   Hosting: Vercel / Hostinger  │
                    └──────────┬───────────────────┘
                               │ REST / Realtime
                    ┌──────────▼───────────────────┐
                    │      SUPABASE CLOUD           │
                    │   ┌─────────────────────┐     │
                    │   │ PostgreSQL + pgvector│     │
                    │   │ • zakazky           │     │
                    │   │ • dokumenty          │     │
                    │   │ • analyzy            │     │
                    │   │ • cenovy_sklad       │     │
                    │   │ • produkty           │     │
                    │   │ • nabidky            │     │
                    │   │ • vz_embeddings      │     │
                    │   └─────────────────────┘     │
                    │   • Auth (uživatelé)           │
                    │   • Storage (PDF soubory)      │
                    │   • Edge Functions (API)       │
                    │   • Realtime (notifikace)      │
                    └──────────┬───────────────────┘
                               │ Webhooks / API
          ┌────────────────────┼────────────────────┐
          │                    │                    │
┌─────────▼──────┐  ┌─────────▼──────┐  ┌─────────▼──────┐
│   n8n ENGINE   │  │  AI API Layer  │  │   TABIDOO      │
│ (Hostinger VPS)│  │                │  │   (LuDone)     │
│                │  │ • Claude API   │  │                │
│ • VZ monitoring│  │ • Gemini API   │  │ • Fakturace    │
│ • Feed filtr   │  │ • Embeddings   │  │ • CRM kontakty │
│ • PDF parsing  │  │   (Cohere)     │  │ • Timetracking │
│ • AI orchestr. │  │                │  │                │
│ • Slack notify │  │                │  │                │
│ • Cron jobs    │  │                │  │                │
└───────┬────────┘  └────────────────┘  └────────────────┘
        │
        │ API calls
┌───────▼──────────────────────────────┐
│         DATOVÉ ZDROJE VZ             │
│                                      │
│  • Hlídač státu API (REST, JSON)     │
│  • ISVZ open data (CSV/XML export)   │
│  • NEN API (podpora.nipez.cz)        │
│  • zakazky.gov.cz (RSS/scraping)     │
│  • TED eForms API (EU nadlimitní)    │
│                                      │
└──────────────────────────────────────┘
```

### 3.2 Product Flow — Životní cyklus zakázky v systému

```
FÁZE 1: MONITORING & FILTRACE
──────────────────────────────
  n8n CRON (každých 30 min)
        │
        ▼
  Hlídač státu API ──► Nové zakázky (JSON)
  ISVZ export       ──► Nové zakázky (CSV)
  zakazky.gov.cz    ──► RSS feed
        │
        ▼
  ┌─────────────────────────┐
  │   FILTRAČNÍ ENGINE      │
  │   (n8n + Supabase)      │
  │                         │
  │   Přednastavené filtry: │
  │   • CPV kódy            │
  │   • Klíčová slova       │
  │   • Region (okres/kraj) │
  │   • Cenový rozsah       │
  │   • Typ zadavatele      │
  │   • Lhůta pro podání    │
  │                         │
  │   AI Triáž:             │
  │   • Gemini Flash scoring│
  │   • Relevance 0-100     │
  │   • Auto-tag kategorií  │
  └──────────┬──────────────┘
             │
             ▼
  Supabase: tabulka `zakazky`
  (status: "nová" → "relevantní" → "analyzovaná" → ...)
             │
             ▼
  Slack notifikace: "3 nové relevantní zakázky"
  + odkaz do dashboardu


FÁZE 2: ANALÝZA DOKUMENTŮ
──────────────────────────
  Uživatel klikne "Analyzovat" v dashboardu
  NEBO automaticky (pokud relevance > 80)
        │
        ▼
  n8n workflow "analyze_tender":
        │
        ├── 1. Stáhni zadávací dokumentaci (PDF)
        │      └── Supabase Storage
        │
        ├── 2. Extrahuj text (pymupdf4llm)
        │      └── n8n Code node / Edge Function
        │
        ├── 3. Pošli do Claude Sonnet 4.5
        │      Prompt: "Analyzuj tuto zadávací dokumentaci..."
        │      Output (structured JSON):
        │      {
        │        nazev_zakazky: "...",
        │        zadavatel: { ico, nazev, kontakt },
        │        predmet: "...",
        │        kvalifikacni_pozadavky: [...],
        │        hodnotici_kriteria: [
        │          { nazev, vaha_procent, popis }
        │        ],
        │        terminy: {
        │          lhuta_nabidek: "2026-03-15",
        │          doba_plneni: "12 měsíců",
        │          prohlidka_mista: "2026-02-28"
        │        },
        │        polozky: [
        │          { nazev, mnozstvi, jednotka, specifikace }
        │        ],
        │        rizika: [...],
        │        doporuceni_go_nogo: "GO / NOGO / ZVÁŽIT"
        │      }
        │
        └── 4. Ulož analýzu → Supabase: tabulka `analyzy`


FÁZE 3: OCEŇOVÁNÍ POLOŽEK
──────────────────────────
  Extrahované položky ze zadávací dokumentace
        │
        ▼
  ┌─────────────────────────────────┐
  │     CENOVÝ ENGINE               │
  │                                 │
  │  A) Automatický lookup:         │
  │     → Interní SKLAD CEN        │
  │       (Supabase: `produkty`)    │
  │       Match: název + parametry  │
  │                                 │
  │  B) AI cenový odhad:            │
  │     → Gemini Flash + web search │
  │       Hledá reference ceny      │
  │       na internetu              │
  │                                 │
  │  C) Historické ceny:            │
  │     → Z minulých nabídek        │
  │       (Supabase: `nabidky`)     │
  │       Inflační korekce          │
  │                                 │
  │  OUTPUT:                        │
  │  {                              │
  │    polozka: "Server Dell R750", │
  │    zdroj: "sklad_cen",          │
  │    nakupni_cena: 85000,         │
  │    doporucena_prodejni: 102000, │
  │    marze_procent: 20,           │
  │    confidence: "high",          │
  │    alternativy: [...]           │
  │  }                              │
  └──────────┬──────────────────────┘
             │
             ▼
  Dashboard: Tabulka položek s cenami
  → Uživatel validuje / upravuje ceny
  → Uloží do Supabase + aktualizuje sklad cen


FÁZE 4: PŘÍPRAVA NABÍDKY
─────────────────────────
  Uživatel spustí "Připravit nabídku"
        │
        ▼
  n8n workflow "generate_bid":
        │
        ├── 1. Claude Sonnet: Technický návrh
        │      (vstup: analýza + profil firmy + šablony)
        │
        ├── 2. Claude Sonnet: Metodika plnění
        │      (vstup: hodnotící kritéria + best practices)
        │
        ├── 3. Auto-generace: Krycí list nabídky
        │      (vstup: oceněné položky + data firmy)
        │
        ├── 4. Auto-generace: Čestná prohlášení
        │      (šablony + data firmy z Tabidoo/LuDone)
        │
        ├── 5. Compliance check:
        │      Claude: "Ověř že nabídka splňuje..."
        │      → Seznam nesplněných požadavků
        │
        └── 6. OUTPUT:
               → ZIP s připravenými dokumenty
               → Dashboard: checklist pro finalizaci
               → Slack: "Nabídka pro [zakázka] připravena"
```

---

## 4. Databázové schéma (Supabase PostgreSQL)

### 4.1 Klíčové tabulky

```sql
-- ============================================================
-- JÁDRO: Zakázky a jejich životní cyklus
-- ============================================================

CREATE TABLE zakazky (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id TEXT,                    -- ID z Hlídače státu / ISVZ
    zdroj TEXT NOT NULL,                 -- 'hlidac_statu', 'isvz', 'nen', 'manual'
    nazev TEXT NOT NULL,
    zadavatel_nazev TEXT,
    zadavatel_ico TEXT,
    cpv_kody TEXT[],                     -- Array CPV kódů
    predpokladana_hodnota BIGINT,        -- v CZK (haléře)
    typ_zakazky TEXT,                    -- 'dodavky', 'sluzby', 'stavebni_prace'
    typ_rizeni TEXT,                     -- 'otevrene', 'uzsi', 'jrbu', ...
    region TEXT,                         -- kraj / okres
    lhuta_nabidek TIMESTAMPTZ,
    url_profil TEXT,                     -- odkaz na profil zadavatele
    url_dokumentace TEXT,                -- odkaz na zadávací dokumentaci

    -- AI scoring
    relevance_score INTEGER DEFAULT 0,   -- 0-100, AI scoring
    ai_tags TEXT[],                       -- automatické tagy
    ai_summary TEXT,                      -- krátký AI souhrn

    -- Workflow status
    status TEXT DEFAULT 'nova',          -- nova → relevantni → analyzovana →
                                         -- ocenena → pripravena → odeslana →
                                         -- vyhodnocena → vyhrali / prohrali
    rozhodnuti TEXT,                      -- 'go', 'nogo', 'zvazit'

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    user_id UUID REFERENCES auth.users(id) -- multi-tenant
);

-- Index pro fulltext search v češtině
CREATE INDEX idx_zakazky_search ON zakazky
    USING GIN (to_tsvector('czech', nazev || ' ' || COALESCE(ai_summary, '')));

-- ============================================================
-- ANALÝZY: Strukturovaný výstup AI analýzy dokumentů
-- ============================================================

CREATE TABLE analyzy (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zakazka_id UUID REFERENCES zakazky(id) ON DELETE CASCADE,

    -- Extrahované údaje (JSON pro flexibilitu)
    kvalifikacni_pozadavky JSONB,        -- [{typ, popis, splneno: bool}]
    hodnotici_kriteria JSONB,            -- [{nazev, vaha_procent, popis}]
    terminy JSONB,                       -- {lhuta, doba_plneni, ...}
    technicke_pozadavky JSONB,           -- [{kategorie, pozadavek, specifikace}]
    polozky JSONB,                       -- [{nazev, mnozstvi, jednotka, spec}]
    rizika JSONB,                        -- [{popis, zavaznost, mitigace}]

    doporuceni TEXT,                      -- GO / NOGO / ZVÁŽIT s odůvodněním
    raw_ai_response JSONB,               -- kompletní AI odpověď pro debug

    ai_model TEXT,                       -- 'claude-sonnet-4-5'
    ai_cost_czk DECIMAL(10,2),           -- náklad na AI analýzu
    processing_time_ms INTEGER,

    created_at TIMESTAMPTZ DEFAULT now(),
    user_id UUID REFERENCES auth.users(id)
);

-- ============================================================
-- SKLAD CEN: Cenová databáze produktů a služeb
-- ============================================================

CREATE TABLE produkty (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nazev TEXT NOT NULL,
    kategorie TEXT,                       -- 'HW', 'SW', 'sluzba', 'material', ...
    vyrobce TEXT,
    model TEXT,
    part_number TEXT,                     -- katalogové číslo

    -- Parametry (flexibilní pro různé typy produktů)
    parametry JSONB,                     -- {ram: "64GB", cpu: "Xeon", ...}

    -- Cenová data
    nakupni_cena DECIMAL(12,2),          -- poslední známá nákupní cena
    nakupni_cena_datum DATE,             -- kdy byla cena zjištěna
    nakupni_zdroj TEXT,                  -- 'dodavatel_x', 'eshop_y', 'web'
    doporucena_marze DECIMAL(5,2),       -- % marže

    -- Metadata
    aktivni BOOLEAN DEFAULT true,
    tags TEXT[],
    poznamky TEXT,

    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    user_id UUID REFERENCES auth.users(id)
);

-- Fulltext search na produktech
CREATE INDEX idx_produkty_search ON produkty
    USING GIN (to_tsvector('czech', nazev || ' ' || COALESCE(vyrobce, '') || ' ' || COALESCE(model, '')));

-- ============================================================
-- CENOVÉ POLOŽKY: Oceněné položky ke konkrétní zakázce
-- ============================================================

CREATE TABLE cenove_polozky (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zakazka_id UUID REFERENCES zakazky(id) ON DELETE CASCADE,
    analyza_id UUID REFERENCES analyzy(id),

    nazev_polozky TEXT NOT NULL,          -- název z zadávací dokumentace
    mnozstvi DECIMAL(12,3),
    jednotka TEXT,                        -- 'ks', 'hod', 'm2', ...
    specifikace TEXT,                     -- požadovaná specifikace

    -- Matching s produktovým katalogem
    produkt_id UUID REFERENCES produkty(id),
    match_confidence TEXT,                -- 'exact', 'similar', 'manual', 'ai_estimate'
    match_score DECIMAL(5,2),            -- 0-100

    -- Ceny
    jednotkova_cena DECIMAL(12,2),
    celkova_cena DECIMAL(14,2),          -- = mnozstvi × jednotkova_cena
    nakupni_cena DECIMAL(12,2),
    marze_procent DECIMAL(5,2),

    -- Zdroj ceny
    cenovy_zdroj TEXT,                   -- 'sklad', 'web_ai', 'historie', 'manual'
    cenovy_zdroj_detail TEXT,            -- URL nebo popis

    -- Alternativy (AI navržené)
    alternativy JSONB,                   -- [{nazev, cena, zdroj, vyhodnost}]

    status TEXT DEFAULT 'ai_navrh',      -- ai_navrh → overeno → schvaleno
    created_at TIMESTAMPTZ DEFAULT now(),
    user_id UUID REFERENCES auth.users(id)
);

-- ============================================================
-- NABÍDKY: Finální nabídkové dokumenty
-- ============================================================

CREATE TABLE nabidky (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zakazka_id UUID REFERENCES zakazky(id) ON DELETE CASCADE,

    celkova_cena DECIMAL(14,2),
    celkova_cena_dph DECIMAL(14,2),

    -- Generované sekce
    technicky_navrh TEXT,                -- AI-generovaný text
    metodika TEXT,                       -- AI-generovaná metodika
    kryci_list JSONB,                    -- strukturovaná data pro template

    -- Compliance
    compliance_check JSONB,              -- [{pozadavek, splneno, komentar}]
    compliance_score DECIMAL(5,2),       -- % splněných požadavků

    -- Soubory
    dokumenty_paths TEXT[],              -- cesty v Supabase Storage

    status TEXT DEFAULT 'draft',         -- draft → review → final → odeslana
    odeslana_at TIMESTAMPTZ,
    vysledek TEXT,                       -- 'vyhrali', 'prohrali', 'zruseno'
    vysledek_poznamky TEXT,

    created_at TIMESTAMPTZ DEFAULT now(),
    user_id UUID REFERENCES auth.users(id)
);

-- ============================================================
-- FILTRY: Uživatelské přednastavené filtry pro monitoring
-- ============================================================

CREATE TABLE monitoring_filtry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nazev TEXT NOT NULL,                  -- "IT zakázky Jihomoravský kraj"
    aktivni BOOLEAN DEFAULT true,

    cpv_kody TEXT[],                      -- ['72000000', '48000000']
    klicova_slova TEXT[],                 -- ['server', 'síť', 'IT']
    vylucujici_slova TEXT[],             -- ['úklid', 'stravování']
    regiony TEXT[],                       -- ['CZ064', 'CZ062'] - NUTS kódy
    min_hodnota BIGINT,                  -- minimální předpokládaná hodnota
    max_hodnota BIGINT,
    typy_zakazek TEXT[],                 -- ['dodavky', 'sluzby']
    typy_rizeni TEXT[],
    min_dnu_do_lhuty INTEGER DEFAULT 7,  -- min. zbývajících dní

    -- Notifikace
    slack_channel TEXT,                  -- '#vz-monitoring'
    email_notify BOOLEAN DEFAULT false,
    notify_frequency TEXT DEFAULT 'instant', -- 'instant', 'daily', 'weekly'

    created_at TIMESTAMPTZ DEFAULT now(),
    user_id UUID REFERENCES auth.users(id)
);

-- ============================================================
-- RAG: Embeddings pro právní knowledge base
-- ============================================================

CREATE TABLE vz_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zdroj TEXT NOT NULL,                 -- 'zzvz', 'vyhlaska', 'uohs', 'metodika'
    dokument TEXT NOT NULL,              -- 'zákon 134/2016 Sb.'
    sekce TEXT,                          -- '§ 73 - Kvalifikace'
    chunk_text TEXT NOT NULL,            -- text chunku
    chunk_index INTEGER,
    embedding vector(1024),              -- Cohere embed-multilingual-v3.0
    metadata JSONB,                      -- {paragraf, odstavec, datum_ucinnosti}

    created_at TIMESTAMPTZ DEFAULT now()
);

-- HNSW index pro rychlé vector search
CREATE INDEX idx_embeddings_vector ON vz_embeddings
    USING hnsw (embedding vector_cosine_ops);
```

### 4.2 Row Level Security (pro budoucí multi-tenant SaaS)

```sql
-- Zapnout RLS
ALTER TABLE zakazky ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyzy ENABLE ROW LEVEL SECURITY;
ALTER TABLE produkty ENABLE ROW LEVEL SECURITY;
-- ... pro všechny tabulky

-- Policy: uživatel vidí jen svá data
CREATE POLICY "Users see own data" ON zakazky
    FOR ALL USING (auth.uid() = user_id);

-- V Fázi 1 (single tenant) stačí jeden user
-- V Fázi 2 (SaaS) přidáme organization_id a team policies
```

---

## 5. Backend: n8n Workflow architektura

### 5.1 Přehled n8n workflows

```
┌─────────────────────────────────────────────────────────────┐
│                    n8n WORKFLOWS                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  🔄 SCHEDULED (CRON)                                       │
│  ├── vz_monitor_hlidac     (každých 30 min)                │
│  ├── vz_monitor_isvz       (denně 6:00)                    │
│  ├── vz_monitor_rss        (každou hodinu)                 │
│  ├── ceny_aktualizace      (týdně)                         │
│  └── daily_digest           (denně 8:00 → Slack)           │
│                                                             │
│  🔗 WEBHOOK (volané z frontendu / Supabase)                │
│  ├── analyze_tender         POST /webhook/analyze           │
│  ├── price_items            POST /webhook/price             │
│  ├── generate_bid           POST /webhook/generate-bid      │
│  ├── compliance_check       POST /webhook/compliance        │
│  └── rag_query              POST /webhook/rag               │
│                                                             │
│  📨 TRIGGERED (Supabase webhooks)                           │
│  ├── on_zakazka_created     (nová zakázka → auto-triáž)    │
│  ├── on_status_change       (status change → notifikace)    │
│  └── on_nabidka_final       (nabídka finální → LuDone)      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Klíčový workflow: vz_monitor_hlidac

```
[Cron: */30 * * * *]
    │
    ▼
[HTTP Request: Hlídač státu API]
  GET /api/v2/verejnezakazky/hledat
  ?dotaz=*
  &stav=1  (zahájené)
  &razeni=2 (nejnovější)
  ?page=1&size=50
    │
    ▼
[Loop: pro každou zakázku]
    │
    ├── [Supabase: CHECK existuje?]
    │     SELECT id FROM zakazky
    │     WHERE external_id = {{$json.id}}
    │     │
    │     ├── EXISTS → Skip
    │     └── NOT EXISTS ▼
    │
    ├── [Supabase: Načti aktivní filtry]
    │     SELECT * FROM monitoring_filtry
    │     WHERE aktivni = true
    │
    ├── [Code Node: Aplikuj filtry]
    │     - CPV kódy match?
    │     - Klíčová slova v názvu?
    │     - Region match?
    │     - Cenový rozsah ok?
    │     - Dostatek dní do lhůty?
    │     → relevance_score (0-100)
    │
    ├── [IF: relevance_score > 30]
    │     │
    │     ├── TRUE ▼
    │     │   [AI: Gemini Flash - triáž]
    │     │     "Ohodnoť relevanci 0-100 pro IT firmu..."
    │     │     → Upraven relevance_score
    │     │     → ai_tags, ai_summary
    │     │
    │     │   [Supabase: INSERT zakazka]
    │     │     status = 'relevantni'
    │     │
    │     │   [IF: relevance_score > 70]
    │     │     │
    │     │     └── [Slack: Notifikace]
    │     │           #vz-monitoring
    │     │           "🎯 Nová relevantní zakázka (score: 85)"
    │     │           "[Název] | [Zadavatel] | [Hodnota]"
    │     │           "Lhůta: [datum] | [odkaz do dashboardu]"
    │     │
    │     └── FALSE → [Supabase: INSERT status='nova']
    │
    └── [End Loop]
```

### 5.3 Klíčový workflow: analyze_tender

```
[Webhook: POST /webhook/analyze]
  Body: { zakazka_id: "uuid" }
    │
    ▼
[Supabase: Načti zakázku]
  SELECT * FROM zakazky WHERE id = zakazka_id
    │
    ▼
[HTTP Request: Stáhni PDF]
  GET url_dokumentace
  → Binary data
    │
    ▼
[Supabase Storage: Upload PDF]
  Bucket: 'dokumentace'
  Path: '{zakazka_id}/zadavaci_dokumentace.pdf'
    │
    ▼
[Code Node: PDF → Text]
  // Varianta A: pymupdf4llm přes Python subprocess
  // Varianta B: pdf-parse npm knihovna
  // Varianta C: Edge Function na Supabase
  → Extrahovaný text (markdown)
    │
    ▼
[AI: Claude Sonnet 4.5]
  System prompt (cached):
    "Jsi expert na české veřejné zakázky.
     Analyzuj zadávací dokumentaci a extrahuj
     strukturovaná data ve formátu JSON..."

  User message:
    "{extrahovaný text dokumentu}"

  → JSON response s analýzou
    │
    ▼
[Code Node: Parse & validate JSON]
    │
    ▼
[Supabase: INSERT do `analyzy`]
    │
    ▼
[Supabase: UPDATE zakazka status = 'analyzovana']
    │
    ▼
[Slack: "✅ Analýza dokončena: [název zakázky]"]
    │
    ▼
[Respond to Webhook: 200 OK + analysis_id]
```

---

## 6. Frontend architektura

### 6.1 Doporučený přístup: Lovable MVP → Next.js Scale

```
FÁZE 1-2 (MVP + Early SaaS):  LOVABLE
───────────────────────────────────────
  + Nejrychlejší cesta k funkčnímu UI (dny, ne týdny)
  + Nativní Supabase integrace (Auth, DB, Storage)
  + Generuje čistý React + Tailwind kód
  + Exportovatelný do GitHub — vlastníte kód
  + Iterace přes přirozený jazyk
  - Omezení na složitější custom komponenty
  - Méně kontroly nad architekturou

FÁZE 3 (Enterprise Scale):  NEXT.js + CLAUDE CODE
───────────────────────────────────────────────────
  + Plná kontrola nad architekturou
  + SSR pro SEO (marketing pages)
  + API Routes jako backend
  + Claude Code pro rychlý vývoj
  - Vyžaduje více dev času
  - Manuální setup Auth, DB integrace
```

### 6.2 MVP Frontend — Screens a komponenty

```
┌─────────────────────────────────────────────────────────────┐
│  VZ AI TOOL — MVP FRONTEND SCREENS                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  📊 DASHBOARD (hlavní stránka)                             │
│  ├── Statistiky: celkem zakázek, analyzovaných, nabídek     │
│  ├── Nové relevantní zakázky (karty s score)               │
│  ├── Blížící se termíny (timeline)                         │
│  └── Rychlé akce: "Analyzovat", "Zobrazit feed"            │
│                                                             │
│  📋 FEED ZAKÁZEK (filtrovatelný seznam)                    │
│  ├── Tabulka: název, zadavatel, hodnota, lhůta, score      │
│  ├── Filtry: CPV, region, typ, status, datum                │
│  ├── Řazení: relevance, datum, hodnota                      │
│  ├── Bulk akce: "Analyzovat vybrané"                        │
│  └── Status badges: nová, relevantní, analyzovaná, ...     │
│                                                             │
│  🔍 DETAIL ZAKÁZKY                                         │
│  ├── Záložka: Přehled (AI souhrn, score, metadata)          │
│  ├── Záložka: Analýza (požadavky, kritéria, termíny)        │
│  ├── Záložka: Položky & Ceny (cenový editor)               │
│  ├── Záložka: Nabídka (generátor, compliance check)        │
│  ├── Záložka: Dokumenty (PDF viewer, upload)                │
│  └── Sidebar: GO/NOGO rozhodnutí, poznámky                 │
│                                                             │
│  💰 CENOVÝ EDITOR (klíčový screen)                        │
│  ├── Tabulka položek z analýzy                              │
│  ├── Pro každou položku:                                    │
│  │   ├── AI-navržená cena + zdroj + confidence              │
│  │   ├── Match z produktového katalogu                      │
│  │   ├── Alternativy (dropdown)                              │
│  │   ├── Editovatelné pole: cena, marže                     │
│  │   └── Status: AI návrh → ověřeno → schváleno            │
│  ├── Celková cena nabídky (auto-kalkulace)                  │
│  └── Export: Excel, krycí list                              │
│                                                             │
│  📦 PRODUKTOVÝ KATALOG / SKLAD CEN                         │
│  ├── CRUD pro produkty (název, výrobce, parametry, cena)   │
│  ├── Import z CSV/Excel                                     │
│  ├── Hledání a filtrování                                   │
│  ├── Historie cen (graf)                                    │
│  └── Bulk update cen                                        │
│                                                             │
│  ⚙️ NASTAVENÍ                                              │
│  ├── Monitorovací filtry (CRUD)                             │
│  ├── Profil firmy (pro generování nabídek)                  │
│  ├── Šablony dokumentů                                      │
│  ├── Slack integrace                                        │
│  ├── API klíče (AI providers)                               │
│  └── Uživatelé a role (Fáze 2+)                            │
│                                                             │
│  📄 GENERÁTOR NABÍDKY                                      │
│  ├── Checklist požadavků (z analýzy)                        │
│  ├── AI-generované sekce (editovatelné)                     │
│  ├── Compliance score (real-time)                           │
│  ├── Preview dokumentů                                      │
│  └── Export: DOCX, PDF, ZIP                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 Lovable prompt pro MVP

Pro vytvoření MVP v Lovable doporučuji rozdělit na 3–4 iterace:

**Iterace 1:** Dashboard + Feed zakázek + základní CRUD
**Iterace 2:** Detail zakázky + analýza + cenový editor
**Iterace 3:** Produktový katalog + filtry nastavení
**Iterace 4:** Generátor nabídky + compliance check

Každou iteraci definujte Lovable promptem s referencí na Supabase tabulky.

---

## 7. Sklad cen & Produktový katalog

### 7.1 Architektura cenového engine

```
┌─────────────────────────────────────────────────────────────┐
│                  CENOVÝ ENGINE                              │
│                                                             │
│   INPUT: Položka ze zadávací dokumentace                    │
│   { nazev: "Server rack 42U",                               │
│     specifikace: "min. 1000kg nosnost, perforované dveře" } │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   KROK 1: Exact match v produktovém katalogu               │
│   ─────────────────────────────────────────                 │
│   SELECT * FROM produkty                                    │
│   WHERE nazev ILIKE '%server rack 42U%'                     │
│   OR part_number = '...'                                    │
│   → Nalezen? → confidence: "exact" → HOTOVO                │
│                                                             │
│   KROK 2: Sémantický match (pgvector)                      │
│   ─────────────────────────────────────                     │
│   Embedding položky → cosine similarity s produkty          │
│   → Similarity > 0.85? → confidence: "similar" → NABÍDNI   │
│                                                             │
│   KROK 3: AI cenový odhad                                  │
│   ───────────────────────                                   │
│   Gemini Flash: "Najdi přibližnou tržní cenu pro:          │
│   [specifikace]. Uveď zdroj."                               │
│   → confidence: "ai_estimate" → NABÍDNI K VALIDACI         │
│                                                             │
│   KROK 4: Historická data                                   │
│   ─────────────────────                                     │
│   SELECT cena FROM cenove_polozky                           │
│   WHERE nazev_polozky SIMILAR TO '...'                      │
│   AND created_at > now() - interval '2 years'               │
│   → Inflační korekce (ČSÚ index)                           │
│   → confidence: "historie" → NABÍDNI K VALIDACI            │
│                                                             │
│   OUTPUT: Seřazený seznam cenových návrhů                   │
│   [{cena, zdroj, confidence, detail}]                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘

FEEDBACK LOOP:
──────────────
Každá manuálně ověřená/upravená cena:
  → Aktualizuje produktový katalog
  → Trénuje matching algoritmus (lepší příště)
  → Buduje cenovou historii
  → = DATOVÝ MOAT (roste s každou zakázkou)
```

### 7.2 Produktový katalog — struktura parametrů

```json
// Příklad: IT hardware
{
  "nazev": "Dell PowerEdge R760",
  "kategorie": "HW/server",
  "vyrobce": "Dell Technologies",
  "model": "R760",
  "part_number": "PER760-001",
  "parametry": {
    "cpu": "2× Intel Xeon Gold 6430",
    "ram": "256 GB DDR5",
    "storage": "4× 1.92TB NVMe SSD",
    "formfaktor": "2U rack",
    "zaruka": "3 roky ProSupport"
  },
  "nakupni_cena": 285000,
  "nakupni_cena_datum": "2026-01-15",
  "nakupni_zdroj": "Dell Premier Partner",
  "doporucena_marze": 18.5,
  "tags": ["server", "rack", "enterprise", "dell"]
}

// Příklad: Služba
{
  "nazev": "Konzultační hodina - senior IT architekt",
  "kategorie": "sluzba/konzultace",
  "parametry": {
    "seniorita": "senior (10+ let)",
    "certifikace": ["TOGAF", "AWS SA Pro"],
    "dostupnost": "po-pá 8-17"
  },
  "nakupni_cena": 1200,
  "nakupni_cena_datum": "2026-02-01",
  "nakupni_zdroj": "interní kalkulace",
  "doporucena_marze": 35,
  "tags": ["konzultace", "IT", "architektura"]
}
```

---

## 8. RAG Knowledge Base — Právní znalostní báze

### 8.1 Obsah knowledge base

| Zdroj | Rozsah | Aktualizace | Priorita |
|---|---|---|---|
| Zákon 134/2016 Sb. (ZZVZ) | ~500K tokenů | Při novelách | P0 - kritické |
| Prováděcí vyhlášky (168/2016, 169/2016, 170/2016, 345/2023) | ~200K tokenů | Při změnách | P0 |
| Metodiky MMR | ~300K tokenů | Čtvrtletně | P1 |
| Rozhodnutí ÚOHS (databáze) | ~2M tokenů (klíčová) | Měsíčně | P1 |
| Judikatura NSS/KS | ~500K tokenů | Měsíčně | P2 |
| Metodické pokyny ÚOHS | ~100K tokenů | Při vydání | P1 |

### 8.2 RAG pipeline

```
INDEXOVÁNÍ (jednorázové + aktualizace):
──────────────────────────────────────
  Zdrojový dokument (zákon, metodika, rozhodnutí)
      │
      ▼
  Chunking (512 tokenů, overlap 64)
  Speciální pravidla pro právní text:
    - Nerozdělovat uprostřed paragrafu
    - Zachovat kontext (§ číslo, odstavec)
    - Metadata: {zdroj, paragraf, datum_ucinnosti}
      │
      ▼
  Embedding: Cohere embed-multilingual-v3.0
  (1024 dimenzí, $0.10/M tokenů)
      │
      ▼
  Uložení: Supabase pgvector (tabulka vz_embeddings)


DOTAZOVÁNÍ (runtime):
─────────────────────
  Uživatelský dotaz / AI potřebuje právní kontext
      │
      ▼
  Embedding dotazu (Cohere)
      │
      ▼
  Vector search (pgvector cosine similarity)
  + Keyword search (tsvector Czech)
  = Hybrid search (RRF fusion)
      │
      ▼
  Top 5-10 relevantních chunků
      │
      ▼
  Claude Sonnet 4.5:
    System: "Jsi právní expert na VZ. Odpověz na základě
             poskytnutého kontextu ze zákona a judikatury."
    Context: [relevantní chunky s citacemi]
    User: [dotaz]
      │
      ▼
  Odpověď s citacemi zdrojů (§, rozhodnutí ÚOHS, ...)
```

---

## 9. Integrace datových zdrojů VZ

### 9.1 Hlídač státu API (primární zdroj)

```
Endpoint: https://www.hlidacstatu.cz/api/v2/verejnezakazky/hledat
Auth: Bearer token (registrace na hlidacstatu.cz)
Licence: CC BY 3.0 CZ (bezplatné i komerční)
Rate limit: ~100 req/min (přiměřené užití)

Dostupná data:
  - Základní údaje o zakázce (název, zadavatel, hodnota)
  - CPV kódy, typ řízení, stav
  - Datum zahájení, lhůta pro nabídky
  - Odkaz na profil zadavatele
  - Dodavatelé (u uzavřených)
  - Nabídkové ceny (u uzavřených)

n8n integrace:
  → HTTP Request node
  → Cron schedule (každých 30 min)
  → Pagination handling (Code node)
```

### 9.2 NEN Public API

```
Endpoint: podpora.nipez.cz/en/verejne-api-systemu-nen/
Dokumentace: OpenAPI / Swagger
Auth: Registrace dodavatele v NEN

Dostupná data:
  - Zakázky z NEN systému
  - Dokumentace ke stažení
  - Profily zadavatelů

Omezení:
  - Pokrývá ~8% zadavatelů (státní orgány)
  - Vyžaduje registraci
```

### 9.3 ISVZ Open Data

```
Endpoint: portal-vz.cz (open data export)
Formát: CSV + XML (eForms od 2/2024)
Frekvence: Denní exporty
Auth: Volně dostupné

XSD schémata: Vyhláška č. 345/2023 Sb.
  → Strukturovaná data o zakázkách
  → Machine-readable profily zadavatelů
```

### 9.4 Mapa napojení na datové zdroje

```
┌──────────────────────┐     ┌──────────────────────┐
│   Hlídač státu       │────►│                      │
│   (REST API)         │     │                      │
│   ~15K zakázek/rok   │     │                      │
└──────────────────────┘     │                      │
                             │    n8n MONITORING     │
┌──────────────────────┐     │    WORKFLOWS          │
│   ISVZ Open Data     │────►│                      │
│   (CSV/XML export)   │     │    Deduplikace       │
│   Denní export       │     │    Normalizace       │
└──────────────────────┘     │    Filtrování        │
                             │    AI Triáž          │
┌──────────────────────┐     │                      │
│   NEN API            │────►│                      │────► Supabase
│   (REST API)         │     │                      │      (zakazky)
│   Státní orgány      │     │                      │
└──────────────────────┘     │                      │
                             │                      │
┌──────────────────────┐     │                      │
│   zakazky.gov.cz     │────►│                      │
│   (RSS/web)          │     │                      │
│   Agregátor          │     │                      │
└──────────────────────┘     │                      │
                             │                      │
┌──────────────────────┐     │                      │
│   TED eForms API     │────►│                      │
│   (REST API)         │     │                      │
│   Nadlimitní EU      │     │                      │
└──────────────────────┘     └──────────────────────┘
```

---

## 10. Hosting & infrastruktura

### 10.1 Doporučená konfigurace

```
┌─────────────────────────────────────────────────────────────┐
│                   INFRASTRUKTURA                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  HOSTINGER VPS (existující)                                │
│  ├── n8n (Docker)                                          │
│  │   └── 2-4 GB RAM, stačí pro AI workflows                │
│  ├── Reverse proxy (Nginx/Caddy)                           │
│  ├── pymupdf4llm service (Python, pro PDF extraction)      │
│  └── Volitelně: Qdrant (pokud pgvector nestačí)            │
│  Náklad: ~300-600 CZK/měsíc (existující)                  │
│                                                             │
│  SUPABASE CLOUD                                            │
│  ├── Free tier: 500 MB DB, 1 GB storage, 50K auth users   │
│  │   → Stačí pro Fázi 1                                    │
│  ├── Pro tier ($25/měsíc = ~585 CZK):                     │
│  │   8 GB DB, 100 GB storage, 100K auth users              │
│  │   → Pro Fázi 2                                          │
│  └── pgvector: Zahrnuto ve všech tierech                   │
│                                                             │
│  VERCEL (frontend hosting)                                  │
│  ├── Free tier: dostatečný pro MVP                         │
│  ├── Pro ($20/měsíc = ~470 CZK): custom domain, analytics │
│  └── Automatický deploy z GitHub                           │
│                                                             │
│  AI API                                                     │
│  ├── Anthropic: Pay-as-you-go, DPA dostupné               │
│  ├── Google AI: Pay-as-you-go, $0 free credit start        │
│  └── Cohere: Free tier pro embeddings (100K/měsíc)         │
│                                                             │
│  CELKOVÉ MĚSÍČNÍ NÁKLADY:                                  │
│  ├── Fáze 1 (MVP):    ~1 500-2 500 CZK/měsíc             │
│  ├── Fáze 2 (SaaS):   ~3 500-7 000 CZK/měsíc             │
│  └── Fáze 3 (Scale):  ~15 000-35 000 CZK/měsíc           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 11. Development phases — TODO kroky

### FÁZE 0: Setup (Týden 1-2)

```
□ INFRASTRUKTURA
  □ Supabase projekt: vytvořit na supabase.com
  □ Databáze: spustit SQL schéma (sekce 4)
  □ Supabase Storage: vytvořit buckety (dokumentace, nabidky, sablony)
  □ n8n: ověřit běžící instanci na Hostinger VPS
  □ n8n: nainstalovat community nodes (Supabase, AI providers)
  □ GitHub repo: vytvořit `vz-ai-tool` monorepo
  □ Vercel: propojit s GitHub repo

□ API KLÍČE
  □ Anthropic API key (Claude)
  □ Google AI Studio API key (Gemini)
  □ Cohere API key (embeddings)
  □ Hlídač státu API token
  □ Slack webhook URL pro #vz-monitoring

□ DOKUMENTACE
  □ Notion: vytvořit workspace "VZ AI Tool"
  □ Notion: architektura (odkaz na tento dokument)
  □ Notion: API dokumentace
  □ Notion: prompt library (systémové prompty pro AI)
```

### FÁZE 1A: Monitoring pipeline (Týden 3-5)

```
□ n8n WORKFLOW: vz_monitor_hlidac
  □ HTTP Request node → Hlídač státu API
  □ Pagination handling (Code node)
  □ Deduplikace (Supabase lookup)
  □ Uložení do Supabase `zakazky`
  □ Testování: denní běh, kontrola dat

□ n8n WORKFLOW: filter_and_score
  □ Načtení aktivních filtrů z Supabase
  □ Code node: aplikace filtrů (CPV, region, klíčová slova)
  □ AI node: Gemini Flash triáž (relevance scoring)
  □ Update zakazky s score a tagy
  □ Testování: ověřit kvalitu scoringu na 50 zakázkách

□ n8n WORKFLOW: slack_notify
  □ Trigger: nová zakázka s score > 70
  □ Formátovaná Slack zpráva s detaily
  □ Odkaz do budoucího dashboardu
  □ Testování: ověřit doručení do Slacku

□ SUPABASE: monitoring_filtry
  □ Seed data: první sada filtrů pro vaše CPV kódy
  □ Edge Function: CRUD API pro filtry
```

### FÁZE 1B: Analýza dokumentů (Týden 5-8)

```
□ PDF EXTRACTION SERVICE
  □ Python script: pymupdf4llm wrapper
  □ Nasazení na Hostinger VPS (FastAPI nebo Flask endpoint)
  □ Endpoint: POST /extract-pdf → markdown text
  □ Testování: 10 reálných zadávacích dokumentací

□ n8n WORKFLOW: analyze_tender
  □ Webhook trigger (POST /webhook/analyze)
  □ Stažení PDF ze zadávací dokumentace
  □ Volání PDF extraction service
  □ Claude Sonnet 4.5 analýza (prompt v Notion)
  □ Parse JSON response
  □ Uložení do Supabase `analyzy`
  □ Slack notifikace o dokončení
  □ Testování: 10 reálných zakázek, validace kvality

□ PROMPT ENGINEERING
  □ System prompt pro analýzu (iterovat na 20+ dokumentech)
  □ JSON schema pro strukturovaný output
  □ Prompt pro GO/NOGO doporučení
  □ Uložit finální prompty do Notion
```

### FÁZE 1C: Cenový engine (Týden 8-11)

```
□ PRODUKTOVÝ KATALOG
  □ Supabase: tabulka `produkty` (dle schématu)
  □ Import existujících produktů (CSV/Excel)
  □ Embeddings pro produkty (Cohere → pgvector)

□ CENOVÝ MATCHING
  □ Supabase Edge Function: match_product
    □ Exact match (název, part_number)
    □ Sémantický match (pgvector cosine similarity)
    □ Fallback: AI cenový odhad (Gemini Flash)

□ n8n WORKFLOW: price_items
  □ Webhook trigger
  □ Pro každou položku z analýzy:
    □ Volání match_product Edge Function
    □ Agregace výsledků
  □ Uložení do Supabase `cenove_polozky`

□ FEEDBACK LOOP
  □ Supabase trigger: po manuální úpravě ceny
    → aktualizovat `produkty` (nakupni_cena, datum)
```

### FÁZE 1D: MVP Frontend (Týden 9-13, paralelně s 1C)

```
□ LOVABLE: Iterace 1 — Dashboard + Feed
  □ Prompt: Dashboard s metrikami (celkem zakázek, score, ...)
  □ Tabulka zakázek s filtry a řazením
  □ Supabase Auth (login/register)
  □ Napojení na Supabase DB (zakazky tabulka)

□ LOVABLE: Iterace 2 — Detail zakázky + Analýza
  □ Detail view s tabbed layout
  □ Zobrazení AI analýzy (JSON → hezký UI)
  □ Tlačítko "Analyzovat" → volání n8n webhook
  □ Loading state během analýzy

□ LOVABLE: Iterace 3 — Cenový editor
  □ Tabulka položek s editovatelnými cenami
  □ Match status indikátory (exact/similar/estimate)
  □ Alternativy v dropdown
  □ Auto-kalkulace celkové ceny
  □ Tlačítko "Ocenit" → volání n8n webhook

□ LOVABLE: Iterace 4 — Produktový katalog
  □ CRUD pro produkty
  □ Search a filtrování
  □ Import z CSV
  □ Historie cen (jednoduchý graf)

□ EXPORT Z LOVABLE
  □ Export kódu do GitHub repo
  □ Deploy na Vercel
  □ Custom doména (vz.ludone.cz nebo nový název)
```

### FÁZE 1E: Generátor nabídek (Týden 12-16)

```
□ ŠABLONY
  □ Notion: šablona krycího listu
  □ Notion: šablona čestného prohlášení
  □ Notion: šablona technického návrhu

□ n8n WORKFLOW: generate_bid
  □ Webhook trigger
  □ Claude Sonnet: generování technického návrhu
  □ Claude Sonnet: generování metodiky
  □ Template engine: krycí list (data firmy + ceny)
  □ Template engine: čestná prohlášení
  □ Compliance check (Claude: ověření úplnosti)
  □ Export: ZIP s dokumenty

□ FRONTEND: Generátor nabídky screen
  □ Checklist požadavků
  □ Editovatelné AI-generované sekce
  □ Compliance score
  □ Download ZIP
```

### FÁZE 2: SaaS přechod (Měsíc 5-10)

```
□ MULTI-TENANCY
  □ Supabase RLS policies pro organization_id
  □ Onboarding flow pro nové firmy
  □ Billing integrace (Stripe / GoPay)

□ RAG KNOWLEDGE BASE
  □ Zpracování zákona 134/2016 Sb. (chunking + embeddings)
  □ Zpracování prováděcích vyhlášek
  □ Import klíčových rozhodnutí ÚOHS
  □ Edge Function: RAG query endpoint
  □ Frontend: "Zeptej se na zákon" chat widget

□ ROZŠÍŘENÝ FRONTEND (Next.js migration via Claude Code)
  □ Export Lovable kódu jako základ
  □ Přidat SSR pro veřejné stránky (marketing)
  □ Přidat API routes pro server-side logic
  □ Rozšířit cenový editor o pokročilé funkce
  □ Team management UI

□ TABIDOO/LUDONE INTEGRACE
  □ n8n workflow: sync nabídky → LuDone CRM
  □ Automatická fakturace přes LuFak
  □ Time tracking na zakázkách přes LuTrack
```

---

## 12. Nástroje pro vývoj jednotlivých částí

| Část systému | Nástroj pro tvorbu | Proč |
|---|---|---|
| **Supabase schéma** | Claude Code + Supabase Dashboard | SQL generování, vizuální ověření |
| **n8n workflows** | n8n GUI (drag & drop) + Code nodes | Vizuální builder, AI nodes vestavěné |
| **Systémové prompty** | Claude.ai (iterace) → Notion (uložení) | Testování v reálném čase |
| **PDF extraction** | Claude Code (Python FastAPI) | Rychlé vytvoření API endpointu |
| **Frontend MVP** | Lovable | Nejrychlejší cesta k UI s Supabase |
| **Frontend Scale** | Claude Code (Next.js) | Plná kontrola, SSR |
| **Edge Functions** | Claude Code (TypeScript/Deno) | Supabase edge runtime |
| **RAG indexování** | Claude Code (Python script) | Jednorázový batch process |
| **Dokumenty/šablony** | Claude Code (docx-js / pdf-lib) | Generování DOCX/PDF |
| **Testování** | Claude Code + n8n test runs | E2E na reálných datech |
| **Dokumentace** | Notion | Centrální knowledge base |
| **Diagramy** | Claude.ai (Mermaid) → Notion | Technická dokumentace |

---

## 13. Bezpečnost a compliance

### 13.1 GDPR

```
ZÁSADY:
  • AI API (Claude, Gemini): podepsat DPA s Anthropic a Google
  • Osobní údaje z VZ dokumentů: anonymizovat před AI zpracováním
    → Regex: detekce rodných čísel, tel. čísel, e-mailů
    → Nahrazení placeholdery: [OSOBA_1], [TELEFON_1]
  • Supabase: EU region (Frankfurt) pro data residency
  • Právo na výmaz: implementovat cascade delete
  • Logování: nelogovat plný obsah AI requestů s osobními údaji

IMPLEMENTACE:
  □ Supabase: nastavit region eu-central-1
  □ n8n: Code node pro anonymizaci před AI voláním
  □ DPA: Anthropic (https://www.anthropic.com/dpa)
  □ DPA: Google (Cloud terms of service)
```

### 13.2 Bezpečnost API klíčů

```
  • n8n: Credentials store (šifrované)
  • Supabase: Environment variables pro Edge Functions
  • Frontend: NIKDY neukládat API klíče
    → Vše přes Supabase Edge Functions nebo n8n webhooks
  • Rotace klíčů: čtvrtletně
```

---

## 14. Metriky úspěchu

### Co měřit od Fáze 1

| Metrika | Cíl Měsíc 3 | Cíl Měsíc 6 | Cíl Rok 1 |
|---|---|---|---|
| Sledovaných zakázek/měsíc | 500 | 1 000 | 2 000 |
| Analyzovaných dokumentů/měsíc | 20 | 50 | 100 |
| Připravených nabídek/měsíc | 3 | 8 | 15 |
| Průměrný čas přípravy nabídky | 30 hodin | 20 hodin | 12 hodin |
| Win rate (výhry/podané) | baseline | +5 % | +15 % |
| Produktů v cenovém skladu | 100 | 500 | 2 000 |
| Přesnost AI cenotvorby | 60 % | 75 % | 85 % |
| Náklady AI API/měsíc | 1 300 CZK | 2 500 CZK | 5 000 CZK |

---

## Příloha A: Klíčové API endpointy (Supabase Edge Functions)

```typescript
// POST /functions/v1/analyze-tender
// Spustí analýzu zadávací dokumentace
{
  zakazka_id: string;
}

// POST /functions/v1/price-items
// Ocení položky z analýzy
{
  analyza_id: string;
}

// POST /functions/v1/generate-bid
// Vygeneruje podklady nabídky
{
  zakazka_id: string;
  sections: string[]; // ['technicky_navrh', 'metodika', 'kryci_list']
}

// POST /functions/v1/rag-query
// Dotaz na právní knowledge base
{
  query: string;
  sources?: string[]; // ['zzvz', 'uohs', 'metodika']
}

// GET /functions/v1/product-match
// Najde matching produkty v katalogu
{
  nazev: string;
  specifikace?: string;
  limit?: number;
}
```

---

## Příloha B: Prompt template — Analýza zadávací dokumentace

```
SYSTEM:
Jsi expert na české veřejné zakázky s hlubokou znalostí zákona
č. 134/2016 Sb. (ZZVZ). Tvým úkolem je analyzovat zadávací
dokumentaci a extrahovat klíčové informace ve strukturovaném
formátu JSON.

Vždy extrahuj:
1. Základní údaje (název, zadavatel, předmět)
2. Kvalifikační požadavky (technické, ekonomické, profesní)
3. Hodnotící kritéria s vahami
4. Důležité termíny
5. Položkový rozpočet (pokud je v dokumentu)
6. Identifikovaná rizika
7. Doporučení GO/NOGO s odůvodněním

Odpověz POUZE validním JSON. Žádný další text.

USER:
Analyzuj následující zadávací dokumentaci:

---
{extracted_document_text}
---

Odpověz ve formátu:
{
  "zakazka": {
    "nazev": "...",
    "evidencni_cislo": "...",
    "zadavatel": {"nazev": "...", "ico": "...", "kontakt": "..."},
    "predmet": "...",
    "predpokladana_hodnota": null,
    "typ_zakazky": "dodavky|sluzby|stavebni_prace",
    "typ_rizeni": "otevrene|uzsi|jrbu|..."
  },
  "kvalifikace": [
    {"typ": "profesni|technicka|ekonomicka", "popis": "...", "splnitelne": true}
  ],
  "hodnotici_kriteria": [
    {"nazev": "...", "vaha_procent": 60, "popis": "..."}
  ],
  "terminy": {
    "lhuta_nabidek": "2026-03-15T10:00:00",
    "otevirani_obalek": "2026-03-15T14:00:00",
    "doba_plneni_od": "2026-04-01",
    "doba_plneni_do": "2027-03-31",
    "prohlidka_mista": null
  },
  "polozky": [
    {"nazev": "...", "mnozstvi": 10, "jednotka": "ks", "specifikace": "..."}
  ],
  "rizika": [
    {"popis": "...", "zavaznost": "vysoka|stredni|nizka", "mitigace": "..."}
  ],
  "doporuceni": {
    "rozhodnuti": "GO|NOGO|ZVAZIT",
    "oduvodneni": "...",
    "klicove_body": ["...", "..."]
  }
}
```

---

## 15. Role n8n vs Supabase Edge Functions — kdo co dělá

### 15.1 Klíčové pravidlo

**n8n = asynchronní orchestrace na pozadí. Supabase Edge Functions = synchronní odpovědi uživateli.**

n8n nikdy nesmí sloužit jako primární API backend. Webhook nodes nemají rate limiting a přidávají 50–200ms overhead na každý node. Správný vzor je tenká vrstva Supabase Edge Functions pro synchronní requesty, která triggeruje n8n přes HTTP pro vše, co může běžet na pozadí.

```
Uživatel → Frontend → Supabase Edge Function (auth + validace, < 2s)
                           ↓ (HTTP call / database webhook)
                        n8n (AI processing, generování dokumentů)
                           ↓ (Supabase node aktualizuje DB)
                        Supabase DB → Realtime → Frontend se aktualizuje
```

### 15.2 Rozdělení zodpovědností

| Typ úlohy | Kde běží | Proč |
|---|---|---|
| AI generování nabídky (multi-step) | **n8n** | Asynchronní, LangChain integrace, 5–60s |
| Tvorba dokumentů (DOCX/PDF) | **n8n + Gotenberg** | Potřebuje Node.js runtime, LibreOffice |
| Synchronizace cenových feedů | **n8n** (cron) | Plánované ETL, retry logika |
| Email notifikace + Slack | **n8n** | Integration-heavy |
| Ověření přihlášení uživatele | **Supabase Edge Functions** | Synchronní, < 100ms |
| Validace formulářů | **Supabase Edge Functions** | User-facing, okamžitá odpověď |
| Stripe webhook zpracování | **Edge Function → n8n** | Rychlá validace + asynchronní logika |
| Realtime dotazy na data | **Supabase přímo** | PostgREST to zvládá nativně |

### 15.3 Jak n8n generuje dokumenty nabídek

n8n **může a má** generovat DOCX/PDF nabídky. Doporučený stack:

**Carbone.io** (community node `n8n-nodes-carbone`): Template-based generování. Nahrajete DOCX šablonu s placeholdery `{d.nazev_zakazky}`, `{d.polozky[i].nazev}`, a Carbone je naplní JSON daty. Podporuje podmínky, cykly, formátování. Výstup: DOCX, PDF, XLSX, PPTX. Cloud API (€39/měsíc za 5K dokumentů) nebo self-hosted (open-source).

**Gotenberg** (self-hosted Docker kontejner): Konvertuje HTML/DOCX → PDF přes LibreOffice/Chromium. Běží jako sidecar vedle n8n na Hostinger VPS. Volání přes HTTP API. Zcela zdarma.

**docxtemplater** (community node `n8n-nodes-docxtemplater`): Alternativa k Carbone pro čistě DOCX šablony s Jexl syntax pro kondice.

Pro VZ nabídky flow vypadá takto:

```
n8n workflow "generate_bid":
  │
  ├── 1. Claude Sonnet: Vygeneruj technický návrh (text)
  ├── 2. Claude Sonnet: Vygeneruj metodiku (text)
  ├── 3. Supabase: Načti oceněné položky + data firmy
  ├── 4. Code node: Sestav JSON payload pro šablonu
  ├── 5. Carbone: Naplň DOCX šablonu krycího listu
  ├── 6. Carbone: Naplň DOCX šablonu technického návrhu
  ├── 7. Carbone: Naplň DOCX šablonu čestného prohlášení
  ├── 8. Gotenberg: Konvertuj DOCX → PDF (volitelně)
  ├── 9. Supabase Storage: Upload všech dokumentů
  └── 10. Supabase: Update status nabídky + Slack notifikace
```

### 15.4 Škálování n8n

Default single-instance n8n zvládne ~5–10 souběžných webhook requestů. S nastavením `N8N_CONCURRENCY_PRODUCTION_LIMIT` přibude FIFO fronta. Queue mode (vyžaduje PostgreSQL + Redis) oddělí webhook procesory od worker nodes s 10 souběžnými joby na worker. Pro SaaS s tisíci uživateli stačí queue mode se 2–3 workery.

**Licenční omezení:** n8n Sustainable Use License zakazuje hostování n8n jako služby, kde zákazníci přímo přistupují k n8n funkcionalitě. Použití n8n jako interní orchestrační vrstvy (uživatelé n8n nikdy nevidí) je v pořádku. Toto je zásadní pro white-label SaaS — API plochu vždy řešte přes Supabase Edge Functions.

### 15.5 Supabase Edge Functions — limity a cena

Edge Functions běží na Deno (V8 izolace) s rychlými cold starty (milisekundy). Klíčové limity:

| Parametr | Free tier | Pro tier ($25/měsíc) |
|---|---|---|
| CPU čas na invokaci | 2 sekundy | 2 sekundy |
| Wall clock (celkový čas) | 150 sekund | 400 sekund |
| Invokace/měsíc v ceně | 500K | 2M |
| Cena za další invokace | — | $2 za milion |
| Paměť | 256 MB | 256 MB |

CPU čas nezahrnuje I/O wait — volání AI API se nepočítá proti CPU limitu. Ale těžká výpočetní logika (parsování velkých JSON, embedding kalkulace) může limit překročit. Proto: Edge Functions pro validaci a routing, n8n pro heavy lifting.

### 15.6 Vzor „Action Queue"

Elegantní pattern pro propojení frontendu s n8n:

```sql
CREATE TABLE action_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action_type TEXT NOT NULL,        -- 'analyze_tender', 'generate_bid', 'price_items'
    payload JSONB NOT NULL,           -- {zakazka_id: "...", options: {...}}
    status TEXT DEFAULT 'pending',    -- pending → processing → completed → failed
    result JSONB,                     -- výsledek po dokončení
    error TEXT,                       -- chybová zpráva
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ,
    user_id UUID REFERENCES auth.users(id)
);
```

Frontend vloží řádek → database webhook spustí n8n → n8n zpracuje a updatuje status + result → frontend sleduje změny přes Supabase Realtime.

---

## 16. Integrace cenových feedů z distributorů

### 16.1 Stav českého distribučního trhu

| Distributor | API přístup | Typ integrace | Poznámka |
|---|---|---|---|
| **Ingram Micro** | ✅ Veřejné REST API | OAuth2, sandbox, SDK | Jediný se self-service developer portálem |
| **AT Computers** | ⚠️ Proprietární web services | Vyžaduje partnerskou smlouvu | „ATC Business Link" B2B portál, 65 000+ položek, 2FA app |
| **eD system** | ⚠️ B2B integrace na vyžádání | Individuální dohoda | Dodává Alza, CZC, DATART |
| **ALSO (SWS + ABC Data)** | ⚠️ Cloud API pouze | REST API pro cloud/SaaS produkty | HW přes legacy „InterLink" portál |
| **Icecat** | ✅ Zdarma (Open Icecat) | REST API | 18M+ produktových datasheetů, BEZ cen |

**Žádný český distributor nepoužívá standardy OCI, cXML, BMEcat ani ETIM** pro IT produkty. De facto standard je proprietární XML feed nebo Heureka XML formát pro e-commerce.

### 16.2 Doporučené pořadí integrace

**Fáze 1 (okamžitě):** Ingram Micro REST API — self-service registrace na developer.ingrammicro.com, sandbox prostředí, real-time ceny + dostupnost skladem.

**Fáze 1 (paralelně):** Icecat Open API pro obohacení produktových dat (specifikace, obrázky, EAN kódy). Zdarma, okamžité.

**Fáze 2 (vyjednávání):** AT Computers — kontaktovat obchodní oddělení, vyjednat přístup k web services. Největší český distributor (~30 mld. CZK obrat).

**Fáze 2 (alternativa):** Stock In The Channel (stockinthechannel.com) — komerční agregátor, který už integruje ABC Data pro ČR. Může být rychlejší cesta k multi-distribučním datům.

**Fáze 3:** eD system a ALSO HW portál — individuální vyjednávání.

### 16.3 Databázové schéma pro cenový sklad (rozšířené)

```sql
-- Kanoničtí produkty (deduplikováno výrobce + MPN)
CREATE TABLE products_canonical (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manufacturer TEXT NOT NULL,
    mpn TEXT,                          -- Manufacturer Part Number
    ean TEXT,                          -- EAN/GTIN (globally unique)
    name TEXT NOT NULL,
    category TEXT,
    parameters JSONB,                  -- z Icecat nebo manuální
    icecat_id INTEGER,                 -- reference na Icecat datasheet
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(manufacturer, mpn)
);

-- Dodavatelé
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                -- 'ingram_micro', 'at_computers', ...
    api_type TEXT,                     -- 'rest', 'soap', 'csv', 'manual'
    config JSONB,                      -- API credentials, endpoints
    active BOOLEAN DEFAULT true,
    last_sync_at TIMESTAMPTZ
);

-- Mapování dodavatel → kanonický produkt
CREATE TABLE supplier_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID REFERENCES suppliers(id),
    product_id UUID REFERENCES products_canonical(id),
    supplier_sku TEXT NOT NULL,         -- SKU u dodavatele
    supplier_name TEXT,                 -- název u dodavatele
    match_confidence TEXT,              -- 'ean_match', 'mpn_match', 'fuzzy', 'manual'
    match_score DECIMAL(5,2),
    UNIQUE(supplier_id, supplier_sku)
);

-- Aktuální ceny (UPSERT při každém syncu)
CREATE TABLE current_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_product_id UUID REFERENCES supplier_products(id),
    price_net DECIMAL(12,2) NOT NULL,  -- bez DPH
    currency TEXT DEFAULT 'CZK',
    stock_status TEXT,                  -- 'in_stock', 'on_order', 'discontinued'
    stock_quantity INTEGER,
    delivery_days INTEGER,
    fetched_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(supplier_product_id)        -- jedna aktuální cena per supplier SKU
);

-- Historie cen (append-only pro trendy)
CREATE TABLE price_history (
    id BIGSERIAL PRIMARY KEY,
    supplier_product_id UUID REFERENCES supplier_products(id),
    price_net DECIMAL(12,2),
    stock_status TEXT,
    recorded_at TIMESTAMPTZ DEFAULT now()
);
-- Partitioning by month pro efektivní archivaci
CREATE INDEX idx_price_history_date ON price_history (recorded_at);

-- VIEW: Nejlepší cena napříč dodavateli
CREATE VIEW v_best_prices AS
SELECT DISTINCT ON (p.id)
    p.id, p.name, p.manufacturer, p.mpn, p.ean,
    s.name AS supplier_name,
    cp.price_net, cp.currency, cp.stock_status,
    cp.stock_quantity, cp.delivery_days, cp.fetched_at
FROM products_canonical p
JOIN supplier_products sp ON sp.product_id = p.id
JOIN current_prices cp ON cp.supplier_product_id = sp.id
JOIN suppliers s ON s.id = sp.supplier_id
WHERE cp.stock_status = 'in_stock'
ORDER BY p.id, cp.price_net ASC;
```

### 16.4 Matching produktů — priorita algoritmů

```
1. EAN/GTIN match (100% spolehlivost)
   → SELECT * FROM products_canonical WHERE ean = {input_ean}

2. Normalizovaný MPN match (95% spolehlivost)
   → UPPER(REPLACE(mpn, '-', '')) = UPPER(REPLACE({input}, '-', ''))

3. Fuzzy text match (pg_trgm extension)
   → similarity(name, {input}) > 0.6
   → ORDER BY similarity DESC

4. AI matching (pro nové produkty bez EAN/MPN)
   → Gemini Flash: "Najdi nejbližší produkt..."
```

### 16.5 n8n workflow: price_feed_sync

```
[Cron: denně 4:00 nebo real-time webhook]
    │
    ▼
[Pro každého aktivního dodavatele:]
    │
    ├── Ingram Micro: HTTP Request → REST API
    │   GET /catalog/products?category=servers&...
    │   Auth: OAuth2 Bearer token
    │
    ├── AT Computers: HTTP Request → SOAP/XML
    │   (nebo CSV import pokud nemáme API přístup)
    │
    ├── CSV/Excel import: Read Binary File
    │   (pro dodavatele bez API)
    │
    ▼
[Code node: Normalizace dat]
    → Jednotný formát {sku, name, manufacturer, mpn, ean, price, stock}
    │
    ▼
[Code node: Product matching]
    → EAN → MPN → fuzzy → nový produkt
    │
    ▼
[Supabase: UPSERT current_prices]
[Supabase: INSERT price_history]
    │
    ▼
[IF: Výrazné cenové změny (>10%)]
    └── Slack: "⚠️ Cena serveru Dell R760 klesla o 15%"
```

### 16.6 Web scraping — právní úvahy a technický přístup

Scraping veřejných ceníků (neautentizovaných) je nízké riziko pod GDPR (nejedná se o osobní údaje). Scraping za-login B2B portálů nese riziko porušení obchodních podmínek a směrnice EU o databázích. **Playwright** je nejlepší volba pro B2B portály — zvládá JavaScript-heavy SPA, persistentní autentizaci a stealth pluginy.

Heureka ani Zboží.cz **nenabízejí cenové agregační API**. Obě platformy poskytují pouze merchant-facing API pro správu vlastních produktových listingů. Pro cenové srovnání doporučuji přímou integraci s distributory, ne s agregátory.

---

## 17. GitHub workflow a předávání mezi vývojovými prostředími

### 17.1 Lovable ↔ GitHub ↔ Claude Code — obousměrná synchronizace

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   LOVABLE    │◄────►│   GITHUB     │◄────►│ CLAUDE CODE  │
│              │ push │   REPO       │ push │              │
│  UI design   │ pull │  Source of   │ pull │  Backend     │
│  prototyping │      │  truth       │      │  logic       │
│              │      │              │      │  Edge funcs  │
└──────────────┘      └──────┬───────┘      └──────────────┘
                             │
                    ┌────────┼────────┐
                    ▼        ▼        ▼
              ┌─────────┐ ┌──────┐ ┌──────────┐
              │ VERCEL  │ │ VPS  │ │ SUPABASE │
              │frontend │ │ n8n  │ │ DB+funcs │
              └─────────┘ └──────┘ └──────────┘
```

**Lovable.dev** vytváří GitHub repozitář a pushuje kód při každém uložení. Synchronizace je **obousměrná** — změny pushnuté z Claude Code nebo jiného editoru se stáhnou zpět do Lovable. Doporučený postup: založte repo z Lovable (ne z GitHubu), naklonujte lokálně, a střídejte Lovable pro UI práci a Claude Code pro backend logiku. Nepoužívejte obojí současně — hrozí konflikty.

### 17.2 n8n verzování přes CLI

```bash
# Export všech workflows jako JSON soubory
n8n export:workflow --backup --output=./n8n-workflows/

# Automatický backup (cron na VPS, každou hodinu)
0 * * * * cd /cesta/k/repo && \
  n8n export:workflow --backup --output=./n8n-workflows/ && \
  git add . && \
  git diff --cached --quiet || \
  git commit -m "n8n: $(date +'%Y-%m-%d %H:%M')" && \
  git push
```

n8n Enterprise má vestavěnou Git integraci s push/pull na větve. Pro self-hosted community edition je CLI backup spolehlivý a zdarma.

### 17.3 Supabase migrace jako source of truth pro schéma

```bash
# Vygeneruj migraci ze změn v lokálním Studio UI
supabase db diff -f nazev_migrace

# Aplikuj migrace na produkci
supabase db push

# Deploy Edge Functions
supabase functions deploy
```

Migrace žijí v `supabase/migrations/` jako timestampované SQL soubory. Supabase Branching vytváří izolovaná DB prostředí pro každou Git větev.

### 17.4 Monorepo struktura

```
vz-ai-tool/
├── .github/
│   └── workflows/
│       ├── deploy-web.yml          # Vercel deploy (path: apps/web/**)
│       ├── deploy-supabase.yml     # DB migrace + Edge Functions
│       └── deploy-n8n.yml          # SSH import na VPS
├── apps/
│   └── web/                        # React frontend (z Lovable)
│       ├── src/
│       ├── package.json
│       └── vite.config.ts
├── packages/
│   └── shared/                     # Sdílené TypeScript typy
│       └── types.ts                # supabase gen types typescript
├── supabase/
│   ├── migrations/                 # Timestampované SQL
│   ├── functions/                  # Edge Functions (Deno/TS)
│   ├── seed.sql                    # Testovací data
│   └── config.toml
├── n8n-workflows/                  # Exportované JSON
│   ├── vz_monitor_hlidac.json
│   ├── analyze_tender.json
│   ├── price_items.json
│   └── generate_bid.json
├── docker/
│   └── docker-compose.yml          # n8n + Gotenberg + Redis
├── templates/                      # DOCX šablony pro Carbone
│   ├── kryci_list.docx
│   ├── technicky_navrh.docx
│   └── cestne_prohlaseni.docx
├── CLAUDE.md                       # Context pro Claude Code
├── turbo.json                      # Turborepo config
└── README.md
```

### 17.5 CI/CD pipeline (GitHub Actions)

```yaml
# .github/workflows/deploy-web.yml
name: Deploy Frontend
on:
  push:
    branches: [main]
    paths: ['apps/web/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'

# .github/workflows/deploy-supabase.yml
name: Deploy Supabase
on:
  push:
    branches: [main]
    paths: ['supabase/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_ID }}
      - run: supabase db push
      - run: supabase functions deploy

# .github/workflows/deploy-n8n.yml
name: Deploy n8n Workflows
on:
  push:
    branches: [main]
    paths: ['n8n-workflows/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/vz-ai-tool && git pull origin main
            docker exec n8n n8n import:workflow \
              --input=/data/n8n-workflows/ --separate
```

### 17.6 Prostředí (environments)

| Prostředí | Supabase | n8n | Frontend |
|---|---|---|---|
| **Lokální vývoj** | `supabase start` (Docker) | `docker run n8n` lokálně | `npm run dev` |
| **Staging** | Samostatný Supabase projekt (free tier) | Volitelně: druhý port na VPS | Vercel preview |
| **Produkce** | Supabase Pro ($25/měsíc) | Hostinger VPS | Vercel production |

Pro solo vývojáře je staging n8n obvykle zbytečný. Dva Supabase projekty (dev na free tier, produkce na Pro) + lokální Docker pokrývají workflow.

---

## 18. CRM dashboard s emailem

### 18.1 Dashboard jako CRM pro manažery

Dashboard VZ AI Tool může sloužit současně jako CRM pro správu VZ příležitostí:

```
┌─────────────────────────────────────────────────────────────┐
│  CRM POHLED PRO MANAŽERY                                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  📊 PIPELINE (Kanban board)                                │
│  ┌─────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────┐│
│  │ Nové    │→│Analyzuje │→│ Oceňuje  │→│Nabídka │→│Výsle-││
│  │         │ │ se       │ │ se       │ │podána  │ │dek   ││
│  │ ■■■     │ │ ■■       │ │ ■■■      │ │ ■      │ │ ■■   ││
│  │ ■■      │ │ ■        │ │          │ │        │ │      ││
│  └─────────┘ └──────────┘ └──────────┘ └────────┘ └──────┘│
│                                                             │
│  👥 KONTAKTY (zadavatelé + dodavatelé)                     │
│  │ Firma, kontaktní osoba, IČO, email, telefon             │
│  │ Historie interakcí (emaily, nabídky, výsledky)           │
│  │ Propojení s Tabidoo/LuDone kontakty                     │
│                                                             │
│  📧 EMAIL (timeline komunikace)                            │
│  │ Odeslaný/přijatý email ke každé zakázce                 │
│  │ Šablony: dotaz na ZD, odeslání nabídky, follow-up       │
│  │ Tracking: otevření, kliknutí                             │
│                                                             │
│  📈 REPORTING (manažerský přehled)                          │
│  │ Win rate, průměrná marže, čas přípravy                   │
│  │ Příjmy z VZ (napojení na LuFak)                         │
│  │ Výkon týmu (kdo kolik nabídek, úspěšnost)               │
│                                                             │
│  🔐 ROLE                                                   │
│  │ Admin: vše                                               │
│  │ Manažer: přehled týmu + reporting                       │
│  │ Specialista: vlastní zakázky + analýza + nabídky        │
│  │ Viewer: read-only dashboardy                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 18.2 Email integrace — Resend jako nejlepší volba

| | Resend | SendGrid | Postmark |
|---|---|---|---|
| **Free tier** | 3 000/měsíc | 100/den (60denní trial) | 100/měsíc |
| **Placený** | $20/měsíc → 50K | $19.95/měsíc → 50K | $15/měsíc → 10K |
| **React Email** | Nativní integrace | Manuální HTML | Vlastní šablony |
| **Supabase integrace** | Oficiální příklady | Manuální | Manuální |
| **Příchozí pošta** | Ano (2025 feature) | Ano (Inbound Parse) | Jen Pro tier |
| **Tracking (open/click)** | Webhooky | Vestavěný | Vestavěný |

**Resend** je jasná volba: React Email pro type-safe šablony v JSX, nativní Supabase Edge Function příklady, tracking webhooky (`email.opened`, `email.clicked`, `email.bounced`). Free tier 3 000 emailů/měsíc pro MVP stačí.

Pro Gmail/Outlook integraci: **v MVP přeskočit**. Fáze 2 může přidat OAuth2 integraci s Gmail API a Microsoft Graph API.

### 18.3 Role-based přístup přes Supabase RLS

```sql
-- Helper funkce (SECURITY DEFINER pro výkon)
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM user_profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_user_team_id()
RETURNS UUID AS $$
  SELECT team_id FROM user_profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Manažer vidí data celého týmu
CREATE POLICY "Manažer vidí tým" ON zakazky
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()  -- vlastní data
    OR (
      (SELECT get_user_role()) = 'manager'
      AND user_id IN (
        SELECT id FROM user_profiles
        WHERE team_id = (SELECT get_user_team_id())
      )
    )
  );

-- Admin vidí vše
CREATE POLICY "Admin vidí vše" ON zakazky
  FOR ALL TO authenticated
  USING ((SELECT get_user_role()) = 'admin');
```

### 18.4 Kanban board — technická implementace

Knihovna **@dnd-kit** (~10KB, zero dependencies) pro drag-and-drop. Kombinace se Supabase Realtime — přetažení karty jedním uživatelem se okamžitě projeví u ostatních. Auditní log přes `supa_audit` extension: `SELECT audit.enable_tracking('public.zakazky'::regclass)`.

---

## 19. White-label / krabicové řešení — multi-tenant architektura

### 19.1 Fázovaný přístup k multi-tenancy

| Fáze | Počet tenantů | Vzor | Měsíční infra |
|---|---|---|---|
| **MVP** | 1–10 | Sdílená DB + RLS | $25–50 |
| **Growth** | 10–50 | Pro + větší compute | $50–100 |
| **Scale** | 50–200 | Pro + Medium compute + read replica | $200–500 |
| **Enterprise** | 200+ | Team plan, hybridní izolace | $600–2 000 |

### 19.2 Tenant izolace přes RLS (Fáze 1–2)

Pro MVP až ~100 tenantů stačí jedna Supabase instance s `tenant_id` na každé tabulce:

```sql
-- Přidej tenant_id na všechny business tabulky
ALTER TABLE zakazky ADD COLUMN tenant_id UUID NOT NULL;
ALTER TABLE analyzy ADD COLUMN tenant_id UUID NOT NULL;
ALTER TABLE produkty ADD COLUMN tenant_id UUID NOT NULL;
-- ...

-- Helper funkce
CREATE OR REPLACE FUNCTION get_current_tenant_id()
RETURNS UUID AS $$
  SELECT (auth.jwt()->>'app_metadata')::jsonb->>'tenant_id'
$$ LANGUAGE sql STABLE;

-- Univerzální tenant policy
CREATE POLICY "Tenant izolace" ON zakazky
  FOR ALL USING (tenant_id = get_current_tenant_id());
```

### 19.3 Custom domény a dynamický branding

Next.js middleware detekuje tenant podle subdomény (`firma1.vzaitool.cz`) nebo custom domény (`firma1.cz`):

```typescript
// middleware.ts
export function middleware(request: NextRequest) {
  const hostname = request.headers.get('host');
  const tenant = await getTenantByDomain(hostname);

  // Inject tenant context
  const response = NextResponse.rewrite(request.url);
  response.headers.set('x-tenant-id', tenant.id);
  return response;
}
```

Vercel umožňuje programatické přidávání custom domén přes SDK s automatickým SSL. Dynamické theming přes CSS custom properties z tenant konfigurace — `--color-primary`, `--color-secondary`, URL loga.

### 19.4 Billing — Stripe pro české B2B SaaS

Stripe plně podporuje ČR s poplatky **1,5 % + 6,50 Kč** za evropské karty, CZK vyúčtování. České brány GoPay (0,9–2,2 %) a Comgate (0,79–0,99 %) mají nižší transakční poplatky, ale Stripe nabízí vestavěnou správu předplatného, zákaznický portál, usage-based billing a webhooky. GoPay/Comgate přidat jen pokud zákazníci specificky požadují české platební tlačítka.

Supabase má nativní **Stripe Foreign Data Wrapper** — lze dotazovat Stripe data přímo z PostgreSQL. Šablona `nextjs-subscription-payments` od Vercelu poskytuje production-ready základ.

### 19.5 Cenový model pro české B2B

| Tier | Cena/měsíc | Uživatelé | Nabídky | AI funkce |
|---|---|---|---|---|
| **Starter** | 1 990 CZK (~€80) | 5 | 50/měsíc | Analýza + monitoring |
| **Professional** | 4 990 CZK (~€200) | 20 | Neomezené | Vše včetně AI psaní |
| **Enterprise** | 9 990+ CZK | Neomezené | Neomezené | + custom doména, white-label, podpora |

### 19.6 Per-tenant AI konfigurace

```sql
CREATE TABLE tenant_ai_config (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
    primary_model TEXT DEFAULT 'claude-sonnet-4-5',
    system_prompt_override TEXT,       -- vlastní system prompt
    temperature DECIMAL(3,2) DEFAULT 0.3,
    max_monthly_ai_budget DECIMAL(10,2),  -- CZK limit
    current_month_usage DECIMAL(10,2) DEFAULT 0
);

CREATE TABLE tenant_prompt_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    category TEXT NOT NULL,            -- 'bid_analysis', 'technical_proposal', ...
    name TEXT NOT NULL,
    template TEXT NOT NULL,            -- Handlebars šablona
    is_default BOOLEAN DEFAULT false
);
```

Sdílená LLM infrastruktura (jeden API klíč) s per-tenant context injection — nejefektivnější a nejjednodušší správa.

---

## 20. Vývojová prostředí — co použít pro co

### 20.1 Doporučený stack vývojových nástrojů

| Úloha | Primární nástroj | Alternativa | Poznámka |
|---|---|---|---|
| **Frontend UI design + prototyping** | **Lovable** | Cursor, Bolt.new | Lovable má nejlepší Supabase integraci |
| **Frontend rozšiřování + backend** | **Claude Code** (CLI) | Cursor, VS Code + Cline | Claude Code = nejsilnější pro Anthropic modely |
| **n8n workflows** | **n8n GUI** (webový editor) | — | Drag & drop, vizuální debugging |
| **Supabase schéma + migrace** | **Supabase Studio** (web) + CLI | TablePlus, DBeaver | Studio pro vizuální návrh, CLI pro migrace |
| **Edge Functions** | **Claude Code** + Supabase CLI | VS Code + Deno extension | TS/Deno runtime |
| **DOCX šablony** | **LibreOffice** / MS Word | Google Docs | Carbone template syntax |
| **AI prompty** | **Claude.ai** (iterace v chatu) | Anthropic Workbench | Testování na reálných VZ dokumentech |
| **Dokumentace** | **Notion** | Obsidian | Již zavedené |
| **Diagramy** | **Claude.ai** (Mermaid) | Excalidraw, draw.io | Export do Notion |
| **API testování** | **Bruno** / Insomnia | Postman, curl | Bruno je open-source, Git-friendly |
| **Git + CI/CD** | **GitHub** + GitHub Actions | GitLab | Lovable vyžaduje GitHub |

### 20.2 Lovable vs Cursor vs Bolt.new — kdy co

```
LOVABLE (lovable.dev)
  ✅ Nejrychlejší cesta od nuly k funkčnímu UI
  ✅ Nativní Supabase integrace (Auth, DB, Storage)
  ✅ Obousměrná GitHub synchronizace
  ✅ Generuje čistý React + TypeScript + Tailwind + shadcn/ui
  ✅ Iterace přes přirozený jazyk
  ⚠️ Omezený na frontend (není backend/API)
  ⚠️ Méně kontroly nad architekturou
  ⚠️ Konflikty při souběžné práci s Claude Code
  💰 Free: 5 generací/den | Pro: $20/měsíc

  → POUŽÍT PRO: MVP dashboard, formuláře, tabulky, CRUD screeny

CURSOR (cursor.com)
  ✅ Plnohodnotné IDE (fork VS Code)
  ✅ AI asistence v kontextu celého projektu
  ✅ Tab autocomplete + inline edits
  ✅ Multi-file editace
  ⚠️ Drahší pro plné využití ($20/měsíc Pro)
  ⚠️ Slabší než Claude Code pro velké refaktoringy

  → POUŽÍT PRO: Denní kódování když preferujete GUI IDE

CLAUDE CODE (CLI)
  ✅ Nejsilnější AI coding agent (Opus 4.5/Sonnet 4.5)
  ✅ Nativní Git operace (branch, commit, PR)
  ✅ CLAUDE.md pro persistentní projektový kontext
  ✅ Multi-agent orchestrace (sub-agents pro paralelní úkoly)
  ✅ MCP servery pro Supabase, GitHub, Slack integrace
  ⚠️ Pouze CLI (terminál)
  ⚠️ Vyžaduje Max plan ($100/měsíc) nebo API credits
  ⚠️ Učení křivka pro efektivní promptování

  → POUŽÍT PRO: Backend logiku, Edge Functions, refactoring,
                 komplexní features, CI/CD setup

BOLT.NEW (bolt.new)
  ✅ Full-stack v prohlížeči (WebContainers)
  ✅ Podporuje více frameworků (Next.js, Astro, Remix)
  ⚠️ Méně zaměřený na Supabase než Lovable
  ⚠️ Kód méně čistý než z Lovable

  → POUŽÍT PRO: Rychlé prototypy, landing pages, experimenty
```

### 20.3 Doporučený vývojový workflow (den v životě)

```
RÁNO: Kontrola n8n (VPS dashboard)
  → Proběhly overnight monitoring workflows?
  → Nové relevantní zakázky v Slacku?

DOPOLEDNE: Feature development
  → Lovable: UI práce (nový screen, úprava komponent)
     NEBO
  → Claude Code: Backend práce (Edge Function, workflow logika)
  → Commit → Push → Auto-deploy

ODPOLEDNE: n8n workflow development
  → n8n GUI: Nový workflow nebo úprava existujícího
  → Testování na reálných datech
  → Export → Git commit

PRŮBĚŽNĚ: AI prompt iterace
  → Claude.ai: Testování systémových promptů
  → Notion: Uložení finálních promptů

KONEC DNE: Dokumentace
  → Notion: Update architektury, poznámky
  → Git: Review open PRs, merge to main
```

### 20.4 CLAUDE.md — kontext pro Claude Code

Vytvořte tento soubor v kořeni monorepa:

```markdown
# VZ AI Tool — Project Context

## Architecture
- Frontend: React + TypeScript + Tailwind + shadcn/ui (from Lovable)
- Backend: Supabase (PostgreSQL + pgvector + Auth + Storage + Edge Functions)
- Workflow engine: n8n (self-hosted, Docker)
- AI: Claude Sonnet 4.5 (analysis, bid writing), Gemini Flash (triage)

## Key conventions
- All database tables have tenant_id and user_id columns
- Use Supabase RLS for data isolation
- Edge Functions are in supabase/functions/ (Deno/TypeScript)
- Types are auto-generated: `supabase gen types typescript`
- Czech language in UI, English in code comments

## Commands
- `npm run dev` — start frontend dev server
- `supabase start` — start local Supabase
- `supabase db diff -f name` — generate migration
- `supabase functions serve` — local Edge Functions
- `supabase gen types typescript --local > packages/shared/types.ts`

## File structure
- apps/web/ — React frontend
- supabase/functions/ — Edge Functions
- supabase/migrations/ — SQL migrations
- n8n-workflows/ — exported JSON workflows
- templates/ — DOCX templates for Carbone
```

### 20.5 Lokální dev environment setup

```bash
# 1. Klonování repo
git clone https://github.com/your-org/vz-ai-tool.git
cd vz-ai-tool

# 2. Lokální Supabase (Docker Desktop musí běžet)
supabase start
# → Dashboard: http://localhost:54323
# → API: http://localhost:54321

# 3. Lokální n8n
docker run -d --name n8n \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  -e NODE_FUNCTION_ALLOW_EXTERNAL=docxtemplater,pdfkit \
  n8nio/n8n

# 4. Frontend
cd apps/web
npm install
npm run dev
# → http://localhost:5173

# 5. Supabase Edge Functions (lokální)
supabase functions serve
# → http://localhost:54321/functions/v1/

# 6. Generování typů z DB schématu
supabase gen types typescript --local > packages/shared/types.ts
```
