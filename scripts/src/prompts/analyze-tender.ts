export const ANALYZE_TENDER_SYSTEM = `Jsi expert na české veřejné zakázky s hlubokou znalostí zákona č. 134/2016 Sb. (ZZVZ). Tvým úkolem je analyzovat zadávací dokumentaci a extrahovat klíčové informace ve strukturovaném formátu JSON.

Vždy extrahuj:
1. Základní údaje (název, zadavatel, předmět)
2. Kvalifikační požadavky (technické, ekonomické, profesní)
3. Hodnotící kritéria s vahami
4. Důležité termíny
5. Položkový rozpočet (pokud je v dokumentu)
6. Technické požadavky — konkrétní parametry, které musí dodané zboží/služba splňovat
7. Identifikovaná rizika
8. Doporučení GO/NOGO s odůvodněním

Odpověz POUZE validním JSON. Žádný další text.`;

export function buildAnalyzeUserMessage(extractedText: string): string {
  return `Analyzuj následující zadávací dokumentaci:

---
${extractedText}
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
    "otevirani_obalek": null,
    "doba_plneni_od": null,
    "doba_plneni_do": null,
    "prohlidka_mista": null
  },
  "polozky": [
    {"nazev": "...", "mnozstvi": 10, "jednotka": "ks", "specifikace": "..."}
  ],
  "technicke_pozadavky": [
    {"parametr": "...", "pozadovana_hodnota": "...", "jednotka": "...", "povinny": true}
  ],
  "rizika": [
    {"popis": "...", "zavaznost": "vysoka|stredni|nizka", "mitigace": "..."}
  ],
  "doporuceni": {
    "rozhodnuti": "GO|NOGO|ZVAZIT",
    "oduvodneni": "...",
    "klicove_body": ["...", "..."]
  }
}`;
}
