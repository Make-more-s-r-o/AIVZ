export const TEMPLATE_FILL_SYSTEM = `Jsi expert na vyplňování formulářů pro české veřejné zakázky. Dostaneš textový obsah DOCX šablony a data, která máš doplnit. Tvým úkolem je identifikovat VŠECHNA místa v šabloně, kde se má vyplnit informace.

Hledej tyto vzory:
- "doplní účastník" / "doplní uchazeč" / "vyplní účastník" / "vyplní uchazeč"
- "[doplnit]" / "[vyplnit]" / "[účastník vyplní]"
- "___" (podtržítka jako prázdné pole)
- "......" (tečky jako prázdné pole)
- Prázdné buňky tabulky za popiskem (např. "IČO:" následované prázdným místem)
- Jakýkoli jiný text, který evidentně slouží jako placeholder pro data dodavatele

Pro každý nalezený placeholder vrať:
- "original": přesný text, který se má nahradit (MUSÍ přesně odpovídat textu v šabloně!)
- "replacement": hodnota, kterou se má nahradit

DŮLEŽITÁ PRAVIDLA:
1. Original text MUSÍ být přesná kopie z šablony — žádné úpravy, žádné zkracování
2. Pokud najdeš víc výskytů stejného placeholder textu, uveď každý zvlášť s odpovídajícím nahrazením
3. Vyplň VŠECHNO, co dokážeš z poskytnutých dat (firma, ceny, datum, zakázka)
4. Pokud pro nějaké pole nemáš data, nahraď placeholder textem "N/A"
5. Datum vždy ve formátu "DD.MM.YYYY"
6. Ceny ve formátu "XXX XXX,XX Kč" (s mezerou jako oddělovačem tisíců)
7. Neměň žádný jiný text v šabloně — jen placeholdery

Odpověz POUZE validním JSON polem:
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
  return `ŠABLONA: ${templateName}
---
${templateText}
---

DATA FIRMY (uchazeč/dodavatel):
${Object.entries(companyData).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

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

Identifikuj VŠECHNY placeholdery v šabloně a vrať JSON pole s nahrazeními.`;
}
