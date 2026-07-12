/**
 * Document slot types for company qualification docs.
 * Mirrors packages/shared/constants.ts — keep in sync.
 */

export const DOC_SLOTS = [
  { type: 'vypis_or', label: 'Výpis z obchodního rejstříku', multi: false, bezne_pozadovan: true, typicka_platnost_dnu: 90, popis: 'Výpis z obchodního rejstříku, ne starší 3 měsíců — justice.cz nebo Czech POINT.' },
  { type: 'rejstrik_trestu', label: 'Výpis z rejstříku trestů', multi: false, bezne_pozadovan: true, typicka_platnost_dnu: 90, popis: 'Výpis z evidence Rejstříku trestů, ne starší 3 měsíců — Czech POINT nebo Portál občana.' },
  { type: 'potvrzeni_fu', label: 'Potvrzení finančního úřadu', multi: false, bezne_pozadovan: true, typicka_platnost_dnu: 90, popis: 'Potvrzení o neexistenci daňových nedoplatků, ne starší 3 měsíců — vyžádejte u příslušného finančního úřadu nebo přes datovou schránku.' },
  { type: 'potvrzeni_ossz', label: 'Potvrzení OSSZ', multi: false, bezne_pozadovan: true, typicka_platnost_dnu: 90, popis: 'Potvrzení o neexistenci nedoplatků na sociálním zabezpečení, ne starší 3 měsíců — vyžádejte u příslušné OSSZ nebo přes ePortál ČSSZ.' },
  { type: 'profesni_opravneni', label: 'Profesní oprávnění', multi: false, bezne_pozadovan: false, typicka_platnost_dnu: null, popis: 'Doklad o oprávnění vykonávat regulovanou činnost — získáte u příslušné komory, úřadu nebo profesního registru.' },
  { type: 'ostatni', label: 'Ostatní', multi: true, bezne_pozadovan: false, typicka_platnost_dnu: null, popis: 'Další kvalifikační doklady podle konkrétní zakázky — zdroj určuje zadávací dokumentace.' },
] as const;

export type DocSlotType = (typeof DOC_SLOTS)[number]['type'];

export interface DocSlotEntry {
  slot: DocSlotType;
  filename: string;
  uploadedAt: string;  // ISO datetime
  /**
   * Datum platnosti dokladu (ISO YYYY-MM-DD). Firemní kvalifikační doklady
   * (výpisy z rejstříků, potvrzení) mají omezenou platnost (typicky 90 dní).
   * Volitelné — staré manifesty pole nemají (zpětná kompatibilita → 'nezadano').
   */
  platnost_do?: string | null;
}

export interface DocManifest {
  version: number;
  entries: DocSlotEntry[];
}

export interface CompanyReadinessItem {
  slot: DocSlotType;
  label: string;
  popis: string;
}

export interface CompanyReadiness {
  pripraveno: number;
  celkem: number;
  chybi: CompanyReadinessItem[];
  expirovane: CompanyReadinessItem[];
  bez_platnosti: CompanyReadinessItem[];
}

// --- Sledování platnosti dokladů ---

/** Kolik dní před koncem platnosti se doklad hlásí jako „expiruje" (varování). */
export const EXPIRY_WARNING_DAYS = 30;

export type DocExpiryStatus = 'ok' | 'expiruje' | 'expirovany' | 'nezadano';

/**
 * Rozparsuje kalendářní datum ve formátu YYYY-MM-DD (další znaky, např. čas, se ignorují).
 * Vrátí null pro chybný formát i pro neexistující datum (např. 2026-02-30).
 */
export function parseCivilDate(
  s: string | null | undefined,
): { y: number; m: number; d: number } | null {
  if (!s) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  // Round-trip přes Date odchytí neexistující datum (den/měsíc mimo rozsah).
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** True, pokud je řetězec platné datum ve formátu přesně YYYY-MM-DD. */
export function isValidIsoDateString(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) && parseCivilDate(s) !== null;
}

/**
 * Počet dní od `now` do konce platnosti (kladné = ještě platí, 0 = poslední den,
 * záporné = po platnosti). Porovnává se na úrovni kalendářních dnů, čas se ignoruje.
 * Vrátí null, pokud platnost není zadaná nebo je datum nevalidní.
 */
export function daysUntilExpiry(
  platnostDo: string | null | undefined,
  now: Date = new Date(),
): number | null {
  const p = parseCivilDate(platnostDo);
  if (!p) return null;
  // Server může běžet v UTC nebo jiném systémovém TZ. Právní platnost dokladu se
  // vyhodnocuje podle českého kalendářního dne, včetně přechodů letní/zimní čas.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value);
  const today = Date.UTC(part('year'), part('month') - 1, part('day'));
  const exp = Date.UTC(p.y, p.m - 1, p.d);
  return Math.round((exp - today) / 86_400_000);
}

/**
 * Stav platnosti dokladu vůči datu `now`:
 *  - 'nezadano'   — platnost není vyplněná (nebo nevalidní datum)
 *  - 'expirovany' — konec platnosti už proběhl (< dnešek)
 *  - 'expiruje'   — konec platnosti je dnes až za ≤ EXPIRY_WARNING_DAYS dní
 *  - 'ok'         — konec platnosti je za více než EXPIRY_WARNING_DAYS dní
 */
export function docExpiryStatus(
  platnostDo: string | null | undefined,
  now: Date = new Date(),
): DocExpiryStatus {
  const days = daysUntilExpiry(platnostDo, now);
  if (days == null) return 'nezadano';
  if (days < 0) return 'expirovany';
  if (days <= EXPIRY_WARNING_DAYS) return 'expiruje';
  return 'ok';
}

/** Vyhodnotí standardní sadu bez práce se soubory; expirující doklad je ještě platný. */
export function computeCompanyReadiness(
  entries: readonly DocSlotEntry[],
  now: Date = new Date(),
): CompanyReadiness {
  const required = DOC_SLOTS.filter((slot) => slot.bezne_pozadovan);
  const result: CompanyReadiness = {
    pripraveno: 0,
    celkem: required.length,
    chybi: [],
    expirovane: [],
    bez_platnosti: [],
  };

  for (const slot of required) {
    const item = { slot: slot.type, label: slot.label, popis: slot.popis };
    const slotEntries = entries.filter((entry) => entry.slot === slot.type);
    if (slotEntries.length === 0) {
      result.chybi.push(item);
      continue;
    }
    const statuses = slotEntries.map((entry) => docExpiryStatus(entry.platnost_do, now));
    if (statuses.some((status) => status === 'ok' || status === 'expiruje')) {
      result.pripraveno += 1;
    } else if (statuses.some((status) => status === 'nezadano')) {
      result.bez_platnosti.push(item);
    } else {
      result.expirovane.push(item);
    }
  }
  return result;
}

// --- Checklist kvalifikačních příloh (čistá logika, sdílená s endpointem) ---

export interface ChecklistItemInput {
  slot: DocSlotType;
  label: string;
  /** Firemní doklad ve slotu (z manifestu) — nese platnost_do. Null = firma nemá. */
  companyEntry?: { filename: string; platnost_do?: string | null } | null;
  /** Název přílohy nahrané přímo k zakázce (má přednost před firmou). */
  attachmentFilename?: string | null;
  now?: Date;
}

export interface ChecklistItem {
  slot: DocSlotType;
  label: string;
  status: 'nahrano' | 'chybi';
  zdroj?: 'firma' | 'zakazka';
  filename?: string;
  platnost_do?: string | null;
  platnost_status?: DocExpiryStatus;
  poznamka?: string;
}

/**
 * Sestaví jednu položku checklistu příloh pro daný požadovaný slot.
 * Expirace se vyhodnocuje z firemního dokladu (přílohy zakázky jsou kopie bez
 * vlastní platnosti). Doklad po platnosti se hlásí jako 'chybi' s poznámkou.
 */
export function buildChecklistItem(input: ChecklistItemInput): ChecklistItem {
  const { slot, label, companyEntry, attachmentFilename, now } = input;
  const companyFile = companyEntry?.filename;
  const source: 'zakazka' | 'firma' | null =
    attachmentFilename ? 'zakazka' : companyFile ? 'firma' : null;
  const filename = attachmentFilename ?? companyFile;

  const platnostDo = companyEntry?.platnost_do ?? null;
  const expiryStatus: DocExpiryStatus = companyEntry
    ? docExpiryStatus(companyEntry.platnost_do, now)
    : 'nezadano';

  if (!source || !filename) {
    return { slot, label, status: 'chybi' };
  }

  // Doklad je po platnosti → hlásíme jako chybějící (je potřeba nahrát nový).
  if (expiryStatus === 'expirovany') {
    return {
      slot,
      label,
      status: 'chybi',
      zdroj: source,
      filename,
      platnost_do: platnostDo,
      platnost_status: expiryStatus,
      poznamka: 'nahraný doklad je po platnosti',
    };
  }

  const item: ChecklistItem = { slot, label, status: 'nahrano', zdroj: source, filename };
  if (platnostDo) {
    item.platnost_do = platnostDo;
    item.platnost_status = expiryStatus;
  }
  if (expiryStatus === 'expiruje') {
    const days = daysUntilExpiry(platnostDo, now);
    item.poznamka =
      days != null ? `doklad brzy expiruje (za ${days} dní)` : 'doklad brzy expiruje';
  }
  return item;
}
