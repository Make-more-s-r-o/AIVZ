import { getJwt, clearAuth } from './auth';

const API_BASE = '/api';

// Legacy token key — kept for backward compatibility (dev without JWT_SECRET)
const LEGACY_TOKEN_KEY = 'vz_api_token';

export function getAuthToken(): string | null {
  return localStorage.getItem(LEGACY_TOKEN_KEY);
}

export function setAuthToken(token: string): void {
  localStorage.setItem(LEGACY_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  // Prefer JWT, fallback to legacy static token
  const jwt = getJwt();
  if (jwt) return { Authorization: `Bearer ${jwt}` };
  const legacy = getAuthToken();
  return legacy ? { Authorization: `Bearer ${legacy}` } : {};
}

function getTokenParam(): string {
  const jwt = getJwt();
  if (jwt) return jwt;
  const legacy = getAuthToken();
  return legacy || '';
}

export interface TenderSummary {
  id: string;
  name?: string;
  inputFiles: string[];
  tenderId: string;
  steps: PipelineSteps;
}

export interface PipelineSteps {
  extract: StepStatus;
  analyze: StepStatus;
  match: StepStatus;
  generate: StepStatus;
  validate: StepStatus;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'error';
export type StepName = keyof PipelineSteps;

export interface JobStatus {
  id: string;
  tenderId: string;
  step: string;
  status: 'queued' | 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  logs: string[];
  totalLogLines: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    headers: authHeaders(),
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function getTenders(): Promise<TenderSummary[]> {
  return fetchJson('/tenders');
}

export async function uploadFiles(files: File[], tenderId?: string): Promise<TenderSummary> {
  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));

  const url = tenderId
    ? `${API_BASE}/tenders/${tenderId}/upload`
    : `${API_BASE}/tenders/upload`;

  const res = await fetch(url, { method: 'POST', body: formData, headers: authHeaders() });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export async function getTenderStatus(id: string) {
  return fetchJson<{ tenderId: string; steps: PipelineSteps }>(`/tenders/${id}/status`);
}

export async function getExtractedText(id: string) {
  return fetchJson<Record<string, unknown>>(`/tenders/${id}/extracted-text`);
}

export async function getAnalysis(id: string) {
  return fetchJson<Record<string, unknown>>(`/tenders/${id}/analysis`);
}

export async function getProductMatch(id: string) {
  return fetchJson<Record<string, unknown>>(`/tenders/${id}/product-match`);
}

export async function getDocuments(id: string): Promise<string[]> {
  return fetchJson(`/tenders/${id}/documents`);
}

export async function getValidation(id: string) {
  return fetchJson<Record<string, unknown>>(`/tenders/${id}/validation`);
}

/** Start a pipeline step — returns jobId for polling */
export async function runStep(id: string, step: StepName): Promise<{ jobId: string; status: string }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/run/${step}`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Step ${step} failed`);
  }
  return res.json();
}

/** Poll job status (with optional log offset for incremental logs) */
export async function getJobStatus(jobId: string, since?: number): Promise<JobStatus> {
  const params = since ? `?since=${since}` : '';
  return fetchJson(`/jobs/${jobId}${params}`);
}

export interface PriceOverrideData {
  nakupni_cena_bez_dph: number;
  nakupni_cena_s_dph: number;
  marze_procent: number;
  nabidkova_cena_bez_dph: number;
  nabidkova_cena_s_dph: number;
  potvrzeno: boolean;
  poznamka?: string;
}

export async function updatePriceOverride(id: string, data: PriceOverrideData): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/product-match/price`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to save price override');
  }
  return res.json();
}

export async function updateItemPriceOverride(
  id: string, itemIndex: number, data: PriceOverrideData
): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/product-match/price/${itemIndex}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to save item price override');
  }
  return res.json();
}

export async function deleteTender(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to delete tender');
  }
  return res.json();
}

export function getDocumentDownloadUrl(id: string, filename: string): string {
  const token = getTokenParam();
  const base = `${API_BASE}/tenders/${id}/documents/${encodeURIComponent(filename)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// Attachments (qualification documents)
export async function getAttachments(id: string): Promise<string[]> {
  return fetchJson(`/tenders/${id}/attachments`);
}

export async function uploadAttachments(id: string, files: File[]): Promise<{ uploaded: string[]; attachments: string[] }> {
  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));
  const res = await fetch(`${API_BASE}/tenders/${id}/attachments`, { method: 'POST', body: formData, headers: authHeaders() });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export async function deleteAttachment(id: string, filename: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/attachments/${encodeURIComponent(filename)}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error('Delete failed');
  return res.json();
}

export function getAttachmentDownloadUrl(id: string, filename: string): string {
  const token = getTokenParam();
  const base = `${API_BASE}/tenders/${id}/attachments/${encodeURIComponent(filename)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// --- Tender rename ---

export async function renameTender(id: string, name: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/name`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to rename tender');
  }
  return res.json();
}

// --- AI Cost ---

export interface CostSummary {
  entries: Array<{
    timestamp: string;
    step: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costCZK: number;
  }>;
  totalCZK: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byStep: Record<string, { costCZK: number; inputTokens: number; outputTokens: number; calls: number }>;
}

export async function getCost(id: string): Promise<CostSummary> {
  return fetchJson(`/tenders/${id}/cost`);
}

// --- ZIP downloads ---

export function getDocumentsZipUrl(id: string): string {
  const token = getTokenParam();
  const base = `${API_BASE}/tenders/${id}/download/documents`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

export function getBundleZipUrl(id: string): string {
  const token = getTokenParam();
  const base = `${API_BASE}/tenders/${id}/download/bundle`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// --- Parts (části zakázky) API ---

export interface Cast {
  id: string;
  nazev: string;
  predpokladana_hodnota?: number;
  pocet_polozek: number;
  soupis_filename?: string;
}

export interface PartsData {
  casti: Cast[];
  selected_parts: string[];
}

export async function getParts(id: string): Promise<PartsData> {
  return fetchJson(`/tenders/${id}/parts`);
}

export async function saveParts(id: string, selected: string[]): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/parts`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ selected_parts: selected }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to save parts selection');
  }
  return res.json();
}

// --- User management API ---

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export async function getUsers(): Promise<SafeUser[]> {
  return fetchJson('/users');
}

export async function createNewUser(email: string, name: string, password: string): Promise<SafeUser> {
  const res = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ email, name, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to create user');
  }
  return res.json();
}

export async function deleteUserById(userId: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to delete user');
  }
  return res.json();
}

// --- Company management API ---

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
  created_at: string;
  updated_at: string;
}

export async function getCompanies(): Promise<CompanyData[]> {
  return fetchJson('/companies');
}

export async function getCompanyById(id: string): Promise<CompanyData> {
  return fetchJson(`/companies/${id}`);
}

export async function createCompany(data: Partial<CompanyData>): Promise<CompanyData> {
  const res = await fetch(`${API_BASE}/companies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to create company');
  }
  return res.json();
}

export async function updateCompanyApi(id: string, data: Partial<CompanyData>): Promise<CompanyData> {
  const res = await fetch(`${API_BASE}/companies/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to update company');
  }
  return res.json();
}

export async function deleteCompanyApi(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/companies/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to delete company');
  }
  return res.json();
}

export async function getCompanyDocs(companyId: string): Promise<string[]> {
  return fetchJson(`/companies/${companyId}/documents`);
}

export async function uploadCompanyDocs(companyId: string, files: File[]): Promise<{ uploaded: string[]; documents: string[] }> {
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  const res = await fetch(`${API_BASE}/companies/${companyId}/documents`, {
    method: 'POST',
    body: formData,
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export async function deleteCompanyDoc(companyId: string, filename: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/companies/${companyId}/documents/${encodeURIComponent(filename)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('Delete failed');
  return res.json();
}

export async function setTenderCompany(tenderId: string, companyId: string): Promise<{ success: boolean; copied_documents: string[] }> {
  const res = await fetch(`${API_BASE}/tenders/${tenderId}/company`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ company_id: companyId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to set company');
  }
  return res.json();
}
