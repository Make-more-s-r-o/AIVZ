/**
 * Company store — multi-company CRUD with default qualification documents.
 *
 * Data layout:
 *   config/companies/
 *     {id}.json          ← company data
 *     {id}/documents/    ← default qualification docs for this company
 */
import { readFile, writeFile, readdir, mkdir, rm, copyFile, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import type { DocSlotType, DocSlotEntry, DocManifest } from './doc-slots.js';
import { DOC_SLOTS } from './doc-slots.js';

const ROOT = new URL('../../../', import.meta.url).pathname;
const COMPANIES_DIR = join(ROOT, 'config', 'companies');
const LEGACY_PATH = join(ROOT, 'config', 'company.json');

export interface CompanyData {
  id: string;
  nazev: string;
  ico: string;
  dic: string;
  sidlo: string;
  ucet?: string;
  iban?: string;
  bic?: string;
  datova_schranka?: string;
  rejstrik?: string;
  jednajici_osoba: string;
  telefon?: string;
  email?: string;
  obory?: string[];
  keyword_filters?: Record<string, string[]>;
  created_at: string;
  updated_at: string;
}

/** One-time migration from config/company.json → config/companies/default.json */
export async function migrateFromLegacy(): Promise<void> {
  await mkdir(COMPANIES_DIR, { recursive: true });
  const defaultPath = join(COMPANIES_DIR, 'default.json');

  // Skip if already migrated
  if (existsSync(defaultPath)) return;

  // Skip if no legacy file
  if (!existsSync(LEGACY_PATH)) return;

  try {
    const legacy = JSON.parse(await readFile(LEGACY_PATH, 'utf-8'));
    const now = new Date().toISOString();
    const company: CompanyData = {
      id: 'default',
      nazev: legacy.nazev || '',
      ico: legacy.ico || '',
      dic: legacy.dic || '',
      sidlo: legacy.sidlo || '',
      ucet: legacy.ucet,
      iban: legacy.iban,
      bic: legacy.bic,
      datova_schranka: legacy.datova_schranka,
      rejstrik: legacy.rejstrik,
      jednajici_osoba: legacy.jednajici_osoba || '',
      telefon: legacy.telefon,
      email: legacy.email,
      obory: legacy.obory,
      keyword_filters: legacy.keyword_filters,
      created_at: now,
      updated_at: now,
    };
    await writeFile(defaultPath, JSON.stringify(company, null, 2), 'utf-8');
    await mkdir(join(COMPANIES_DIR, 'default', 'documents'), { recursive: true });
    console.log('Company store: migrated legacy company.json → companies/default.json');
  } catch (err) {
    console.error('Company store: migration failed:', err);
  }
}

export async function getAllCompanies(): Promise<CompanyData[]> {
  await mkdir(COMPANIES_DIR, { recursive: true });
  const files = await readdir(COMPANIES_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));
  const companies: CompanyData[] = [];
  for (const f of jsonFiles) {
    try {
      const data = JSON.parse(await readFile(join(COMPANIES_DIR, f), 'utf-8'));
      companies.push(data);
    } catch {}
  }
  return companies.sort((a, b) => a.nazev.localeCompare(b.nazev, 'cs'));
}

export async function getCompany(id: string): Promise<CompanyData | null> {
  try {
    return JSON.parse(await readFile(join(COMPANIES_DIR, `${id}.json`), 'utf-8'));
  } catch {
    return null;
  }
}

export async function createCompany(data: Omit<CompanyData, 'id' | 'created_at' | 'updated_at'>): Promise<CompanyData> {
  const id = randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const company: CompanyData = { ...data, id, created_at: now, updated_at: now };
  await mkdir(COMPANIES_DIR, { recursive: true });
  await writeFile(join(COMPANIES_DIR, `${id}.json`), JSON.stringify(company, null, 2), 'utf-8');
  await mkdir(join(COMPANIES_DIR, id, 'documents'), { recursive: true });
  return company;
}

export async function updateCompany(id: string, data: Partial<CompanyData>): Promise<CompanyData | null> {
  const existing = await getCompany(id);
  if (!existing) return null;
  const updated: CompanyData = {
    ...existing,
    ...data,
    id, // prevent id change
    created_at: existing.created_at,
    updated_at: new Date().toISOString(),
  };
  await writeFile(join(COMPANIES_DIR, `${id}.json`), JSON.stringify(updated, null, 2), 'utf-8');
  return updated;
}

export async function deleteCompany(id: string): Promise<boolean> {
  try {
    await rm(join(COMPANIES_DIR, `${id}.json`), { force: true });
    await rm(join(COMPANIES_DIR, id), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function getCompanyDocuments(id: string): Promise<string[]> {
  const dir = join(COMPANIES_DIR, id, 'documents');
  try {
    const files = await readdir(dir);
    return files.filter(f => !f.startsWith('.'));
  } catch {
    return [];
  }
}

export async function deleteCompanyDocument(id: string, filename: string): Promise<boolean> {
  try {
    await rm(join(COMPANIES_DIR, id, 'documents', filename), { force: true });
    return true;
  } catch {
    return false;
  }
}

export function getCompanyDocumentsDir(id: string): string {
  return join(COMPANIES_DIR, id, 'documents');
}

// --- Document manifest (slot-based qualification docs) ---

function manifestPath(companyId: string): string {
  return join(COMPANIES_DIR, companyId, 'documents.json');
}

/** Read manifest, auto-migrate legacy files to 'ostatni' slot if needed */
export async function getDocManifest(companyId: string): Promise<DocManifest> {
  const mPath = manifestPath(companyId);
  try {
    return JSON.parse(await readFile(mPath, 'utf-8'));
  } catch {
    // No manifest — auto-migrate existing files to 'ostatni'
    const dir = join(COMPANIES_DIR, companyId, 'documents');
    let files: string[] = [];
    try {
      files = (await readdir(dir)).filter(f => !f.startsWith('.'));
    } catch {}
    const now = new Date().toISOString();
    const manifest: DocManifest = {
      version: 1,
      entries: files.map(f => ({ slot: 'ostatni' as DocSlotType, filename: f, uploadedAt: now })),
    };
    await mkdir(join(COMPANIES_DIR, companyId), { recursive: true });
    await writeFile(mPath, JSON.stringify(manifest, null, 2), 'utf-8');
    return manifest;
  }
}

export async function saveDocManifest(companyId: string, manifest: DocManifest): Promise<void> {
  await writeFile(manifestPath(companyId), JSON.stringify(manifest, null, 2), 'utf-8');
}

/** Add a file to a slot. For fixed slots (multi=false), removes previous file first. */
export async function addDocToSlot(companyId: string, slot: DocSlotType, filename: string): Promise<DocManifest> {
  const manifest = await getDocManifest(companyId);
  const slotDef = DOC_SLOTS.find(s => s.type === slot);
  const isMulti = slotDef?.multi ?? false;

  if (!isMulti) {
    // Remove existing file for this slot
    const existing = manifest.entries.filter(e => e.slot === slot);
    for (const e of existing) {
      try {
        await unlink(join(COMPANIES_DIR, companyId, 'documents', e.filename));
      } catch {}
    }
    manifest.entries = manifest.entries.filter(e => e.slot !== slot);
  }

  manifest.entries.push({ slot, filename, uploadedAt: new Date().toISOString() });
  await saveDocManifest(companyId, manifest);
  return manifest;
}

/** Remove a file from a slot (deletes from disk too) */
export async function removeDocFromSlot(companyId: string, slot: DocSlotType, filename: string): Promise<DocManifest> {
  const manifest = await getDocManifest(companyId);
  manifest.entries = manifest.entries.filter(e => !(e.slot === slot && e.filename === filename));
  try {
    await unlink(join(COMPANIES_DIR, companyId, 'documents', filename));
  } catch {}
  await saveDocManifest(companyId, manifest);
  return manifest;
}

/** Map kvalifikace requirements to document slot types */
export function mapQualifikaceToSlots(
  kvalifikace: Array<{ typ: string; popis: string }>
): DocSlotType[] {
  const slots = new Set<DocSlotType>();

  for (const kv of kvalifikace) {
    const typ = kv.typ.toLowerCase();
    const popis = kv.popis.toLowerCase();
    const combined = `${typ} ${popis}`;

    if (typ.includes('zakladni') || typ.includes('základní')) {
      slots.add('rejstrik_trestu');
      slots.add('potvrzeni_fu');
      slots.add('potvrzeni_ossz');
    }
    if (typ.includes('profesni') || typ.includes('profesní')) {
      slots.add('vypis_or');
      slots.add('profesni_opravneni');
    }
    // Keyword matching in popis
    if (combined.includes('obchodní rejstřík') || combined.includes('obchodního rejstříku')) {
      slots.add('vypis_or');
    }
    if (combined.includes('trestů') || combined.includes('rejstřík trestů')) {
      slots.add('rejstrik_trestu');
    }
    if (combined.includes('finančn') || combined.includes('daňov') || combined.includes('nedoplatk')) {
      slots.add('potvrzeni_fu');
    }
    if (combined.includes('ossz') || combined.includes('sociální') || combined.includes('pojistn')) {
      slots.add('potvrzeni_ossz');
    }
    if (combined.includes('oprávnění') || combined.includes('živnostens') || combined.includes('autorizac')) {
      slots.add('profesni_opravneni');
    }
  }

  return [...slots];
}

/** Copy company's default qualification docs to tender's prilohy/ dir */
export async function copyCompanyDocsToTender(
  companyId: string,
  tenderId: string,
  requiredSlots?: DocSlotType[],
): Promise<{ copied: string[]; missing: DocSlotType[] }> {
  const srcDir = join(COMPANIES_DIR, companyId, 'documents');
  const destDir = join(ROOT, 'output', tenderId, 'prilohy');
  await mkdir(destDir, { recursive: true });

  const manifest = await getDocManifest(companyId);

  // Filter entries based on required slots
  let entriesToCopy = manifest.entries;
  const missing: DocSlotType[] = [];

  if (requiredSlots && requiredSlots.length > 0) {
    const slotsWithOstatni = new Set([...requiredSlots, 'ostatni' as DocSlotType]);
    entriesToCopy = manifest.entries.filter(e => slotsWithOstatni.has(e.slot));

    // Check for missing required slots
    for (const slot of requiredSlots) {
      if (!manifest.entries.some(e => e.slot === slot)) {
        missing.push(slot);
      }
    }
  }

  const copied: string[] = [];
  for (const entry of entriesToCopy) {
    try {
      await copyFile(join(srcDir, entry.filename), join(destDir, entry.filename));
      copied.push(entry.filename);
    } catch {}
  }

  return { copied, missing };
}

/** Get company for a tender (from tender-meta.json) */
export async function getTenderCompanyId(tenderId: string): Promise<string | null> {
  try {
    const metaPath = join(ROOT, 'output', tenderId, 'tender-meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    return meta.company_id || null;
  } catch {
    return null;
  }
}
