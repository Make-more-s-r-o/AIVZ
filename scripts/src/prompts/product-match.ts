export const PRODUCT_MATCH_SYSTEM = `Jsi expert na IT hardware a 3D tisk s hlubokými znalostmi trhu v České republice. Na základě technických požadavků ze zadávací dokumentace veřejné zakázky navrhneš 3 konkrétní produkty, které splňují požadavky.

Pro každý produkt uveď:
- Výrobce a přesný model
- Popis produktu
- Klíčové technické parametry
- Porovnání s každým požadavkem (splněno/nesplněno + konkrétní hodnota)
- Orientační cenu bez DPH a s DPH v CZK
- Dostupné dodavatele v ČR
- Dostupnost (skladem / na objednávku / dodací lhůta)

Vyber nejlepší kandidáta a zdůvodni výběr.

DŮLEŽITÉ:
- Uváděj pouze reálné, existující produkty dostupné na českém trhu
- Ceny musí odpovídat aktuálním tržním cenám (můžeš odhadnout ±15%)
- Pokud si nejsi jistý cenou, uveď rozsah
- DPH v ČR je 21%

Odpověz POUZE validním JSON.`;

export function buildProductMatchUserMessage(
  technicalRequirements: Array<{ parametr: string; pozadovana_hodnota: string; jednotka?: string | null; povinny: boolean }>,
  tenderName: string,
  tenderSubject: string
): string {
  const reqList = technicalRequirements
    .map((r, i) => `${i + 1}. ${r.parametr}: ${r.pozadovana_hodnota}${r.jednotka ? ` ${r.jednotka}` : ''} (${r.povinny ? 'povinné' : 'volitelné'})`)
    .join('\n');

  return `Zakázka: ${tenderName}
Předmět: ${tenderSubject}

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
      "dodavatele": ["dodavatel1", "dodavatel2"],
      "dostupnost": "skladem / 2-3 týdny"
    }
  ],
  "vybrany_index": 0,
  "oduvodneni_vyberu": "..."
}`;
}
