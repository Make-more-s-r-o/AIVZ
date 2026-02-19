const API_BASE = '/api';

export interface TenderSummary {
  id: string;
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`);
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

  const res = await fetch(url, { method: 'POST', body: formData });
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

export async function runStep(id: string, step: StepName) {
  const res = await fetch(`${API_BASE}/tenders/${id}/run/${step}`, {
    method: 'POST',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Step ${step} failed`);
  }
  return res.json();
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to save item price override');
  }
  return res.json();
}

export async function deleteTender(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to delete tender');
  }
  return res.json();
}

export function getDocumentDownloadUrl(id: string, filename: string): string {
  return `${API_BASE}/tenders/${id}/documents/${encodeURIComponent(filename)}`;
}

// Attachments (qualification documents)
export async function getAttachments(id: string): Promise<string[]> {
  return fetchJson(`/tenders/${id}/attachments`);
}

export async function uploadAttachments(id: string, files: File[]): Promise<{ uploaded: string[]; attachments: string[] }> {
  const formData = new FormData();
  files.forEach((f) => formData.append('files', f));
  const res = await fetch(`${API_BASE}/tenders/${id}/attachments`, { method: 'POST', body: formData });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export async function deleteAttachment(id: string, filename: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/attachments/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Delete failed');
  return res.json();
}

export function getAttachmentDownloadUrl(id: string, filename: string): string {
  return `${API_BASE}/tenders/${id}/attachments/${encodeURIComponent(filename)}`;
}
