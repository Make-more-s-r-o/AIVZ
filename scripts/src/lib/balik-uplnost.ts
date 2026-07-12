import { createHash } from 'node:crypto';

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
  zdroj?: 'vygenerovano' | 'zakazka';
  poznamka?: string;
}

export interface BalikPotvrzeni {
  potvrdil: string;
  at: string;
  soubor: string;
  sha256: string;
  pozadavek_fingerprint: string;
  zamitnuto?: false;
}

export interface BalikZamitnuti {
  zamitnuto: true;
  duvod: string;
  kdo: string;
  at: string;
  pozadavek_fingerprint: string;
}

export interface PrevzetiUplnosti {
  prevzato: true;
  duvod: string;
  kdo: string;
  at: string;
}

export type BalikAudit = BalikPotvrzeni | BalikZamitnuti | PrevzetiUplnosti;
export type BalikPotvrzeniMap = Record<string, BalikAudit>;

type Soubor = string | { filename: string };

export function normalizeNazev(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function pozadavekFingerprint(value: PozadovanyDokument): string {
  const canonical = JSON.stringify([normalizeNazev(value.nazev), value.typ ?? 'jine', value.povinny]);
  return createHash('sha256').update(canonical).digest('hex');
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

function tokeny(value: string): string[] { return normalizeNazev(value).split(' ').filter(Boolean); }
function stejneTokeny(a: string, b: string): boolean {
  const aa = tokeny(a); const bb = tokeny(b);
  return aa.length === bb.length && aa.every((token, index) => token === bb[index]);
}
function podobneTokeny(a: string, b: string): boolean {
  const aa = tokeny(a); const bb = tokeny(b);
  const cislaA = aa.filter((x) => /^\d+$/.test(x));
  const cislaB = bb.filter((x) => /^\d+$/.test(x));
  if (cislaA.length > 0 && (cislaA.length !== cislaB.length || cislaA.some((x, i) => x !== cislaB[i]))) return false;
  const words = new Set(aa.filter((x) => x.length > 2 && !/^\d+$/.test(x)));
  return bb.some((x) => words.has(x));
}

/** Checklist pracuje jen s obsahem plánovaného ZIPu. Manifest firmy slouží pouze
 * k vysvětlení, že známý doklad nebyl do příloh zakázky skutečně zkopírován. */
export function buildBalikChecklist(input: {
  pozadovaneDokumenty: PozadovanyDokument[];
  vygenerovaneSoubory: Soubor[];
  prilohyZakazky: Soubor[];
  firemniDoklady: Soubor[];
}): BalikChecklistItem[] {
  const candidates = [
    ...input.vygenerovaneSoubory.map((file) => ({ file, zdroj: 'vygenerovano' as const, prefix: '' })),
    ...input.prilohyZakazky.map((file) => ({ file, zdroj: 'zakazka' as const, prefix: 'prilohy/' })),
  ].map(({ file, zdroj, prefix }, index) => {
    const filename = typeof file === 'string' ? file : file.filename;
    return { id: index, filename, cesta: `${prefix}${filename}`, typ: typSouboru(filename), zdroj };
  });
  const company = input.firemniDoklady.map((file) => typeof file === 'string' ? file : file.filename);
  const used = new Set<number>();
  const occurrences = new Map<string, number>();

  return input.pozadovaneDokumenty.map((requirement) => {
    const normalized = normalizeNazev(requirement.nazev);
    const baseKey = `${requirement.typ ?? 'jine'}:${normalized}`;
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    const klic = occurrence === 0 ? baseKey : `${baseKey}:${occurrence + 1}`;
    const typed = requirement.typ && requirement.typ !== 'jine'
      ? candidates.find((candidate) => candidate.typ === requirement.typ) : undefined;
    const exact = candidates.find((candidate) => stejneTokeny(candidate.filename, requirement.nazev));
    const exactBezKonfliktu = requirement.typ && requirement.typ !== 'jine' && exact?.typ && exact.typ !== requirement.typ
      ? undefined : exact;
    const match = typed ?? exactBezKonfliktu;
    if (match) {
      if (used.has(match.id)) return { ...requirement, klic, status: 'nejiste', soubor: match.cesta, zdroj: match.zdroj,
        poznamka: 'Soubor už pokrývá jiný požadavek; potvrďte, že obsahuje oba dokumenty.' };
      used.add(match.id);
      return { ...requirement, klic, status: 'pokryto', soubor: match.cesta, zdroj: match.zdroj };
    }
    const fuzzy = candidates.find((candidate) => podobneTokeny(normalized, candidate.filename));
    if (fuzzy) return { ...requirement, klic, status: 'nejiste', soubor: fuzzy.cesta, zdroj: fuzzy.zdroj };
    const firmaMatch = company.some((filename) =>
      (requirement.typ && requirement.typ !== 'jine' && typSouboru(filename) === requirement.typ)
      || stejneTokeny(filename, requirement.nazev));
    if (firmaMatch) return { ...requirement, klic, status: 'chybi',
      poznamka: 'doklad je v Nastavení firmy, ale není přiložen k zakázce' };
    if (candidates.length > 0 && (!requirement.typ || requirement.typ === 'jine')) {
      const candidate = candidates.find((x) => !used.has(x.id)) ?? candidates[0];
      return { ...requirement, klic, status: 'nejiste', soubor: candidate.cesta, zdroj: candidate.zdroj };
    }
    return { ...requirement, klic, status: 'chybi' };
  });
}

export function isValidBalikPotvrzeni(value: unknown): value is BalikPotvrzeni {
  if (!value || typeof value !== 'object') return false;
  const x = value as Record<string, unknown>;
  return typeof x.potvrdil === 'string' && !!x.potvrdil.trim() && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at))
    && typeof x.soubor === 'string' && !!x.soubor && typeof x.sha256 === 'string' && /^[a-f0-9]{64}$/.test(x.sha256)
    && typeof x.pozadavek_fingerprint === 'string' && /^[a-f0-9]{64}$/.test(x.pozadavek_fingerprint);
}

export function isValidBalikZamitnuti(value: unknown, requirement: PozadovanyDokument): value is BalikZamitnuti {
  const x = value as Partial<BalikZamitnuti> | null;
  return !!x && x.zamitnuto === true && typeof x.duvod === 'string' && x.duvod.trim().length >= 10
    && typeof x.kdo === 'string' && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at))
    && x.pozadavek_fingerprint === pozadavekFingerprint(requirement);
}

export function isValidPrevzetiUplnosti(value: unknown): value is PrevzetiUplnosti {
  const x = value as Partial<PrevzetiUplnosti> | null;
  return !!x && x.prevzato === true && typeof x.duvod === 'string' && x.duvod.trim().length >= 10
    && typeof x.kdo === 'string' && !!x.kdo && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at));
}

export function createBalikPotvrzeni(actor: { name?: string; email?: string; sub?: string }, soubor: string, sha256: string,
  requirement: PozadovanyDokument, at = new Date()): BalikPotvrzeni {
  const potvrdil = actor.name || actor.email || actor.sub;
  if (!potvrdil) throw new Error('Chybí identita přihlášeného uživatele.');
  return { potvrdil, at: at.toISOString(), soubor, sha256, pozadavek_fingerprint: pozadavekFingerprint(requirement) };
}
