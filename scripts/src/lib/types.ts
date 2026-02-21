import { z } from 'zod';

// Extracted text from documents
export const ExtractedDocumentSchema = z.object({
  filename: z.string(),
  type: z.enum(['pdf', 'docx', 'doc', 'xls', 'xlsx']),
  text: z.string(),
  pageCount: z.number().optional(),
  isTemplate: z.boolean().default(false),
});

export const ExtractedTextSchema = z.object({
  tenderId: z.string(),
  extractedAt: z.string().datetime(),
  documents: z.array(ExtractedDocumentSchema),
  totalCharacters: z.number(),
});

// AI Analysis output
export const TenderAnalysisSchema = z.object({
  zakazka: z.object({
    nazev: z.string(),
    evidencni_cislo: z.string().optional().nullable(),
    zadavatel: z.object({
      nazev: z.string(),
      ico: z.string().optional().nullable(),
      kontakt: z.string().optional().nullable(),
    }),
    predmet: z.string(),
    predpokladana_hodnota: z.preprocess((val) => {
      if (typeof val === 'number') return val;
      if (val && typeof val === 'object') {
        // Multi-part tenders: sum numeric values, ignore strings like "mena"
        const nums = Object.values(val as Record<string, unknown>).filter(v => typeof v === 'number') as number[];
        return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
      }
      return null;
    }, z.number().optional().nullable()),
    typ_zakazky: z.string(),
    typ_rizeni: z.string(),
  }),
  kvalifikace: z.array(z.object({
    typ: z.string(),
    popis: z.string(),
    splnitelne: z.boolean(),
  })),
  hodnotici_kriteria: z.array(z.object({
    nazev: z.string(),
    vaha_procent: z.number(),
    popis: z.string(),
  })).optional().default([]),
  terminy: z.object({
    lhuta_nabidek: z.string().optional().nullable(),
    otevirani_obalek: z.string().optional().nullable(),
    doba_plneni_od: z.string().optional().nullable(),
    doba_plneni_do: z.string().optional().nullable(),
    prohlidka_mista: z.string().optional().nullable(),
  }),
  polozky: z.array(z.object({
    nazev: z.string(),
    mnozstvi: z.number().optional().nullable(),
    jednotka: z.string().optional().nullable(),
    specifikace: z.string(),
  })),
  technicke_pozadavky: z.array(z.object({
    parametr: z.string(),
    pozadovana_hodnota: z.string(),
    jednotka: z.string().optional().nullable(),
    povinny: z.boolean().default(true),
  })).optional().default([]),
  rizika: z.array(z.object({
    popis: z.string(),
    zavaznost: z.string(),
    mitigace: z.string(),
  })),
  doporuceni: z.object({
    rozhodnuti: z.string().transform(v => v.toUpperCase()),
    oduvodneni: z.string(),
    klicove_body: z.array(z.string()),
  }),
});

// Product matching
export const ProductCandidateSchema = z.object({
  vyrobce: z.string(),
  model: z.string(),
  popis: z.string(),
  parametry: z.record(z.string(), z.string()),
  shoda_s_pozadavky: z.array(z.object({
    pozadavek: z.string(),
    splneno: z.boolean(),
    hodnota: z.string(),
    komentar: z.string().optional(),
  })),
  cena_bez_dph: z.number(),
  cena_s_dph: z.number(),
  cena_spolehlivost: z.enum(['vysoka', 'stredni', 'nizka']).default('nizka'),
  cena_komentar: z.string().optional(),
  dodavatele: z.array(z.string()),
  dostupnost: z.string(),
  zdroj_ceny: z.string().optional(),
  reference_urls: z.array(z.string()).optional(),
});

export const PriceOverrideSchema = z.object({
  nakupni_cena_bez_dph: z.number(),
  nakupni_cena_s_dph: z.number(),
  marze_procent: z.number().default(0),
  nabidkova_cena_bez_dph: z.number(),
  nabidkova_cena_s_dph: z.number(),
  potvrzeno: z.boolean().default(false),
  poznamka: z.string().optional(),
});

export const PolozkaMatchSchema = z.object({
  polozka_nazev: z.string(),
  polozka_index: z.number(),
  mnozstvi: z.number().optional(),
  jednotka: z.string().optional(),
  specifikace: z.string().optional(),
  typ: z.enum(['produkt', 'prislusenstvi', 'sluzba']).default('produkt'),
  kandidati: z.array(ProductCandidateSchema),
  vybrany_index: z.number(),
  oduvodneni_vyberu: z.string(),
  cenova_uprava: PriceOverrideSchema.optional(),
});

export const ProductMatchSchema = z.object({
  tenderId: z.string(),
  matchedAt: z.string().datetime(),
  // Legacy single-product fields
  kandidati: z.array(ProductCandidateSchema).optional(),
  vybrany_index: z.number().optional(),
  oduvodneni_vyberu: z.string().optional(),
  cenova_uprava: PriceOverrideSchema.optional(),
  // Multi-product fields
  polozky_match: z.array(PolozkaMatchSchema).optional(),
}).refine(d => d.kandidati || d.polozky_match,
  { message: "Must have 'kandidati' or 'polozky_match'" }
);

// Validation report
export const ValidationCheckSchema = z.object({
  kategorie: z.string(),
  kontrola: z.string(),
  status: z.enum(['pass', 'fail', 'warning']),
  detail: z.string(),
});

export const ValidationReportSchema = z.object({
  tenderId: z.string(),
  validatedAt: z.string().datetime(),
  overall_score: z.number().min(1).max(10),
  ready_to_submit: z.boolean(),
  checks: z.array(ValidationCheckSchema),
  kriticke_problemy: z.array(z.union([z.string(), z.object({}).passthrough()])).transform(
    items => items.map(i => typeof i === 'string' ? i : JSON.stringify(i))
  ),
  doporuceni: z.array(z.union([z.string(), z.object({}).passthrough()])).transform(
    items => items.map(i => typeof i === 'string' ? i : JSON.stringify(i))
  ),
});

// Pipeline status
export const PipelineStatusSchema = z.object({
  tenderId: z.string(),
  steps: z.object({
    extract: z.enum(['pending', 'running', 'done', 'error']).default('pending'),
    analyze: z.enum(['pending', 'running', 'done', 'error']).default('pending'),
    match: z.enum(['pending', 'running', 'done', 'error']).default('pending'),
    generate: z.enum(['pending', 'running', 'done', 'error']).default('pending'),
    validate: z.enum(['pending', 'running', 'done', 'error']).default('pending'),
  }),
  errors: z.record(z.string(), z.string()).optional(),
});

// Infer types
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;
export type ExtractedText = z.infer<typeof ExtractedTextSchema>;
export type TenderAnalysis = z.infer<typeof TenderAnalysisSchema>;
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;
export type PriceOverride = z.infer<typeof PriceOverrideSchema>;
export type PolozkaMatch = z.infer<typeof PolozkaMatchSchema>;
export type ProductMatch = z.infer<typeof ProductMatchSchema>;
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;
