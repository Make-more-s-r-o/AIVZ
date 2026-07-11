import { DOC_SLOTS, docExpiryStatus, type DocManifest, type DocSlotType } from './doc-slots.js';
import { mapQualifikaceToSlots } from './company-store.js';

export type PrilohaChecklistStatus = 'nahrano' | 'chybi' | 'po_platnosti' | 'expiruje';

export interface KvalifikacniPozadavek {
  typ?: string;
  popis?: string;
  povinny?: boolean;
}

export interface PrilohaChecklistItem {
  slot: DocSlotType;
  label: string;
  status: PrilohaChecklistStatus;
  povinny: boolean;
  zdroj?: 'firma' | 'zakazka';
  filename?: string;
  platnost_do?: string | null;
  poznamka?: string;
}

export interface KvalifikaceVyjimka {
  duvod: string;
  schvalil: string;
  at: string;
}

export type KvalifikaceVyjimky = Partial<Record<DocSlotType, KvalifikaceVyjimka>>;

/**
 * Čistý checklist nad analýzou, manifestem a názvy příloh zakázky.
 * Pokud analýza neobsahuje explicitní `povinny`, považujeme požadavek konzervativně
 * za povinný: nejasnost v AI výstupu nesmí umožnit formálně neúplné podání.
 */
export function buildPrilohaChecklist(input: {
  kvalifikace: KvalifikacniPozadavek[];
  manifest: DocManifest;
  attachments: string[];
  now?: Date;
}): PrilohaChecklistItem[] {
  const bySlot = new Map<DocSlotType, { povinny: boolean }>();
  for (const pozadavek of input.kvalifikace) {
    const normalized = { typ: pozadavek.typ ?? '', popis: pozadavek.popis ?? '' };
    for (const slot of mapQualifikaceToSlots([normalized])) {
      const povinny = pozadavek.povinny !== false;
      const previous = bySlot.get(slot);
      bySlot.set(slot, { povinny: (previous?.povinny ?? false) || povinny });
    }
  }

  return [...bySlot.entries()].map(([slot, requirement]) => {
    const label = DOC_SLOTS.find((candidate) => candidate.type === slot)?.label ?? slot;
    const companyEntry = input.manifest.entries.find((entry) => entry.slot === slot);
    const normalizedSlot = slot.replace(/_/g, '');
    const attachment = input.attachments.find((filename) =>
      filename === companyEntry?.filename || filename.toLowerCase().replace(/[_\s-]/g, '').includes(normalizedSlot));
    const filename = attachment ?? companyEntry?.filename;
    const zdroj = attachment ? 'zakazka' as const : companyEntry ? 'firma' as const : undefined;

    if (!filename || !zdroj) return { slot, label, status: 'chybi', povinny: requirement.povinny };
    const expiry = companyEntry ? docExpiryStatus(companyEntry.platnost_do, input.now) : 'nezadano';
    if (expiry === 'expirovany') {
      return { slot, label, status: 'po_platnosti', povinny: requirement.povinny, zdroj, filename,
        platnost_do: companyEntry?.platnost_do ?? null, poznamka: 'nahraný doklad je po platnosti' };
    }
    if (expiry === 'expiruje') {
      return { slot, label, status: 'expiruje', povinny: requirement.povinny, zdroj, filename,
        platnost_do: companyEntry?.platnost_do ?? null, poznamka: 'doklad brzy expiruje' };
    }
    return { slot, label, status: 'nahrano', povinny: requirement.povinny, zdroj, filename,
      ...(companyEntry?.platnost_do ? { platnost_do: companyEntry.platnost_do } : {}) };
  });
}

export function isValidKvalifikaceVyjimka(value: unknown): value is KvalifikaceVyjimka {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.duvod === 'string' && item.duvod.trim().length >= 10
    && typeof item.schvalil === 'string' && item.schvalil.trim().length > 0
    && typeof item.at === 'string' && !Number.isNaN(Date.parse(item.at));
}

export function validateVyjimkaInput(value: unknown): { slot: DocSlotType; duvod: string } | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const slot = body.slot;
  const duvod = typeof body.duvod === 'string' ? body.duvod.trim() : '';
  if (!DOC_SLOTS.some((candidate) => candidate.type === slot) || duvod.length < 10) return null;
  return { slot: slot as DocSlotType, duvod };
}
