export const PRODUCT_MATCH_SYSTEM = `Jsi expert na IT hardware, techniku a technologie s hlubokými znalostmi trhu v České republice. Na základě technických požadavků ze zadávací dokumentace veřejné zakázky navrhneš 3 konkrétní produkty, které splňují požadavky.

Pro každý produkt uveď:
- Výrobce a přesný model
- Popis produktu
- Klíčové technické parametry
- Porovnání s každým požadavkem (splněno/nesplněno + konkrétní hodnota)
- Orientační cenu bez DPH a s DPH v CZK
- Spolehlivost cenového odhadu (viz níže)
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
- Pokud je v zadání uvedena předpokládaná hodnota zakázky, porovnej ji se svým odhadem:
  - Pokud se liší víc než 2x, explicitně to uveď v cena_komentar
  - NEHODNOŤ rozpočet jako "nerealistický" — spíš přiznej, že tvůj odhad může být nepřesný
- DPH v ČR je 21%
- Uváděj pouze reálné, existující produkty

Odpověz POUZE validním JSON.`;

export function buildProductMatchUserMessage(
  technicalRequirements: Array<{ parametr: string; pozadovana_hodnota: string; jednotka?: string | null; povinny: boolean }>,
  tenderName: string,
  tenderSubject: string,
  budgetBezDph?: number | null
): string {
  const reqList = technicalRequirements
    .map((r, i) => `${i + 1}. ${r.parametr}: ${r.pozadovana_hodnota}${r.jednotka ? ` ${r.jednotka}` : ''} (${r.povinny ? 'povinné' : 'volitelné'})`)
    .join('\n');

  const budgetLine = budgetBezDph
    ? `\nPředpokládaná hodnota zakázky (bez DPH): ${budgetBezDph.toLocaleString('cs-CZ')} Kč\nPorovnej svůj cenový odhad s touto částkou.\n`
    : '';

  return `Zakázka: ${tenderName}
Předmět: ${tenderSubject}
${budgetLine}
Technické požadavky:
${reqList}

Navrhni 3 konkrétní produkty ve formátu:
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
      "dodavatele": ["dodavatel1", "dodavatel2"],
      "dostupnost": "skladem / 2-3 týdny"
    }
  ],
  "vybrany_index": 0,
  "oduvodneni_vyberu": "..."
}`;
}
