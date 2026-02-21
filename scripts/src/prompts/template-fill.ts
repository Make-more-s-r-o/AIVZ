export const TEMPLATE_FILL_SYSTEM = `Jsi expert na vyplňování formulářů pro české veřejné zakázky. Dostaneš textový obsah DOCX šablony a data, která máš doplnit. Tvým úkolem je identifikovat VŠECHNA místa v šabloně, kde se má vyplnit informace, a vrátit přesné JSON náhrady.

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

PRAVIDLA:
1. "original" MUSÍ být přesný text z šablony (copy-paste přesnost) — nezměněný, nezkrácený
2. Pro obecné placeholdery jako "doplní účastník" zahrň CELÝ kontext (5-10 slov před i za), aby byl unikátní. Příklad: místo "doplní účastník" piš "Obchodní firma: doplní účastník" a nahraď "Obchodní firma: Make more s.r.o."
3. Pokud se stejný placeholder opakuje vícekrát, uveď každý výskyt zvlášť s unikátním kontextem
4. Vyplň VŠE, co dokážeš z poskytnutých dat
5. Pro neznámá pole použij "N/A"
6. Datum VŽDY ve formátu "DD.MM.YYYY"
7. Ceny VŽDY ve formátu "1 234 567,00 Kč" (mezera jako oddělovač tisíců, čárka pro desetinné)
8. Neměň jiný text šablony — pouze placeholdery
9. Pokud vidíš "doplní účastník" nebo podobné na víc řádcích u různých polí, nahraď každý výskyt správnou hodnotou pro dané pole

Odpověz POUZE validním JSON polem (bez markdown, bez komentářů):
[
  {"original": "přesný text placeholderu", "replacement": "hodnota"},
  ...
]`;

export function buildTemplateFillUserMessage(
  templateText: string,
  templateName: string,
  companyData: Record<string, string>,
  tenderData: {
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
): string {
  // Filter out internal/meta keys from company data
  const filteredCompany = Object.entries(companyData)
    .filter(([k]) => !k.startsWith('_') && k !== 'obory' && k !== 'keyword_filters')
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  return `ŠABLONA: ${templateName}
---
${templateText}
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

INSTRUKCE: Identifikuj VŠECHNY placeholdery v šabloně. Nezapomeň na opakující se "doplní účastník" vzory — každý výskyt musí být v JSON zvlášť s unikátním kontextem. Vrať JSON pole.`;
}
