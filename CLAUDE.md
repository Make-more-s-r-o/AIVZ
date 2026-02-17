# VZ AI Tool

## Co tento projekt dělá

AI nástroj pro české veřejné zakázky. Automaticky monitoruje nové zakázky, AI analyzuje zadávací dokumentaci, oceňuje položky z interního cenového skladu a generuje kompletní nabídkové dokumenty (krycí list, technický návrh, čestné prohlášení, cenovou nabídku).

Cílový zákazník: malá/střední IT firma, která chce podávat nabídky do veřejných zakázek ale nemá kapacitu na manuální přípravu (40-80 hodin → 4-8 hodin).

## Architektura

```
Frontend (React + TS + Tailwind + shadcn/ui)
    ↓ Supabase Auth + PostgREST
Supabase (PostgreSQL + pgvector + Edge Functions + Storage + Realtime)
    ↓ Database webhooks
n8n (self-hosted Docker, async workflow engine)
    ↓ HTTP requests
AI APIs (Claude Sonnet 4.5 pro analýzu/psaní, Gemini 2.0 Flash pro triáž/scoring)
    ↓
Hlídač státu API (data o zakázkách)
```

### Klíčové rozhodnutí
- **n8n NIKDY neslouží jako API server** pro frontend. n8n = async background processing (AI analýza, generování dokumentů, notifikace). Frontend vždy komunikuje přes Supabase Edge Functions nebo PostgREST.
- **Supabase Edge Functions** = synchronní user-facing endpointy (<2s response)
- **Dokumenty** se generují přes Carbone.io (DOCX šablony) + Gotenberg (PDF konverze)
- **Multi-tenant ready** od začátku: tenant_id na všech business tabulkách

## Multi-agent pravidla

Když dostaneš komplexní úkol s 3+ nezávislými částmi:
1. Rozlož na sub-tasky
2. Každý sub-task řeš jako samostatný sub-agent
3. Každý sub-agent commitne do vlastní větve (feature/nazev-subtask)
4. Na konci: merge všech větví přes PR
```

A do Claude Code **memory** (persistentní, přežije restart):
```
/memory add "Pro komplexní úkoly používej sub-agenty. Každý sub-agent = vlastní větev."

## Tech stack

| Vrstva | Technologie | Poznámka |
|--------|------------|----------|
| Frontend | React 18 + TypeScript + Vite | Vytvořeno v Lovable, rozšiřováno v Claude Code |
| UI knihovna | shadcn/ui + Tailwind CSS | Konzistentní design system |
| Backend DB | Supabase PostgreSQL | RLS pro izolaci dat |
| Vector search | pgvector extension | Pro RAG (fáze 2) |
| Auth | Supabase Auth | Email + heslo, JWT |
| Storage | Supabase Storage | PDF dokumentace, vygenerované nabídky |
| Realtime | Supabase Realtime | WebSocket updates pro dashboard |
| Edge Functions | Supabase Edge Functions (Deno/TS) | Synchronní API endpointy |
| Workflow engine | n8n (self-hosted Docker) | Async: AI analýza, generování, notifikace |
| AI - analýza | Claude Sonnet 4.5 | Analýza ZD, psaní technických návrhů |
| AI - triáž | Gemini 2.0 Flash | Scoring relevance, rychlá klasifikace |
| Doc generation | Carbone.io + Gotenberg | DOCX šablony → PDF |
| Data zdroj | Hlídač státu API | Veřejné zakázky ČR |
| Hosting frontend | Vercel | Auto-deploy z GitHub |
| Hosting n8n | Hostinger VPS | Docker Compose |
| CI/CD | GitHub Actions | Path-based triggers |
| Email (fáze 2) | Resend | React Email templates |
| Billing (fáze 2) | Stripe | Subscription management |

## Konvence

### Kód
- TypeScript VŽDY (nikdy plain JavaScript)
- Supabase client z `@supabase/supabase-js`
- Edge Functions v Deno TypeScript (`supabase/functions/`)
- Auto-generated typy: `supabase gen types typescript --local > packages/shared/types.ts`
- Importy: absolutní cesty kde možné, relativní v rámci modulu
- Error handling: vždy try/catch, vracet strukturované chyby `{error: string, code: number}`

### Databáze
- **KAŽDÁ business tabulka** má sloupce `tenant_id UUID` a `user_id UUID`
- RLS policies na VŠECH tabulkách (i pro development)
- Indexy na KAŽDÉM sloupci referencovaném v RLS policy
- `(SELECT ...)` wrapper na subqueries v RLS pro optimalizaci
- Migrace v `supabase/migrations/` jako timestamped SQL
- NIKDY neměnit produkční DB přímo — vždy přes migrace

### Jazyk
- UI texty: **česky** (čeština je primární jazyk aplikace)
- Kód, komentáře, commit messages: **anglicky**
- Proměnné a funkce: anglicky (`fetchTenders`, `analyzeDocument`)
- DB tabulky a sloupce: anglicky (`tenders`, `analyses`, `bid_documents`)

### Git
- Commit messages: anglicky, stručně, conventional commits (`feat:`, `fix:`, `chore:`)
- Branch naming: `feature/nazev`, `fix/nazev`, `hotfix/nazev`
- NIKDY force push na `main`
- Pull Requests pro všechny změny (i vlastní)

## Adresářová struktura

```
vz-ai-tool/
├── CLAUDE.md                      # TENTO SOUBOR
├── .mcp.json                      # MCP server konfigurace (sdílená)
├── turbo.json                     # Turborepo config
├── package.json                   # Root workspace
├── .github/
│   └── workflows/
│       ├── deploy-web.yml         # Vercel deploy (apps/web/**)
│       ├── deploy-supabase.yml    # DB push + functions (supabase/**)
│       └── deploy-n8n.yml         # SSH workflow import (n8n-workflows/**)
├── apps/
│   └── web/                       # React frontend (z Lovable)
│       ├── src/
│       │   ├── components/        # React komponenty
│       │   ├── pages/             # Stránky (dashboard, feed, detail, ...)
│       │   ├── hooks/             # Custom hooks (useSupabase, useTenders, ...)
│       │   ├── lib/               # Utility funkce, Supabase client
│       │   └── types/             # Frontend-specific typy
│       ├── index.html
│       ├── vite.config.ts
│       └── package.json
├── packages/
│   └── shared/                    # Sdílené TypeScript typy
│       ├── types.ts               # Auto-generated Supabase types
│       └── constants.ts           # Sdílené konstanty
├── supabase/
│   ├── config.toml                # Supabase project config
│   ├── migrations/                # Timestamped SQL migrace
│   │   ├── 00001_initial_schema.sql
│   │   ├── 00002_price_warehouse.sql
│   │   └── ...
│   └── functions/                 # Edge Functions (Deno/TS)
│       ├── extract-pdf/
│       │   └── index.ts
│       ├── match-product/
│       │   └── index.ts
│       ├── analyze-tender/
│       │   └── index.ts
│       └── generate-bid/
│           └── index.ts
├── n8n-workflows/                 # Exportované JSON workflows
│   ├── vz_monitor_hlidac.json
│   ├── vz_filter_score.json
│   ├── vz_analyze_tender.json
│   ├── vz_price_items.json
│   └── vz_generate_bid.json
├── templates/                     # DOCX šablony pro Carbone
│   ├── kryci_list.docx
│   ├── cenova_nabidka.docx
│   ├── technicky_navrh.docx
│   └── cestne_prohlaseni.docx
└── docker/
    └── docker-compose.yml         # n8n + Gotenberg + Redis (pro VPS)
```

## Klíčové příkazy

```bash
# Frontend
cd apps/web && npm run dev              # Dev server (localhost:5173)
cd apps/web && npm run build            # Production build
cd apps/web && npm run lint             # ESLint

# Supabase (lokální)
supabase start                          # Start local Supabase (Docker)
supabase stop                           # Stop local Supabase
supabase status                         # Ukáže URL a klíče

# Supabase (databáze)
supabase db diff -f migration_name      # Vygeneruj migraci z lokálních změn
supabase db push                        # Aplikuj migrace na remote
supabase db reset                       # Reset lokální DB + replay migrací

# Supabase (Edge Functions)
supabase functions serve                # Lokální Edge Functions server
supabase functions deploy nazev         # Deploy jedné funkce
supabase functions deploy               # Deploy všech funkcí

# Supabase (typy)
supabase gen types typescript --local > packages/shared/types.ts

# n8n (na VPS)
docker compose -f docker/docker-compose.yml up -d    # Start
docker compose -f docker/docker-compose.yml logs -f   # Logs

# n8n (export workflows)
# V n8n GUI: menu → Export → Download as JSON → uložit do n8n-workflows/
```

## MCP servery

Projekt používá tyto MCP servery (konfigurace v `.mcp.json`):

1. **Supabase** — přímý přístup k DB, vytváření migrací, testování dotazů
2. **Hlídač státu** — vyhledávání veřejných zakázek, detail zakázky, smlouvy
3. **n8n** — správa workflows, spouštění, monitoring executions
4. **n8n-mcp (node knowledge)** — dokumentace 1000+ n8n nodů pro psaní workflow JSONů
5. **GitHub** — issues, PRs, repo management

## Na čem právě pracuji

**AKTUÁLNÍ FÁZE: Mini MVP (proof-of-concept)**

Cíl: Vzít konkrétní zakázku (3D tiskárna pro tisk termoplastů) a demonstrovat celý flow od analýzy po vygenerování nabídkových dokumentů.

Kroky:
1. ✅ Strategická analýza a technický blueprint hotový
2. → Založení projektu (Supabase + Lovable + GitHub)
3. → Mini MVP: ruční flow s jednou zakázkou
4. → Automatizace přes n8n workflows

## Známé problémy a workaroundy

- Lovable a Claude Code NESMÍ editovat stejné soubory současně (git konflikty)
- n8n Sustainable Use License zakazuje hosting n8n jako služby pro zákazníky — API musí jít přes Supabase Edge Functions
- Supabase Edge Functions CPU limit 2s (I/O wait se nepočítá) — dlouhé AI volání řešit přes n8n
- Carbone.io community node v n8n (`n8n-nodes-carbone`) nebo alternativa docxtemplater v Code node

## Referenční dokumenty

Kompletní technická analýza, business case a diagramy jsou v těchto souborech:
- `docs/technicka-implementace-v2.md` — architektura, DB schéma, AI stack, všechny sekce
- `docs/strategicka-mapa.md` — business case, trh, příjmový model
- `docs/architektura-diagramy.html` — 10 interaktivních Mermaid diagramů
- `docs/todo-implementace-v3.md` — krok-za-krokem implementační plán
