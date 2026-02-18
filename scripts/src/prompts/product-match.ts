export interface MatchableItem {
  nazev: string;
  mnozstvi?: number | null;
  jednotka?: string | null;
  specifikace: string;
  technicke_pozadavky: Array<{ parametr: string; pozadovana_hodnota: string; jednotka?: string | null; povinny: boolean }>;
}

export const PRODUCT_MATCH_SYSTEM = `Jsi expert na IT hardware, techniku a technologie s hlubokými znalostmi trhu v České republice. Na základě technických požadavků ze zadávací dokumentace veřejné zakázky navrhneš konkrétní produkty, které splňují požadavky.

Pro každý produkt uveď:
- Výrobce a přesný model
- Popis produktu
- Klíčové technické parametry
- Porovnání s každým požadavkem (splněno/nesplněno + konkrétní hodnota)
- Orientační cenu bez DPH a s DPH v CZK
- Spolehlivost cenového odhadu (viz níže)
- Zdroj cenového odhadu ("zdroj_ceny") — na čem je cena založená (katalogová cena výrobce, odhad z distribuce, apod.)
- Referenční URL pro ověření ceny ("reference_urls") — vyhledávací odkazy na české e-shopy (alza.cz, czc.cz, heureka.cz)
- Dostupné dodavatele v ČR
- Dostupnost (skladem / na objednávku / dodací lhůta)

Vyber nejlepší kandidáta a zdůvodni výběr.

DŮLEŽITÉ PRAVIDLA PRO CENY:
- Ceny jsou ORIENTAČNÍ ODHAD — nemáš přístup k aktuálním e-shopům
- U každého produktu uveď "cena_spolehlivost": "vysoka" / "stredni" / "nizka"
  - "vysoka" = běžný produkt, jehož cenu dobře znáš (např. standardní kancelářský HW)
  - "stredni" = znáš přibližnou cenovou kategorii, ale přesná cena se může lišit ±30%
  - "nizka" = specializovaný/nový produkt, odhad může být nepřesný i 2x+
- U každého produktu uveď "cena_komentar" — vysvětli, na čem je odhad založen
- U každého produktu uveď "zdroj_ceny" — odkud pochází cenový odhad
- U každého produktu uveď "reference_urls" — vyhledávací URL na české e-shopy pro ověření:
  - https://www.alza.cz/search?q=VYROBCE+MODEL
  - https://www.heureka.cz/?h%5Bfraze%5D=VYROBCE+MODEL
  - https://www.czc.cz/hledat?q=VYROBCE+MODEL
  POZOR: URL jsou orientační vyhledávací odkazy — uživatel ověří ručně.
- Pokud je v zadání uvedena předpokládaná hodnota zakázky, porovnej ji se svým odhadem:
  - Pokud se liší víc než 2x, explicitně to uveď v cena_komentar
  - NEHODNOŤ rozpočet jako "nerealistický" — spíš přiznej, že tvůj odhad může být nepřesný
- DPH v ČR je 21%
- Uváděj pouze reálné, existující produkty

Odpověz POUZE validním JSON.`;

export function buildProductMatchUserMessage(
  items: MatchableItem[],
  tenderName: string,
  tenderSubject: string,
  budgetBezDph?: number | null,
  candidateCount: number = 3,
): string {
  const budgetLine = budgetBezDph
    ? `\nPředpokládaná hodnota zakázky (bez DPH): ${budgetBezDph.toLocaleString('cs-CZ')} Kč\nPorovnej svůj cenový odhad s touto částkou.\n`
    : '';

  // Single item → legacy flat format
  if (items.length === 1) {
    const item = items[0];
    const reqList = item.technicke_pozadavky
      .map((r, i) => `${i + 1}. ${r.parametr}: ${r.pozadovana_hodnota}${r.jednotka ? ` ${r.jednotka}` : ''} (${r.povinny ? 'povinné' : 'volitelné'})`)
      .join('\n');

    const specLine = item.specifikace ? `\nSpecifikace položky: ${item.specifikace}\n` : '';

    return `Zakázka: ${tenderName}
Předmět: ${tenderSubject}
${budgetLine}${specLine}
Technické požadavky:
${reqList}

Navrhni ${candidateCount} konkrétní produkty ve formátu:
{
  "kandidati": [
    {
      "vyrobce": "...",
      "model": "...",
      "popis": "...",
      "parametry": {"parametr1": "hodnota1", ...},
      "shoda_s_pozadavky": [
        {"pozadavek": "...", "splneno": true, "hodnota": "...", "komentar": "..."}
      ],
      "cena_bez_dph": 150000,
      "cena_s_dph": 181500,
      "cena_spolehlivost": "stredni",
      "cena_komentar": "Odhad na základě ..., může se lišit ±30%",
      "zdroj_ceny": "Katalogová cena výrobce + odhad marže distribuce",
      "reference_urls": ["https://www.alza.cz/search?q=...", "https://www.heureka.cz/?h%5Bfraze%5D=..."],
      "dodavatele": ["dodavatel1", "dodavatel2"],
      "dostupnost": "skladem / 2-3 týdny"
    }
  ],
  "vybrany_index": 0,
  "oduvodneni_vyberu": "..."
}`;
  }

  // Multi-item → polozky_match format
  const itemsDescription = items.map((item, idx) => {
    const reqList = item.technicke_pozadavky
      .map((r, i) => `  ${i + 1}. ${r.parametr}: ${r.pozadovana_hodnota}${r.jednotka ? ` ${r.jednotka}` : ''} (${r.povinny ? 'povinné' : 'volitelné'})`)
      .join('\n');

    const mnozstviStr = item.mnozstvi ? ` (množství: ${item.mnozstvi}${item.jednotka ? ` ${item.jednotka}` : ''})` : '';
    return `POLOŽKA ${idx + 1}: ${item.nazev}${mnozstviStr}
Specifikace: ${item.specifikace}
Technické požadavky:
${reqList || '  (žádné specifické — použij specifikaci výše)'}`;
  }).join('\n\n');

  return `Zakázka: ${tenderName}
Předmět: ${tenderSubject}
${budgetLine}
Zakázka obsahuje ${items.length} položek. Pro KAŽDOU položku navrhni ${candidateCount} konkrétní produkty.

${itemsDescription}

Odpověz ve formátu (KAŽDÁ položka má vlastní pole kandidátů):
{
  "polozky_match": [
    {
      "polozka_nazev": "Název položky 1",
      "polozka_index": 0,
      "mnozstvi": 1,
      "kandidati": [
        {
          "vyrobce": "...",
          "model": "...",
          "popis": "...",
          "parametry": {"parametr1": "hodnota1", ...},
          "shoda_s_pozadavky": [
            {"pozadavek": "...", "splneno": true, "hodnota": "...", "komentar": "..."}
          ],
          "cena_bez_dph": 150000,
          "cena_s_dph": 181500,
          "cena_spolehlivost": "stredni",
          "cena_komentar": "Odhad na základě ...",
          "zdroj_ceny": "Katalogová cena výrobce + odhad marže distribuce",
          "reference_urls": ["https://www.alza.cz/search?q=...", "https://www.heureka.cz/?h%5Bfraze%5D=..."],
          "dodavatele": ["dodavatel1", "dodavatel2"],
          "dostupnost": "skladem / 2-3 týdny"
        }
      ],
      "vybrany_index": 0,
      "oduvodneni_vyberu": "..."
    }
  ]
}`;
}
