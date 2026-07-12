export const POVINNE_FILL_KLICE = ['cena', 'ico', 'dic', 'nazev_firmy', 'datum', 'podpis'] as const;

export interface NevyplnenySlot {
  klic: string;
  kontext: string;
  povinny?: boolean;
}

export interface FillDocumentReport {
  dokument: string;
  slotu_celkem: number;
  vyplneno: number;
  nevyplneno: number;
  miss_rate: number;
  nevyplnene_sloty: NevyplnenySlot[];
}

export interface FillReport {
  dokumenty: FillDocumentReport[];
  celkem: { slotu_celkem: number; vyplneno: number; nevyplneno: number; miss_rate: number };
}

export interface FillAttempt {
  klic?: string;
  original: string;
  hodnota?: string | null;
  vyplneno: boolean;
}

/** Stabilní čistý výpočet; nulový počet slotů nemá miss-rate. */
export function calculateMissRate(nevyplneno: number, slotuCelkem: number): number {
  return slotuCelkem > 0 ? nevyplneno / slotuCelkem : 0;
}

function bezDiakritiky(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function inferFillKey(text: string): string {
  const value = bezDiakritiky(text);
  if (/\b(di[cč]|vat)\b/.test(value)) return 'dic';
  if (/\b(i[cč]o?|identifikacni cislo)\b/.test(value)) return 'ico';
  if (/cena|dph|price|castka/.test(value)) return 'cena';
  if (/podpis|signature|podeps/.test(value)) return 'podpis';
  if (/datum|date|dne\b/.test(value)) return 'datum';
  if (/obchodni firma|nazev (firmy|dodavatele|ucastnika)|company.name/.test(value)) return 'nazev_firmy';
  const token = value.match(/[a-z][a-z0-9_]{1,40}/)?.[0];
  return token ?? 'neznamy_slot';
}

export function isRequiredFillKey(klic: string): boolean {
  return (POVINNE_FILL_KLICE as readonly string[]).includes(klic);
}

/** Kontext je záměrně krátký, aby byl bezpečně zobrazitelný v UI. */
export function makeFillContext(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function buildDocumentFillReport(dokument: string, attempts: readonly FillAttempt[]): FillDocumentReport {
  const missing = attempts.filter((attempt) => !attempt.vyplneno).map((attempt) => {
    const klic = attempt.klic || inferFillKey(attempt.original);
    return { klic, kontext: makeFillContext(attempt.original), povinny: isRequiredFillKey(klic) };
  });
  const total = attempts.length;
  return {
    dokument,
    slotu_celkem: total,
    vyplneno: total - missing.length,
    nevyplneno: missing.length,
    miss_rate: calculateMissRate(missing.length, total),
    nevyplnene_sloty: missing,
  };
}

export function buildFillReport(dokumenty: readonly FillDocumentReport[]): FillReport {
  const celkem = dokumenty.reduce((sum, doc) => ({
    slotu_celkem: sum.slotu_celkem + doc.slotu_celkem,
    vyplneno: sum.vyplneno + doc.vyplneno,
    nevyplneno: sum.nevyplneno + doc.nevyplneno,
  }), { slotu_celkem: 0, vyplneno: 0, nevyplneno: 0 });
  return { dokumenty: [...dokumenty], celkem: { ...celkem, miss_rate: calculateMissRate(celkem.nevyplneno, celkem.slotu_celkem) } };
}

export function splitFillProblems(report: FillReport): { required: Array<NevyplnenySlot & { dokument: string }>; optional: Array<NevyplnenySlot & { dokument: string }> } {
  const required: Array<NevyplnenySlot & { dokument: string }> = [];
  const optional: Array<NevyplnenySlot & { dokument: string }> = [];
  for (const doc of report.dokumenty ?? []) for (const slot of doc.nevyplnene_sloty ?? []) {
    (slot.povinny || isRequiredFillKey(slot.klic) ? required : optional).push({ ...slot, dokument: doc.dokument });
  }
  return { required, optional };
}
