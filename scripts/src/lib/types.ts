import { z } from 'zod';

// Extracted text from documents
export const ExtractedDocumentSchema = z.object({
  filename: z.string(),
  type: z.enum(['pdf', 'docx', 'doc', 'xls', 'xlsx']),
  text: z.string(),
  pageCount: z.number().optional(),
  isTemplate: z.boolean().default(false),
  isSoupis: z.boolean().default(false),
});

export const ExtractedTextSchema = z.object({
  tenderId: z.string(),
  extractedAt: z.string().datetime(),
  documents: z.array(ExtractedDocumentSchema),
  totalCharacters: z.number(),
});

// Part (část) definition for multi-part tenders
export const CastSchema = z.object({
  id: z.string(),                    // "A", "B", "C" or "1", "2", "3"
  nazev: z.string(),                 // "Část A - nábytek"
  predpokladana_hodnota: z.number().optional(),
  pocet_polozek: z.number(),
  soupis_filename: z.string().optional(), // source soupis file
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
    vaha_procent: z.preprocess(parseAiNumber, z.number().nullable()).transform(v => v ?? 0),
    popis: z.string(),
  })).optional().default([]),
  terminy: z.object({
    lhuta_nabidek: z.string().optional().nullable(),
    otevirani_obalek: z.string().optional().nullable(),
    doba_plneni_od: z.string().optional().nullable(),
    doba_plneni_do: z.string().optional().nullable(),
    prohlidka_mista: z.string().optional().nullable(),
  }),
  casti: z.array(CastSchema).optional().default([]),  // empty = single-part tender
  polozky: z.array(z.object({
    nazev: z.string(),
    mnozstvi: z.number().optional().nullable(),
    jednotka: z.string().optional().nullable(),
    specifikace: z.string(),
    cast_id: z.string().optional(),  // references CastSchema.id
    // Hard per-unit price cap incl. VAT (e.g. "Cena za kus nesmí přesáhnout 39.999,- Kč s DPH").
    // Parsed from specifikace; null/undefined = no cap.
    cena_max_s_dph: z.number().optional().nullable(),
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
  go_no_go: z.object({
    score: z.number().min(0).max(100),
    doporuceni: z.enum(['GO', 'ZVAZIT', 'NOGO']),
    duvody: z.array(z.string()),
  }).optional(),
});

// Čísla z AI výstupů občas přijdou jako string („12 990,50 Kč", „1.299,-") — bez koerce
// spadne celý match na ZodError až PO zaplacení všech AI dávek (prod job 8752b6d9).
// Koerce toleruje mezery/nbsp, měnu a českou desetinnou čárku; nečíselný string nechá
// projít do z.number(), které ho odmítne standardní chybou.
function parseAiNumber(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  let s = v.replace(/[\s ]/g, '').replace(/(Kč|CZK|,-|%)$/i, '');
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // „1.299“ = česky 1299
  else s = s.replace(',', '.');
  if (s === '' || !/^-?\d/.test(s)) return v;
  const n = Number(s);
  return Number.isNaN(n) ? v : n;
}
const aiNumber = () => z.preprocess(parseAiNumber, z.number());

// Product matching
export const ProductCandidateSchema = z.object({
  vyrobce: z.string(),
  model: z.string(),
  popis: z.string(),
  parametry: z.record(z.string(), z.string()),
  shoda_s_pozadavky: z.array(z.object({
    pozadavek: z.string(),
    // AI občas vrátí null (nevyhodnoceno) — bezpečná koerce na false (netvrdit splnění)
    splneno: z.boolean().nullable().transform(v => v ?? false),
    hodnota: z.string(),
    komentar: z.string().optional(),
  })),
  cena_bez_dph: aiNumber(),
  cena_s_dph: aiNumber(),
  cena_spolehlivost: z.enum(['vysoka', 'stredni', 'nizka']).default('nizka'),
  cena_komentar: z.string().optional(),
  dodavatele: z.array(z.string()),
  dostupnost: z.string(),
  zdroj_ceny: z.string().optional(),
  katalogove_cislo: z.string().optional(),
  reference_urls: z.array(z.string()).optional(),
  // AI nenašla reálný odpovídající produkt — kandidát je jen zástupný záznam s nulovou
  // cenou (viz prompt „KDYŽ NENAJDEŠ REÁLNÝ PRODUKT"). Taková položka se NIKDY
  // nepředvyplňuje cenou kandidáta — nacení ji operátor ručně.
  zadna_shoda: z.boolean().optional(),
  // Warehouse matching metadata
  warehouse_product_id: z.string().uuid().optional(),
  match_tier: z.enum(['exact', 'text', 'vector']).optional(),
  match_score: z.preprocess(parseAiNumber, z.number().optional()),
});

export const PriceOverrideSchema = z.object({
  nakupni_cena_bez_dph: z.number(),
  nakupni_cena_s_dph: z.number(),
  marze_procent: z.number().default(0),
  nabidkova_cena_bez_dph: z.number(),
  nabidkova_cena_s_dph: z.number(),
  potvrzeno: z.boolean().default(false),
  poznamka: z.string().optional(),
  zdroj_nakupu: z.object({
    url: z.string().refine((value) => /^https?:\/\//i.test(value), 'URL musí používat HTTP(S)'),
    dodavatel: z.string().nullable(),
  }).optional(),
  override_pod_nakupem: z.object({
    potvrzeno: z.literal(true),
    duvod: z.string().trim().min(10, 'Důvod výjimky musí mít alespoň 10 znaků'),
    schvalil: z.string().trim().min(1).optional(),
  }).optional(),
});

export const PriceSanityFlagSchema = z.object({
  polozka_index: z.number(),
  level: z.enum(['hard', 'warn']),
  code: z.enum([
    'overcap',
    'zero_price',
    'below_cost',
    'bid_share',
    'low_confidence_big',
    'outlier_vs_batch',
    'extreme_outlier',
    'cena_pod_nakupem',
    // Historické soubory zůstanou čitelné; při parse se starý název přepíše.
    'ai_cena_pod_trhem',
  ]).transform((code) => code === 'ai_cena_pod_trhem' ? 'cena_pod_nakupem' as const : code),
  message: z.string(),
});

// Jeden konkrétní nákupní nález z webového ověření ceny. Pole `zdroje` je na
// `overeni_ceny` volitelné, aby dál prošly i starší product-match.json soubory,
// které obsahují pouze jeden zdroj v top-level polích.
export const WebPriceSourceSchema = z.object({
  url: z.string().refine((value) => /^https:\/\//i.test(value), 'URL musí používat HTTPS'),
  dodavatel: z.string().nullable(),
  // Volitelné kvůli starším product-match.json; nové webové ověření ho vždy vyžaduje v promptu.
  nazev_produktu: z.string().optional(),
  cena_bez_dph: z.number().nullable(),
  cena_s_dph: z.number().nullable(),
  cena_baleni_s_dph: z.number().nullable().optional().default(null),
  baleni_ks: z.number().positive().nullable().optional().default(null),
  mena: z.literal('CZK').optional().default('CZK'),
  sazba_dph: z.number().positive().nullable().optional(),
  dostupnost: z.preprocess(
    (value) => value == null ? 'neznámá' : value,
    z.enum(['skladem', 'na dotaz', 'není skladem', 'neznámá']),
  ),
  poznamka: z.string().nullable(),
  splnuje_specifikaci: z.boolean().optional(),
  shoda_parametru: z.array(z.string()).optional(),
});

export const OvereniCenySchema = z.object({
  stav: z.enum(['nalezeno', 'ekvivalent', 'nenalezeno', 'chyba']),
  // Nová pole jsou volitelná, aby zůstaly čitelné historické soubory se stavem `nalezeno`.
  shoda_typ: z.enum(['presny', 'ekvivalent']).optional(),
  web_cena_bez_dph: z.number().optional(),
  web_cena_s_dph: z.number().optional(),
  mena: z.string().optional(),
  zdroj_url: z.string().optional(),
  dodavatel: z.string().optional(),
  dostupnost: z.string().optional(),
  poznamka: z.string().optional(),
  overeno_at: z.string().datetime(),
  kandidat_fingerprint: z.string().optional(),
  prekracuje_strop: z.boolean().optional(),
  zdroje: z.array(WebPriceSourceSchema).max(3).optional(),
  realita: z.object({
    nejlevnejsi_bez_dph: z.number().nullable(),
    rozdil_procent: z.number().nullable(),
    pod_trhem: z.boolean(),
    nejlevnejsi_dodavatel: z.string().nullable().optional(),
    nejlevnejsi_zdroj_url: z.string().nullable().optional(),
    poznamka: z.string().nullable().optional(),
  }).optional(),
});

export const PolozkaMatchSchema = z.object({
  polozka_nazev: z.string(),
  polozka_index: z.number(),
  mnozstvi: z.preprocess(parseAiNumber, z.number().optional()),
  jednotka: z.string().optional(),
  specifikace: z.string().optional(),
  cena_max_s_dph: z.number().optional(),  // hard per-unit cap incl. VAT (carried from analysis)
  typ: z.enum(['produkt', 'prislusenstvi', 'sluzba']).default('produkt'),
  cast_id: z.string().optional(),    // references CastSchema.id
  kandidati: z.array(ProductCandidateSchema),
  vybrany_index: aiNumber(),
  oduvodneni_vyberu: z.string(),
  cenova_uprava: PriceOverrideSchema.optional(),
  sanity_flags: z.array(PriceSanityFlagSchema).optional(),
  overeni_ceny: OvereniCenySchema.optional(),
});

export const ProductMatchSchema = z.object({
  tenderId: z.string(),
  matchedAt: z.string().datetime(),
  // Snapshot výběru částí při nacenění; null znamená všechny části.
  // Optional zachovává kompatibilitu se staršími product-match soubory.
  selected_parts_snapshot: z.array(z.string()).nullable().optional(),
  // Legacy single-product fields
  kandidati: z.array(ProductCandidateSchema).optional(),
  vybrany_index: z.preprocess(parseAiNumber, z.number().optional()),
  oduvodneni_vyberu: z.string().optional(),
  cenova_uprava: PriceOverrideSchema.optional(),
  overeni_ceny: OvereniCenySchema.optional(),
  // Multi-product fields
  polozky_match: z.array(PolozkaMatchSchema).optional(),
  // Profit-aware bid skóre počítané PO nacenění (viz go-no-go.ts scoreBid).
  // Ukládá se do product-match.json; při potvrzení ceny se přepočítává on-the-fly
  // přes GET /api/tenders/:id/bid-score (nezapisuje se znovu).
  bid_score: z.object({
    score: z.number(),
    doporuceni: z.enum(['GO', 'ZVAZIT', 'NOGO']),
    duvody: z.array(z.string()),
    zisk_kc: z.number(),
    marze_procent: z.number(),
  }).optional(),
}).refine(d => d.kandidati || d.polozky_match,
  { message: "Must have 'kandidati' or 'polozky_match'" }
);

// Validation report
export const ValidationCheckSchema = z.object({
  kategorie: z.string(),
  kontrola: z.string(),
  status: z.enum(['pass', 'fail', 'warning']),
  detail: z.string(),
  zdroj: z.enum(['deterministic', 'ai']).default('ai'),
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
export type Cast = z.infer<typeof CastSchema>;
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;
export type ExtractedText = z.infer<typeof ExtractedTextSchema>;
export type TenderAnalysis = z.infer<typeof TenderAnalysisSchema>;
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;
export type PriceOverride = z.infer<typeof PriceOverrideSchema>;
export type PriceSanityFlag = z.infer<typeof PriceSanityFlagSchema>;
export type WebPriceSource = z.infer<typeof WebPriceSourceSchema>;
export type OvereniCeny = z.infer<typeof OvereniCenySchema>;
export type PolozkaMatch = z.infer<typeof PolozkaMatchSchema>;
export type ProductMatch = z.infer<typeof ProductMatchSchema>;
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
export type PipelineStatus = z.infer<typeof PipelineStatusSchema>;
