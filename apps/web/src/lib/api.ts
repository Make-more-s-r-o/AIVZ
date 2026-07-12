import { getJwt, clearAuth } from './auth';
import type { TenderAnalysis, ProductMatch, PriceSanityFlag, ValidationReport } from '../types/tender';
import type { StageKey } from './stages';

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

/**
 * Stáhne binární soubor (dokument, příloha, ZIP balík) z API endpointu s Authorization
 * hlavičkou (JWT/legacy token) a spustí jeho uložení v prohlížeči.
 *
 * Nahrazuje dřívější posílání tokenu v `?token=` query stringu — ten unikal do nginx access
 * logů. `<a href>` odkaz ani `window.location` neumí poslat Authorization hlavičku, proto
 * fetch → blob → programatický `<a download>`.
 *
 * Jméno souboru z `Content-Disposition` (server ho u ZIP balíků odvozuje z názvu zakázky) má
 * přednost před `fallbackFilename`, který se použije jen když hlavička chybí nebo je nečitelná.
 */
export async function downloadWithAuth(url: string, fallbackFilename: string): Promise<void> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Stažení souboru se nezdařilo');
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const rawFilename = match?.[1];
  let filename = fallbackFilename;
  if (rawFilename) {
    try { filename = decodeURIComponent(rawFilename); } catch { filename = rawFilename; }
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Kompaktní souhrn analýzy embednutý do /api/tenders?include=analysis (zrušení N+1).
 * Obsahuje jen pole, která seznamy (Přehled/Zakázky/Pipeline) reálně zobrazují.
 */
export interface TenderAnalysisSummary {
  nazev: string | null;
  evidencni_cislo: string | null;
  zadavatel_nazev: string | null;
  zadavatel_ico: string | null;
  predpokladana_hodnota: number | null;
  lhuta_nabidek: string | null;
  rozhodnuti: string | null;
  go_no_go?: GoNoGo | null;
}

export interface GoNoGo {
  score: number;
  doporuceni: 'GO' | 'ZVAZIT' | 'NOGO';
  duvody: string[];
}

// Profit-aware bid skóre počítané PO nacenění (go-no-go.ts scoreBid).
export interface BidScore {
  score: number;
  doporuceni: 'GO' | 'ZVAZIT' | 'NOGO';
  duvody: string[];
  zisk_kc: number;
  marze_procent: number;
}

export interface HlidacTenderCandidate {
  id: string;
  nazev: string;
  zadavatel: string;
  budget: number | null;
  lhuta: string | null;
  stavVZ: string | null;
  url: string;
  dokumenty: Array<{ nazev: string; url: string }>;
  cpv: unknown[];
}

export interface TenderSummary {
  id: string;
  name?: string;
  inputFiles: string[];
  tenderId: string;
  steps: PipelineSteps;
  // CRM (M2): persistovaný lifecycle stav + řešitel (null když není DB / není záznam).
  status?: StageKey | null;
  assignee?: string | null;
  // CRM (M3): počty úkolů pro kanban chip „Úkoly {done}/{total}" (bez DB → {0,0}).
  tasks?: { done: number; total: number };
  // CRM (M9b): štítky zakázky (chips na řádcích Zakázek); bez DB → [].
  stitky?: Stitek[];
  // Přítomné jen při ?include=analysis / ?include=cost (getTendersSummary). null = nezanalyzováno.
  analysis?: TenderAnalysisSummary | null;
  costTotalCZK?: number | null;
}

export interface ActivityEntry {
  id: string;
  tender_id: string;
  type: string;
  actor_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
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
export type JobStatusValue = 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'waiting_approval';

export interface RunAllStatus {
  jobId: string;
  status: JobStatusValue;
  currentStep?: StepName;
  failedStep?: StepName;
  error?: string;
}

export interface JobStatus {
  id: string;
  tenderId: string;
  step: string;
  status: JobStatusValue;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  kind?: 'step' | 'pipeline';
  parentJobId?: string;
  currentStep?: StepName;
  failedStep?: StepName;
  logs: string[];
  totalLogLines: number;
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
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

export async function getHlidacTenders(query: string): Promise<HlidacTenderCandidate[]> {
  return fetchJson(`/monitoring/hlidac?q=${encodeURIComponent(query)}`);
}

// --- Monitoring feed (perzistovaný, s go/no-go skóre) ---

export type MonitoringStav = 'nova' | 'prevzata' | 'ignorovana';
export type MonitoringKategorie =
  | 'it_av' | 'naradi_dilna' | 'zdravotnicke' | 'vozidla' | 'stavebni_prace'
  | 'potraviny' | 'energie' | 'nabytek' | 'kancelar' | 'sluzby' | 'ostatni';

export interface MonitoringConfig {
  kategorie_zajmu: MonitoringKategorie[];
  klicova_slova: string[];
  vyloucena_slova: string[];
  min_hodnota: number | null;
  max_hodnota: number | null;
}

export interface MonitoringFeedItem {
  id: string;
  zdroj: string;
  zdroj_id: string;
  nazev: string;
  kategorie: MonitoringKategorie;
  zadavatel: string | null;
  predpokladana_hodnota: number | null;
  lhuta_nabidek: string | null;
  url: string | null;
  stav: MonitoringStav;
  tender_id: string | null;
  created_at: string;
  go_no_go: GoNoGo;
}

/** Natáhne nové zakázky ze zdroje do feedu. Vrací počty nalezeno/nových. */
export async function syncMonitoring(
  opts: { zdroj?: 'nen' | 'hlidac' | 'both'; q?: string } = {},
): Promise<{ zdroj: string; nalezeno: number; novych: number; zdroje_pouzite: string[]; synchronizovano_at: string; varovani?: string }> {
  const res = await fetch(`${API_BASE}/monitoring/sync`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (res.status === 401) { clearAuth(); window.location.reload(); throw new Error('Session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Synchronizace selhala');
  }
  return res.json();
}

export async function getMonitoringFeed(
  stav: MonitoringStav = 'nova',
  options: { kategorie?: MonitoringKategorie; vse?: boolean } = {},
): Promise<MonitoringFeedItem[]> {
  const params = new URLSearchParams({ stav });
  if (options.kategorie) params.set('kategorie', options.kategorie);
  if (options.vse) params.set('vse', '1');
  return fetchJson(`/monitoring/feed?${params.toString()}`);
}

export async function getMonitoringConfig(): Promise<MonitoringConfig> {
  return fetchJson('/monitoring/config');
}

export async function saveMonitoringConfig(config: MonitoringConfig): Promise<MonitoringConfig> {
  const res = await fetch(`${API_BASE}/monitoring/config`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (res.status === 401) { clearAuth(); window.location.reload(); throw new Error('Session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Nastavení monitoringu se nepodařilo uložit');
  }
  return res.json();
}

export interface PrevzitResult {
  tender_id: string;
  alreadyTaken?: boolean;
  pocet_stazenych?: number;
  spusteno?: boolean;
  jobId?: string | null;
  varovani?: string[];
}

/**
 * Převezme zakázku z monitoringu. `stahnout_zd` navíc stáhne přílohy ZD z NEN do input/,
 * `spustit` (jen s alespoň 1 staženým souborem) zařadí celý pipeline (s money-gate pauzou).
 */
export async function prevzitMonitoring(
  id: string,
  options: { stahnout_zd?: boolean; spustit?: boolean } = {},
): Promise<PrevzitResult> {
  const res = await fetch(`${API_BASE}/monitoring/${id}/prevzit`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (res.status === 401) { clearAuth(); window.location.reload(); throw new Error('Session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Převzetí selhalo');
  }
  return res.json();
}

export async function ignorovatMonitoring(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/monitoring/${id}/ignorovat`, {
    method: 'POST', headers: authHeaders(),
  });
  if (res.status === 401) { clearAuth(); window.location.reload(); throw new Error('Session expired'); }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Akce selhala');
  }
}

// Schvalovací inbox — jedna řádka na zakázku, která čeká na akci operátora.
export interface InboxEntry {
  tender_id: string;
  nazev: string;
  crm_stav: string | null;
  nepotvrzene_ceny: number;
  hard_flagy: number;
  validation_fails: number;
  ready_to_submit: boolean;
  celkova_cena_s_dph: number | null;
  zisk_kc: number | null;
  data_error: boolean;
  data_error_files: string[];
  deadline_alarm: boolean;
  hodin_do_lhuty: number | null;
}

export async function getInbox(): Promise<InboxEntry[]> {
  return fetchJson('/inbox');
}

// Profit-aware bid skóre počítané on-the-fly z aktuálních souborů zakázky.
export async function getBidScore(id: string): Promise<BidScore> {
  return fetchJson(`/tenders/${id}/bid-score`);
}

/**
 * Seznam zakázek s embednutým souhrnem analýzy + AI náklady (jeden request místo N+1).
 * Používají Přehled/Zakázky/Pipeline. Vlastní query key (['tenders','summary']), ať se
 * needostane do kolize s holým getTenders() cache.
 */
export async function getTendersSummary(): Promise<TenderSummary[]> {
  return fetchJson('/tenders?include=analysis,cost');
}

/** Náhled obsahu nahraného ZIPu (bez rozbalení) — kolik souborů archiv obsahuje. */
export interface UploadZipInfo {
  filename: string;
  fileCount: number | null;
}

export interface UploadResponse extends TenderSummary {
  uploadedFiles: string[];
  /** Přítomné jen pokud byl mezi nahranými soubory ZIP. */
  zipFiles?: UploadZipInfo[];
}

export async function uploadFiles(files: File[], tenderId?: string): Promise<UploadResponse> {
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

export interface TenderStatusResponse {
  tenderId: string;
  steps: PipelineSteps;
  runAll?: RunAllStatus;
  pdfAvailable?: boolean;
  // CRM (M2): persistovaný stav + řešitel + efektivní fáze + povolené přechody.
  status?: StageKey | null;
  assignee?: string | null;
  effectiveStatus?: StageKey;
  allowedNext?: StageKey[];
  // Vygenerované dokumenty jsou starší než poslední změna/potvrzení ceny — je třeba
  // spustit krok Generování znovu (viz lib/stale-check.ts na backendu).
  stale?: boolean;
}

export async function getTenderStatus(id: string): Promise<TenderStatusResponse> {
  return fetchJson<TenderStatusResponse>(`/tenders/${id}/status`);
}

export async function getExtractedText(id: string) {
  return fetchJson<Record<string, unknown>>(`/tenders/${id}/extracted-text`);
}

export async function getAnalysis(id: string) {
  return fetchJson<TenderAnalysis>(`/tenders/${id}/analysis`);
}

export async function getProductMatch(id: string) {
  return fetchJson<ProductMatch>(`/tenders/${id}/product-match`);
}

export interface PricingDefaults {
  default_marze_procent: number;
}

/**
 * Výchozí marže (%) pro cenové potvrzení — z nastavení firmy přiřazené zakázce
 * (fallback default firma → legacy config → 10 %). Backend vrací vždy 200.
 */
export async function getPricingDefaults(id: string): Promise<PricingDefaults> {
  return fetchJson(`/tenders/${id}/pricing-defaults`);
}

export interface WinPriceSample {
  predmet: string;
  cena_bez_dph: number;
  dodavatel_nazev: string | null;
  datum: string | null;
  url: string | null;
}

export interface WinPriceBand {
  n: number;
  median_bez_dph?: number;
  p25?: number;
  p75?: number;
  min?: number;
  max?: number;
  samples?: WinPriceSample[];
}

/** Historické ceny jsou pouze informační podklad; tato funkce nic nezapisuje. */
export async function getWinPriceBand(subject: string, category?: string): Promise<WinPriceBand> {
  const params = new URLSearchParams({ q: subject });
  if (category) params.set('kategorie', category);
  return fetchJson(`/winprice/band?${params.toString()}`);
}

// --- Výsledky podání (win-rate feedback loop) ---

export type VysledekPodani = 'vyhra' | 'prohra' | 'zruseno';

export interface TenderOutcome {
  id: string;
  tender_id: string;
  vysledek: VysledekPodani;
  vitezna_cena_bez_dph: number | null;
  nase_cena_bez_dph: number | null;
  pocet_uchazecu: number | null;
  vitez_nazev: string | null;
  poznamka: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutcomeInput {
  vysledek: VysledekPodani;
  vitezna_cena_bez_dph?: number | null;
  nase_cena_bez_dph?: number | null;
  pocet_uchazecu?: number | null;
  vitez_nazev?: string | null;
  poznamka?: string | null;
}

export interface OutcomeStats {
  celkem: number;
  vyhry: number;
  prohry: number;
  zrusene: number;
  win_rate_procent: number | null;
  prumerna_odchylka_od_viteze_procent: number | null;
}

/** Výsledek zakázky — resilientní (401/chyba/bez záznamu → null, ne reload). */
export async function getOutcome(id: string): Promise<TenderOutcome | null> {
  try {
    const res = await fetch(`${API_BASE}/tenders/${encodeURIComponent(id)}/outcome`, { headers: authHeaders() });
    if (!res.ok) return null;
    return (await res.json()).outcome ?? null;
  } catch {
    return null;
  }
}

/** Uloží výsledek podání (idempotentní upsert). Vítěznou cenu backend propíše do win_prices. */
export async function saveOutcome(id: string, input: OutcomeInput): Promise<{ outcome: TenderOutcome; winprice_feedback: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${encodeURIComponent(id)}/outcome`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.detail || err.error || 'Nepodařilo se uložit výsledek');
  }
  return res.json();
}

/** Souhrnné win-rate statistiky — resilientní (401/chyba → prázdné nuly, ne reload). */
export async function getOutcomeStats(): Promise<OutcomeStats> {
  const empty: OutcomeStats = { celkem: 0, vyhry: 0, prohry: 0, zrusene: 0, win_rate_procent: null, prumerna_odchylka_od_viteze_procent: null };
  try {
    const res = await fetch(`${API_BASE}/outcomes/stats`, { headers: authHeaders() });
    if (!res.ok) return empty;
    return await res.json();
  } catch {
    return empty;
  }
}

// --- Nákupní seznam po výhře ---

export interface NakupItem {
  id: number;
  tender_id: string;
  polozka_index: number;
  polozka_nazev: string | null;
  mnozstvi: number | null;
  jednotka: string | null;
  nakupni_cena_bez_dph: number | null;
  dodavatel: string | null;
  url: string | null;
  objednano: boolean;
  objednano_at: string | null;
  poznamka: string | null;
  created_at: string;
  updated_at: string;
}

export async function getNakupy(id: string): Promise<NakupItem[]> {
  const response = await fetchJson<{ nakupy: NakupItem[] }>(`/tenders/${encodeURIComponent(id)}/nakupy`);
  return response.nakupy;
}

export async function seedNakupy(id: string): Promise<{
  nakupy: NakupItem[];
  seeded: number;
  vynechane_nepotvrzene: number;
}> {
  const res = await fetch(`${API_BASE}/tenders/${encodeURIComponent(id)}/nakupy/seed`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.detail || err.error || 'Nepodařilo se sestavit nákupní seznam');
  }
  return res.json();
}

export async function updateNakup(
  id: string,
  polozkaIndex: number,
  input: { objednano: boolean; poznamka?: string | null },
): Promise<NakupItem> {
  const res = await fetch(`${API_BASE}/tenders/${encodeURIComponent(id)}/nakupy/${polozkaIndex}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.detail || err.error || 'Nepodařilo se upravit nákupní položku');
  }
  return (await res.json()).nakup;
}

export async function getDocuments(id: string): Promise<string[]> {
  return fetchJson(`/tenders/${id}/documents`);
}

export async function getValidation(id: string) {
  return fetchJson<ValidationReport>(`/tenders/${id}/validation`);
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

/** Spustí všech pět kroků jako serverem řízený sekvenční řetězec. */
export async function runAllSteps(id: string): Promise<RunAllStatus> {
  const res = await fetch(`${API_BASE}/tenders/${id}/run/all`, {
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
    throw new Error(err.error || 'Spuštění pipeline selhalo');
  }
  return res.json();
}

/**
 * Pokračování pozastaveného run-all řetězce po lidském potvrzení cen (money-gate).
 * 404 = žádný pozastavený řetězec; 409 = stále nepotvrzené ceny (pendingCount).
 */
export async function resumeRunAll(id: string): Promise<RunAllStatus> {
  const res = await fetch(`${API_BASE}/tenders/${id}/run-all/resume`, {
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
    throw new Error(err.error || 'Pokračování pipeline selhalo');
  }
  return res.json();
}

/** Poll job status (with optional log offset for incremental logs) */
/**
 * Job není v serverovém registru (např. po úklidu starých jobů nebo neúspěšné obnově souboru).
 * Odlišuje se od síťové chyby: 404 = úloha je definitivně ztracená, nemá smysl dál pollovat.
 */
export class JobNotFoundError extends Error {
  constructor() {
    super('Úloha nenalezena');
    this.name = 'JobNotFoundError';
  }
}

export async function getJobStatus(jobId: string, since?: number): Promise<JobStatus> {
  const params = since ? `?since=${since}` : '';
  const res = await fetch(`${API_BASE}/jobs/${jobId}${params}`, {
    headers: authHeaders(),
  });
  if (res.status === 401) {
    clearAuth();
    window.location.reload();
    throw new Error('Session expired');
  }
  // 404 = úloha už v registru serveru není → vlastní typ, ať to FE nezamění
  // se síťovým výpadkem a nepoluje donekonečna (nekonečný spinner).
  if (res.status === 404) {
    throw new JobNotFoundError();
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
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
  zdroj_nakupu?: {
    url: string;
    dodavatel: string | null;
  };
  override_pod_nakupem?: {
    potvrzeno: true;
    duvod: string;
    schvalil?: string;
  };
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
): Promise<{ success: boolean; warnings: PriceSanityFlag[] }> {
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

/**
 * Hromadné potvrzení cen více položek jedním requestem (transakčně nad product-match.json).
 * Uloží pouze řádky, které operátor jednotlivě zobrazil a explicitně attestoval.
 */
export async function bulkUpdateItemPriceOverride(
  id: string,
  items: Array<{ itemIndex: number; attestace: true; cenova_uprava: PriceOverrideData }>,
): Promise<{ success: boolean; updated: number; preskoceno_bez_kontroly: number[]; warnings: PriceSanityFlag[]; can_resume_run_all?: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/product-match/price/bulk`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ items }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Nepodařilo se hromadně potvrdit ceny');
  }
  return res.json();
}

export interface ApplyMarketPricesResponse {
  success: boolean;
  upraveno: number;
  preskoceno: number;
  duvody_preskoceni: {
    orientacni: number;
    bez_zdroje: number;
    zmeneny_kandidat: number;
  };
  nova_celkova_cena_bez_dph: number;
  nova_celkova_cena_s_dph: number;
}

/** Hromadně předvyplní doložené tržní ceny; endpoint je nikdy nepotvrdí. */
export async function applyMarketPrices(
  id: string,
  polozkaIndexy?: number[],
): Promise<ApplyMarketPricesResponse> {
  const res = await fetch(`${API_BASE}/tenders/${encodeURIComponent(id)}/product-match/apply-market-prices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(polozkaIndexy ? { polozka_indexy: polozkaIndexy } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Reálné ceny se nepodařilo použít');
  }
  return res.json();
}

/**
 * Ruční výběr produktového kandidáta operátorem (AI někdy vybere špatný produkt).
 * itemIndex = `polozka_index` položky (u legacy single-product formátu se ignoruje, pošli -1).
 * Když měla položka potvrzenou cenu, backend ji smaže a vrátí `priceCleared: true`.
 */
export async function selectProductCandidate(
  id: string, itemIndex: number, candidateIndex: number
): Promise<{ success: boolean; priceCleared?: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/product-match/select`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ itemIndex, candidateIndex }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Nepodařilo se vybrat produkt');
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
  return `${API_BASE}/tenders/${id}/documents/${encodeURIComponent(filename)}`;
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
  return `${API_BASE}/tenders/${id}/attachments/${encodeURIComponent(filename)}`;
}

// --- Generation meta + field validation ---

export interface GenerationMetaEntry {
  mode: 'clean' | 'reconstruct' | 'fill';
  source: string;
  cost_czk: number;
  template_source?: string;
}

export type GenerationMeta = Record<string, GenerationMetaEntry>;

export interface FieldValidationCheck {
  field: string;
  expected: string;
  actual: string;
  status: 'pass' | 'fail' | 'warning';
}

export interface FieldValidationResult {
  document: string;
  mode: 'clean' | 'reconstruct' | 'fill';
  checks: FieldValidationCheck[];
  overall: 'pass' | 'fail';
  confidence: number;
}

export async function getGenerationMeta(id: string): Promise<GenerationMeta> {
  return fetchJson(`/tenders/${id}/generation-meta`);
}

export async function getFieldValidation(id: string): Promise<FieldValidationResult[]> {
  return fetchJson(`/tenders/${id}/field-validation`);
}

export async function setDocumentMode(
  id: string, filename: string, mode: 'clean' | 'reconstruct' | 'fill'
): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/documents/${encodeURIComponent(filename)}/mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to set mode');
  }
  return res.json();
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

// --- CRM lifecycle status + aktivita (M2) ---

/**
 * Změna fáze zakázky přes state-machine guardy. Na zákaz (409) vyhodí Error s českým
 * důvodem (pro guard toast); na chybějící DB (503) vyhodí Error s 'db_unavailable'.
 */
export async function setTenderStatus(
  id: string,
  status: StageKey,
  reason?: string,
): Promise<{ success: boolean; status: StageKey }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ status, reason }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se změnit stav');
  }
  return res.json();
}

export async function setTenderAssignee(
  id: string,
  assignee: string | null,
): Promise<{ success: boolean; assignee: string | null }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/assignee`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ assignee }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se přiřadit řešitele');
  }
  return res.json();
}

// --- Submission cockpit (balík podání + evidence) ---

export interface SubmissionManifestFile {
  name: string;
  sha256: string;
  size: number;
}

export interface SubmissionManifest {
  version: number;
  content_hash: string;
  created_at: string;
  zip_filename: string;
  files: SubmissionManifestFile[];
  celkova_cena_s_dph: number | null;
  vybrane_casti: string[] | null;
}

export interface SubmissionEvidence {
  portal: string;
  cas_podani: string;
  evidencni_cislo?: string;
  poznamka?: string;
  zaznamenano: string;
  manifest_version: number;
  manifest_content_hash: string;
}

export interface PodaniState {
  manifest: SubmissionManifest | null;
  evidence: SubmissionEvidence | null;
}

export interface EvidenceInput {
  portal: string;
  cas_podani: string; // ISO
  evidencni_cislo?: string;
  poznamka?: string;
}

/**
 * Finalizace nabídky — gate na kompletní podatelný balík. Vytvoří IMMUTABILNÍ balík podání
 * (ZIP + manifest se sha256) a přepne zakázku maximálně na 'pripravena'. NEPŘEPÍNÁ na
 * 'odeslana' — to dělá až recordPodano se skutečnou evidencí. Na nepřipravenou nabídku
 * (409) vyhodí Error s výčtem problémů (pro toast).
 */
export async function finalizeTender(id: string): Promise<{ success: boolean; status: StageKey; reused: boolean; manifest: SubmissionManifest }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/finalize`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const problems = Array.isArray(err.problems) && err.problems.length ? ' · ' + err.problems.join(' · ') : '';
    throw new Error((err.reason || err.error || 'Finalizace selhala') + problems);
  }
  return res.json();
}

export async function getPodani(id: string): Promise<PodaniState> {
  return fetchJson(`/tenders/${id}/podani`);
}

export function getPodaniDownloadUrl(id: string): string {
  return `${API_BASE}/tenders/${id}/podani/download`;
}

/** Zaznamená podání (portál, čas, evidenční číslo) → přepne zakázku na 'odeslana'. */
export async function recordPodano(id: string, input: EvidenceInput): Promise<{ success: boolean; status: StageKey; evidence: SubmissionEvidence }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/podano`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Zaznamenání podání selhalo');
  }
  return res.json();
}

export async function getActivity(id: string): Promise<ActivityEntry[]> {
  const data = await fetchJson<{ activity: ActivityEntry[] }>(`/tenders/${id}/activity`);
  return data.activity;
}

export async function getRecentActivity(): Promise<ActivityEntry[]> {
  const data = await fetchJson<{ activity: ActivityEntry[] }>(`/activity/recent`);
  return data.activity;
}

// --- Úkoly + checklisty (M3) ---

export type TaskStav = 'k_vyrizeni' | 'probiha' | 'hotovo' | 'blokovano';
export type TaskPriorita = 'nizka' | 'stredni' | 'vysoka';

export interface Task {
  id: string;
  tender_id: string;
  title: string;
  assignee: string | null;
  due_date: string | null; // 'YYYY-MM-DD'
  stav: TaskStav;
  priorita: TaskPriorita;
  je_checklist: boolean;
  seed_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateTaskInput {
  title: string;
  assignee?: string | null;
  due_date?: string | null;
  stav?: TaskStav;
  priorita?: TaskPriorita;
  je_checklist?: boolean;
}

// Čtení úkolů je enrichment — 401/chyba NESMÍ spustit clearAuth+reload (jako getUsers).
export async function getTasks(id: string): Promise<Task[]> {
  try {
    const res = await fetch(`${API_BASE}/tenders/${id}/tasks`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).tasks ?? [];
  } catch {
    return [];
  }
}

/**
 * „Moje úkoly" — nedokončené úkoly přihlášeného uživatele napříč zakázkami.
 * Příjemce určuje server z JWT (sub), NE z query — proto se ?assignee neposílá (anti-IDOR).
 * `assignee` slouží jen jako guard: bez přihlášeného uživatele voláním neplýtváme.
 */
export async function getMyTasks(assignee: string): Promise<Task[]> {
  if (!assignee) return [];
  try {
    const res = await fetch(`${API_BASE}/tasks/mine`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).tasks ?? [];
  } catch {
    return [];
  }
}

export async function createTask(id: string, input: CreateTaskInput): Promise<Task> {
  const res = await fetch(`${API_BASE}/tenders/${id}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se vytvořit úkol');
  }
  return res.json();
}

export async function updateTask(taskId: string, patch: Partial<CreateTaskInput>): Promise<Task> {
  const res = await fetch(`${API_BASE}/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se upravit úkol');
  }
  return res.json();
}

export async function deleteTask(taskId: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tasks/${taskId}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se smazat úkol');
  }
  return res.json();
}

/** Auto-seed checklistu z kvalifikačních požadavků analýzy (idempotentní). */
export async function seedChecklist(id: string): Promise<{ seeded: number; tasks: Task[] }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/tasks/seed`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se vygenerovat checklist');
  }
  return res.json();
}

// --- Termíny + kalendář (M6) ---

export type TerminTyp = 'lhuta_nabidek' | 'otevirani_obalek' | 'doba_plneni' | 'prohlidka' | 'vlastni';

export interface Termin {
  id: string;
  tender_id: string;
  typ: TerminTyp;
  datum: string | null; // 'YYYY-MM-DD'
  cas: string | null;
  popis: string | null;
  pripominka: number | null;
  seed_key: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarItem {
  id: string;
  tender_id: string;
  typ: TerminTyp;
  datum: string | null;
  cas: string | null;
  popis: string | null;
  kind: 'termin';
}

export interface CreateTerminInput {
  typ: TerminTyp;
  datum: string;
  cas?: string | null;
  popis?: string | null;
  pripominka?: number | null;
}

// Resilientní GETy (vzor getTasks) — 401/chyba → prázdno, ne reload.
export async function getTerminy(id: string): Promise<Termin[]> {
  try {
    const res = await fetch(`${API_BASE}/tenders/${id}/terminy`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).terminy ?? [];
  } catch {
    return [];
  }
}

export async function getCalendar(from?: string, to?: string): Promise<CalendarItem[]> {
  try {
    const qs = new URLSearchParams();
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    const res = await fetch(`${API_BASE}/calendar${qs.toString() ? '?' + qs.toString() : ''}`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).items ?? [];
  } catch {
    return [];
  }
}

export async function createTermin(id: string, input: CreateTerminInput): Promise<Termin> {
  const res = await fetch(`${API_BASE}/tenders/${id}/terminy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se vytvořit termín');
  }
  return res.json();
}

export async function updateTermin(terminId: string, patch: Partial<CreateTerminInput>): Promise<Termin> {
  const res = await fetch(`${API_BASE}/terminy/${terminId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se upravit termín');
  }
  return res.json();
}

export async function deleteTermin(terminId: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/terminy/${terminId}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se smazat termín');
  }
  return res.json();
}

/** Seed termínů z analysis.terminy (idempotentní). */
export async function seedTerminy(id: string): Promise<{ seeded: number; terminy: Termin[] }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/terminy/seed`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se vygenerovat termíny');
  }
  return res.json();
}

// --- Notifikace (M7, zvonek) ---

export interface Notification {
  id: string;
  user_id: string;
  typ: string;
  text: string;
  url: string | null;
  tender_id: string | null;
  entity_typ: string | null;
  entity_id: string | null;
  actor_id: string | null;
  precteno: boolean;
  created_at: string;
}

/** Notifikace přihlášeného uživatele — resilientní (401/chyba → prázdno, ne reload). */
export async function getNotifications(userId: string): Promise<{ items: Notification[]; unread: number }> {
  if (!userId) return { items: [], unread: 0 };
  try {
    const res = await fetch(`${API_BASE}/notifications?userId=${encodeURIComponent(userId)}`, { headers: authHeaders() });
    if (!res.ok) return { items: [], unread: 0 };
    const data = await res.json();
    return { items: data.items ?? [], unread: data.unread ?? 0 };
  } catch {
    return { items: [], unread: 0 };
  }
}

export async function markNotificationsRead(ids?: string[]): Promise<{ updated: number }> {
  const res = await fetch(`${API_BASE}/notifications/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(ids ? { ids } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se označit přečtené');
  }
  return res.json();
}

// --- Komentáře + @mention (M8) ---

export interface Comment {
  id: string;
  tender_id: string;
  text: string;
  mentions: string[];
  author_id: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
}

/** Komentáře zakázky — resilientní GET (vzor getTasks): 401/chyba → prázdno, ne reload. */
export async function getComments(id: string): Promise<Comment[]> {
  try {
    const res = await fetch(`${API_BASE}/tenders/${id}/comments`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).comments ?? [];
  } catch {
    return [];
  }
}

export async function createComment(id: string, input: { text: string; mentions?: string[] }): Promise<Comment> {
  const res = await fetch(`${API_BASE}/tenders/${id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se přidat komentář');
  }
  return res.json();
}

export async function deleteComment(commentId: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/comments/${commentId}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se smazat komentář');
  }
  return res.json();
}

// --- Uložené pohledy (M9b, saved views) ---

export interface SavedView {
  id: string;
  user_id: string;
  nazev: string;
  definice: { query?: string; decision?: string; view?: string; tag?: string };
  je_sdileny: boolean;
  created_at: string;
}

/** Pohledy přihlášeného uživatele (vlastní + sdílené) — resilientní GET (401/chyba → []). */
export async function getViews(): Promise<SavedView[]> {
  try {
    const res = await fetch(`${API_BASE}/views`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).views ?? [];
  } catch {
    return [];
  }
}

export async function createView(input: { nazev: string; definice: SavedView['definice']; je_sdileny?: boolean }): Promise<SavedView> {
  const res = await fetch(`${API_BASE}/views`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se uložit pohled');
  }
  return res.json();
}

export async function deleteView(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/views/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se smazat pohled');
  }
  return res.json();
}

// --- Štítky (M9b, tags) ---

export type TagColor = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface Stitek {
  id: string;
  nazev: string;
  barva: TagColor | string;
  created_by: string | null;
  created_at: string;
}

/** Globální číselník štítků — resilientní GET (401/chyba → []). */
export async function getTags(): Promise<Stitek[]> {
  try {
    const res = await fetch(`${API_BASE}/stitky`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).stitky ?? [];
  } catch {
    return [];
  }
}

export async function createTag(nazev: string, barva: TagColor): Promise<Stitek> {
  const res = await fetch(`${API_BASE}/stitky`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ nazev, barva }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se vytvořit štítek');
  }
  return res.json();
}

export async function deleteTag(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/stitky/${id}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se smazat štítek');
  }
  return res.json();
}

/** Štítky konkrétní zakázky — resilientní GET. */
export async function getTenderTags(id: string): Promise<Stitek[]> {
  try {
    const res = await fetch(`${API_BASE}/tenders/${id}/stitky`, { headers: authHeaders() });
    if (!res.ok) return [];
    return (await res.json()).stitky ?? [];
  } catch {
    return [];
  }
}

export async function attachTag(id: string, stitekId: string): Promise<{ success: boolean; stitky: Stitek[] }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/stitky`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ stitek_id: stitekId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se přiřadit štítek');
  }
  return res.json();
}

export async function detachTag(id: string, stitekId: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_BASE}/tenders/${id}/stitky/${stitekId}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se odebrat štítek');
  }
  return res.json();
}

// --- Ověření cen web-searchem + checklist příloh (followup b+d) ---

/** Návrh ceny dohledaný web-searchem (NIKDY nepřepisuje cenova_uprava — potvrzuje uživatel). */
export interface WebPriceSource {
  url: string;
  dodavatel: string | null;
  nazev_produktu?: string;
  cena_bez_dph: number | null;
  cena_s_dph: number | null;
  cena_baleni_s_dph: number | null;
  baleni_ks: number | null;
  mena: 'CZK';
  sazba_dph?: number | null;
  dostupnost: 'skladem' | 'na dotaz' | 'není skladem' | 'neznámá';
  poznamka: string | null;
  splnuje_specifikaci?: boolean;
  shoda_parametru?: string[];
  orientacni?: boolean;
  z_cache?: boolean;
  cache_stari_dnu?: number;
}

export interface OvereniCeny {
  stav: 'nalezeno' | 'ekvivalent' | 'orientacni' | 'nenalezeno' | 'chyba';
  shoda_typ?: 'presny' | 'ekvivalent';
  web_cena_bez_dph?: number;
  web_cena_s_dph?: number;
  mena?: string;
  zdroj_url?: string;
  dodavatel?: string;
  dostupnost?: string;
  poznamka?: string;
  posledni_chyba?: {
    zprava: string;
    at: string;
  };
  overeno_at: string;
  kandidat_fingerprint?: string;
  prekracuje_strop?: boolean;
  kandidat_neexistuje?: boolean;
  z_cache?: boolean;
  cache_stari_dnu?: number;
  zdroje?: WebPriceSource[];
  realita?: {
    nejlevnejsi_bez_dph: number | null;
    rozdil_procent: number | null;
    pod_trhem: boolean;
    nejlevnejsi_dodavatel?: string | null;
    nejlevnejsi_zdroj_url?: string | null;
    poznamka?: string | null;
  };
}

/** Spustí background job ověření cen (web search) — vrací jobId pro polling přes getJobStatus. */
export async function verifyPrices(id: string): Promise<{ jobId: string; status: string }> {
  const res = await fetch(`${API_BASE}/tenders/${encodeURIComponent(id)}/run/verify-prices`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Ověření cen se nepodařilo spustit');
  }
  return res.json();
}

export interface PrilohaChecklistItem {
  slot: string;
  label: string;
  status: 'nahrano' | 'chybi' | 'po_platnosti' | 'expiruje';
  povinny: boolean;
  zdroj?: 'firma' | 'zakazka';
  filename?: string;
  platnost_do?: string | null;
  platnost_status?: 'ok' | 'expiruje' | 'expirovany' | 'nezadano';
  poznamka?: string;  // např. „nahraný doklad je po platnosti" / „doklad brzy expiruje"
  vyjimka?: { duvod: string; schvalil: string; at: string };
}

export async function createKvalifikaceVyjimka(id: string, slot: string, duvod: string): Promise<void> {
  await fetchJson(`/tenders/${encodeURIComponent(id)}/kvalifikace/vyjimka`, {
    method: 'POST',
    body: JSON.stringify({ slot, duvod }),
  });
}

export interface PrilohaChecklist {
  items: PrilohaChecklistItem[];
  company_id: string | null;
  analyza_hotova: boolean;
}

/** Checklist kvalifikačních příloh — resilientní GET (401/chyba → prázdno). */
export async function getPrilohaChecklist(id: string): Promise<PrilohaChecklist> {
  const empty: PrilohaChecklist = { items: [], company_id: null, analyza_hotova: false };
  try {
    const res = await fetch(`${API_BASE}/tenders/${encodeURIComponent(id)}/priloha-checklist`, { headers: authHeaders() });
    if (!res.ok) return empty;
    return await res.json();
  } catch {
    return empty;
  }
}

export type BalikChecklistStatus = 'pokryto' | 'chybi' | 'nejiste';
export interface BalikChecklistItem {
  klic: string;
  nazev: string;
  popis?: string;
  povinny: boolean;
  typ?: 'kryci_list' | 'cestne_prohlaseni' | 'soupis' | 'smlouva' | 'seznam_poddodavatelu' | 'jine';
  status: BalikChecklistStatus;
  soubor?: string;
  zdroj?: 'vygenerovano' | 'zakazka' | 'firma';
  poznamka?: string;
  potvrzeni?: { potvrdil: string; at: string; soubor: string; sha256: string; pozadavek_fingerprint: string };
  potvrzeni_propadlo?: boolean;
  zamitnuti?: { zamitnuto: true; duvod: string; kdo: string; at: string; pozadavek_fingerprint: string };
}

export interface BalikChecklist {
  items: BalikChecklistItem[];
  analyza_hotova: boolean;
  podporovana_analyza: boolean;
  prevzeti_uplnosti?: { prevzato: true; duvod: string; kdo: string; at: string };
}

export function getBalikChecklist(id: string): Promise<BalikChecklist> {
  return fetchJson(`/tenders/${encodeURIComponent(id)}/balik-checklist`);
}

export function confirmBalikItem(id: string, klic: string): Promise<{ success: boolean }> {
  return fetchJson(`/tenders/${encodeURIComponent(id)}/balik/potvrdit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ klic }),
  });
}

export function prevzitUplnost(id: string, duvod: string): Promise<{ success: boolean }> {
  return fetchJson(`/tenders/${encodeURIComponent(id)}/balik/prevzit-uplnost`, { method: 'POST', body: JSON.stringify({ duvod }) });
}

export function zamitnoutBalikPozadavek(id: string, klic: string, duvod: string): Promise<{ success: boolean }> {
  return fetchJson(`/tenders/${encodeURIComponent(id)}/balik/zamitnout-pozadavek`, { method: 'POST', body: JSON.stringify({ klic, duvod }) });
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

/** Agregovaný přehled AI nákladů napříč všemi zakázkami (karta "AI náklady" v Přehledu). */
export interface CostsOverview {
  dnes_czk: number;
  tyden_czk: number;
  mesic_czk: number;
  celkem_czk: number;
  top_zakazky: Array<{ tender_id: string; nazev: string | null; celkem_czk: number }>;
  po_dnech: Array<{ den: string; czk: number }>;
}

const EMPTY_COSTS_OVERVIEW: CostsOverview = {
  dnes_czk: 0, tyden_czk: 0, mesic_czk: 0, celkem_czk: 0, top_zakazky: [], po_dnech: [],
};

/** Resilientní GET — chyba/401 vrátí prázdný přehled místo pádu Přehledu. */
export async function getCostsOverview(): Promise<CostsOverview> {
  try {
    const res = await fetch(`${API_BASE}/costs/summary`, { headers: authHeaders() });
    if (!res.ok) return EMPTY_COSTS_OVERVIEW;
    return await res.json();
  } catch {
    return EMPTY_COSTS_OVERVIEW;
  }
}

export interface Governance {
  ingest_enabled: boolean;
  ai_jobs_enabled: boolean;
  generate_enabled: boolean;
  finalize_enabled: boolean;
  submission_enabled: boolean;
  denni_ai_limit_czk: number | null;
  poznamka: string | null;
  zmeneno_at: string | null;
  zmeneno_kym: string | null;
}

export async function getGovernance(): Promise<Governance> {
  return fetchJson('/governance');
}

export async function saveGovernance(patch: Partial<Governance>): Promise<Governance> {
  const res = await fetch(`${API_BASE}/governance`, {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Governance se nepodařilo uložit.');
  }
  return res.json();
}

// --- ZIP downloads ---

export function getDocumentsZipUrl(id: string): string {
  return `${API_BASE}/tenders/${id}/download/documents`;
}

export function getBundleZipUrl(id: string): string {
  return `${API_BASE}/tenders/${id}/download/bundle`;
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

export type UserRole = 'admin' | 'analytik' | 'viewer';

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export async function updateUserRole(userId: string, role: UserRole): Promise<SafeUser> {
  const res = await fetch(`${API_BASE}/users/${userId}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.reason || err.error || 'Nepodařilo se změnit roli');
  }
  return res.json();
}

export async function getUsers(): Promise<SafeUser[]> {
  // Řešitelské jméno je jen enrichment — 401/chyba NESMÍ spustit globální logout/reload
  // (getUsers se volá napříč Pipeline/Přehled/Detail). Degraduje na prázdný seznam.
  try {
    const res = await fetch(`${API_BASE}/users`, { headers: authHeaders() });
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export async function createNewUser(email: string, name: string, password: string, role?: UserRole): Promise<SafeUser> {
  const res = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ email, name, password, role }),
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
  default_marze_procent?: number;
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

// --- Document slot types (mirrored from shared/constants) ---

export type DocExpiryStatus = 'ok' | 'expiruje' | 'expirovany' | 'nezadano';

export interface DocSlotEntry {
  slot: string;
  filename: string;
  uploadedAt: string;
  platnost_do?: string | null;       // ISO datum (YYYY-MM-DD) platnosti dokladu
  platnost_status?: DocExpiryStatus; // dopočítáno serverem
  dny_do_expirace?: number | null;   // dopočítáno serverem (kladné = platí, záporné = po platnosti)
}

export interface CompanyDocsResponse {
  entries: DocSlotEntry[];
  files: string[];
}

export async function getCompanyDocs(companyId: string): Promise<CompanyDocsResponse> {
  return fetchJson(`/companies/${companyId}/documents`);
}

export async function uploadCompanyDocs(
  companyId: string,
  files: File[],
  slot: string = 'ostatni',
): Promise<{ uploaded: string[]; entries: DocSlotEntry[]; files: string[] }> {
  const formData = new FormData();
  files.forEach(f => formData.append('files', f));
  formData.append('slot', slot);
  const res = await fetch(`${API_BASE}/companies/${companyId}/documents`, {
    method: 'POST',
    body: formData,
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error('Upload failed');
  return res.json();
}

export async function deleteCompanyDoc(
  companyId: string,
  filename: string,
  slot: string = 'ostatni',
): Promise<{ success: boolean; entries: DocSlotEntry[] }> {
  const res = await fetch(
    `${API_BASE}/companies/${companyId}/documents/${encodeURIComponent(filename)}?slot=${encodeURIComponent(slot)}`,
    { method: 'DELETE', headers: authHeaders() },
  );
  if (!res.ok) throw new Error('Delete failed');
  return res.json();
}

/** Nastaví/zruší datum platnosti dokladu (platnost_do = null → zrušit). */
export async function setCompanyDocPlatnost(
  companyId: string,
  filename: string,
  platnostDo: string | null,
  slot: string = 'ostatni',
): Promise<{ success: boolean; entries: DocSlotEntry[] }> {
  const res = await fetch(
    `${API_BASE}/companies/${companyId}/documents/${encodeURIComponent(filename)}/platnost`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ platnost_do: platnostDo, slot }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Failed to set platnost');
  }
  return res.json();
}

export async function setTenderCompany(tenderId: string, companyId: string): Promise<{ success: boolean; copied_documents: string[]; missing_documents?: string[] }> {
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

// --- Warehouse (cenový sklad) API ---

export interface WarehouseStats {
  products: number;
  products_active: number;
  sources: number;
  categories: number;
  prices: number;
  last_import: string | null;
}

export interface WarehouseProduct {
  id: string;
  manufacturer: string;
  model: string;
  ean: string | null;
  part_number: string | null;
  category_id: number | null;
  category_slug?: string;
  category_nazev?: string;
  description: string | null;
  parameters: Record<string, string>;
  parameters_normalized: Record<string, unknown>;
  image_url: string | null;
  is_active: boolean;
  best_price?: number | null;
  best_price_source?: string | null;
  best_price_fetched_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WarehouseCategory {
  id: number;
  slug: string;
  nazev: string;
  parent_id: number | null;
  ikona: string | null;
  children?: WarehouseCategory[];
}

export interface ImportPreview {
  filename: string;
  total_rows: number;
  columns: string[];
  suggested_mapping: Array<{
    source_index: number;
    source_name: string;
    target_field: string | null;
  }>;
  sample_rows: Record<string, string>[];
  upload_path: string;
}

export interface ImportResult {
  total_rows: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; error: string }>;
}

export async function getWarehouseStats(): Promise<WarehouseStats> {
  return fetchJson('/warehouse/stats');
}

export interface WarehouseQualityStats {
  price_freshness: { fresh: number; aging: number; stale: number };
  products_without_price: number;
  products_without_image: number;
  products_without_description: number;
  categories_breakdown: Array<{ category_id: number; category_nazev: string; product_count: number; avg_price: number | null }>;
  sources_breakdown: Array<{ source_id: number; source_name: string; product_count: number; price_count: number; last_scraped_at: string | null }>;
  avg_prices_per_product: number;
}

export async function getWarehouseQualityStats(): Promise<WarehouseQualityStats> {
  return fetchJson('/warehouse/quality-stats');
}

export async function getWarehouseProducts(params?: {
  q?: string;
  category_id?: number;
  manufacturer?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_dir?: string;
  price_min?: number;
  price_max?: number;
}): Promise<{ items: WarehouseProduct[]; total: number }> {
  const searchParams = new URLSearchParams();
  if (params?.q) searchParams.set('q', params.q);
  if (params?.category_id) searchParams.set('category_id', String(params.category_id));
  if (params?.manufacturer) searchParams.set('manufacturer', params.manufacturer);
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset) searchParams.set('offset', String(params.offset));
  if (params?.sort_by) searchParams.set('sort_by', params.sort_by);
  if (params?.sort_dir) searchParams.set('sort_dir', params.sort_dir);
  if (params?.price_min != null) searchParams.set('price_min', String(params.price_min));
  if (params?.price_max != null) searchParams.set('price_max', String(params.price_max));
  const qs = searchParams.toString();
  return fetchJson(`/warehouse/products${qs ? '?' + qs : ''}`);
}

export interface ProductPrice {
  product_id: string;
  source_id: number;
  source_name: string;
  price_bez_dph: number;
  price_s_dph: number | null;
  currency: string;
  availability: string | null;
  stock_quantity: number | null;
  delivery_days: number | null;
  source_url: string | null;
  source_sku: string | null;
  fetched_at: string;
}

export async function getWarehouseProduct(id: string): Promise<WarehouseProduct & { prices: ProductPrice[] }> {
  return fetchJson(`/warehouse/products/${id}`);
}

export async function getWarehouseCategories(tree?: boolean): Promise<WarehouseCategory[]> {
  return fetchJson(`/warehouse/categories${tree ? '?tree=1' : ''}`);
}

export async function getWarehouseManufacturers(): Promise<string[]> {
  return fetchJson('/warehouse/manufacturers');
}

export interface DataSourceWithDetails {
  id: number;
  name: string;
  type: string;
  base_url: string | null;
  is_active: boolean;
  last_scraped_at: string | null;
  created_at: string;
  price_count: number;
  scraper_config: Record<string, unknown> | null;
}

export async function getWarehouseSources(): Promise<DataSourceWithDetails[]> {
  return fetchJson('/warehouse/sources');
}

export async function uploadImportFile(file: File): Promise<ImportPreview> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/warehouse/import/preview`, {
    method: 'POST',
    body: formData,
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
}

// Scraping
export async function startScraping(data: {
  source_id: number;
  query?: string;
  category_url?: string;
  max_items?: number;
  category_id?: number;
}): Promise<{ status: string; source: string }> {
  const res = await fetch(`${API_BASE}/warehouse/scrape`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Scrape failed');
  }
  return res.json();
}

export interface ScrapeJob {
  id: number;
  source_id: number;
  source_name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  query: string | null;
  items_found: number;
  items_new: number;
  items_updated: number;
  items_price_changed: number;
  duration_ms: number | null;
  created_at: string;
}

export async function getScrapeJobs(limit = 20): Promise<ScrapeJob[]> {
  return fetchJson(`/warehouse/scrape/jobs?limit=${limit}`);
}

export async function enrichWithIcecat(limit = 50): Promise<any> {
  const res = await fetch(`${API_BASE}/warehouse/enrich/icecat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ limit }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Icecat enrichment failed');
  }
  return res.json();
}

export async function runWarehouseImport(data: {
  upload_path: string;
  mapping: ImportPreview['suggested_mapping'];
  source_id: number;
  category_id?: number;
  enrich_params?: boolean;
}): Promise<ImportResult> {
  const res = await fetch(`${API_BASE}/warehouse/import/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Import failed');
  }
  return res.json();
}
