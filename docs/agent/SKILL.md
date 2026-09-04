---
name: vz-agent
description: Bezpečný postup pro příjem a zpracování veřejných zakázek přes MCP.
---

# VZ agent

Používej MCP server na cestě `/mcp`. Každý požadavek se ověřuje agentním klíčem v hlavičce `Authorization`. Neplatný nebo odvolaný klíč server odmítne.

## Konfigurace Hermese

Do `~/.hermes/config.yaml` vlož:

```yaml
mcp_servers:
  vz:
    url: 'https://<VZ_HOST>/mcp'
    headers:
      Authorization: 'Bearer <VZ_AGENT_KEY>'
```

Klíč neukládej do repozitáře, logů ani výstupů nástrojů.

## Doporučený postup

1. Zavolej `zakazka_z_odkazu` s odkazem na detail zakázky. Server vyhledá již založenou zakázku, nebo ji založí a u podporovaného zdroje sám stáhne dokumentaci. Ulož si vrácené ID zakázky.
2. Zavolej `cti_uplnost`. Pokud je ingest `castecne` nebo `selhalo`, řiď se poli `chybi` a `naprava`; neprezentuj zakázku jako kompletní.
3. Když dokumenty nejsou dostupné bez přihlášení, stáhni je na straně agenta a zavolej `vydej_upload_listek`. Soubor odešli ihned na vrácenou krátkodobou URL jako `multipart/form-data` v poli `files`. Binární obsah nikdy nevkládej do argumentu MCP ani jej neposílej jako base64.
4. Po dokončení ingestu znovu ověř `cti_uplnost`. Pipeline spouštěj jen tehdy, když jsou k dispozici skutečné vstupní dokumenty a chybějící soubory jsou vyřešené nebo výslovně evidované.
5. Zavolej `spust_pipeline` a ulož vrácené ID jobu. Opakované volání nemá zakládat souběžný pipeline pro stejnou zakázku.
6. Stav sleduj pomocí `zjisti_stav_jobu`. Dotaz opakuj s rozumným odstupem, například 5–10 sekund, dokud job neskončí nebo nezačne čekat na zásah člověka. Při `error`, `waiting_approval`, `budget_paused` nebo `interrupted` se řiď vráceným důvodem; stav neobcházej.
7. Výsledek čti po menších celcích: `cti_analyzu`, `cti_casti`, `cti_polozky` a `cti_uplnost`. U vícedílné zakázky respektuj přiřazení položek k částem a aktuální výběr částí.
8. Doloženou cenu předej přes `navrhni_cenu`. Uveď cenu, datum zjištění a URL konkrétní produktové stránky. Odkaz na vyhledávání, kategorii nebo výsledkový seznam není doklad a server jej odmítne. Návrh zůstává nepotvrzený, dokud jej nezkontroluje člověk.

Příklad uploadu na URL vrácenou nástrojem:

```bash
curl --fail --request POST '<UPLOAD_URL>' \
  --header 'Authorization: Bearer <VZ_AGENT_KEY>' \
  --form 'files=@/cesta/k/dokumentu.pdf'
```

## Jak číst úplnost

- `uplne`: krok vytvořil všechny očekávané výstupy.
- `castecne`: vznikla jen část výstupů. Doplň položky uvedené v `chybi` a krok opakuj.
- `selhalo`: požadovaný výstup nevznikl nebo jej nelze bezpečně ověřit. Zastav navazující práci a postupuj podle `naprava`.

Starší zakázka nemusí mít kontrakt úplnosti. Absence kontraktu není důkaz, že je zpracování úplné.

## Zakázané akce

Agent nesmí:

- potvrdit cenu ani se vydávat za lidského schvalovatele;
- finalizovat nabídku nebo balík podání;
- označit nabídku jako podanou;
- změnit stav zakázky na `odeslana` ani na stav podání nebo výsledku;
- obcházet pozastavení pipeline, rozpočtový limit nebo kontrolu úplnosti.

Tyto kroky mají finanční nebo právní dopad a vyžadují dohledatelné rozhodnutí člověka. MCP proto zpřístupňuje jen příjem zakázky, zpracování, čtení výsledků a uložení nepotvrzeného cenového návrhu.
