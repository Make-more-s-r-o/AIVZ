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

const TENDER_TERM_KEYS = [
  'lhuta_nabidek',
  'otevirani_obalek',
  'doba_plneni_od',
  'doba_plneni_do',
  'prohlidka_mista',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLabel(value: string): string {
  return value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function partIdFromLabel(label: string): string | undefined {
  const normalized = normalizeLabel(label);
  const explicit = normalized.match(
    /(?:^|\b)(?:dilci\s+cast|cast|part|lot|los)\s*(?:c(?:islo)?|no)?\s*([a-z]|\d+)\b/,
  );
  if (explicit) return explicit[1];
  return /^([a-z]|\d+)$/.exec(normalized)?.[1];
}

function canonicalPartIdentity(value: string): string {
  const extracted = partIdFromLabel(value);
  const normalized = extracted ?? normalizeLabel(value);
  if (/^\d+$/.test(normalized)) return `ordinal:${Number(normalized)}`;
  if (/^[a-z]$/.test(normalized)) return `ordinal:${normalized.charCodeAt(0) - 96}`;
  return `name:${normalized}`;
}

function isAggregateLabel(label: string): boolean {
  const normalized = normalizeLabel(label);
  return /\b(celkem|celkova|celkovy|souhrn|overall|total|zakazka)\b/.test(normalized)
    || /^(predpokladana )?hodnota( zakazky)?( bez dph)?$/.test(normalized)
    || /^bez (dph|vat)$/.test(normalized);
}

function isInclusiveVatLabel(label: string): boolean {
  const normalized = normalizeLabel(label);
  return /\b(?:vc|vcetne|including|incl)(?:\s+\d+)?\s*(?:dph|vat)\b/.test(normalized)
    || /\bs(?:\s+\d+)?\s+(?:dph|vat)\b/.test(normalized);
}

function isWithoutVatLabel(label: string): boolean {
  return /\bbez(?:\s+\d+)?\s+(?:dph|vat)\b/.test(normalizeLabel(label));
}

function isPartsWrapperLabel(label: string): boolean {
  return /\b(casti|parts|lots)\b/.test(normalizeLabel(label));
}

function aiFiniteNumber(value: unknown): number | undefined {
  const withoutVatQualifier = typeof value === 'string'
    ? value.replace(
      /\b(?:bez|vč(?:etně)?|vc(?:etne)?|s)\.?\s*(?:\d+(?:[.,]\d+)?\s*%?\s*)?(?:DPH|VAT)\b/giu,
      '',
    ).trim()
    : value;
  const parsed = parseAiNumber(withoutVatQualifier);
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

interface LabeledNumber {
  label: string;
  detailLabel: string;
  value: number;
  nestedPart: boolean;
  contextLabel?: string;
  valueLabel?: string;
}

function labeledNumbers(value: Record<string, unknown>): LabeledNumber[] {
  const result: LabeledNumber[] = [];
  for (const [label, raw] of Object.entries(value)) {
    const numeric = aiFiniteNumber(raw);
    if (numeric !== undefined) {
      result.push({
        label,
        detailLabel: label,
        value: numeric,
        nestedPart: false,
        valueLabel: typeof raw === 'string' ? raw : undefined,
      });
      continue;
    }

    if (isRecord(raw) && isPartsWrapperLabel(label)) {
      for (const [partLabel, partRaw] of Object.entries(raw)) {
        const partValue = aiFiniteNumber(partRaw);
        if (partValue !== undefined) {
          result.push({
            label: partLabel,
            detailLabel: `${label}.${partLabel}`,
            value: partValue,
            nestedPart: true,
            contextLabel: label,
            valueLabel: typeof partRaw === 'string' ? partRaw : undefined,
          });
        }
      }
    }
  }
  return result;
}

function moneyEntryIsGross(entry: LabeledNumber): boolean {
  return isInclusiveVatLabel(entry.label)
    || (entry.contextLabel !== undefined && isInclusiveVatLabel(entry.contextLabel))
    || (entry.valueLabel !== undefined && isInclusiveVatLabel(entry.valueLabel));
}

function moneyEntryIsWithoutVat(entry: LabeledNumber): boolean {
  return isWithoutVatLabel(entry.label)
    || (entry.contextLabel !== undefined && isWithoutVatLabel(entry.contextLabel))
    || (entry.valueLabel !== undefined && isWithoutVatLabel(entry.valueLabel));
}

function representativeMoney(entries: LabeledNumber[]): number | null {
  if (entries.length === 0) return null;

  // `predpokladana_hodnota` is a without-VAT whole-tender value. Prefer an explicitly
  // declared whole without VAT, then an unqualified declared whole. If neither exists,
  // max is the only safe aggregate: a whole cannot be smaller than any of its parts.
  const declared = entries.filter((entry) => !entry.nestedPart && isAggregateLabel(entry.label));
  const declaredWithoutVat = declared.filter(moneyEntryIsWithoutVat);
  const declaredUnqualified = declared.filter((entry) => !moneyEntryIsGross(entry));
  const nonGrossEntries = entries.filter((entry) => !moneyEntryIsGross(entry));
  const candidates = declaredWithoutVat.length > 0
    ? declaredWithoutVat
    : declaredUnqualified.length > 0
      ? declaredUnqualified
      : nonGrossEntries;
  if (candidates.length === 0) return null;
  return Math.max(...candidates.map((entry) => entry.value));
}

function comparableDate(value: string): number | undefined {
  const trimmed = value.trim();
  const czech = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(trimmed);
  if (czech) {
    const [, day, month, year, hour = '0', minute = '0'] = czech;
    const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  // ISO without an offset describes the same local procurement time as Czech notation.
  // Compare its components as a timezone-free value; Date.parse would otherwise shift
  // only the ISO branch according to the server's timezone.
  const localIso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(trimmed);
  if (localIso) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = localIso;
    const timestamp = Date.UTC(
      Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
    );
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

interface LabeledDate {
  label: string;
  value: string | null;
  nestedPart: boolean;
}

function labeledDates(value: Record<string, unknown>): LabeledDate[] {
  const result: LabeledDate[] = [];
  for (const [label, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || raw === null) {
      result.push({ label, value: raw, nestedPart: false });
      continue;
    }

    if (isRecord(raw) && isPartsWrapperLabel(label)) {
      for (const [partLabel, partRaw] of Object.entries(raw)) {
        if (typeof partRaw === 'string' || partRaw === null) {
          result.push({ label: partLabel, value: partRaw, nestedPart: true });
        }
      }
    }
  }
  return result;
}

function representativeDate(entries: LabeledDate[], latest: boolean): string | null {
  const strings = entries.filter((entry): entry is LabeledDate & { value: string } => typeof entry.value === 'string');
  if (strings.length === 0) return null;

  const comparable = strings
    .map((entry) => ({ ...entry, timestamp: comparableDate(entry.value) }))
    .filter((entry): entry is typeof entry & { timestamp: number } => entry.timestamp !== undefined);
  if (comparable.length === 0) return strings[0].value;
  return comparable.reduce((selected, candidate) => {
    const candidateWins = latest
      ? candidate.timestamp > selected.timestamp
      : candidate.timestamp < selected.timestamp;
    return candidateWins ? candidate : selected;
  }).value;
}

function dateField(latest = false) {
  return z.preprocess((value) => {
    if (!isRecord(value)) return value;
    return representativeDate(labeledDates(value), latest);
  }, z.string().optional().nullable());
}

const TenderTerminySchema = z.object({
  lhuta_nabidek: dateField(),
  otevirani_obalek: dateField(),
  doba_plneni_od: dateField(),
  doba_plneni_do: dateField(true),
  prohlidka_mista: dateField(),
});

const MoneyByPartSchema = z.record(z.string(), z.preprocess((value) => {
  const numeric = aiFiniteNumber(value);
  return numeric ?? value;
}, z.number()));

// Part (část) definition for multi-part tenders
export const CastSchema = z.object({
  id: z.string(),                    // "A", "B", "C" or "1", "2", "3"
  nazev: z.string(),                 // "Část A - nábytek"
  predpokladana_hodnota: z.preprocess(
    (value) => value == null || (typeof value === 'string' && isInclusiveVatLabel(value))
      ? undefined
      : aiFiniteNumber(value) ?? value,
    z.number().optional(),
  ),
  terminy: TenderTerminySchema.optional(),
  pocet_polozek: z.number().int().nonnegative().optional().default(0),
  soupis_filename: z.string().optional(), // source soupis file
});

type CastOutput = z.output<typeof CastSchema>;

/**
 * Deterministic soupis detection owns the final part ID and item count. AI/schema
 * extraction may already know the human name, budget and dates, so merge those
 * details by a stable identifier (1 == A), never by array position.
 */
function matchingCastIndex(existingParts: CastOutput[], detected: CastOutput): number {
  const identity = canonicalPartIdentity(detected.id);
  const byId = existingParts.findIndex((part) => canonicalPartIdentity(part.id) === identity);
  if (byId >= 0) return byId;

  if (detected.soupis_filename) {
    const normalizedFilename = normalizeLabel(detected.soupis_filename);
    return existingParts.findIndex((part) => {
      const subject = normalizeLabel(part.nazev)
        .replace(/^(?:dilci\s+)?cast\s*(?:[a-z]|\d+)\s*/, '')
        .trim();
      return subject.length >= 4 && normalizedFilename.includes(subject);
    });
  }
  return -1;
}

export function mergeDetectedCastDetails(existingParts: CastOutput[], detected: CastOutput): CastOutput {
  const existingIndex = matchingCastIndex(existingParts, detected);
  const existing = existingIndex >= 0 ? existingParts[existingIndex] : undefined;

  return existing
    ? { ...existing, ...detected, nazev: existing.nazev }
    : detected;
}

/** Merge all deterministically detected parts while retaining any unmatched AI part detail. */
export function mergeDetectedCastiDetails(existingParts: CastOutput[], detectedParts: CastOutput[]): CastOutput[] {
  const unmatched = new Set(existingParts.map((_, index) => index));
  const merged = detectedParts.map((detected) => {
    const available = existingParts.filter((_, index) => unmatched.has(index));
    const availableIndex = matchingCastIndex(available, detected);
    if (availableIndex < 0) return detected;

    const originalIndex = existingParts.indexOf(available[availableIndex]);
    unmatched.delete(originalIndex);
    const existing = existingParts[originalIndex];
    return { ...existing, ...detected, nazev: existing.nazev };
  });
  return [...merged, ...[...unmatched].map((index) => existingParts[index])];
}

function mutablePart(parts: unknown[], label: string): Record<string, unknown> {
  const identity = canonicalPartIdentity(label);
  const normalizedLabel = normalizeLabel(label);
  const existing = parts.find((candidate) => {
    if (!isRecord(candidate)) return false;
    if (typeof candidate.id === 'string' && canonicalPartIdentity(candidate.id) === identity) return true;
    if (typeof candidate.nazev !== 'string') return false;
    if (canonicalPartIdentity(candidate.nazev) === identity) return true;
    const normalizedName = normalizeLabel(candidate.nazev);
    return normalizedLabel.length >= 4
      && (normalizedName.includes(normalizedLabel) || normalizedLabel.includes(normalizedName));
  });
  if (isRecord(existing)) return existing;

  const extractedId = partIdFromLabel(label);
  const part: Record<string, unknown> = {
    id: extractedId ?? normalizeLabel(label).replace(/\s+/g, '-'),
    nazev: label,
    pocet_polozek: 0,
  };
  parts.push(part);
  return part;
}

function normalizeTenderAnalysisInput(input: unknown): unknown {
  if (!isRecord(input)) return input;

  const normalized: Record<string, unknown> = { ...input };
  const parts: unknown[] = Array.isArray(input.casti)
    ? input.casti.map((part) => isRecord(part) ? { ...part } : part)
    : [];

  if (isRecord(input.zakazka)) {
    const zakazka: Record<string, unknown> = { ...input.zakazka };
    if (isRecord(zakazka.predpokladana_hodnota)) {
      const entries = labeledNumbers(zakazka.predpokladana_hodnota);
      zakazka.predpokladana_hodnota = representativeMoney(entries);
      const valueByPart: Record<string, number> = isRecord(zakazka.hodnota_po_castech)
        ? Object.fromEntries(Object.entries(zakazka.hodnota_po_castech)
          .flatMap(([label, value]) => {
            const numeric = aiFiniteNumber(value);
            return numeric === undefined ? [] : [[label, numeric] as const];
          }))
        : {};
      for (const entry of entries) {
        const isPart = entry.nestedPart || partIdFromLabel(entry.label) !== undefined;
        if (!isPart) continue;
        valueByPart[entry.detailLabel] = entry.value;
        const part = mutablePart(parts, entry.label);
        // A gross cap is valuable audit detail, but must not enter a field consumed
        // downstream as a without-VAT amount. Unqualified legacy values stay only
        // in `hodnota_po_castech`; canonical `casti[]` from the prompt is unaffected.
        if (moneyEntryIsWithoutVat(entry) && aiFiniteNumber(part.predpokladana_hodnota) === undefined) {
          part.predpokladana_hodnota = entry.value;
        }
      }
      if (Object.keys(valueByPart).length > 0) zakazka.hodnota_po_castech = valueByPart;
    }
    normalized.zakazka = zakazka;
  }

  if (isRecord(input.terminy)) {
    const terminy: Record<string, unknown> = { ...input.terminy };
    const termsByPart: Record<string, Record<string, unknown>> = isRecord(input.terminy_po_castech)
      ? Object.fromEntries(Object.entries(input.terminy_po_castech)
        .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
        .map(([label, detail]) => [label, { ...detail }]))
      : {};
    for (const key of TENDER_TERM_KEYS) {
      const rawValue = terminy[key];
      if (!isRecord(rawValue)) continue;

      const entries = labeledDates(rawValue);
      terminy[key] = representativeDate(entries, key === 'doba_plneni_do');
      for (const entry of entries) {
        const isPart = entry.nestedPart || partIdFromLabel(entry.label) !== undefined;
        if (!isPart) continue;
        const preservedTerms = termsByPart[entry.label] ?? {};
        if (!(key in preservedTerms) || preservedTerms[key] == null) preservedTerms[key] = entry.value;
        termsByPart[entry.label] = preservedTerms;
        const part = mutablePart(parts, entry.label);
        const partTerminy = isRecord(part.terminy) ? { ...part.terminy } : {};
        if (!(key in partTerminy) || partTerminy[key] == null) partTerminy[key] = entry.value;
        part.terminy = partTerminy;
      }
    }
    normalized.terminy = terminy;
    if (Object.keys(termsByPart).length > 0) normalized.terminy_po_castech = termsByPart;
  }

  if (parts.length > 0 || Array.isArray(input.casti)) normalized.casti = parts;
  return normalized;
}

// AI Analysis output
export const TenderAnalysisSchema = z.preprocess(normalizeTenderAnalysisInput, z.object({
  zakazka: z.object({
    nazev: z.string(),
    evidencni_cislo: z.string().optional().nullable(),
    zadavatel: z.object({
      nazev: z.string(),
      ico: z.string().optional().nullable(),
      kontakt: z.string().optional().nullable(),
    }),
    predmet: z.string(),
    predpokladana_hodnota: z.preprocess((value) => {
      if (value == null) return null;
      if (typeof value === 'string' && isInclusiveVatLabel(value)) return null;
      return aiFiniteNumber(value) ?? value;
    }, z.number().optional().nullable()),
    hodnota_po_castech: MoneyByPartSchema.optional(),
    typ_zakazky: z.string(),
    typ_rizeni: z.string(),
  }),
  kvalifikace: z.array(z.object({
    typ: z.string(),
    popis: z.string(),
    splnitelne: z.boolean(),
  })),
  // Volitelné bez defaultu kvůli rozlišení historických analýz. Chybějící pole
  // nesmí staré zakázky zablokovat, ale submit-gate na ně výslovně upozorní.
  pozadovane_dokumenty: z.array(z.object({
    nazev: z.string(),
    popis: z.string().optional(),
    povinny: z.boolean(),
    typ: z.enum([
      'kryci_list', 'cestne_prohlaseni', 'soupis', 'smlouva',
      'seznam_poddodavatelu', 'jine',
    ]).optional(),
  })).optional(),
  hodnotici_kriteria: z.array(z.object({
    nazev: z.string(),
    vaha_procent: z.preprocess(parseAiNumber, z.number().nullable()).transform(v => v ?? 0),
    popis: z.string(),
  })).optional().default([]),
  terminy: TenderTerminySchema,
  terminy_po_castech: z.record(z.string(), TenderTerminySchema).optional(),
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
}));

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
  // Volitelné kvůli zpětné kompatibilitě historických product-match souborů.
  identifikace_jistota: z.enum(['vysoka', 'stredni', 'nizka']).optional(),
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

const PriceOverrideObjectSchema = z.object({
  nakupni_cena_bez_dph: z.number(),
  nakupni_cena_s_dph: z.number(),
  marze_procent: z.number().default(0),
  nabidkova_cena_bez_dph: z.number(),
  nabidkova_cena_s_dph: z.number(),
  potvrzeno: z.boolean().default(false),
  zkontrolovano_at: z.string().datetime({ offset: true }).optional(),
  zkontrolovano_kym: z.string().trim().min(1).optional(),
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

export const PriceOverrideSchema = PriceOverrideObjectSchema.superRefine((value, context) => {
  if (value.potvrzeno && (!value.zkontrolovano_at || !value.zkontrolovano_kym)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Potvrzená cena musí obsahovat čas a identitu lidské kontroly',
      path: ['potvrzeno'],
    });
  }
});

// Pouze pro čtení historických product-match souborů. Všechny zápisové endpointy
// používají výše uvedené přísné schéma a legacy potvrzení tedy neumějí vytvořit.
const LegacyPriceOverrideSchema = PriceOverrideObjectSchema;

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
    'orientacni_cena_nad_nabidkou',
    'genericky_kandidat',
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
  // Orientační zdroj má použitelný odkaz a cenu, ale AI nedoložila shodu parametrů.
  orientacni: z.boolean().optional(),
  z_cache: z.boolean().optional(),
  cache_stari_dnu: z.number().nonnegative().optional(),
});

export const OvereniCenySchema = z.object({
  stav: z.enum(['nalezeno', 'ekvivalent', 'orientacni', 'nenalezeno', 'chyba']),
  // Nová pole jsou volitelná, aby zůstaly čitelné historické soubory se stavem `nalezeno`.
  shoda_typ: z.enum(['presny', 'ekvivalent']).optional(),
  web_cena_bez_dph: z.number().optional(),
  web_cena_s_dph: z.number().optional(),
  mena: z.string().optional(),
  zdroj_url: z.string().optional(),
  dodavatel: z.string().optional(),
  dostupnost: z.string().optional(),
  poznamka: z.string().optional(),
  posledni_chyba: z.object({
    zprava: z.string(),
    at: z.string().datetime(),
  }).optional(),
  overeno_at: z.string().datetime(),
  kandidat_fingerprint: z.string().optional(),
  prekracuje_strop: z.boolean().optional(),
  kandidat_neexistuje: z.boolean().optional(),
  z_cache: z.boolean().optional(),
  cache_stari_dnu: z.number().nonnegative().optional(),
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
  cenova_uprava: LegacyPriceOverrideSchema.optional(),
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
  cenova_uprava: LegacyPriceOverrideSchema.optional(),
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
