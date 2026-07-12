export type TypPozadovanehoDokumentu =
  | 'kryci_list' | 'cestne_prohlaseni' | 'soupis' | 'smlouva'
  | 'seznam_poddodavatelu' | 'jine';

export interface PozadovanyDokument {
  nazev: string;
  popis?: string;
  povinny: boolean;
  typ?: TypPozadovanehoDokumentu;
}

export type BalikChecklistStatus = 'pokryto' | 'chybi' | 'nejiste';

export interface BalikChecklistItem extends PozadovanyDokument {
  klic: string;
  status: BalikChecklistStatus;
  soubor?: string;
  zdroj?: 'vygenerovano' | 'zakazka' | 'firma';
}

export interface BalikPotvrzeni {
  potvrdil: string;
  at: string;
}

export type BalikPotvrzeniMap = Record<string, BalikPotvrzeni>;

type Soubor = string | { filename: string };

/** Normalizace je záměrně exportovaná pro deterministické testy a stabilní klíče. */
export function normalizeNazev(value: string): string {
  return value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function typSouboru(filename: string): Exclude<TypPozadovanehoDokumentu, 'jine'> | undefined {
  const n = normalizeNazev(filename);
  if (/\bkryci list\b/.test(n)) return 'kryci_list';
  if (/\bcestne prohlaseni\b/.test(n)) return 'cestne_prohlaseni';
  if (/\b(soupis|vykaz vymer|polozkovy rozpocet)\b/.test(n)) return 'soupis';
  if (/\b(smlouva|navrh smlouvy)\b/.test(n)) return 'smlouva';
  if (/\bseznam poddodavatelu\b/.test(n)) return 'seznam_poddodavatelu';
  return undefined;
}

function spolecnaSlova(a: string, b: string): number {
  const aa = new Set(a.split(' ').filter((word) => word.length > 2));
  return b.split(' ').filter((word) => aa.has(word)).length;
}

/**
 * Čistý checklist úplnosti. Typové párování má přednost před názvem; pouze přesná
 * typová či názvová shoda je „pokryto“. Přibližná shoda zůstává „nejistá“ a musí
 * ji potvrdit člověk. Funkce sama nikdy nevytváří auditované potvrzení.
 */
export function buildBalikChecklist(input: {
  pozadovaneDokumenty: PozadovanyDokument[];
  vygenerovaneSoubory: Soubor[];
  prilohyZakazky: Soubor[];
  firemniDoklady: Soubor[];
}): BalikChecklistItem[] {
  const candidates = [
    ...input.vygenerovaneSoubory.map((file) => ({ file, zdroj: 'vygenerovano' as const })),
    ...input.prilohyZakazky.map((file) => ({ file, zdroj: 'zakazka' as const })),
    ...input.firemniDoklady.map((file) => ({ file, zdroj: 'firma' as const })),
  ].map(({ file, zdroj }) => {
    const filename = typeof file === 'string' ? file : file.filename;
    return { filename, normalized: normalizeNazev(filename), typ: typSouboru(filename), zdroj };
  });
  const occurrences = new Map<string, number>();

  return input.pozadovaneDokumenty.map((requirement) => {
    const normalized = normalizeNazev(requirement.nazev);
    const baseKey = `${requirement.typ ?? 'jine'}:${normalized}`;
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    const klic = occurrence === 0 ? baseKey : `${baseKey}:${occurrence + 1}`;

    const typed = requirement.typ && requirement.typ !== 'jine'
      ? candidates.find((candidate) => candidate.typ === requirement.typ)
      : undefined;
    const exact = candidates.find((candidate) =>
      candidate.normalized === normalized
      || (normalized.length >= 6 && candidate.normalized.includes(normalized)));
    // Je-li explicitní typ v konfliktu s typem nalezeným z názvu souboru, nesmí
    // samotný název konflikt automaticky prohlásit za pokrytý.
    const exactBezKonfliktu = requirement.typ && requirement.typ !== 'jine'
      && exact?.typ && exact.typ !== requirement.typ ? undefined : exact;
    const match = typed ?? exactBezKonfliktu;
    if (match) return { ...requirement, klic, status: 'pokryto', soubor: match.filename, zdroj: match.zdroj };

    if (exact) return { ...requirement, klic, status: 'nejiste', soubor: exact.filename, zdroj: exact.zdroj };

    if (candidates.length === 0) return { ...requirement, klic, status: 'chybi' };
    const fuzzy = candidates.find((candidate) => spolecnaSlova(normalized, candidate.normalized) >= 1);
    if (fuzzy) return { ...requirement, klic, status: 'nejiste', soubor: fuzzy.filename, zdroj: fuzzy.zdroj };
    return { ...requirement, klic, status: requirement.typ && requirement.typ !== 'jine' ? 'chybi' : 'nejiste' };
  });
}

export function isValidBalikPotvrzeni(value: unknown): value is BalikPotvrzeni {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.potvrdil === 'string' && item.potvrdil.trim().length > 0
    && typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at));
}

/** Serverová továrna: tělo požadavku se sem neposílá, identita je jen z JWT principalu. */
export function createBalikPotvrzeni(actor: { name?: string; email?: string; sub?: string }, at = new Date()): BalikPotvrzeni {
  const potvrdil = actor.name || actor.email || actor.sub;
  if (!potvrdil) throw new Error('Chybí identita přihlášeného uživatele.');
  return { potvrdil, at: at.toISOString() };
}
