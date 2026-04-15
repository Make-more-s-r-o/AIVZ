# VZ — Systémová architektura: 3 varianty a doporučení

**Datum:** 2026-04-15
**Autor:** Architectural strategy agent
**Kontext:** Mini-MVP běží (audit 2026-02-21, E2E 865063 ze 2026-03-17), 6 tenderů E2E, ~35-40 % původního plánu hotovo, pricing warehouse fáze 1-6 + Prusa scraper hotové. Cíl: interně podávat **10-20 VZ / den v hodnotě 50-500 k Kč**.

---

## Základní čísla pro kalkulace

- **AI cost dnes:** generate 3,68 CZK + validate 2,23 CZK + analyze ~1 CZK = **~7 CZK/tender** (Sonnet pro analýzu, Haiku pro triage).
- **Lidský čas dnes (audit):** 4-8 hodin/tender (review, upload kvalifikačních dokladů, fix šablon, portal submit manuálně). Cíl: 30-60 minut.
- **Hrubá marže 50-500 k Kč zakázky při 10 %:** 5-50 k Kč → cena zakázky za zpracování může pohltit 200-2000 Kč AI nákladů, ne víc.
- **Hit-rate (odhad):** 10-25 % nabídek končí výhrou. Na 200 zakázek/měsíc ⇒ 20-50 výher/měsíc.
- **Portálů k integraci:** NEN, Tenderarena, E-ZAK, EZAKAZKY. Každý má jiný login, formulář, validaci certifikátem.

---

## A) VZ 1.0 continued — ladíme současnou architekturu

### Diagram flow

```
Email (FEN XLSX)
    ↓  [n8n IMAP trigger]
FEN parser (ts) ─→ tenders DB (Postgres/Supabase)
    ↓
extract-tender.ts  ─→ /data/tenders/<id>/extracted/
    ↓
analyze-tender.ts  ─→ analysis.json  (Claude Sonnet)
    ↓
match-product.ts   ─→ product-match.json  (warehouse lookup + Haiku + Sonnet)
    ↓
React UI: user review cen, marže, potvrzení
    ↓
generate-bid.ts    ─→ 7 DOCX + XLSX + PDF (Carbone/docxtemplater + Gotenberg)
    ↓
validate-bid.ts    ─→ scorecard
    ↓
User review UI → "Odeslat" tlačítko
    ↓  [MANUÁLNĚ] user loguje do NEN/Tenderarena/E-ZAK, uploaduje ZIP
```

### Komponenty

| Vrstva | Co | Technologie |
|---|---|---|
| Poll mailu | FEN parser trigger | n8n IMAP + ts parser |
| API | 23 endpointů (serve-api.ts, 24 kB) | Express/Node |
| Pipeline | 5 skriptů (extract/analyze/match/generate/validate) | TS + tsx loader, spawn-based job queue |
| DB | tenders, products, prices, runs | Supabase Postgres + pgvector |
| Warehouse | Prusa scraper + fáze 1-6 | scripts/src/scrapers/ |
| Doc gen | template-engine.ts (41 kB) | docxtemplater + AI fill + clean builder |
| PDF | `--convert-to pdf` | Gotenberg/LibreOffice headless |
| UI | React + shadcn, 9 stránek | apps/web |
| Auth | Bearer token (workaround) | — |
| AI | Sonnet + Haiku | Anthropic API |
| Orchestrator | n8n (plán, dnes skoro ne) | Docker na VPS |
| Portály | **člověk manuálně** | NEN, Tenderarena, E-ZAK, EZAKAZKY |

### Dělící čáry

| Krok | Agent (LLM) | Člověk | App/kód |
|---|---|---|---|
| Příjem FEN | — | — | parser |
| Extrakce PDF/DOCX | — | — | skript |
| Analýza ZD | Sonnet 1× | — | skript |
| Matching produktů | Haiku pre-filter + Sonnet batch | — | skript + warehouse DB |
| Cenová kalkulace | — | **schvaluje marži** | UI (ItemPriceCalculator) |
| Generování | Sonnet pro fill/reconstruct | — | template-engine |
| Validace | Sonnet | **čte scorecard, opravuje** | validate-bid |
| Kvalifikační doklady | — | **uploaduje** | UI attachment |
| Podání portálem | — | **přihlásí se, uploaduje** | — |

### Cena per zakázka

- AI: analyze 1 + match 1,5 + generate 3,7 + validate 2,2 = **~8,4 CZK**
- Infra: Hostinger VPS 1,2 k/měs, Supabase free / 25 USD, Gotenberg zdarma. Při 400 tenderů/měs → **~3-7 CZK/tender infra**.
- Lidský čas: dnes 4-8 h, realisticky po všech fixech (soupis, XLSX, template reliability) **60-120 min** × 800 Kč/h = **~800-1 600 CZK/tender**.
- Portal submit: 15-30 min manuálně = **~300 Kč/tender**.
- **Totál: ~1 200-2 000 CZK/tender** (AI je zanedbatelný, člověk dominuje).
- **Měsíčně 10-20/den × 22 dnů = 220-440 tenderů → 260-880 k Kč osobních nákladů.**

### Čas do funkčnosti

- **MVP (první reálná nabídka):** 2-3 týdny — fix XLSX soupis output, PDF, template reliability, kvalifikační upload UI (viz audit sekce 7).
- **Produkce 10-20/den:** 8-12 týdnů — plná n8n orchestrace, monitoring, retry, SLA, error budget, knowledge base, druhý validátor, rollback deploy.

### Migration path

Žádná. Jede se dál.

### Silné stránky

- Hotové, testované, deployed, 6 tenderů E2E, metriky existují.
- Kód je čitelný, skripty modulární, AI cost 7 CZK je tak nízký, že je irelevantní.
- Deterministická pipeline — každý krok lze spustit samostatně, retryovat, auditovat.
- Pricing warehouse je přesně ten směr, kterým by šlo každé řešení — **to se nezahazuje**.

### Slabé stránky

- **Portál submit zůstává manuální.** To je 300 Kč + pozornost per tender, při 20/den = 6 000 Kč/den.
- **Review UX** je "prohlédni 7 dokumentů, klikni 4×" — drahá pozornost.
- **Template filling** má 30-40 % miss rate dle auditu 4.2. Hybrid fix pomůže, ale zůstává křehký.
- **n8n** pro multi-step AI řetězce je nepřirozený (JSON workflow pro LLM retry + branching je horor).
- **Nepřirozené pro "agent je nejistý → přijde člověk"** — dnes je logika "skript vrátí JSON, UI ukáže, user klikne". Nejistota není first-class.
- **Škálování na 50+/den** vyžaduje hodně lidského review kapacit.

### Rizika

- **Tech:** template-engine.ts (41 kB) je single point of complexity; každá nová šablona = nový bug. Klasifikace šablon závisí na heuristikách.
- **Operační:** FAIL na cenova_nabidka a kryci_list XLSX znamená, že "ship" stav je v realitě ~70 %. Bez dashboardu s retry/alerting to člověk neuhlídá při 20/den.
- **Lidská:** know-how je v skriptech a v hlavě 1 developera. Nový operátor potřebuje týdny.
- **Portály se mění** — každý redesign NEN/Tenderareny = manuální adaptace SOP.

---

## B) Hybrid — webapp je systém záznamu, agent dělá pracné

### Diagram flow

```
Email (FEN XLSX)
    ↓
n8n (nebo cron) → upload do "inbox" tabulky (vz_tenders: status=new)
    ↓
┌──────── Anthropic Agent run (Claude Agent SDK, Sonnet + Haiku) ───────┐
│  Skills: extract-tender, analyze-zd, match-warehouse, draft-bid,      │
│          validate-bid, prepare-submission                             │
│  MCP servery: pricing-warehouse-mcp, company-profile-mcp,             │
│               hlidac-statu-mcp, gotenberg-mcp, portal-nen-mcp (CU),   │
│               portal-tenderarena-mcp (CU), portal-ezak-mcp (CU)       │
│  Agent volá skills/MCP iterativně, loguje eventy do vz_agent_runs     │
│  Při nejistotě → vytvoří "human_review" task s kontextem              │
└───────────────────────────────────────────────────────────────────────┘
    ↓                                    ↓
Draft uložen do DB                   Review task v UI
    ↓                                    ↓
Webapp: user vidí draft, upraví marži, schválí
    ↓
Agent pokračuje: vyplní portal (computer use), submit
    ↓
Audit log + uložená nabídka (blob storage) + potvrzení podání
```

### Komponenty

| Typ | Co | Technologie |
|---|---|---|
| Classic kód | FEN parser, warehouse DB, company-profile storage, audit log | Node/ts, Postgres |
| MCP server | pricing-warehouse-mcp | lookup_product, get_price_history, get_margin_hint |
| MCP server | company-profile-mcp | get_ico, get_contacts, get_certificates, list_qualifying_docs |
| MCP server | hlidac-statu-mcp | search_tender, get_tender_detail (hotový v .mcp.json) |
| MCP server | doc-gen-mcp | render_docx(template, data), convert_pdf, zip_bundle |
| MCP server (CU) | portal-nen-mcp, portal-tenderarena-mcp, … | tenký wrapper nad computer-use (login, upload, submit) |
| Skill | "analyze-tender" | Zod schema + prompt + references (audit-report, vzory) |
| Skill | "draft-bid" | Orchestrace render_docx pro 7 typů |
| Skill | "portal-submit" | SOP playbook pro každý portál |
| Agent | Claude Agent SDK (Sonnet 4.5 + Haiku pro batch) | async runs, event log |
| UI | Review dashboard (React, zachováme) | Seznam běhů, review tasks, price editor, audit trail |
| DB | `vz_agent_runs`, `vz_events`, `vz_human_tasks`, `vz_bids` | Postgres |
| External | Anthropic API, Gotenberg | |

### Dělící čáry

| Krok | Agent | Člověk | App/kód |
|---|---|---|---|
| Příjem FEN | — | — | parser |
| Extrakce | volá skill | — | skript jako MCP tool |
| Analýza | **autonomně** | — | — |
| Warehouse lookup | MCP volání | — | DB |
| Cena/marže | navrhne, ukáže | **schvaluje marži** | review UI |
| Draft | generuje všech 7 dokumentů | — | doc-gen-mcp |
| Validace | self-review | — | — |
| Kvalifikační doklady | požádá MCP o seznam | **nahrává chybějící** | UI |
| Podání | computer-use na portálu | **schvaluje finální submit (tlačítko)** | portal-MCP |
| Rozhodnutí "jít / nejít" | doporučí (score) | **finální GO/NO-GO** | UI |

### Cena per zakázka

- Agent run: typicky 8-15 kroků, 150-400 k tokenů (analýza ZD + multi-step orchestrace + self-correction). S prompt cache Sonnet ~**18-35 CZK/tender**.
- Computer-use pro submit: 1-3 min, 30-80 k tokenů, ~**5-12 CZK/tender**.
- Haiku pro warehouse matching batch: ~**1 CZK**.
- **AI totál: ~25-50 CZK/tender.** Stále pod 0,01 % hodnoty zakázky.
- Infra: +25 USD/měs Supabase, VPS stejný, MCP servery jako Docker sidecars.
- **Lidský čas: ~15-30 min/tender** (jen schválení marže + nahrání dokladů + final click). × 800 Kč/h = **200-400 Kč**.
- **Totál: ~225-450 CZK/tender.**
- **Měsíčně 440 tenderů: AI 11-22 k Kč + lidský čas 90-180 k Kč + infra ~5 k Kč = 106-207 k Kč.** Proti variantě A úspora **~50-70 %** hlavně na lidech.

### Čas do funkčnosti

- **MVP:** 4-6 týdnů.
  - Týden 1-2: MCP servery pro warehouse + doc-gen + company-profile (tenké wrappery nad existujícími skripty).
  - Týden 3: skills pro analyze/draft/validate + review UI schvalování + audit log.
  - Týden 4: 1 portál (start NEN — nejtěžší, open standard) přes computer-use, pilot na 1-2 reálných zakázkách.
  - Týden 5-6: stabilizace, druhý portál.
- **Produkce 10-20/den:** 12-16 týdnů (všech 4 portálů + monitoring + retry + playbooky).

### Migration path

**Zachránit:**
- Pricing warehouse + Prusa scraper (1:1 se stává MCP serverem).
- Skripty extract/analyze/match/generate/validate — obal se jako MCP tools, prompt logika zůstane.
- Template engine (klidně ho necháme — volá se z doc-gen-mcp).
- React UI, ale reduced scope: dashboard běhů + review tasky + audit trail (dnes 9 stránek → 4-5 stránek).
- Company profile JSON.

**Zahodit / parkovat:**
- n8n jako orchestrátor AI flow — nahradí agent. n8n může zůstat na drobné triggery (cron, IMAP poll), ale ne na řetězec AI kroků.
- Velkou část custom async job queue v `serve-api.ts` — agent SDK to řeší nativně.
- Heuristickou klasifikaci šablon — agent volá "classify_template" skill a má kontext.

**Kritický bod:** nedávat agentovi přímo do kódu — přes MCP. Tím si chráníme refactor.

### Silné stránky

- **"Agent dělá nejpracnější, člověk marži + final click"** přesně, jak uživatel chce.
- **Nejistota je first-class:** agent vytvoří `human_review` task a pokračuje/počká.
- Řízená migrace — každý skript se dá přemigrovat jako MCP tool bez přepisu.
- Warehouse, šablony, company profile — **všechno to bohatství se neztratí**.
- Škála: agent běží paralelně, limit je jen review kapacita člověka.
- Computer-use pro portály je **jediné realistické řešení** (4 portály, jiné UX, API neposkytují).

### Slabé stránky

- **Computer-use pro submit je křehká** (Q1 2026 stále maturity nízká), ladí se po webech.
- Agent runs jsou drah(ší) než skripty — 3-7× proti A. Pro 50 k zakázku je OK, pro těžkou hromadu 50 k drobností už ne úplně.
- Observability agent runs je náročnější — potřeba good event log, traces, replays.
- **Přeučení týmu:** "skript → JSON → klikni" vs "agent → review task → schval". Jiná mentální mapa.

### Rizika

- **Tech:** agent uvízne ve smyčce, self-correct nedobere, timeout. Mitigace: hard step cap (12 kroků), budget cap, eskalace na člověka.
- **Operační:** portál change → CU skripty se rozpadnou. Mitigace: portal-MCP smoke test denně, screenshot diffing.
- **Lidská:** operátor ztrácí detailní know-how o jednotlivých krocích (vše dělá agent). Mitigace: audit log + "replay runs".
- **Legal:** computer-use na veřejných portálech má smluvní nejasnosti (viz paralelní legal agent). Pokud portál má ToS proti botům → submit musí zůstat manuální, CU dělá jen prep.

---

## C) VZ 2.0 agent-first — tenký dashboard nad agentními běhy

### Diagram flow

```
Email → blob storage (raw XLSX/PDF)
    ↓ trigger
Agent spawn (Claude Agent SDK, sub-agents: scout, analyst, pricer, writer, submitter)
    ↓
Agent si sám pulluje dokumenty, warehouse, company profile přes MCP
Agent řídí celý workflow, loguje eventy do event store
Při GO/NO-GO nebo schválení → vytvoří human task
    ↓
UI = tenký dashboard:
    - List of runs (status, cost, duration)
    - Human task queue (marže, uploady, final click)
    - Event replay (debug)
    - Audit trail (compliance)
    ↓
Submit přes CU MCP (nebo člověk, pokud CU nelze)
```

### Komponenty

| Typ | Co |
|---|---|
| Classic kód | Minimal: event ingestion, blob upload, auth, scheduling |
| Blob storage | Raw documenty, drafty, final bundle (S3 / Supabase Storage) |
| Event store | agent_runs, events, human_tasks (append-only) |
| MCP servery | warehouse, company-profile, doc-gen, portal-CU (4×), hlidac-statu, email-parser |
| Agent prompts / skills | scout (poll email, triage), analyst, pricer, writer, reviewer, submitter |
| Sub-agent pattern | main agent spawnuje workers per tender |
| UI | Thin React (2-3 stránky): Runs, Tasks, Settings |
| External | Anthropic API, Gotenberg, portal sites |

### Dělící čáry

| Krok | Agent | Člověk | App |
|---|---|---|---|
| Trigger | scout (autonomní) | — | blob |
| Vše od analýzy po draft | analyst + writer | — | — |
| Warehouse / katalog | pricer | — | warehouse-MCP |
| Marže | pricer navrhne | **klikne schválit** | human task |
| Validace | reviewer (self) | — | — |
| Uploady | reviewer požádá | **nahraje** | human task |
| Submit | submitter (CU) | **klikne GO** | portal-MCP |
| Monitoring | — | **čte dashboard** | — |

### Cena per zakázka

- Agent run delší, více sub-agentů, víc tokenů: 400-800 k tokenů ⇒ Sonnet ~**40-90 CZK**.
- Computer-use: ~8-15 CZK.
- **AI totál: ~50-105 CZK/tender.** U 50 k zakázky pořád 0,1 %.
- Lidský čas: ~10-15 min/tender = **130-200 Kč**.
- **Totál: ~180-300 CZK/tender.**
- **Měsíčně 440 tenderů: AI 22-46 k Kč + lidi 60-90 k Kč + infra 7 k Kč = 90-145 k Kč.**

### Čas do funkčnosti

- **MVP:** 8-10 týdnů. Nové skills + nové MCP + nový UI + refactor storage + agent design + sub-agent orchestrace.
- **Produkce:** 16-24 týdnů. Škálování, obs, retry, playbooky, multi-portál CU.

### Migration path

- Většina dnešního React UI se zahodí / zjednoduší.
- Express API server se zmenší na tenkou auth + event ingestion vrstvu.
- Pipeline skripty se refaktorují do MCP tools (podobně jako v B), **ale jdou ještě dál** — žádná "5-step pipeline", agent si to poskládá sám.
- Warehouse zůstává, company profile zůstává, šablony zůstávají.
- n8n pryč.

### Silné stránky

- **Future-proof:** agent ecosystem (skills, MCPs) se explicitně rozvíjí ve směru, který Anthropic roadmapuje.
- **Nejlevnější ustálený provoz** (lidský čas minimální).
- **Nejflexibilnější** — nový portál = nový MCP, bez změn v jádře.
- **"Agent dělá nejpracnější"** v maximální míře.

### Slabé stránky

- **Velký rewrite.** Zahodíme hodně současné práce (UI, část API, klasifikace šablon, async queue).
- **Stav nástrojů Q2 2026:** agent SDK + computer-use jsou maturity ~2/5. Bez safety netu (deterministických skriptů) je riziko podání chybné nabídky neúnosné.
- **Debugging agent chování** je těžší než debug deterministického skriptu.
- **"Premature architecture":** dnes máme 6 E2E tenderů, ne 1000. Navrhovat systém pro 50+/den, když neumíme ještě stabilně 10 reálných, je risk.
- Při 10-20/den je absolutní úspora oproti B jen ~15-40 k Kč/měs, což nestojí za rewrite v tuto chvíli.

### Rizika

- **Tech:** CU na 4 portálech current-gen = 1-2 ze 4 budou dlouhodobě nespolehlivé. Fallback na člověka nutný.
- **Operační:** bez deterministického pipeline se ztratí schopnost rychle reprodukovat konkrétní krok. Event replay to částečně řeší, ale ne úplně.
- **Lidská:** tým ztratí cit pro jednotlivé kroky; když agent chybuje, člověk nemá intuition.
- **Business:** 8-10 týdnů bez progressu v dashboardu vs. 3 týdny v B.

---

## Porovnávací tabulka

| Kritérium | A VZ 1.0 | B Hybrid | C Agent-first |
|---|---|---|---|
| Cena per zakázka (vše včetně člověka) | 1 200-2 000 Kč | 225-450 Kč | 180-300 Kč |
| AI cost per zakázka | ~8 Kč | 25-50 Kč | 50-105 Kč |
| Čas do MVP | 2-3 týdny (už 85 %) | 4-6 týdnů | 8-10 týdnů |
| Čas do produkce 10-20/den | 8-12 týdnů | 12-16 týdnů | 16-24 týdnů |
| Riziko selhání (nabídka s chybou) | Střední (ruční review chytne) | Střední-nízké (review task + schvalování) | Střední-vysoké (agent autonomie + CU) |
| Škálovatelnost na 50+/den | Lidský strop ~25/den | 70-100/den (review-limited) | 150+/den |
| Future-proofnost (24 měs.) | Nízká (kustom skripty) | Vysoká (MCP + skills + klasika) | Nejvyšší, ale vsazeno na nezralé nástroje |
| Náklady údržby/měs | 15-30 k Kč (devops + bugfix) | 20-35 k Kč (+ MCP údržba) | 30-50 k Kč (+ agent obs + CU smoke) |
| Využití dnes hotového | 100 % | 80-85 % | 45-55 % |
| Soulad s preferencí ("agent dělá pracné") | Nízký | **Vysoký** | Nejvyšší |

---

## Doporučení

### Varianta **B (Hybrid) teď, s otevřenými dveřmi pro C do 9-12 měsíců.**

**Proč B:**

1. **Ekonomika.** Cíl je 10-20/den, ne 50+. Dnešní bottleneck není AI cost (7 Kč), ale lidský čas review a manuální portal submit. B tlačí lidský čas z 4-8 h na 15-30 min — to je 10× zlepšení **s reálným business impactem** (úspora 100-200 k Kč/měs u 440 tenderů). C přidá jen dalších ~15-30 % nad B, ale za cenu 2-3× delšího time-to-market a rewritů.

2. **Riziko.** C sází na CU a agent-first v době, kdy CU je maturity 2/5 a pravomocné smluvní tělo (portál ToS, ZZVZ, eIDAS pro podpisy) má nevyjasněné interpretace. B drží deterministický skelet jako safety net. Když agent selže, pipeline dojede, člověk doplní — systém submituje. V C je failure mode "celý run padl" běžnější.

3. **Využití dnes hotového.** B recykluje 80-85 % kódu: pipeline skripty jako MCP tools, warehouse a scraper beze změny, template engine nechá jak je. C zahazuje UI, async queue, velkou část serveru. Při 35-40 % plánu hotovém je zahození drahé a demoralizující.

4. **Preferenční fit.** Uživatel řekl: "agent dělá nejpracnější, člověk nastavuje marži a schvaluje odeslání. Kde je agent nejistý, přijde člověk." Toto je **přesná definice hybrid pattern** (agent jako default worker, human-in-the-loop pro high-trust rozhodnutí).

5. **Učící křivka.** B je přirozený učící krok: tým pozná Claude Agent SDK, MCP servery, computer-use, review UX — na relativně malé ploše (warehouse MCP, 1 portál). Z B do C je pak inkrementální posun (víc autonomie, tenčí UI), ne rewrite.

### Fáze

- **Fáze B1 (týdny 1-6):** MCP-ifikace warehouse + doc-gen + company-profile, agent orchestrace analýzy a draftu, review UI zjednodušení, **1 portál CU (doporučuju NEN — nejotevřenější a nejčastější).** Cíl: 1 reálná podaná nabídka.
- **Fáze B2 (týdny 7-16):** zbylé 3 portály, monitoring, retry, audit trail pro compliance, přepnutí z Express serveru na agent-first koncept pro nové tendery; starý pipeline mode jen jako fallback.
- **Fáze C-ready (měsíc 9-12):** vyhodnocení — pokud CU zralejší, tým komfortní a scale reálně tlačí nad 25/den, přejít na tenčí UI a plně agent-driven. Pokud ne, zůstáváme na B navždy.

---

## De-risk plán prvních 2 týdnů (pro variantu B)

**Cíl:** před psaním MCP serverů mít ověřené 3 neznámé, aby se investice 4-6 týdnů neukázala jako chyba.

### Týden 1

1. **Spike Claude Agent SDK (2 dny).** Vzít existující `analyze-tender.ts` a zabalit jako skill + jeden agent run přes SDK. Změřit: token cost, latence, chování při nejistotě (jak snadno agent vyrobí `human_review` task?). Blocker, pokud run stojí >100 CZK pro jednu analýzu nebo SDK nemá čisté "pause for human" primitivum.
2. **Spike computer-use na NEN (2 dny).** Zkusit: přihlášení, nalezení zakázky, upload dummy ZIP, submit-bez-potvrzení (dry run). Měřit success rate na 5 manuálních pokusech. Blocker, pokud <3/5 úspěch nebo ToS explicitně zakazuje boty (spolupráce s legal agentem).
3. **Review UX wireframe (1 den).** Jeden screen: "Run #123, agent doporučuje marži 12 %, tady je 7 dokumentů, 2 chybějící doklady. Schválit / Upravit / Odmítnout." S uživatelem ověřit, že je to ten flow, který chce.

### Týden 2

4. **MCP warehouse server (2 dny).** 4 tooly: `lookup_product`, `get_price_history`, `get_margin_hint`, `log_feedback`. Nativní test přes Claude Desktop / Inspector.
5. **MCP doc-gen server (2 dny).** 3 tooly: `render_docx`, `convert_pdf`, `bundle_zip`. Reuse `template-engine.ts`.
6. **End-to-end dry run (1 den).** Agent run nad 865063: analyze → match (přes MCP warehouse) → draft (přes MCP doc-gen) → validate → stop před submitem. Porovnat s v2 reportem (shoda na 7 dokumentech, cost pod 50 CZK, žádný halucinace v cenách z warehouse).

**Go/no-go kritéria na konci týdne 2:**

- [ ] Agent SDK run stabilní, <50 CZK per plný draft run.
- [ ] CU NEN 4/5 úspěch na dry run, legal zelená.
- [ ] Review UX schválen uživatelem.
- [ ] Warehouse MCP vrací stejné matche jako `match-product.ts` na 3 z 3 testovaných tenderů.
- [ ] Draft se shoduje s referenčním e2e-report 865063 na ≥6 ze 7 dokumentů.

Pokud 4/5 splněno → jdeme do B1. Pokud <4 → re-plan (možná A+ krátkodobě, nebo čekat 1 kvartál na vyzrání CU).

---

## Co by zvrátilo doporučení

Doporučení B padá / posouvá se, pokud **paralelní agent-landscape / legal / devil's advocate** přinesou některý z následujících nálezů:

| Nález | Odkud | Důsledek |
|---|---|---|
| **Agent SDK + MCP ještě zásadně nestabilní (rate limits, breaking changes Q2)** | Agent landscape | A ještě 3-6 měs., pak B. |
| **Computer-use na žádném ze 4 portálů neprojde ToS / ZZVZ / eIDAS** | Legal | B i C se amputují o submit — pak jen draft (zůstává 60 % úspory, stále lepší než A). |
| **Hit-rate se ukáže <5 %** (příliš málo výher) | Business reality check | Priorita klesá na cenu per draft; pak C přes A přes B (A je nejlevnější na MVP, když nepůjdeme dál). |
| **NEN/Tenderarena poskytují oficiální API / webhook submission** | Agent landscape | CU MCP nepotřeba → B se zjednoduší, časový odhad -2 týdny. |
| **Opus 5 nebo srovnatelný model s "full-workflow agents" vyjde Q2 2026** | Agent landscape | Zvážit C dřív (místo 9-12 měs. třeba 4-6). |
| **Konkurenční SaaS (Tender Arena nebo QCM) vydá AI bid generator** | Devil's advocate | Focus se posouvá z "nejlepší architektura" na "nejrychlejší do ostrého" — A se hodí na 2-3 měsíce, pak pivot. |
| **Interní kapacita 1 dev, ne 2+** | Devil's advocate | B je na hraně; C nemožné. A + postupně MCP-ify jen nejbolestivější místa. |
| **ZZVZ vyžaduje digitální podpis držitele (ne agenta)** | Legal | Final submit **musí** zůstat manuální. B zůstává (draft + review), ale část úspory ze submit automatizace padá. |

---

## Závěr

- **Dělej B.**
- Začni 2-týdenním de-risk spike (agent SDK + NEN CU + review UX).
- Nech A běžet (produkce je A, nic se nevypíná — postupně se tendery přeroutují na B).
- Nech C jako severku pro rok 2027, jestli se vývoj nástrojů a scale potvrdí.
- Neutrácej energii na kontextové sliby kterékoli varianty, dokud paralelní agenti (legal, landscape, devil's advocate) neodevzdají svá zjištění — ta mají pravomoc B vyřadit i zrychlit.
