/**
 * Company store — multi-company CRUD with default qualification documents.
 *
 * Data layout:
 *   config/companies/
 *     {id}.json          ← company data
 *     {id}/documents/    ← default qualification docs for this company
 */
import { readFile, writeFile, readdir, mkdir, rm, copyFile, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';

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

/** Copy company's default qualification docs to tender's prilohy/ dir */
export async function copyCompanyDocsToTender(companyId: string, tenderId: string): Promise<string[]> {
  const srcDir = join(COMPANIES_DIR, companyId, 'documents');
  const destDir = join(ROOT, 'output', tenderId, 'prilohy');
  await mkdir(destDir, { recursive: true });

  let files: string[];
  try {
    files = (await readdir(srcDir)).filter(f => !f.startsWith('.'));
  } catch {
    return [];
  }

  const copied: string[] = [];
  for (const f of files) {
    await copyFile(join(srcDir, f), join(destDir, f));
    copied.push(f);
  }
  return copied;
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
