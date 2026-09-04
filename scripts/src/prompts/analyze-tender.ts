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
9. Dokumenty, které zadávací dokumentace explicitně požaduje odevzdat jako součást nabídky

V poli pozadovane_dokumenty vypiš JEN dokumenty, které zadávací dokumentace skutečně
požaduje odevzdat jako součást nabídky. NEVYMÝŠLEJ. Když si nejsi jistý povinností,
uveď povinny: true (konzervativně).

Pole zakazka.predpokladana_hodnota vždy vyplň jedním číslem za CELOU zakázku bez DPH,
jen pokud je tento celek v dokumentaci výslovně uveden; hodnoty částí nesčítej a
částkové hodnoty uveď v casti[].predpokladana_hodnota.

Všechna pole v terminy vyplň jako skalární hodnotu za CELOU zakázku, nikdy jako objekt.
U dělené zakázky použij pro doba_plneni_od nejčasnější datum, pro doba_plneni_do nejzazší
datum a pro lhůty nejbližší/nejčasnější datum. Termíny jednotlivých částí zachovej v
casti[].terminy. U nedělené zakázky vrať casti: [].

U každé části vytěž cenovy_strop JEN tehdy, když zadávací dokumentace výslovně říká,
že jde o maximální/nepřekročitelnou nabídkovou cenu dané části. Běžná předpokládaná
hodnota není automaticky cenový strop. Současně nastav cenovy_strop_vcetne_dph na true,
je-li strop uveden včetně DPH, nebo false, je-li bez DPH. Když výslovný strop uveden není,
vrať cenovy_strop: null a cenovy_strop_vcetne_dph: null. Strop nikdy neodhaduj ani
nedopočítávej z hodnot jiných částí. Pokud je maximum uvedeno, ale dokumentace neurčuje
jednoznačně, zda je s DPH nebo bez DPH, základ nehádej a vrať obě pole jako null.

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
  "pozadovane_dokumenty": [
    {"nazev": "...", "popis": "...", "povinny": true, "typ": "kryci_list|cestne_prohlaseni|soupis|smlouva|seznam_poddodavatelu|jine"}
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
  "casti": [
    {
      "id": "1",
      "nazev": "Část 1 - ...",
      "predpokladana_hodnota": null,
      "cenovy_strop": null,
      "cenovy_strop_vcetne_dph": null,
      "pocet_polozek": 0,
      "terminy": {
        "lhuta_nabidek": null,
        "otevirani_obalek": null,
        "doba_plneni_od": null,
        "doba_plneni_do": null,
        "prohlidka_mista": null
      }
    }
  ],
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
