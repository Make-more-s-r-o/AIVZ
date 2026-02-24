export const TEMPLATE_FILL_SYSTEM = `Jsi expert na vyplňování formulářů pro české veřejné zakázky. Dostaneš textový obsah DOCX šablony rozčleněný po odstavcích (každý řádek = 1 odstavec) a data, která máš doplnit. Tvým úkolem je identifikovat VŠECHNA místa v šabloně, kde se má vyplnit informace, a vrátit přesné JSON náhrady.

ROZPOZNÁVEJ TYTO VZORY PLACEHOLDERŮ:
1. "doplní účastník" / "doplní uchazeč" / "vyplní účastník" / "vyplní uchazeč"
2. "[doplnit]" / "[vyplnit]" / "[účastník vyplní]" / "[DOPLNIT]"
3. "___" nebo "______" (podtržítka 3+ jako prázdné pole)
4. "......" nebo "……" (tečky 4+ nebo … jako prázdné pole)
5. Prázdné buňky tabulky za popiskem: "IČO:" nebo "IČO: " (hodnota chybí)
6. Vzory jako "Název: [text]" kde [text] je zjevně placeholder
7. Datum ve formátu "DD.MM.YYYY" — pokud vidíš "XX.XX.XXXX" nebo "__.__.__", nahraď

TRICKY VZORY (příklady z praxe):
- "Obchodní firma (jméno): doplní účastník" → nahradit celý text "doplní účastník" za "Make more s.r.o."
- "IČ dodavatele: " (hodnota chybí) → přidat IČO za dvojtečku: "IČ dodavatele: 07023987"
- "podpisem oprávněné osoby uchazeče" → nemění se, není to placeholder
- "Razítko a podpis" → je placeholder pro podpis, nahraď jménem jednatele
- "V ........ dne ........" → nahradit "V Praha dne DD.MM.YYYY"
- "V … dne …" → nahradit "V Praha dne DD.MM.YYYY"

KLÍČOVÉ PRAVIDLO PRO ODSTAVCE:
Šablona je rozdělena na řádky [P1], [P2], ... — každý řádek = 1 odstavec v dokumentu.
Každé "original" MUSÍ odpovídat textu z JEDNOHO odstavce (jednoho [Pxx] řádku). NIKDY neslučuj text z více odstavců do jednoho "original".
Pokud se "doplní účastník" opakuje ve více odstavcích, zahrň dostatek okolního kontextu z TOHO SAMÉHO odstavce, aby byl "original" unikátní.
Příklad: Pokud [P5] = "IČ: doplní účastník" a [P7] = "DIČ: doplní účastník", vrať:
  {"original": "IČ: doplní účastník", "replacement": "IČ: 07023987"}
  {"original": "DIČ: doplní účastník", "replacement": "DIČ: CZ07023987"}

PRAVIDLA:
1. "original" MUSÍ být přesný text z šablony (copy-paste přesnost) — nezměněný, nezkrácený
2. "original" MUSÍ odpovídat textu z přesně jednoho [Pxx] řádku — nikdy neslučuj text z více řádků
3. Pro obecné placeholdery jako "doplní účastník": zahrň kontextový text ze STEJNÉHO odstavce (popisek + placeholder)
4. Pokud se stejný placeholder opakuje vícekrát, uveď každý výskyt zvlášť s unikátním kontextem ze stejného odstavce
5. Vyplň VŠE, co dokážeš z poskytnutých dat
6. Pro neznámá pole použij "N/A"
7. Datum VŽDY ve formátu "DD.MM.YYYY"
8. Ceny VŽDY ve formátu "1 234 567,00 Kč" (mezera jako oddělovač tisíců, čárka pro desetinné)
9. Neměň jiný text šablony — pouze placeholdery
10. DŮLEŽITÉ: "original" nesmí obsahovat text, který NENÍ v šabloně. Kopíruj přesný text z šablony.
11. Při nahrazování "______" (podtržítka) zahrň CELÝ řetězec podtržítek, ne jen část

Odpověz POUZE validním JSON polem (bez markdown, bez komentářů):
[
  {"original": "přesný text placeholderu", "replacement": "hodnota"},
  ...
]`;

export interface TemplateFillTenderData {
  nazev_zakazky: string;
  evidencni_cislo?: string;
  zadavatel?: string;
  zadavatel_ico?: string;
  zadavatel_kontakt?: string;
  cena_bez_dph?: string;
  cena_s_dph?: string;
  dph?: string;
  dph_sazba?: string;
  datum?: string;
  doba_plneni_od?: string;
  doba_plneni_do?: string;
  lhuta_nabidek?: string;
  produkt_nazev?: string;
  produkt_popis?: string;
}

/**
 * Build the user message for template filling.
 * Accepts either raw text (legacy) or paragraph-segmented text (preferred).
 * When paragraphTexts is provided, the text is formatted with [P1], [P2], etc. prefixes.
 */
export function buildTemplateFillUserMessage(
  templateText: string,
  templateName: string,
  companyData: Record<string, string>,
  tenderData: TemplateFillTenderData,
  paragraphTexts?: string[]
): string {
  // Filter out internal/meta keys from company data
  const filteredCompany = Object.entries(companyData)
    .filter(([k]) => !k.startsWith('_') && k !== 'obory' && k !== 'keyword_filters')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  // Format template text: use paragraph-segmented format if available
  let formattedTemplate: string;
  if (paragraphTexts && paragraphTexts.length > 0) {
    formattedTemplate = paragraphTexts
      .map((text, i) => `[P${i + 1}] ${text}`)
      .filter(line => line.trim().length > 4) // Skip empty paragraphs (just "[Pxx] ")
      .join('\n');
  } else {
    formattedTemplate = templateText;
  }

  return `ŠABLONA: ${templateName}
---
${formattedTemplate}
---

DATA FIRMY (uchazeč/dodavatel):
${filteredCompany}

DATA ZAKÁZKY:
- Název zakázky: ${tenderData.nazev_zakazky}
${tenderData.evidencni_cislo ? `- Evidenční číslo: ${tenderData.evidencni_cislo}` : ''}
${tenderData.zadavatel ? `- Zadavatel: ${tenderData.zadavatel}` : ''}
${tenderData.zadavatel_ico ? `- IČO zadavatele: ${tenderData.zadavatel_ico}` : ''}
${tenderData.cena_bez_dph ? `- Nabídková cena bez DPH: ${tenderData.cena_bez_dph} Kč` : ''}
${tenderData.cena_s_dph ? `- Nabídková cena s DPH: ${tenderData.cena_s_dph} Kč` : ''}
${tenderData.dph ? `- DPH (${tenderData.dph_sazba || '21'}%): ${tenderData.dph} Kč` : ''}
- Datum: ${tenderData.datum || new Date().toLocaleDateString('cs-CZ')}
${tenderData.doba_plneni_od ? `- Doba plnění od: ${tenderData.doba_plneni_od}` : ''}
${tenderData.doba_plneni_do ? `- Doba plnění do: ${tenderData.doba_plneni_do}` : ''}
${tenderData.lhuta_nabidek ? `- Lhůta pro podání nabídek: ${tenderData.lhuta_nabidek}` : ''}
${tenderData.produkt_nazev ? `- Nabízený produkt: ${tenderData.produkt_nazev}` : ''}
${tenderData.produkt_popis ? `- Popis produktu: ${tenderData.produkt_popis}` : ''}

INSTRUKCE: Identifikuj VŠECHNY placeholdery v šabloně. Každý [Pxx] řádek = jeden odstavec. Tvůj "original" MUSÍ odpovídat textu z přesně jednoho odstavce — nikdy neslučuj text z více [Pxx] řádků. Nezapomeň na opakující se "doplní účastník" vzory — každý výskyt musí být v JSON zvlášť s unikátním kontextem ze stejného odstavce. Vrať JSON pole.`;
}
