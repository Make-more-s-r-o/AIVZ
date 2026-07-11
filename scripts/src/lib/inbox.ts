// Schvalovací inbox — agregační logika a defenzivní čtení jeho JSON vstupů.
// Sesbírá napříč zakázkami "co ode mě čeká akci": nepotvrzené ceny, HARD sanity
// flagy, počet fail checků z validace a CRM stav. Endpoint jen načte soubory a
// předá je sem — díky tomu je logika testovatelná nad prostými objekty.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type InboxJsonReadResult =
  | { state: 'ok'; data: unknown }
  | { state: 'missing' }
  | { state: 'corrupt'; filename: string; detail: string };

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Rozliší legitimně chybějící soubor od poškozeného nebo nečitelného JSONu. */
export async function readInboxJson(outputDir: string, tenderId: string, filename: string): Promise<InboxJsonReadResult> {
  try {
    return { state: 'ok', data: JSON.parse(await readFile(join(outputDir, tenderId, filename), 'utf-8')) };
  } catch (error) {
    if (isEnoent(error)) return { state: 'missing' };
    return {
      state: 'corrupt',
      filename,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

// Vstup pro jednu zakázku — už rozparsované JSONy (nebo null, když soubor chybí).
export interface InboxTenderInput {
  tenderId: string;
  // analysis.json (kvůli názvu zakázky)
  analysis?: unknown | null;
  // product-match.json (nepotvrzené ceny, hard flagy, celková cena)
  productMatch?: unknown | null;
  // validation-report.json (ready_to_submit + počet fail checků)
  validation?: unknown | null;
  // Názvy souborů, které existují, ale nelze je bezpečně načíst/parsovat.
  dataErrors?: string[];
  // CRM stav z crm-store (getAllStatuses)
  crmStav?: string | null;
}

export interface InboxEntry {
  tender_id: string;
  nazev: string;
  crm_stav: string | null;
  nepotvrzene_ceny: number;
  hard_flagy: number;
  validation_fails: number;
  ready_to_submit: boolean;
  celkova_cena_s_dph: number | null;
  data_error: boolean;
  data_error_files: string[];
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' ? (value as Record<string, any>) : null;
}

function isConfirmed(cenova_uprava: any): boolean {
  return Boolean(cenova_uprava && cenova_uprava.potvrzeno === true);
}

// Nejlepší dostupná nabídková cena s DPH za kus dané položky.
function itemUnitPriceSDph(item: Record<string, any>): number | null {
  const upravaCena = item?.cenova_uprava?.nabidkova_cena_s_dph;
  if (typeof upravaCena === 'number' && Number.isFinite(upravaCena)) return upravaCena;
  const vybrany = item?.kandidati?.[item?.vybrany_index];
  const kandidatCena = vybrany?.cena_s_dph;
  if (typeof kandidatCena === 'number' && Number.isFinite(kandidatCena)) return kandidatCena;
  return null;
}

// Spočítá jednu řádku inboxu z rozparsovaných dat zakázky.
// Defenzivní: chybějící/vadná data => nuly a fallback název (nikdy nevyhazuje).
export function computeInboxEntry(input: InboxTenderInput): InboxEntry {
  const analysis = asRecord(input.analysis);
  const match = asRecord(input.productMatch);
  const validation = asRecord(input.validation);

  const nazev =
    (analysis?.zakazka?.nazev && String(analysis.zakazka.nazev)) || input.tenderId;

  // Položky: multi-product (polozky_match) i legacy single-product.
  const items: Record<string, any>[] = Array.isArray(match?.polozky_match)
    ? match!.polozky_match
    : [];

  let nepotvrzene_ceny = 0;
  let hard_flagy = 0;
  let celkova = 0;
  let maCenu = false;

  if (items.length > 0) {
    for (const item of items) {
      if (!isConfirmed(item?.cenova_uprava)) nepotvrzene_ceny++;
      if (Array.isArray(item?.sanity_flags)) {
        hard_flagy += item.sanity_flags.filter((f: any) => f?.level === 'hard').length;
      }
      const unit = itemUnitPriceSDph(item);
      if (unit != null) {
        const mnozstvi =
          typeof item?.mnozstvi === 'number' && Number.isFinite(item.mnozstvi) ? item.mnozstvi : 1;
        celkova += unit * mnozstvi;
        maCenu = true;
      }
    }
  } else if (match) {
    // Legacy single-product tvar (kandidati + cenova_uprava na kořeni).
    if (!isConfirmed(match.cenova_uprava)) nepotvrzene_ceny++;
    const unit = itemUnitPriceSDph(match);
    if (unit != null) {
      celkova += unit;
      maCenu = true;
    }
  }

  const checks: any[] = Array.isArray(validation?.checks) ? validation!.checks : [];
  const validation_fails = checks.filter((c: any) => c?.status === 'fail').length;
  const ready_to_submit = validation?.ready_to_submit === true;

  return {
    tender_id: input.tenderId,
    nazev,
    crm_stav: input.crmStav ?? null,
    nepotvrzene_ceny,
    hard_flagy,
    validation_fails,
    ready_to_submit,
    celkova_cena_s_dph: maCenu ? Math.round(celkova) : null,
    data_error: (input.dataErrors?.length ?? 0) > 0,
    data_error_files: input.dataErrors ?? [],
  };
}

// Zakázka vyžaduje akci operátora při vadných datech, nepotvrzené ceně, HARD flagu nebo fail checku.
export function needsAction(entry: InboxEntry): boolean {
  return entry.data_error || entry.nepotvrzene_ceny > 0 || entry.hard_flagy > 0 || entry.validation_fails > 0;
}

// Sestaví celý inbox: spočítá řádky a nechá jen ty, které čekají na akci,
// seřazené "nejnaléhavější první" (vadná data > hard flagy > fails > nepotvrzené ceny).
export function buildInbox(inputs: InboxTenderInput[]): InboxEntry[] {
  return inputs
    .map(computeInboxEntry)
    .filter(needsAction)
    .sort((a, b) => {
      if (a.data_error !== b.data_error) return a.data_error ? -1 : 1;
      if (b.hard_flagy !== a.hard_flagy) return b.hard_flagy - a.hard_flagy;
      if (b.validation_fails !== a.validation_fails) return b.validation_fails - a.validation_fails;
      return b.nepotvrzene_ceny - a.nepotvrzene_ceny;
    });
}
