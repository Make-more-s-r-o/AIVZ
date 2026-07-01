# VZ AI Tool

## Co tento projekt dělá

AI nástroj pro české veřejné zakázky. Automaticky monitoruje nové zakázky, AI analyzuje zadávací dokumentaci, oceňuje položky z interního cenového skladu a generuje kompletní nabídkové dokumenty (krycí list, technický návrh, čestné prohlášení, cenovou nabídku). Nad tím běží CRM vrstva pro řízení zakázek (stavy, úkoly, termíny, notifikace, komentáře, štítky).

Cílový zákazník: malá/střední IT firma, která chce podávat nabídky do veřejných zakázek ale nemá kapacitu na manuální přípravu (40-80 hodin → 4-8 hodin).

## Architektura

```
Frontend (React 18 + TS + Vite SPA, vlastní design systém)
    ↓ fetch /api/* (JWT Bearer)
Jeden Express server (scripts/src/serve-api.ts, TypeScript přes tsx)
    servíruje API i vybuildovanou SPA (apps/web/dist) + SPA fallback
    ↓
PostgreSQL (vz_warehouse, pgvector/pgvector image) přes node-pg
    ↓ (pomocné procesy volané z Express endpointů / CLI)
Claude (Anthropic, ai-client.ts) — analýza ZD, matching, psaní dokumentů
Gotenberg (LibreOffice route) — DOCX → PDF
LibreOffice (soffice v Docker image) — .doc → .docx tenderových šablon
OpenAI Embeddings (volitelné, OPENAI_API_KEY) — vektorové dohledávání v cenovém skladu
```

Žádné Supabase, žádné n8n jako runtime součást aplikace, žádný Vercel, žádné Carbone.io. Vše běží jako jeden Node.js proces v jednom Docker image, nasazený na Hetzner VPS.

### Klíčové rozhodnutí
- **Jeden Express proces** je zároveň API server (`/api/*`) i statický file server pro SPA (`express.static` + `app.get('*')` fallback na `index.html`). Frontend a backend se buildí a nasazují společně v jednom Docker image.
- **Case-sensitive routing** v Expressu je záměrně zapnuté (`app.set('case sensitive routing', true)`) — jinak by `/API/...` obešel case-sensitive auth/RBAC guardy (`startsWith('/api/')`) a prošel bez ověření. Bez tohoto nastavení jde o auth-bypass.
- **Migrace se aplikují automaticky při startu** (`runMigrations()` v `db-migrate.ts`), transakčně, sledované v tabulce `_migrations`. Nejde o "manuální krok" — nový SQL soubor v `scripts/migrations/` se aplikuje sám při dalším startu kontejneru.
- **Graceful degradace bez DB**: `getPool()` vrátí `null`, pokud `DATABASE_URL` není nastavena. Čtecí endpointy pak vrací prázdno (`[]`/`null`), zápisy vyhazují a endpoint to překládá na `503`. Appka nespadne, jen ztratí CRM/warehouse funkce.
- **Auth**: JWT (`jwt-auth.ts`, `JWT_SECRET`) + role `admin` / `analytik` / `viewer` (`user-store.ts`). Globální middleware vyžaduje JWT (nebo legacy statický `API_TOKEN`) na všech non-GET `/api/*` cestách kromě whitelisted public paths; druhý globální middleware blokuje mutace pro roli `viewer`. Same-origin bypass existuje jen v dev (JWT vypnutý) a jen z loopbacku — v produkci je vypnutý, protože Origin/Referer/Host jsou klientem ovladatelné.
- **Single-tenant zatím** — žádný `tenant_id` na tabulkách, multi-tenant je odloženo (DEFER), ne "od začátku multi-tenant ready".
- **Dokumenty**: DOCX se generuje/plní vlastním engine (`docxtemplater` + `reconstruct-engine.ts` + `template-engine.ts` + `doc-slots.ts`), PDF konverze přes Gotenberg (LibreOffice route). LibreOffice (`soffice`) je navíc zabalené přímo v Docker image pro `.doc → .docx` konverzi vstupních tenderových šablon (smlouvy apod.), viz `document-parser.ts`.

## Multi-agent pravidla

Komplexní úkol s více nezávislými částmi rozlož na sub-tasky, každý řeš jako samostatný sub-agent na vlastní feature větvi (`feature/nazev-subtask`), na konci merge přes PR do `main`.

## Tech stack

| Vrstva | Technologie | Poznámka |
|--------|------------|----------|
| Frontend | React 18 + TypeScript + Vite | Buildí se do statického `apps/web/dist`, servíruje ho Express |
| Design systém | Vlastní — CSS proměnné v `apps/web/src/styles/tokens/*.css` + ručně psané primitivy v `components/ui/` (inline styly řízené tokeny) + Tailwind utility třídy pro layout | NENÍ shadcn/ui (žádný `components.json`), Tailwind config jen mapuje utility na tokeny |
| Backend | Express (Node.js/TypeScript, `scripts/src/serve-api.ts`), spouští se přes `tsx` | Jeden proces, servíruje API i SPA, port 3001 |
| DB | PostgreSQL (`vz_warehouse`), image `pgvector/pgvector:pg16` | Přístup přes `pg` (node-pg), žádné ORM |
| Migrace | Timestamped SQL v `scripts/migrations/`, auto-aplikace při startu | Sledováno v tabulce `_migrations`, transakčně |
| Auth | JWT (`jsonwebtoken`) + RBAC role admin/analytik/viewer | Legacy statický `API_TOKEN` pro curl/skripty |
| AI — analýza/generování | Claude (Anthropic SDK, `ai-client.ts`) | Modely sonnet/haiku/opus přes `AI_MODEL` env, streaming volání |
| Vektorové vyhledávání | pgvector sloupec `embedding vector(1536)` + OpenAI `text-embedding-3-small` | Volitelné — bez `OPENAI_API_KEY` matcher vektorovou vrstvu přeskočí (spadne na text/exact tier) |
| Doc generation (DOCX) | `docxtemplater` + vlastní reconstruct/fill engine | `reconstruct-engine.ts`, `template-engine.ts`, `doc-slots.ts` |
| Doc konverze (PDF) | Gotenberg (Docker, LibreOffice route) | `pdf-converter.ts`, `GOTENBERG_URL` |
| .doc → .docx konverze | LibreOffice (`soffice`) přímo v Docker image | `document-parser.ts` |
| Data zdroj zakázek | Hlídač státu API | Veřejné zakázky ČR |
| Scraping cenového skladu | Apify actors + přímé HTTP scrapery | `apify-client.ts`, `scripts/src/scrapers/` |
| Hosting | Hetzner VPS, Docker Compose | `docker/docker-compose.hetzner.yml`, doména vz.ludone.cz |
| Registry image | GitHub Container Registry (GHCR) | `ghcr.io/make-more-s-r-o/aivz` |
| CI/CD | GitHub Actions | `.github/workflows/deploy.yml`: build → push GHCR → SSH deploy na Hetzner |
| Monorepo | Turborepo (`turbo.json`) | Workspaces: `apps/web`, `scripts`, `packages/shared` |

## Konvence

### Kód
- TypeScript VŽDY (nikdy plain JavaScript)
- Backend: `pg` Pool z `scripts/src/lib/db.ts` (query/queryOne helpery), žádné ORM
- Store moduly v `scripts/src/lib/*-store.ts` zapouzdřují SQL pro danou doménu (crm-store, warehouse-store, terminy-store, notif-store, comments-store, views-store, tags-store, user-store, company-store)
- Importy: absolutní cesty kde možné, relativní v rámci modulu
- Error handling: try/catch, strukturované chyby; DB nedostupnost → 503, ne pád procesu

### Databáze
- Single-tenant (žádný `tenant_id`) — multi-tenant je záměrně odložen
- Migrace v `scripts/migrations/` jako číslované SQL (`001_...` až `010_...`), aplikují se automaticky při startu (`runMigrations`)
- Store funkce testují dostupnost DB (`getPool() !== null`) a degradují gracefully (čtení → prázdno, zápis → chyba → 503)
- NIKDY neměnit produkční DB přímo — vždy přes nový migrační soubor

### Jazyk
- UI texty: **česky** (čeština je primární jazyk aplikace)
- Kód, komentáře, commit messages: dle globálních pravidel — komentáře česky, commit messages anglicky
- Proměnné a funkce: anglicky (`fetchTenders`, `analyzeDocument`)
- DB tabulky a sloupce: většinou anglicky (warehouse) i česky (CRM vrstva: `crm_tasks`, `crm_terminy`, `crm_notifikace`, `crm_komentare`, `crm_stitky`)

### Git
- Commit messages: anglicky, stručně, conventional commits (`feat:`, `fix:`, `chore:`)
- Branch naming: `feature/nazev`, `fix/nazev`, `hotfix/nazev`
- NIKDY force push na `main`
- Pull Requests pro všechny změny (i vlastní)

## Adresářová struktura

```
vz-ai-tool/
├── CLAUDE.md
├── turbo.json                     # Turborepo config
├── package.json                   # Root workspace (npm workspaces: apps/*, packages/*, scripts)
├── Dockerfile                     # Multi-stage: frontend build → api build → runtime (+ LibreOffice)
├── docker-entrypoint.sh           # Seeduje config/company.json a users.json do volume při prvním startu
├── .github/workflows/
│   └── deploy.yml                 # Build → GHCR push → SSH deploy (Hostinger legacy + Hetzner)
├── apps/
│   └── web/                       # React frontend
│       ├── src/
│       │   ├── components/        # Komponenty + components/ui/ (vlastní primitivy)
│       │   ├── pages/             # PrehledPage, ZakazkyPage, PipelinePage, KalendarPage, MonitoringPage, NastaveniPage, TenderDetailPage, ...
│       │   ├── hooks/, lib/, types/
│       │   └── styles/tokens/     # CSS proměnné design systému (palette, semantic, stages, typography, ...)
│       ├── tailwind.config.js     # Tailwind namapovaný na CSS proměnné, ne shadcn theme
│       └── package.json
├── packages/
│   └── shared/                    # Sdílené TypeScript typy
├── scripts/                       # Backend: pipeline + Express API server
│   ├── migrations/                # 001_warehouse_schema.sql ... 010_crm_stitky.sql
│   ├── src/
│   │   ├── serve-api.ts           # Express app — API + statický SPA server (jeden proces)
│   │   ├── extract-tender.ts / analyze-tender.ts / match-product.ts / generate-bid.ts / validate-bid.ts
│   │   ├── full-flow.ts           # Orchestrace celého pipeline jako sekvence CLI kroků
│   │   ├── prompts/                # Prompty pro AI kroky (analyze-tender, product-match, technical-proposal, ...)
│   │   ├── scrapers/               # Scraping cenového skladu (Apify + přímé HTTP scrapery)
│   │   └── lib/                    # db.ts, db-migrate.ts, ai-client.ts, jwt-auth.ts, user-store.ts,
│   │                                # crm-store.ts, terminy-store.ts, notif-store.ts, comments-store.ts,
│   │                                # views-store.ts, tags-store.ts, warehouse-store.ts, warehouse-matcher.ts,
│   │                                # stage-machine.ts, submit-gate.ts, template-engine.ts, reconstruct-engine.ts,
│   │                                # doc-slots.ts, pdf-converter.ts, apify-client.ts, icecat-client.ts, ...
│   └── package.json
├── config/                        # company.json (výchozí firemní údaje), companies/ (per-firma data)
├── templates/                     # DOCX šablony (krycí list, čestné prohlášení, seznam poddodavatelů, ...)
├── docker/
│   ├── docker-compose.hetzner.yml # Prod: vz-api + vz-postgres (pgvector image) + vz-gotenberg
│   └── docker-compose.prod.yml    # Legacy Hostinger deploy cesta
├── input/                         # Vstupní zadávací dokumentace jednotlivých zakázek
└── output/                        # Vygenerované nabídkové dokumenty
```

## Klíčové příkazy

```bash
# Monorepo (root)
npm run dev                             # turbo dev — spustí web (vite) i scripts (tsx serve-api) souběžně
npm run build                           # turbo build
npm run lint                            # turbo lint
npm run test:e2e                        # Playwright E2E testy

# Frontend samostatně
cd apps/web && npm run dev              # Vite dev server
cd apps/web && npm run build            # tsc -b && vite build → dist/

# Backend API server samostatně
cd scripts && npm run dev               # tsx src/serve-api.ts (port 3001)
# POZOR: serve-api.ts se nereloaduje sám při změně kódu — po editaci ručně restartovat

# Pipeline kroky (CLI, per zakázka)
cd scripts && npm run extract -- --tender-id=<id>
cd scripts && npm run analyze -- --tender-id=<id>
cd scripts && npm run match -- --tender-id=<id>
cd scripts && npm run generate -- --tender-id=<id>
cd scripts && npm run validate -- --tender-id=<id>
cd scripts && npm run full-flow -- --tender-id=<id>   # všech 5 kroků za sebou

# Databáze — migrace se aplikují AUTOMATICKY při startu serve-api.ts, není potřeba ruční příkaz
# Lokální Postgres: DATABASE_URL v scripts/.env nebo root .env

# Docker (produkce, na Hetzneru — /opt/vz)
docker compose -f docker-compose.hetzner.yml up -d
docker compose -f docker-compose.hetzner.yml logs -f vz-api
docker compose -f docker-compose.hetzner.yml pull      # bývá pomalé/timeoutuje, viz níže
```

## MCP servery

`.mcp.json` je v `.gitignore` (per-vývojářská lokální konfigurace, není součást repa) — v tomto worktree ani neexistuje. Na hlavním checkoutu (`/Users/dan/Dev/ClaudeCode/VZ/.mcp.json`) je aktuálně nakonfigurováno:

1. **hostinger-mcp** — správa Hostinger VPS/DNS (Hetzner je samostatný VPS, ne přes tohle)
2. **n8n-mcp** — knowledge/tooling pro psaní n8n workflow JSONů (Hostinger n8n instance); v aplikaci samotné n8n neběží jako runtime součást
3. **apify** — scraping actors pro cenový sklad

Supabase MCP a GitHub MCP nejsou nakonfigurované — GitHub operace jdou přes `gh` CLI.

## Na čem právě pracuji

**CRM vrstva (M1–M9) je hotová a NASAZENÁ na vz.ludone.cz** (Express + Postgres, GHCR image, Hetzner VPS): stavy zakázek + state machine + drag&drop pipeline (crm_tender_status, crm_activity), úkoly a checklisty (crm_tasks), termíny a reminder sweep (crm_terminy), notifikace (crm_notifikace), komentáře s @mention (crm_komentare), uložené pohledy (crm_ulozene_pohledy), štítky (crm_stitky, zakazka_stitky), RBAC role admin/analytik/viewer.

**AKTUÁLNÍ FÁZE**: reálné testování průchodnosti celého pipeline (extract → analyze → match → generate → validate) na skutečných zakázkách z `input/`, ladění kvality AI výstupů a vyplňování dokumentů.

## Známé problémy a workaroundy

- **Template DOCX z tendrů** mají free-text placeholdery ("doplní účastník", "[účastník vyplní]"), ne `{{}}` — `docxtemplater` je nenahradí, řeší se vlastním reconstruct/fill engine (`reconstruct-engine.ts`, `template-engine.ts`)
- **`serve-api.ts` se nereloaduje automaticky** — po změnách backend kódu nutný ruční restart (`npm run dev` v `scripts/`)
- **Graceful degradace bez DB**: pokud `DATABASE_URL` chybí nebo Postgres nejede, appka neshodí — čtecí endpointy vrací prázdno, zápisy 503. Užitečné pro lokální vývoj bez DB, ale může maskovat skutečný výpadek v produkci
- **`docker compose pull` na Hetzneru** občas timeoutuje (image ~386 MB, `command_timeout` 10 min v deploy workflow) — při selhání GitHub Actions jobu stačí re-run
- **Case-sensitive routing** v Expressu je nutné mít zapnuté (`app.set('case sensitive routing', true)`) — bez toho `/API/...` obchází auth/RBAC middleware (case-sensitive `startsWith('/api/')` guard)
- **Vektorové vyhledávání v cenovém skladu** (pgvector) vyžaduje `OPENAI_API_KEY`; v produkčním `docker-compose.hetzner.yml` není nastaven, takže matcher aktuálně padá zpět na text/exact tier místo vector tier
- **LibreOffice** (`soffice`) je zabalené přímo v Docker image (`apk add libreoffice-writer`) kvůli konverzi `.doc → .docx` u vstupních tenderových šablon (např. kupní smlouva) — bez něj `document-parser.ts` tyto soubory tiše zahazuje
- **`hodnotici_kriteria`** v `TenderAnalysisSchema` — AI občas vynechá, řešeno `.optional().default([])`

## Referenční dokumenty

- `docs/technicka-implementace-v2.md` — architektura, DB schéma, AI stack (historický dokument, část je zastaralá — viz tento CLAUDE.md pro aktuální stav)
- `docs/strategicka-mapa.md` — business case, trh, příjmový model
- `docs/todo-implementace-v3.md` — implementační plán
- `docs/design-brief-vz-crm.md` — design brief CRM vrstvy
- `docs/bugs-and-todos.md` — průběžný seznam bugů a TODO
- `docs/e2e-report-N485400.md` — E2E report pipeline na konkrétní zakázce
