# Autonomní AI agenti od Anthropicu pro české veřejné zakázky

**Datum:** 15. dubna 2026
**Autor:** Claude (Opus 4.6, 1M kontext) pro Make more s.r.o.
**Účel:** Podklad pro strategické rozhodnutí — pokračovat v dosavadní architektuře VZ projektu (React + Supabase + n8n + Claude Sonnet 4.5), nebo přeskočit na AI-first stack postavený na Anthropic agentech.

> **TL;DR** — Od **8. dubna 2026** existuje oficiální produkt **Claude Managed Agents** (public beta), který poskytuje hostovanou infrastrukturu pro autonomní agenty běžící hodiny. **Computer Use** je stále beta a pro zadávací portály (NEN, Tenderarena, profily zadavatelů) spolehlivě zvládne čtení/stažení, nikoliv však **elektronický podpis na tokenu, datové schránky ani CAPTCHA**. **Agent SDK** a **Skills** jsou vyzrálé a nasaditelné produkčně. Pro 10–20 zakázek denně je ekonomika zvládnutelná (řádově 100–400 USD/měsíc na inference), ale nelze úplně obejít člověka u finálního podání.

---

## 1. Claude Agent SDK

**Co to je:** Knihovna pro Python a TypeScript (`@anthropic-ai/claude-agent-sdk`, `claude-agent-sdk`), která dává stejný agent loop, tooling a context management jako Claude Code, ale jako volatelnou knihovnu. Přejmenováno z „Claude Code SDK" koncem 2025.

**Co reálně zvládne samostatně:**

- **Built-in tooly bez implementace:** `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Monitor`, `AskUserQuestion`. Vše funguje „out of the box" — nemusíte psát tool executor.
- **Subagents:** rozdělení úkolu na izolované kontexty (dispatching). Použitelné pro „jeden agent extrahuje ZD, druhý nacení, třetí generuje dokumenty".
- **Skills:** filesystem-based, `.claude/skills/<nazev>/SKILL.md` — progressive disclosure (popis vždy v kontextu, obsah se loaduje jen při invokaci).
- **MCP servery:** plug-and-play přes `mcpServers` option.
- **Hooks:** `PreToolUse`, `PostToolUse`, `SessionStart`, `SessionEnd` — pro audit, blokování, transformaci.
- **Sessions:** `resume` parametr — session ID z první query lze použít pro pokračování s plným kontextem.
- **Permissions:** `allowedTools`, `permissionMode: "acceptEdits"`, atd.

**Kontext a compaction:**

- 200K tokens standardně, **1M tokens** u Opus 4.6/Sonnet 4.6 přes beta.
- Auto-compaction trigger ≈ 83,5 % (tedy kolem 167K tokenů u 200K okna).
- Přes **Compaction API** (`compact-2026-01-12` beta header) lze conversationu držet „do nekonečna" — starší turns se sumarizují do `compaction` bloku. Minimální trigger = 50 000 tokenů, default 150 000. **Compaction se účtuje extra** (input pro sumarizaci + output sumáře). Sumarizuje stejný model, jaký vedl konverzaci (nelze ušetřit přepnutím na Haiku).

**Limity:**

- **Doba běhu:** Limituje sám runtime Python/Node, který SDK hostuje. Agent může běžet „dokud neshoří kontext" — ale v praxi to znamená vlastní supervising proces, restart logic, state persistence. Anthropic oficiálně doporučuje pro dlouhé běhy přeskočit na Managed Agents (viz sekce 2).
- **Deployment:** Self-hosted. Vy musíte hostovat proces s agent loopem, perzistovat session state (buď server-side session API, nebo na disk přes `claude-progress.txt` pattern z [článku o long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).
- **Branding:** Anthropic nedovoluje třetím stranám nabízet Claude.ai login nebo rate limity ve vlastních produktech — nutno používat API key auth.

**Kdy použít:** Pokud chcete plnou kontrolu nad agent loopem, vlastním hostingem (GDPR, interní síť), vlastními nástroji. Pro VZ je to logická **náhrada n8n** pro AI pipeline (analýza, pricing, generování). Zatímco n8n dělá klasické „HTTP → transform → HTTP", Agent SDK dělá „dej agentovi úkol a nástroje, ať to vymyslí sám".

**Zdroj:** [code.claude.com/docs/en/agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview)

---

## 2. Claude Managed Agents — oficiální hostovaný produkt

**Status:** Public beta od **8. dubna 2026** (beta header `managed-agents-2026-04-01`). Dostupné všem Anthropic API účtům. Rozšířené features (outcomes, multi-agent orchestration, memory) jsou v research preview a vyžadují form.

**Co to je:** Anthropic hostuje celý agent harness — Claude + sandbox container + event log — ve své cloudové infrastruktuře. Vy voláte REST/SSE endpointy. Architektura je designově rozdělená na **brain** (Claude + harness), **environment** (container) a **session** (event log), což Anthropic popisuje v [engineering blogu „Scaling Managed Agents"](https://www.anthropic.com/engineering/managed-agents).

**Klíčové koncepty:**

| Koncept | Význam |
|---|---|
| **Agent** | Šablona: model + system prompt + tooly + MCP servery + skills |
| **Environment** | Container template (pre-installed packages, network ACL, mounted files) |
| **Session** | Běžící instance, generuje outputy, má perzistentní filesystem |
| **Events** | Zprávy mezi aplikací a agentem (user turns, tool results, status) streamované přes SSE |

**Co reálně řeší (to, co byste jinak museli stavět sami):**

- Sandbox container (bezpečný Linux prostor pro kód a bash).
- Agent loop (tool execution, opakované volání modelu).
- Prompt caching a compaction automaticky zapnuté.
- State perzistence — session běží i při výpadku klienta; event history server-side.
- Credentials jsou mimo sandbox (před prompt injection) — buď bundled při inicializaci nebo v external vaultu.
- **Steering mid-execution:** můžete během běhu poslat další user event a přesměrovat agenta.

**Cena:**

- **$0,08 / session hour** navíc k běžným token cenám (Opus 4.6 / Sonnet 4.6).
- Rate limits: 60 create/min, 600 read/min na organizaci.

**Limity k 2026-04:**

- Sessions **mohou běžet hodiny** (oficiální wording „hours"), **nikoliv dny** — Anthropic nespecifikoval hard limit, ale architektonicky je to orientováno na „úkol, který má konec".
- Nelze si přinést vlastní OS obraz — jen konfigurace nad připraveným Linux containerem (Python, Node, Go atd. pre-installed).
- Managed Agents **nevyhoví**, pokud potřebujete deployment uvnitř firemní sítě (GDPR s data residency EU — nutno ověřit přímo s Anthropicem; standardní API má US region).
- Early adopters: Notion, Rakuten, Sentry.

**Pro VZ:** Ideální kandidát na **„zakázka-worker"** — každá nová zakázka = jedna session, která běží autonomně 10–60 minut: stáhne ZD, analyzuje, nacení, vygeneruje dokumenty, napíše do Supabase. Pokud by si firma zvolila Managed Agents, **nepotřebuje n8n ani vlastní orchestrator** pro AI část pipeline.

**Zdroje:** [platform.claude.com/docs/en/managed-agents/overview](https://platform.claude.com/docs/en/managed-agents/overview), [anthropic.com/engineering/managed-agents](https://www.anthropic.com/engineering/managed-agents)

---

## 3. Computer Use — stav k 2026-04

**Status:** **Stále beta** (beta header `computer-use-2025-11-24` pro Opus 4.6 / Sonnet 4.6 / Opus 4.5). Nejnovější iterace přidala **zoom action** pro detailní inspekci regionů obrazovky.

**Co zvládá spolehlivě:**

- Screenshot + click + type + keyboard shortcuts (`ctrl+s`, `cmd+c`).
- Scroll s direction a amount (vylepšené od Sonnetu 3.7).
- `left_click_drag`, `double_click`, `hold_key`, `wait`.
- **Modifier keys při kliku** (`shift+click`, `ctrl+click`).
- State-of-the-art na WebArena benchmarku (podle Anthropic claimu) — tedy multi-step browser tasks skutečně funguje.
- **Login s credentials** přes `<robot_credentials>` XML tagy v promptu (doporučení dokumentace).

**Co funguje s výhradami:**

- **Formuláře:** funguje, ale dropdown selecty a scrollbary jsou historicky nespolehlivé. Anthropic doporučuje preferovat keyboard shortcuts.
- **File upload/download:** přes bash tool v sandbox prostředí OK. Přes čistě GUI (file picker dialog) občas unreliable.
- **Tabulky a spreadsheets:** zlepšilo se s `left_mouse_down`/`up` API. Stále není „první volba".

**Failure modes typické pro české VZ portály:**

1. **Prompt injection** z obsahu stránky — obrana: Anthropic má classifier, který při detekci injection požádá o user confirmation. Lze vypnout přes support (ne pro production bez human-in-the-loop).
2. **CAPTCHA** — nezvládá. Žádná oficiální integrace (2Captcha / AntiCaptcha musí řešit aplikace mimo Claude).
3. **2FA s SMS/hardware tokenem** — nezvládá (není design na to).
4. **Kvalifikovaný elektronický podpis na tokenu (ICA, PostSignum, eIdentita)** — **nezvládá**. Vyžaduje USB dongle / čipovou kartu / interakci s OS dialogem mimo browser.
5. **Datové schránky** — přístup přes certifikát + heslo + 2FA. Vyžaduje custom integraci, ne computer use.
6. **Latency** — oficiálně uvedeno jako známý limit. Jedna akce = round-trip model + screenshot (≈ 2–5 sekund). 50–100 akcí na formulář = 3–8 minut práce. Pro batch processing OK, pro real-time ne.
7. **Halucinace souřadnic** — známý problém, lze zmírnit extended thinking režimem.

**Praktické doporučení pro VZ:**

- **Scraping zakázek, download ZD, formulářové vyplnění** — ANO, přes computer use (backup když MCP nebo API neexistuje).
- **Finální podání nabídky** — NE, nedělejte autonomně. Vždy **human-in-the-loop** u posledního kliku „Odeslat". Důvody: právní odpovědnost, elektronický podpis, auditní stopa.
- Alternativa k computer use: **Playwright MCP** (`@playwright/mcp@latest`) — deterministický, programový browser bez screenshotů. Rychlejší a spolehlivější tam, kde HTML selektory stačí.

**Cena Computer Use:** Standard tool use pricing + screenshot image tokeny. System prompt overhead +466–499 tokenů, tool definice +735 tokenů/call. Na 1 stránku formuláře ≈ 10–30 screenshotů × ~1500 tokenů každý (po resize) = **cca 20–50K input tokens per form**. Při Sonnet 4.6 ($3/MTok input) ≈ $0,06–$0,15 na formulář.

**Zdroj:** [platform.claude.com/docs/en/agents-and-tools/computer-use](https://platform.claude.com/docs/en/agents-and-tools/computer-use)

---

## 4. Agent Skills

**Co to je:** Filesystem-based znovupoužitelné kompetence. Každý skill = adresář se `SKILL.md` a volitelnými podpůrnými soubory (šablony, skripty, reference). Open standard [agentskills.io](https://agentskills.io).

**Struktura:**

```
.claude/skills/analyze-tender/
├── SKILL.md              # povinný, YAML frontmatter + instrukce
├── reference.md          # AI si načte, když potřebuje detaily
├── templates/
│   └── analysis.json     # AI vyplní
└── scripts/
    └── extract_pdf.py    # AI může spustit přes Bash
```

**Klíčová vlastnost — progressive disclosure:**
- **V kontextu je vždy jen popis** (`description` + `when_to_use`, max 1 536 znaků).
- Plný obsah SKILL.md se nahraje **až při invokaci** (user přes `/analyze-tender` nebo AI autonomně dle popisu).
- Při auto-compaction se skill zachovává s rozpočtem prvních 5 000 tokenů, celkem 25 000 tokenů pro všechny skills dohromady.

**Frontmatter fields (klíčové pro VZ):**

- `disable-model-invocation: true` — skill se spustí **jen manuálně** (vhodné pro `/submit-tender`, `/generate-offer`).
- `allowed-tools` — pre-approved tooly bez dotazování.
- `paths` — aktivace jen u určitých souborů.
- `context: fork` + `agent: Explore/Plan` — spuštění v izolovaném subagent kontextu.
- `hooks` — lifecycle callbacks.

**Rozdíl vs MCP:**

| | Skill | MCP server |
|---|---|---|
| **Kde žije** | Soubor v repu / `~/.claude` | Samostatný proces (stdio/SSE) |
| **Co je** | Playbook + skripty | Tooly (funkce) vystavené přes protokol |
| **Kdy použít** | Opakovaný postup/šablona pro daný dataset | Přístup k externímu systému (DB, API, cloud) |
| **Cena udržby** | Markdown soubor | Kód + deployment + auth |
| **Příklad pro VZ** | „analyze-tender", „generate-bid" (playbooky) | „supabase-mcp", „hlidac-mcp" (systémy) |

**Pro VZ konkrétně:** Každou část pipeline (extract → analyze → match → generate → validate) napsat jako skill. Agent pak voláním `/analyze-tender 865063` spustí celý pipeline na konkrétní zakázku.

**Zdroj:** [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)

---

## 5. MCP servery

**Role v architektuře:** Standardizovaný protokol, přes který agent sáhne na **externí systémy**: databáze, filesystem, API, browser. Máte je k dispozici i v Managed Agents.

**Kdy psát vlastní MCP vs použít existující vs napsat skill:**

- **Vlastní MCP** — když systém nemá oficiální server a budete k němu volat z více agentů/projektů. Typicky: interní ERP, proprietární API, firemní sklad cen.
- **Existující MCP** — [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers), Supabase MCP, Playwright MCP, GitHub MCP, Apify MCP. Pro VZ už máte nakonfigurované: `hostinger-mcp`, `n8n-mcp`, `apify`.
- **Skill** — když je to „postup + soubory", ne „systém". Skill volá tooly (vč. MCP), ne naopak.
- **Code Interpreter / Bash** — když je úkol jednorázový Python/shell skript. Neposílejte přes MCP, co vyřídí 10 řádků v Bashi.

**Pro VZ — MCP shortlist k budoucímu stacku:**

1. **Supabase MCP** (již v užívání jinde v LuDone) — pro čtení/zápis zakázek, pricingu, šablon.
2. **Custom „hlidac-mcp"** — oficiální Hlídač státu nemá veřejný MCP, ale již máte v `.mcp.json` — pravděpodobně vlastní wrapper. Tohle je **kandidát na konsolidaci** (jeden MCP nahradí n8n workflow `vz_monitor_hlidac`).
3. **Carbone/Gotenberg MCP** — neexistuje oficiální, ale **skill** stačí (volá HTTP endpoint přes Bash/WebFetch).
4. **Playwright MCP** — pro deterministické scrapování VZ portálů tam, kde computer use je přestřelek.

---

## 6. Autonomie v praxi — co to reálně znamená

**Co už jde:**

- Session běžící hodiny (Managed Agents).
- Auto-checkpoint přes event log (server-side perzistence).
- Resume ze session ID (Agent SDK i Managed Agents).
- Subagenty s izolovaným kontextem.
- Recovery patterns popsané v [effective-harnesses-for-long-running-agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): `claude-progress.txt`, feature list JSON, git commits jako state.

**Co ještě nejde bezpečně:**

- **Dny bez dohledu.** Oficiální wording je „hours". Pokud potřebujete „agent sleduje trh 30 dní", stavte to jako **sekvenci krátkých sessions** triggerovaných cronem, ne jedna session.
- **Plné řešení chyby bez retry logiky z vaší strany.** Agent může uvíznout v loopu (screenshot nezachycuje změnu), vyčerpat token budget, narazit na rate limit. Klient musí monitorovat.
- **„Vím, co jsem udělal minulý týden" — memory.** Managed Agents memory je research preview, vyžaduje přístup přes form. V produkci si dělat memory v Supabase nebo přes explicit session resume.

**Failure modes u 10–20 zakázek/den:**

- Rate limit Anthropic API (řešeno přes tiers, při Tier 2+ max Opus 4.6 přes 10K RPM).
- Context overflow při obzvlášť velké ZD (500+ stran) — nutný compaction nebo chunking.
- Model odmítne úkol („I can't submit forms on your behalf") u některých portálových akcí — workaround: prompt engineering + human approval.

---

## 7. Nepřekročitelné limity (aktuálně a ve viditelné budoucnosti)

| Oblast | Proč nejde | Doporučení |
|---|---|---|
| **Kvalifikovaný elektronický podpis (I.CA, PostSignum)** | Soukromý klíč na USB/SmartCard, OS dialog, PIN | Člověk podepíše ručně, agent připraví balíček k podpisu |
| **Datové schránky (ISDS)** | 2FA, certifikát, citlivá agenda | Custom integrace přes ISDS API + člověk schvaluje odeslání |
| **2FA s SMS/hardware tokenem** | Agent nedostane SMS kód, token vyžaduje fyzickou přítomnost | App-specific passwords, service accounts, API keys |
| **CAPTCHA na českých portálech (NEN, Tenderarena)** | Agent není navržen na CAPTCHA solving | 2Captcha / AntiCaptcha (pozor na ToS!), nebo human-in-the-loop |
| **Internet banking** | Totéž co datovky + Anthropic Acceptable Use Policy | Nikdy nedávejte agentovi přístup k platbám |
| **Finální „Odeslat nabídku"** | Právní závazek, neodvolatelnost | Vždy human approval před kliknutím |

Anthropic v Computer Use docs explicitně varuje: *„Asking a human to confirm decisions that may result in meaningful real-world consequences"* — právě toto.

---

## 8. Ekonomika pro VZ — konkrétní odhad

**Ceny k 2026-04-15** ([claude.com/pricing](https://claude.com/pricing)):

| Model | Input $/MTok | Output $/MTok |
|---|---|---|
| **Opus 4.6** | $5 | $25 |
| **Sonnet 4.6** | $3 | $15 |
| **Haiku 4.5** | $1 | $5 |

Prompt caching: Opus cache read $0,50, cache write $6,25. **Batch API: -50 %.** Web search: $10/1000 queries.
**Managed Agents session: $0,08/hour.**

**Odhad na 1 zakázku** (typická ZD 30–80 stran + 5 příloh):

| Fáze | Model | Input tokens | Output tokens | Cena |
|---|---|---|---|---|
| (a) Triáž + scoring (z HlidacStatu feedu) | Haiku 4.5 | 5 000 | 500 | $0,008 |
| (b) Hluboká analýza ZD + nacenění | Sonnet 4.6 | 80 000 | 8 000 | $0,36 |
| (c) Generování dokumentů (krycí list, technický návrh, čestné prohlášení, cenová nabídka) | Sonnet 4.6 | 40 000 | 15 000 | $0,35 |
| (d) Computer use podání (ukládá se, neodesílá) | Sonnet 4.6 | 80 000 (screenshoty) | 3 000 | $0,29 |
| Managed Agents hosting (≈ 45 min session) | — | — | — | $0,06 |
| **Celkem na zakázku** | | | | **≈ $1,07** |

**Při 20 zakázkách/den × 22 dní = 440 zakázek/měsíc:**

- Inference: **≈ $470 / měsíc** (≈ 11 000 Kč)
- + Managed Agents hosting: +$26
- + Web search (odhad 500 queries): +$5
- + Hlídač státu API: dle smlouvy (mimo Anthropic)
- **Odhad celkem: $500–600 / měsíc** (≈ 12–14 000 Kč)

**Srovnání se současnou n8n architekturou:**
- n8n (VPS Hostinger): ~400 Kč/měsíc
- Gemini 2.0 Flash pro triáž: zlomek ceny Haiku
- Claude Sonnet 4.5 pro analýzu: stejný řád jako Sonnet 4.6

**Klíčové zjištění:** Přechod na Managed Agents **není dramaticky dražší** než současná pipeline. Rozdíl ~$100–200/měsíc oproti vlastnímu hostingu, ale **ušetřené hodiny vývoje a provozu n8n** to pravděpodobně kompenzují.

**Optimalizace, které mohou cenu srazit o 40–60 %:**
- **Prompt caching** na opakovaný system prompt, šablony, cenový sklad.
- **Batch API** na non-urgent práci (nightly bulk scoring) — -50 %.
- **Sonnet místo Opus** všude, kde to jde (kromě komplexní analýzy nejasných ZD).

---

## 9. Roadmap a trajectory (co reálně očekávat Q2–Q4 2026)

**Co je announced / v research preview:**

- **Managed Agents → GA** někdy v Q3/Q4 2026 (odhad, není oficiálně datováno).
- **Outcomes API** (research preview) — deklarativní definice „co má agent dokončit", bez krok-za-krokem promptů.
- **Multi-agent orchestration** (research preview) — nativní koordinace paralelních agentů.
- **Memory API** (research preview) — perzistentní memory across sessions bez ručního session resume.
- **Zoom action** v Computer Use — již GA (beta) od 24. 11. 2025.
- **1M context okno** — už běží v beta pro Opus 4.6/Sonnet 4.6.

**Co lze realisticky očekávat do konce 2026:**

- Computer Use z bety do GA (pravděpodobné).
- EU region pro API (oficiálně neavizováno k 2026-04, nutno ověřit pro GDPR — **velké riziko pro VZ projekt s veřejnou správou**).
- Cenové snižování (Anthropic snížil ceny Sonnetu 3× za posledních 18 měsíců).

**Co nečekat:**

- Oficiální CAPTCHA solving.
- Oficiální podporu kvalifikovaného podpisu.
- „Self-healing" agenti, kteří by měsíc běželi bez dohledu u transakčních akcí.

**Zdroj pro trajectory:** V článku [„Scaling Managed Agents"](https://www.anthropic.com/engineering/managed-agents) Anthropic explicitně říká, že architektura je navržena jako „stable interfaces as underlying implementations evolve" — očekává se tedy, že API se nebudou rychle měnit, ale model capabilities ano.

---

## 10. Shrnutí a doporučení pro VZ projekt

**Pro rozhodnutí „pokračovat v n8n stacku nebo přeskočit na AI-first":**

### Scénář A — Zachovat stávající n8n architekturu

**Pro:** Již máte funkční pipeline. Data residency v ČR. Předvídatelné náklady. n8n zdarma (self-hosted).
**Proti:** Hodiny údržby workflow. Rigidní — každá nová výjimka = úprava JSON workflow. AI volání tak jako tak jdou přes Claude API.
**Doporučení:** Pokud tým má 0,5 FTE na provoz n8n a zakázek je stabilně pod 20/den, tahle cesta je racionální **ještě 6–12 měsíců**.

### Scénář B — Přejít na Claude Agent SDK + vlastní hosting (na Hostinger VPS)

**Pro:** Kontrola nad daty. Schopnost „dát agentovi úkol" místo „napsat krok za krokem workflow". Jeden tech stack (TS/Python) místo n8n JSONů.
**Proti:** Musíte postavit agent harness (progress tracking, restart, monitoring). Stále hostujete sami.
**Doporučení:** Nejrozumnější cesta, pokud chcete growth a hlavní riziko vidíte v GDPR / data residency.

### Scénář C — Managed Agents od Anthropicu

**Pro:** Nejnižší operační zátěž. Built-in compaction, caching, perzistence. Time-to-first-token výrazně nižší než self-hosted (p50 -60%, p95 -90% dle Anthropicu).
**Proti:** **Data rezidence mimo EU** (beta, region otázka). Vendor lock-in. Cena $0,08/hour může při vyšších objemech (100+ zakázek/den) narůst.
**Doporučení:** Pro MVP/pilot je to nejrychlejší cesta k výsledku. Pro produkci se státní správou **nutno vyjednat data processing agreement s Anthropicem** před deploymentem.

### Společné doporučení pro všechny tři scénáře

1. **Skills** piště ihned — jsou kompatibilní se všemi třemi. Investice nepropadne.
2. **MCP servery** konsolidujte — custom `hlidac-mcp` nahradí n8n workflow, funguje všude.
3. **Computer Use** pouze na čtení/stahování. Finální podání vždy human-in-the-loop.
4. **Nikdy** nedávejte agentovi kvalifikovaný podpis, datovku, bankovnictví.
5. **Začněte s Sonnet 4.6** (poměr cena/kvalita), Opus 4.6 jen pro problematické ZD.

---

## Zdroje

- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Scaling Managed Agents (engineering blog)](https://www.anthropic.com/engineering/managed-agents)
- [Computer Use tool reference](https://platform.claude.com/docs/en/agents-and-tools/computer-use)
- [Skills in Claude Code](https://code.claude.com/docs/en/skills)
- [Compaction API](https://platform.claude.com/docs/en/build-with-claude/compaction)
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Claude pricing](https://claude.com/pricing)
- [Agent Skills open standard](https://agentskills.io)

---

*Pozn.: Ceny, beta headers a feature availability byly ověřeny 15. 4. 2026 proti oficiálním Anthropic zdrojům. EU region pro Managed Agents a formální DPA pro česká data nebyly k datu dokumentu oficiálně potvrzeny — nutno ověřit přímo u Anthropicu před produkčním deploymentem s údaji ze státní správy.*
