# DAN-TODO

Akce, které vyžadují ruční zásah Dana/Patrika (ne automatizovatelné).

## 2026-07-14 — Monitoring: HLIDAC_TOKEN + THMP zakázky (PR #99, #100, #101)

- [ ] **TenderArena zakázky (THMP a.s. a další)** — ZD přílohy se NEDAJÍ stahovat automaticky (Cloudflare Turnstile na `api.tenderarena.cz`). U každé takové zakázky nahrát dokumenty ručně přes UI (záložka Dokumenty na detailu zakázky), pak spustit `analyze` znovu. Zatím žádné workaround není v plánu (obcházení bot ochrany je mimo scope).
- [ ] Zkontrolovat feed na `/#/monitoring` — po zapojení `HLIDAC_TOKEN` přibylo 155 nových položek (různé kategorie), stojí za rychlý průchod, ne jen THMP.
- [x] `HLIDAC_TOKEN` je teď v GitHub Actions secrets (Dan ho zadal do chatu 2026-07-14) i v `/opt/vz/.env` na Hetzneru.
- [ ] Zvážit, jestli chceš `HLIDAC_TOKEN` mít i v tvém password manageru (teď existuje jen v GH secrets + prod `.env`, nikde jinde zálohovaný).
- [x] Testovací zakázka `ptk-hr-software-pro-spravu-a-rizeni-hr-agendy` (THMP HR software) zůstala v CRM ve stavu "nova" bez dokumentů — reálná relevantní zakázka, ne smazáno, ale nikdo na ní zatím nic nedělal. Buď doplň ZD ručně, nebo ji ignoruj/přesuň, ať nezůstává jako sirotek.

## 2026-07-15 — Archivace + mazání zakázek (PR #103)

- [ ] **Smoke test po deployi (s DB)** — lokálně nešlo (není lokální Postgres). Na vz.ludone.cz ověřit: archivovat zakázku → zmizí z „Aktivní", je v „Archivované", odarchivovat vrátí; smazat → „Koš" → obnovit; jako **analytik** zkusit „Trvale smazat" (musí 403), jako **admin** trvale smazat testovací zakázku a ověřit, že po ní nezbyly osiřelé DB záznamy.
- [ ] Migrace `023_tender_archive_delete.sql` se aplikuje **automaticky** při startu kontejneru (žádný ruční krok) — jen zkontroluj v logu `vz-api`, že proběhla bez chyby.
- [ ] **Pozor — „Trvale smazat" je nevratné**: maže soubory zakázky i všechna CRM data. Chráněno rolí admin + dialogem s přepsáním názvu, ale je to destruktivní; rozmysli, kdo má mít roli admin.

## 2026-07-14 — Monitoring: hodinový auto-sync + filtr (PR #102)

- [ ] Sync teď běží automaticky každou hodinu (in-process timer ve `vz-api`, žádný nový cron). Stojí za to sledovat pár dní `docker logs vz-api | grep monitoring` na Hetzneru, jestli nezpůsobuje zbytečnou zátěž NEN/Hlídače nebo neplní feed rychleji, než stíháte procházet.
- [ ] Zvážit, jestli hodinová frekvence není zbytečně častá vzhledem k tomu, jak rychle se veřejné zakázky mění (možná stačí 4-6×/den) — teď je to natvrdo `60 * 60 * 1000` v `scripts/src/serve-api.ts`.

## 2026-09-03 — NEN zakázka N006/26/V00027380 (Sdílna Litoměřice), Patrikův report

Opraveno v tomto běhu (větev `fix/nen-zd-pagination-multipart`): stránkování ZD na NEN, keep-alive
stall při stahování, `.cer` jako ignorovatelná příloha, „Výkaz výměr" jako soupis, detekce částí
z „3a/3b/3c", ZodError na termínech u dělené zakázky, sčítání předpokládané hodnoty.

**Vědomě ODLOŽENO — rozhodnutí nebo samostatný celek, tenhle běh na to nesahal:**

- [ ] **Monitoring feed zakázku vůbec nenajde.** `config/monitoring.json` má prázdná `klicova_slova`,
      takže sync posílá na NEN prázdný dotaz a přečte 250 záznamů z ~278 500 (a pořadí NEN ani není
      stabilní). Tahle zakázka v tom vzorku není. S fulltextem „Sdílna Litoměřice" / „dílna" /
      „technické vybavení" ji NEN vrátí hned; „nářadí" ne. **Je to obchodní rozhodnutí — jaké obory
      chceš sledovat?** Dokud zůstane prázdné, Patrik bude zakázky nosit ručně.
- [ ] **Kategorizace vrací `ostatni` místo dílenského oboru** → skóre spadne z 61 na 24 = NOGO,
      a feed navíc ořezává na 200 položek. Souvisí s bodem výš (non-IT zakázky).
- [ ] **Stropy jednotlivých částí se nikde nehlídají** (646 500 / 552 000 / 531 600 Kč vč. DPH
      u téhle zakázky). Nabídka nad stropem = vyřazení. Money-critical, ale je to samostatná funkce,
      ne oprava vady — chce to vlastní zadání.
- [ ] **Tvrdý limit 4 šablony na typ** (`template-engine.ts`) tiše zahodí Přílohu 9
      (Čestné prohlášení technické parametry) — povinný dokument se nikdy nevygeneruje.
- [ ] **Krycí list a čestné prohlášení se generují jako VLASTNÍ dokument**, ne vyplněním formuláře
      zadavatele (Příloha 1 / Příloha 5). U zakázek, kde zadavatel formulář předepisuje, je to
      důvod k vyřazení.
- [ ] **Návrh kupní smlouvy se fuzzy spáruje s naším technickým návrhem** (stačí společné slovo
      „návrh") → `balik-uplnost` ho označí za pokrytý, i když pokrytý není.
- [ ] **Do už převzaté zakázky nejde v UI doplnit dokumenty** — upload widget je jen na Monitoringu.
      Když stahování ZD selže, zakázka je slepá ulička.
- [ ] `OPENAI_API_KEY` v produkčním compose pořád není → vektorový tier matcheru je tiše mrtvý
      (známé z dřívějška, jen připomínka).

**Pro Patrika:** u téhle zakázky je nachystaná kompletní ZD (18 souborů) v `input/n006-26-v00027380/`
na Danově stroji. Lhůta pro podání nabídek je **14. 9. 2026 v 10:00**, zakázka je dělená na tři
části a ke každé je samostatný výkaz výměr a samostatný návrh kupní smlouvy.
