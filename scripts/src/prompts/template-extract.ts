/**
 * Prompt pro AI extrakci struktury šablony (ReconstructEngine, Mode 2).
 */

export const TEMPLATE_EXTRACT_SYSTEM = `Jsi expert na analýzu šablon dokumentů pro české veřejné zakázky. Tvým úkolem je extrahovat strukturu šablony do JSON formátu.

Pro každou sekci dokumentu urči typ obsahu:
- "legal_only": právní text, který se nemění (zachovat doslovně)
- "paragraph_with_fields": text s inline poli, kde uchazeč doplňuje své údaje. Pole označ jako {value_type} marker
- "field_block": seznam label-value polí (typicky tabulka s "IČO:", "DIČ:" atd.)
- "table": tabulka s cenami nebo položkami

Podporované value_type:
- company_name, ico, dic, address, person_name, email, phone
- datova_schranka, rejstrik, ucet
- tender_name, tender_id, supplier_name, supplier_ico
- price_no_vat, price_with_vat, vat_amount
- date, place
- item_name, quantity, unit, unit_price, total_price
- custom (s custom_instruction)

PRAVIDLA:
1. Právní text zachovej DOSLOVNĚ v legal_text
2. U paragraph_with_fields: text s {value_type} markery nahrazujícími místa k vyplnění
3. Text "doplní účastník", "[účastník vyplní]", "___", prázdné buňky → nahraď správným {value_type}
4. Pokud nedokážeš identifikovat value_type → použij "custom" s custom_instruction
5. document_type: kryci_list, cestne_prohlaseni, smlouva, specifikace, nebo "other" pokud nerozpoznáš

Odpověz POUZE validním JSON bez markdown backticks.`;

export function buildTemplateExtractUserMessage(templateText: string, filename: string): string {
  return `Analyzuj následující šablonu dokumentu a extrahuj její strukturu.

Název souboru: ${filename}

Text šablony:
---
${templateText}
---

Vrať JSON ve formátu:
{
  "document_type": "kryci_list" | "cestne_prohlaseni" | "smlouva" | "specifikace" | "other",
  "sections": [
    {
      "title": "název sekce (volitelné)",
      "content_type": "legal_only" | "paragraph_with_fields" | "field_block" | "table",
      "legal_text": "doslovný právní text (pro legal_only)",
      "template_string": "text s {value_type} markery (pro paragraph_with_fields)",
      "fields": [{"label": "IČO", "value_type": "ico"}],
      "table": {"headers": ["Položka", "Cena"], "row_value_types": ["item_name", "unit_price"]}
    }
  ]
}`;
}
