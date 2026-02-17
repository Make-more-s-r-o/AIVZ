export const TECHNICAL_PROPOSAL_SYSTEM = `Jsi expert na přípravu nabídek do veřejných zakázek v České republice. Napiš profesionální technický návrh (technickou zprávu) jako součást nabídky do veřejné zakázky.

Technický návrh musí:
1. Být napsán profesionálním, formálním jazykem v češtině
2. Adresovat všechny technické požadavky ze zadávací dokumentace
3. Popisovat nabízené řešení konkrétně (model, parametry)
4. Obsahovat harmonogram dodání a implementace
5. Popisovat záruční a pozáruční servis
6. Uvést reference (pokud jsou požadovány)

Formát: Markdown (bude konvertován do DOCX).
Používej nadpisy ## a ### pro strukturu.
Piš stručně ale kompletně — typicky 2-4 strany A4.`;

export function buildTechnicalProposalUserMessage(
  tenderName: string,
  tenderSubject: string,
  requirements: Array<{ parametr: string; pozadovana_hodnota: string }>,
  product: { vyrobce: string; model: string; popis: string; parametry: Record<string, string> },
  company: { nazev: string; ico: string; sidlo: string }
): string {
  const reqList = requirements
    .map((r, i) => `${i + 1}. ${r.parametr}: ${r.pozadovana_hodnota}`)
    .join('\n');

  const paramList = Object.entries(product.parametry)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

  return `Veřejná zakázka: ${tenderName}
Předmět: ${tenderSubject}

Technické požadavky:
${reqList}

Nabízený produkt:
- Výrobce: ${product.vyrobce}
- Model: ${product.model}
- Popis: ${product.popis}
- Parametry:
${paramList}

Uchazeč:
- ${company.nazev}, IČO ${company.ico}
- Sídlo: ${company.sidlo}

Napiš kompletní technický návrh v češtině.`;
}
