import express from 'express';
import cors from 'cors';
import multer from 'multer';
import archiver from 'archiver';
import { readFile, readdir, mkdir, stat, writeFile, rm, rename } from 'fs/promises';
import { getCostSummary } from './lib/cost-tracker.js';
import { join, extname, basename } from 'path';
import { existsSync, createWriteStream } from 'fs';
import { spawn } from 'child_process';
import { config } from 'dotenv';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { PriceOverrideSchema, ProductMatchSchema } from './lib/types.js';
import { buildInbox, type InboxTenderInput } from './lib/inbox.js';
import { convertToPdf, isGotenbergConfigured } from './lib/pdf-converter.js';
import { randomUUID, createHash } from 'crypto';
import { isJwtEnabled, signToken, verifyToken } from './lib/jwt-auth.js';
import {
  getAllUsers, getUserByEmail, getUserById, createUser,
  verifyPassword, updatePassword, deleteUser, updateLastLogin, isFirstRun,
} from './lib/user-store.js';
import {
  migrateFromLegacy as migrateCompanies,
  getAllCompanies, getCompany, createCompany, updateCompany, deleteCompany as deleteCompanyById,
  getCompanyDocuments, deleteCompanyDocument, getCompanyDocumentsDir,
  copyCompanyDocsToTender,
  getDocManifest, addDocToSlot, removeDocFromSlot, mapQualifikaceToSlots,
} from './lib/company-store.js';
import { DOC_SLOTS, type DocSlotType } from './lib/doc-slots.js';
import { isDbAvailable, closePool } from './lib/db.js';
import { runMigrations } from './lib/db-migrate.js';
import {
  getStatus, getAllStatuses, setStatus, setAssignee, logActivity, getActivity, getRecentActivity,
  getTask, getTasks, getMyTasks, getTaskCounts, createTask, updateTask, deleteTask, seedChecklist,
} from './lib/crm-store.js';
import {
  canTransition, allowedTransitions, deriveStageFromSteps, ALL_STAGES, type StageKey, type StepFlags,
} from './lib/stage-machine.js';
import { computeSubmitGate } from './lib/submit-gate.js';
import { checkPriceSanity } from './lib/price-sanity.js';
import type { PriceSanityFlag } from './lib/types.js';
import {
  getTerminy, getAllTerminy, createTermin, updateTermin, deleteTermin, seedTerminy, getDueReminders, markReminded,
} from './lib/terminy-store.js';
import { notify, getNotifications, getUnreadCount, markRead } from './lib/notif-store.js';
import { getComments, getComment, createComment, softDeleteComment } from './lib/comments-store.js';
import { getViews, getView, createView, deleteView } from './lib/views-store.js';
import {
  getTags, createTag, deleteTag, getTenderTags, getAllTenderTags, attachTag, detachTag,
} from './lib/tags-store.js';
import { updateUserRole, USER_ROLES, type UserRole } from './lib/user-store.js';
import {
  getWarehouseStats, getWarehouseQualityStats, searchProducts, getProduct, createProduct,
  updateProduct, deleteProduct, getCategories, getCategoryTree,
  getDataSources, getManufacturers, getProductPrices, getPriceHistory,
  upsertPrice,
} from './lib/warehouse-store.js';
import { getImportPreview, runImport, type ColumnMapping } from './lib/csv-importer.js';
import { generateMissingEmbeddings } from './lib/embedding-service.js';
import { runScraping, getScrapeJobs, type ScrapeConfig } from './lib/apify-client.js';
import { enrichProductsFromIcecat } from './lib/icecat-client.js';
import { winPriceBandHandler, winPriceStatsHandler } from './lib/winprice-api.js';
import { resolvePricingDefaults } from './lib/pricing-defaults.js';
import { getOutcome, upsertOutcome, getOutcomeStats, type VysledekPodani } from './lib/outcomes-store.js';
import { upsertWinPrices, deleteWinPrice, categorizeCommodity } from './lib/winprice-store.js';
import { z } from 'zod';
import { monitoringHlidacHandler } from './lib/monitoring/hlidac-route.js';
import { fetchNenTenders } from './lib/monitoring/nen-client.js';
import { fetchNewTenders } from './lib/monitoring/hlidac-client.js';
import {
  upsertFeed, listFeed, getFeedItem, setFeedStav,
  toNenFeedInput, toHlidacFeedInput, type MonitoringStav,
} from './lib/monitoring/monitoring-store.js';
import { scoreFeedItem, slugifyTender } from './lib/monitoring/monitoring-score.js';
import {
  RUN_ALL_STEPS,
  advanceRunAllChain,
  loadPipelineJobs,
  savePipelineJobs,
  type PipelineJob as Job,
  type PipelineStep,
} from './lib/pipeline-job-state.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;
const INPUT_DIR = join(ROOT, 'input');
const OUTPUT_DIR = join(ROOT, 'output');
const SCRIPTS_DIR = join(ROOT, 'scripts', 'src');
const JOBS_FILE = join(OUTPUT_DIR, '.jobs.json');
const PORT = process.env.API_PORT || 3001;

// Startup validation
const companyConfigPath = join(ROOT, 'config', 'company.json');
if (!existsSync(companyConfigPath)) {
  console.error('WARNING: config/company.json not found — generate step will fail');
}

const app = express();
// Case-sensitive routing: jinak Express (case-insensitive) namapuje /API/... na /api/... handler,
// zatímco req.path zůstane /API/... a case-sensitive `startsWith('/api/')` guardy v auth/RBAC
// middleware ho pustí bez ověření (auth+RBAC bypass). Tímto /API/... → 404, fail-closed.
app.set('case sensitive routing', true);
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- Security: path traversal protection ---
function isSafePath(value: string): boolean {
  return !value.includes('..') && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

// Middleware: validate :id and :filename params to prevent path traversal
app.param('id', (req, res, next, value) => {
  if (!isSafePath(value)) {
    return res.status(400).json({ error: 'Invalid tender ID' });
  }
  next();
});
app.param('filename', (req, res, next, value) => {
  if (!isSafePath(decodeURIComponent(value))) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  next();
});

// --- Auth middleware ---
// Supports: JWT Bearer token (frontend users), static API_TOKEN (n8n/curl), same-origin (localhost dev)
const API_TOKEN = process.env.API_TOKEN;

// Public routes that never require auth
const PUBLIC_PATHS = ['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup'];

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_PATHS.includes(req.path)) return next();

  // Auth se NOVĚ vynucuje i pro GET požadavky. Dřív byl `if (req.method === 'GET') return next();`
  // hned tady → všechny GET /api/* byly globálně veřejné (kdokoli se znalostí URL četl zakázky,
  // ceny, firemní IČO/DIČ/IBAN i cenový sklad bez přihlášení). Veřejné zůstávají jen cesty
  // z PUBLIC_PATHS (health, auth status/login/setup). Read-only role `viewer` čtení nadále smí —
  // RBAC middleware níže blokuje jen mutace.

  // 1. JWT Bearer token / legacy statický API_TOKEN (platí pro GET i mutace)
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    // Try JWT first
    const jwtPayload = verifyToken(token);
    if (jwtPayload) {
      (req as any).user = jwtPayload;
      return next();
    }
    // Try static API_TOKEN
    if (API_TOKEN && token === API_TOKEN) return next();
  }

  // 2. Support ?token= query param (for download links in <a href> a jiná GET stažení,
  //    kde prohlížeč neumí poslat Authorization hlavičku).
  if (req.query.token) {
    const qToken = req.query.token as string;
    const jwtPayload = verifyToken(qToken);
    if (jwtPayload) {
      (req as any).user = jwtPayload;
      return next();
    }
    if (API_TOKEN && qToken === API_TOKEN) return next();
  }

  // 3. Dev režim (JWT_SECRET nenastaven, isJwtEnabled()===false) = single-user lokální vývoj.
  //    - GET zůstává otevřené (jako dřív) → lokální vývoj bez tokenu funguje beze změny.
  //    - Mutace vyžadují same-origin z loopbacku. Origin/Referer i Host jsou klientem ovladatelné
  //      → NESMÍ sloužit jako auth signál v produkci; proto je celá tato větev v prod (JWT zapnutý)
  //      vypnutá a GET tam vyžaduje platný token (viz výše).
  if (!isJwtEnabled()) {
    if (req.method === 'GET') return next();
    try {
      const origin = req.headers.origin || req.headers.referer;
      const loopback = ['localhost', '127.0.0.1', '::1'];
      if (origin && loopback.includes(req.hostname)) {
        const originHost = new URL(origin).hostname;
        if (originHost === req.hostname) return next();
      }
    } catch {}
  }

  res.status(401).json({ error: 'Unauthorized' });
});

// RBAC (M7): viewer je read-only. Blokuj mutace (non-GET) pro roli viewer napříč API, kromě
// vlastních akcí (přečtení notifikací, změna vlastního hesla) a auth/setup. V dev bez JWT se
// neomezuje (single-user). Běží po auth middleware (req.user je nastaven pro platný JWT).
const ROLE_EXEMPT_MUTATIONS = new Set(['/api/notifications/read', '/api/auth/change-password']);
app.use(async (req, res, next) => {
  if (!isJwtEnabled()) return next();
  if (req.method === 'GET') return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/api/auth/')) return next();
  if (ROLE_EXEMPT_MUTATIONS.has(req.path)) return next();
  // Aktuální role z user-store (ne JWT claim) → demote na viewer se projeví ihned.
  const sub = (req as any).user?.sub;
  let role = (req as any).user?.role as UserRole | undefined;
  if (sub) {
    const u = await getUserById(sub);
    role = (u?.role as UserRole | undefined);
  }
  if (role === 'viewer') {
    return res.status(403).json({ error: 'forbidden_role', reason: 'Účet s rolí Prohlížeč nemůže provádět změny.' });
  }
  next();
});

// --- Async Job Queue ---

const jobs = new Map<string, Job>();
let currentJob: string | null = null;
const jobQueue: string[] = [];
let persistTimer: NodeJS.Timeout | null = null;
let persistDirty = false;
let persistPromise = Promise.resolve();

// Logy mohou přicházet po malých kusech, proto zápisy krátce slučujeme. Stavové přechody
// přesto vždy skončí v atomickém snapshotu output/.jobs.json.
function scheduleJobsPersist() {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { void flushJobsPersist(); }, 50);
}

async function flushJobsPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty) return persistPromise;
  persistDirty = false;
  const snapshot = [...jobs.values()].map((job) => ({ ...job, logs: [...job.logs] }));
  persistPromise = persistPromise
    .then(() => savePipelineJobs(JOBS_FILE, snapshot))
    .catch((err) => console.error('Job persistence error:', err));
  await persistPromise;
  if (persistDirty) scheduleJobsPersist();
}

// Jediný zdroj pravdy: mapa krok → skript. Sdílená frontou (processQueue) i run endpointem,
// aby se obě mapy nerozešly — dřív run endpoint 'verify-prices' NEznal, takže tlačítko
// „Ověřit ceny z webu" vracelo 400 „Unknown step".
const STEP_FILES: Record<string, string> = {
  extract: 'extract-tender.ts',
  analyze: 'analyze-tender.ts',
  match: 'match-product.ts',
  generate: 'generate-bid.ts',
  validate: 'validate-bid.ts',
  'verify-prices': 'verify-prices.ts',
};

async function getStepGateError(tenderId: string, step: string): Promise<string | null> {
  if (step !== 'generate') return null;
  try {
    const matchRaw = await readFile(join(OUTPUT_DIR, tenderId, 'product-match.json'), 'utf-8');
    const matchData = ProductMatchSchema.parse(JSON.parse(matchRaw));

    if (matchData.polozky_match) {
      const unconfirmed = matchData.polozky_match.filter((item) => !item.cenova_uprava?.potvrzeno);
      if (unconfirmed.length > 0) {
        const names = unconfirmed.map((item) => item.polozka_nazev).join(', ');
        return `Nejprve potvrďte ceny u všech položek. Nepotvrzené: ${names}`;
      }
    } else if (!matchData.cenova_uprava?.potvrzeno) {
      return 'Nejprve potvrďte ceny v záložce Produkty. Bez potvrzené cenové kalkulace nelze generovat dokumenty.';
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return 'Nejprve spusťte krok "Produkty" a potvrďte ceny.';
    }
    return `Chyba při čtení product-match.json: ${String(err)}`;
  }
  return null;
}

function enqueueStepJob(tenderId: string, step: string, parentJobId?: string, startQueue = true): Job {
  let jobId = randomUUID().slice(0, 8);
  while (jobs.has(jobId)) jobId = randomUUID().slice(0, 8);
  const job: Job = {
    id: jobId,
    tenderId,
    step,
    status: 'queued',
    logs: [],
    startedAt: new Date().toISOString(),
    kind: 'step',
    parentJobId,
  };
  jobs.set(jobId, job);
  jobQueue.push(jobId);
  cleanupJobs();
  scheduleJobsPersist();
  if (startQueue) processQueue();
  console.log(`Job ${jobId} queued: ${step} for ${tenderId}`);
  return job;
}

function appendJobLogs(job: Job, lines: string[]) {
  if (lines.length === 0) return;
  job.logs.push(...lines);
  if (job.parentJobId) {
    const parent = jobs.get(job.parentJobId);
    parent?.logs.push(...lines.map((line) => `[${job.step}] ${line}`));
  }
  scheduleJobsPersist();
}

function processQueue() {
  if (currentJob) return;
  const nextId = jobQueue.shift();
  if (!nextId) return;

  const job = jobs.get(nextId);
  if (!job) {
    processQueue();
    return;
  }

  currentJob = nextId;
  job.status = 'running';
  if (job.parentJobId) {
    const parent = jobs.get(job.parentJobId);
    if (parent) {
      parent.status = 'running';
      parent.currentStep = job.step as PipelineStep;
    }
  }
  scheduleJobsPersist();

  const scriptFile = STEP_FILES[job.step];
  if (!scriptFile) {
    job.status = 'error';
    job.error = `Unknown step: ${job.step}`;
    job.finishedAt = new Date().toISOString();
    currentJob = null;
    scheduleJobsPersist();
    processQueue();
    return;
  }

  // Watchdog (dřív fixní 600s pro match/generate → dlouhá, ale živá generace umřela na SIGTERM):
  //  (a) IDLE timeout — když dítě 300s nic nevypíše, považuj ho za zaseknuté a ukonči.
  //  (b) absolutní strop — tvrdý horní limit i pro aktivně tekoucí proces; match a verify-prices
  //      mají velkorysých 1800s (desítky položek × web search), generate 600s, ostatní 300s.
  //  (c) po SIGTERM eskaluj na SIGKILL po 10s, pokud proces stále žije.
  //
  // IDLE_TIMEOUT_MS (300s) MUSÍ být komfortně VĚTŠÍ než wall-clock deadline match volání v
  // ai-client (240s). Během tichého AI volání dítě nic nevypisuje, takže idle timer běží proti
  // in-script deadlinu. Kdyby byly stejné (dřív obojí 240s), rodič by mohl SIGTERMnout child
  // přesně ve chvíli, kdy má naskočit graceful rozpůlení dávky (AICallTimeoutError) → celý retry
  // mechanismus by se negoval. S 60s marginem dítě abortuje první, vypíše varování (to resetuje
  // idle timer) a salvage přes půlení dávky proběhne. Idle watchdog tak chytá jen skutečně
  // zaseknuté (žádný progres) procesy.
  const IDLE_TIMEOUT_MS = 300000;
  // match: 188-položková zakázka (24 dávek à ~80 s) legitimně přesáhla 1800 s (job
  // tender-1779109774773 zabit na capu po 30 min živé práce) — cap je runaway pojistka,
  // reálné zaseknutí chytá idle watchdog (300 s bez outputu, heartbeat streamu ho drží).
  const ABSOLUTE_CAP_MS =
    (job.step === 'match' || job.step === 'verify-prices') ? 3600000
    : job.step === 'generate' ? 600000
    : job.step === 'analyze' ? 900000   // 32k-token analyze velké zakázky = jednotky minut
    : 300000;

  const child = spawn(
    'node',
    ['--import', 'tsx', join(SCRIPTS_DIR, scriptFile), `--tender-id=${job.tenderId}`],
    {
      cwd: join(ROOT, 'scripts'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let finished = false;

  // Ukonči dítě: SIGTERM + eskalace na SIGKILL po 10s, pokud stále běží.
  const terminate = (reason: string) => {
    if (finished) return;
    appendJobLogs(job, [`[TIMEOUT] ${reason}`]);
    try { child.kill('SIGTERM'); } catch { /* už mrtvý */ }
    setTimeout(() => {
      if (!finished) {
        appendJobLogs(job, ['[TIMEOUT] process still alive 10s after SIGTERM — sending SIGKILL']);
        try { child.kill('SIGKILL'); } catch { /* už mrtvý */ }
      }
    }, 10000);
  };

  let idleTimer: NodeJS.Timeout;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => terminate(`no output for ${IDLE_TIMEOUT_MS / 1000}s`), IDLE_TIMEOUT_MS);
  };
  resetIdleTimer();

  const absoluteTimer = setTimeout(
    () => terminate(`absolute cap ${ABSOLUTE_CAP_MS / 1000}s exceeded`),
    ABSOLUTE_CAP_MS,
  );

  child.stdout.on('data', (data: Buffer) => {
    resetIdleTimer();
    const lines = data.toString().split('\n').filter(Boolean);
    appendJobLogs(job, lines);
  });

  child.stderr.on('data', (data: Buffer) => {
    resetIdleTimer();
    const lines = data.toString().split('\n').filter(Boolean);
    appendJobLogs(job, lines);
  });

  const finishJob = (status: 'done' | 'error', error?: string) => {
    if (finished) return; // Guard against double-fire (error + close)
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
    job.status = status;
    if (error) job.error = error;
    job.finishedAt = new Date().toISOString();
    currentJob = null;
    scheduleJobsPersist();
    console.log(`Job ${job.id} (${job.step}/${job.tenderId}) ${job.status}`);
    const parent = job.parentJobId ? jobs.get(job.parentJobId) : undefined;
    if (!parent) {
      processQueue();
      return;
    }
    void advanceRunAllChain(parent, job, async (nextStep) => {
      const gateError = await getStepGateError(job.tenderId, nextStep);
      if (gateError) throw new Error(gateError);
      enqueueStepJob(job.tenderId, nextStep, parent.id, false);
    }).finally(() => {
      scheduleJobsPersist();
      processQueue();
    });
  };

  child.on('close', (code, signal) => {
    if (code === 0) {
      finishJob('done');
    } else {
      // Rozliš zabití watchdogem (SIGTERM/SIGKILL) od pádu skriptu — jasnější chybová hláška.
      const killed = signal === 'SIGTERM' || signal === 'SIGKILL';
      const tail = job.logs.slice(-3).join(' | ');
      const reason = killed
        ? `Krok ukončen watchdogem (${signal}) — pravděpodobně zaseknutý nebo příliš dlouhý. Poslední log: ${tail}`
        : `Process exited with code ${code}${signal ? ` (signal ${signal})` : ''}${tail ? ` — ${tail}` : ''}`;
      finishJob('error', reason);
    }
  });

  child.on('error', (err) => {
    finishJob('error', String(err));
  });

  console.log(`Job ${job.id} started: ${job.step} for ${job.tenderId}`);
}

// Clean up old jobs (keep last 100)
function cleanupJobs() {
  if (jobs.size <= 100) return;
  const sorted = [...jobs.values()]
    .filter(j => j.status === 'done' || j.status === 'error' || j.status === 'interrupted')
    .sort((a, b) => (a.startedAt > b.startedAt ? 1 : -1));
  const toRemove = sorted.slice(0, jobs.size - 100);
  for (const j of toRemove) {
    jobs.delete(j.id);
  }
}

// Middleware: assign a stable tender ID once per request (not per file)
function assignTenderId(req: express.Request, _res: express.Response, next: express.NextFunction) {
  if (!req.params.id && !(req as any)._tenderId) {
    (req as any)._tenderId = `tender-${Date.now()}`;
  }
  next();
}

// File upload config
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const tenderId = req.params.id || (req as any)._tenderId || `tender-${Date.now()}`;
      const dir = join(INPUT_DIR, tenderId);
      await mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      // Preserve original filename with proper encoding
      cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (['.pdf', '.docx', '.doc', '.xls', '.xlsx'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, DOC, XLS, and XLSX files are allowed'));
    }
  },
});

// Helper: get pipeline status for a tender
async function getPipelineStatus(tenderId: string) {
  const outputDir = join(OUTPUT_DIR, tenderId);
  const steps = {
    extract: 'pending' as string,
    analyze: 'pending' as string,
    match: 'pending' as string,
    generate: 'pending' as string,
    validate: 'pending' as string,
  };

  try {
    await stat(join(outputDir, 'extracted-text.json'));
    steps.extract = 'done';
  } catch {}
  try {
    await stat(join(outputDir, 'analysis.json'));
    steps.analyze = 'done';
  } catch {}
  try {
    await stat(join(outputDir, 'product-match.json'));
    steps.match = 'done';
  } catch {}
  try {
    const files = await readdir(outputDir);
    if (files.some((f) => f === 'technicky_navrh.docx' || f === 'cenova_nabidka.docx')) {
      steps.generate = 'done';
    }
  } catch {}
  try {
    await stat(join(outputDir, 'validation-report.json'));
    steps.validate = 'done';
  } catch {}

  // Check if any step is currently running via job queue
  for (const job of jobs.values()) {
    if (job.tenderId === tenderId && job.kind !== 'pipeline'
      && (job.status === 'running' || job.status === 'queued') && job.step in steps) {
      steps[job.step as keyof typeof steps] = 'running';
    }
  }

  const latestRunAll = [...jobs.values()]
    .filter((job) => job.tenderId === tenderId && job.kind === 'pipeline')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const runAll = latestRunAll ? {
    jobId: latestRunAll.id,
    status: latestRunAll.status,
    currentStep: latestRunAll.currentStep,
    failedStep: latestRunAll.failedStep,
    error: latestRunAll.error,
  } : undefined;

  return { tenderId, steps, runAll };
}

// CRM (M2): převod pipeline steps → boolean flags + výpočet efektivní fáze (persistovaná ?? odvozená).
function stepsDone(steps: { extract: string; analyze: string; match: string; generate: string; validate: string }): StepFlags {
  return {
    extract: steps.extract === 'done',
    analyze: steps.analyze === 'done',
    match: steps.match === 'done',
    generate: steps.generate === 'done',
    validate: steps.validate === 'done',
  };
}

// GET /api/health - health check (no auth required)
app.get('/api/health', async (_req, res) => {
  let gotenberg: 'ok' | 'unreachable' | 'not_configured' = 'not_configured';
  if (isGotenbergConfigured()) {
    try {
      const gotenbergUrl = (process.env.GOTENBERG_URL || '').replace(/\/$/, '');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const healthRes = await fetch(`${gotenbergUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      gotenberg = healthRes.ok ? 'ok' : 'unreachable';
    } catch {
      gotenberg = 'unreachable';
    }
  }
  const db = await isDbAvailable() ? 'ok' : 'unavailable';
  res.json({ status: 'ok', version: process.env.npm_package_version || '0.1.0', gotenberg, db });
});

// --- Auth endpoints ---

// Helper: require JWT auth for specific routes
function requireJwt(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const payload = verifyToken(auth.slice(7));
    if (payload) {
      (req as any).user = payload;
      return next();
    }
  }
  // Also check query token (for GET routes that need auth)
  if (req.query.token) {
    const payload = verifyToken(req.query.token as string);
    if (payload) {
      (req as any).user = payload;
      return next();
    }
  }
  res.status(401).json({ error: 'Unauthorized — JWT required' });
}

// RBAC (M7): omezení mutací dle role. V dev bez JWT (isJwtEnabled()===false) se neomezuje
// (single-user provoz). Legacy token bez role → dohledat z user-store dle sub (ať se nezamkne).
function requireRole(...roles: UserRole[]) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!isJwtEnabled()) return next();
    const sub = (req as any).user?.sub;
    // Aktuální role z user-store dle sub (ne z JWT claimu) → demote/revoke se projeví ihned,
    // ne až po expiraci tokenu (rememberMe = 30 dní). Fallback na claim jen bez sub.
    let role: UserRole | undefined = (req as any).user?.role;
    if (sub) {
      const u = await getUserById(sub);
      role = (u?.role as UserRole | undefined);
    }
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: 'forbidden_role', reason: 'Nedostatečná oprávnění pro tuto akci.' });
    }
    next();
  };
}

// GET /api/auth/status - check if setup is required
app.get('/api/auth/status', async (_req, res) => {
  try {
    const setupRequired = await isFirstRun();
    res.json({ setupRequired, jwtEnabled: isJwtEnabled() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auth/setup - create first user (only works when no users exist)
app.post('/api/auth/setup', async (req, res) => {
  try {
    const firstRun = await isFirstRun();
    if (!firstRun) {
      return res.status(403).json({ error: 'Setup already completed' });
    }
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const user = await createUser(email, name, password);
    if (isJwtEnabled()) {
      const token = signToken(user, true);
      await updateLastLogin(user.id);
      return res.json({ token, user });
    }
    res.json({ user });
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// POST /api/auth/login - authenticate and get JWT
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const valid = await verifyPassword(user, password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!isJwtEnabled()) {
      return res.status(500).json({ error: 'JWT_SECRET not configured on server' });
    }
    const { passwordHash: _, ...safeUser } = user;
    const token = signToken(safeUser, !!rememberMe);
    await updateLastLogin(user.id);
    res.json({ token, user: safeUser });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /api/auth/me - get current user info
app.get('/api/auth/me', requireJwt, async (req, res) => {
  try {
    const payload = (req as any).user;
    const user = await getUserById(payload.sub);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { passwordHash: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auth/change-password - change own password
app.post('/api/auth/change-password', requireJwt, async (req, res) => {
  try {
    const payload = (req as any).user;
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const user = await getUserById(payload.sub);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const valid = await verifyPassword(user, currentPassword);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await updatePassword(user.id, newPassword);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- User management endpoints ---

// GET /api/monitoring/hlidac - živý feed z Hlídače státu (jen admin).
app.get('/api/monitoring/hlidac', requireJwt, requireRole('admin'), monitoringHlidacHandler);

// POST /api/monitoring/sync - natáhne nové zakázky ze zdroje do tabulky monitoring_zakazky.
// Idempotentní: opakovaný běh nové jen doplní, stav dřív převzatých/ignorovaných nechá.
// zdroj: 'nen' (default, bez tokenu) | 'hlidac' (vyžaduje HLIDAC_TOKEN) | 'both'.
app.post('/api/monitoring/sync', requireJwt, async (req, res) => {
  try {
    const zdroj = typeof req.body?.zdroj === 'string' ? req.body.zdroj : 'nen';
    const q = typeof req.body?.q === 'string' ? req.body.q : '';

    const inputs = [];
    if (zdroj === 'nen' || zdroj === 'both') {
      const nen = await fetchNenTenders(q);
      inputs.push(...nen.map(toNenFeedInput));
    }
    if (zdroj === 'hlidac' || zdroj === 'both') {
      const hlidac = await fetchNewTenders(q);
      inputs.push(...hlidac.map(toHlidacFeedInput));
    }

    // Bez DB nelze feed perzistovat → 503 (ne pád). S DB uloží a vrátí počty.
    const inserted = await upsertFeed(inputs);
    res.json({ zdroj, nalezeno: inputs.length, novych: inserted });
  } catch (err) {
    if (err instanceof Error && err.message === 'db_unavailable') {
      return res.status(503).json({ error: 'Databáze není dostupná — feed nelze uložit.' });
    }
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/monitoring/feed?stav=nova - feed s dopočítaným quick go/no-go skóre.
app.get('/api/monitoring/feed', requireJwt, async (req, res) => {
  try {
    const stavParam = typeof req.query.stav === 'string' ? req.query.stav : 'nova';
    const stav = (['nova', 'prevzata', 'ignorovana'].includes(stavParam)
      ? stavParam
      : undefined) as MonitoringStav | undefined;

    const items = await listFeed(stav);
    // Firemní profil pro sektor/rozpočet faktor (bez něj skóre jen vynechá sektor).
    const company = await getCompany('default');
    const now = new Date();
    const withScore = items.map((item) => ({
      ...item,
      go_no_go: scoreFeedItem(item, company ?? undefined, now),
    }));
    res.json(withScore);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/monitoring/:id/prevzit - založí z feed položky zakázku (složka input/ + CRM stav).
// Dokumenty ZD nahraje operátor ručně (stažení příloh zde neřešíme).
app.post('/api/monitoring/:id/prevzit', requireJwt, async (req, res) => {
  const id = String(req.params.id); // Express params jsou vždy string; coerce kvůli typům
  const actor = (req as any).user?.sub ?? null;
  try {
    const item = await getFeedItem(id);
    if (!item) return res.status(404).json({ error: 'Položka feedu nenalezena.' });
    if (item.stav === 'prevzata' && item.tender_id) {
      return res.json({ tender_id: item.tender_id, alreadyTaken: true });
    }

    // Bezpečný unikátní název složky (isSafePath kompatibilní).
    let tenderId = slugifyTender(item.nazev, `zakazka-${id}`);
    if (!isSafePath(tenderId)) tenderId = `zakazka-${id}`;
    try {
      await stat(join(INPUT_DIR, tenderId));
      tenderId = `${tenderId}-${id}`; // kolize názvu → přípona z feed id
    } catch {}

    await mkdir(join(INPUT_DIR, tenderId), { recursive: true });
    await mkdir(join(OUTPUT_DIR, tenderId), { recursive: true });
    await writeFile(
      join(OUTPUT_DIR, tenderId, 'tender-meta.json'),
      JSON.stringify({
        name: item.nazev,
        created_at: new Date().toISOString(),
        source: {
          zdroj: item.zdroj,
          zdroj_id: item.zdroj_id,
          url: item.url,
          zadavatel: item.zadavatel,
          predpokladana_hodnota: item.predpokladana_hodnota,
          lhuta_nabidek: item.lhuta_nabidek,
        },
      }, null, 2),
      'utf-8',
    );

    // CRM stav 'nova' + zápis do feedu (stav 'prevzata', vazba tender_id). Bez DB → 503.
    await setStatus(tenderId, 'nova');
    await logActivity(tenderId, 'created_from_monitoring', actor, { zdroj: item.zdroj, zdroj_id: item.zdroj_id });
    await setFeedStav(id, 'prevzata', tenderId);

    res.json({ tender_id: tenderId });
  } catch (err) {
    if (err instanceof Error && err.message === 'db_unavailable') {
      return res.status(503).json({ error: 'Databáze není dostupná — zakázku nelze převzít.' });
    }
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/monitoring/:id/ignorovat - skryje položku z feedu (stav 'ignorovana').
app.post('/api/monitoring/:id/ignorovat', requireJwt, async (req, res) => {
  try {
    const updated = await setFeedStav(String(req.params.id), 'ignorovana');
    if (!updated) return res.status(404).json({ error: 'Položka feedu nenalezena.' });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === 'db_unavailable') {
      return res.status(503).json({ error: 'Databáze není dostupná.' });
    }
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/users - list all users
app.get('/api/users', requireJwt, async (_req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/users - create a new user (admin only)
app.post('/api/users', requireJwt, requireRole('admin'), async (req, res) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (role && !USER_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const user = await createUser(email, name, password, role);
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// PATCH /api/users/:userId/role - change a user's role (admin only)
app.patch('/api/users/:userId/role', requireJwt, requireRole('admin'), async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body ?? {};
    if (!role || !USER_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    const payload = (req as any).user;
    // Admin si nesmí sebrat vlastní admin roli (aby nezůstal systém bez admina omylem).
    if (payload?.sub === userId && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote your own admin role' });
    }
    const user = await updateUserRole(userId as string, role as UserRole);
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// DELETE /api/users/:userId - delete a user (self-deletion blocked, admin only)
app.delete('/api/users/:userId', requireJwt, requireRole('admin'), async (req, res) => {
  try {
    const payload = (req as any).user;
    const { userId } = req.params;
    if (payload.sub === userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await deleteUser(userId as string);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// GET /api/tenders - list all tenders
app.get('/api/tenders', async (req, res) => {
  try {
    // Volitelné agregované obohacení: `?include=analysis,cost` vloží kompaktní souhrn analýzy
    // a AI náklady rovnou do každé položky. Bez include je odpověď beze změny (zpětná kompatibilita).
    // Cíl: zrušit N+1 na Přehledu/Zakázkách/Pipeline, kde FE dřív posílal getAnalysis()+getCost()
    // jedním requestem za KAŽDOU zakázku.
    const include = String(req.query.include ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const wantAnalysis = include.includes('analysis');
    const wantCost = include.includes('cost');

    await mkdir(INPUT_DIR, { recursive: true });
    const dirs = await readdir(INPUT_DIR);
    const crmStatuses = await getAllStatuses();
    const taskCounts = await getTaskCounts();
    const tenderTags = await getAllTenderTags();
    const tenders = await Promise.all(
      dirs
        .filter((d) => !d.startsWith('.'))
        .map(async (tenderId) => {
          const inputFiles = await readdir(join(INPUT_DIR, tenderId));
          const pipeline = await getPipelineStatus(tenderId);
          // Read tender display name from meta
          let name: string | undefined;
          try {
            const meta = JSON.parse(await readFile(join(OUTPUT_DIR, tenderId, 'tender-meta.json'), 'utf-8'));
            name = meta.name;
          } catch {}
          const crm = crmStatuses.get(tenderId);
          const base: Record<string, unknown> = {
            id: tenderId,
            name,
            inputFiles: inputFiles.filter((f) => !f.startsWith('.')),
            ...pipeline,
            status: crm?.status ?? null,
            assignee: crm?.assignee ?? null,
            tasks: taskCounts.get(tenderId) ?? { done: 0, total: 0 },
            stitky: tenderTags.get(tenderId) ?? [],
          };

          // Kompaktní souhrn analýzy (jen pole, která seznamy reálně zobrazují) — analyzuje se
          // jen když analyze step doběhl, jinak `null` (žádné zbytečné čtení souboru).
          if (wantAnalysis) {
            let analysis: {
              nazev: string | null; evidencni_cislo: string | null;
              zadavatel_nazev: string | null; zadavatel_ico: string | null;
              predpokladana_hodnota: number | null; lhuta_nabidek: string | null;
              rozhodnuti: string | null;
              go_no_go: { score: number; doporuceni: 'GO' | 'ZVAZIT' | 'NOGO'; duvody: string[] } | null;
            } | null = null;
            if ((pipeline as any)?.steps?.analyze === 'done') {
              try {
                const a = JSON.parse(await readFile(join(OUTPUT_DIR, tenderId, 'analysis.json'), 'utf-8'));
                analysis = {
                  nazev: a?.zakazka?.nazev ?? null,
                  evidencni_cislo: a?.zakazka?.evidencni_cislo ?? null,
                  zadavatel_nazev: a?.zakazka?.zadavatel?.nazev ?? null,
                  zadavatel_ico: a?.zakazka?.zadavatel?.ico ?? null,
                  predpokladana_hodnota: a?.zakazka?.predpokladana_hodnota ?? null,
                  lhuta_nabidek: a?.terminy?.lhuta_nabidek ?? null,
                  rozhodnuti: a?.doporuceni?.rozhodnuti ?? null,
                  go_no_go: a?.go_no_go ?? null,
                };
              } catch {}
            }
            base.analysis = analysis;
          }

          if (wantCost) {
            let costTotalCZK: number | null = null;
            try {
              const summary = await getCostSummary(tenderId);
              costTotalCZK = summary?.totalCZK ?? null;
            } catch {}
            base.costTotalCZK = costTotalCZK;
          }

          return base;
        })
    );
    res.json(tenders);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/inbox - schvalovací inbox napříč zakázkami.
// Agreguje "co ode mě čeká akci": nepotvrzené ceny, HARD sanity flagy, počet fail
// checků z validace a CRM stav. Vrací jen zakázky, kde je akce potřeba (řazeno
// nejnaléhavější první). Čte soubory per zakázka defenzivně (try/catch, vadný JSON
// zakázku nezhodí, jen se z ní stane prázdný vstup).
app.get('/api/inbox', async (req, res) => {
  try {
    await mkdir(INPUT_DIR, { recursive: true });
    const dirs = (await readdir(INPUT_DIR)).filter((d) => !d.startsWith('.'));
    const crmStatuses = await getAllStatuses();

    const readJson = async (tenderId: string, file: string): Promise<unknown | null> => {
      try {
        return JSON.parse(await readFile(join(OUTPUT_DIR, tenderId, file), 'utf-8'));
      } catch {
        return null; // chybějící soubor i syntakticky vadný JSON => prázdný vstup
      }
    };

    const inputs: InboxTenderInput[] = await Promise.all(
      dirs.map(async (tenderId) => {
        const [analysis, productMatch, validation] = await Promise.all([
          readJson(tenderId, 'analysis.json'),
          readJson(tenderId, 'product-match.json'),
          readJson(tenderId, 'validation-report.json'),
        ]);
        return {
          tenderId,
          analysis,
          productMatch,
          validation,
          crmStav: crmStatuses.get(tenderId)?.status ?? null,
        };
      }),
    );

    res.json(buildInbox(inputs));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/tenders/upload - upload new tender documents
app.post('/api/tenders/upload', assignTenderId, upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    // Extract tender ID from the first file's destination
    const tenderId = files[0].destination.split('/').pop()!;
    const status = await getPipelineStatus(tenderId);
    res.json({
      id: tenderId,
      uploadedFiles: files.map((f) => f.filename),
      ...status,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/tenders/:id/upload - upload files to existing tender
app.post('/api/tenders/:id/upload', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const status = await getPipelineStatus(req.params.id);
    res.json({
      id: req.params.id,
      uploadedFiles: files.map((f) => f.filename),
      ...status,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/tenders/upload-url - download tender documents from URLs (for n8n integration)
app.post('/api/tenders/upload-url', async (req, res) => {
  try {
    const { urls, tenderId: customId, metadata } = req.body as {
      urls: string[];
      tenderId?: string;
      metadata?: Record<string, unknown>;
    };

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'Provide "urls" array with document URLs' });
    }

    // Validate tenderId if custom
    if (customId && !isSafePath(customId)) {
      return res.status(400).json({ error: 'Invalid tenderId' });
    }

    const allowedExts = ['.pdf', '.docx', '.doc', '.xls', '.xlsx'];
    const tenderId = customId || `tender-${Date.now()}`;
    const dir = join(INPUT_DIR, tenderId);
    await mkdir(dir, { recursive: true });

    const downloaded: string[] = [];
    const errors: string[] = [];

    for (const url of urls) {
      try {
        // SSRF protection: block private/internal URLs
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push(`${url}: only http/https allowed`);
          continue;
        }
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1'
          || host.startsWith('10.') || host.startsWith('192.168.')
          || host.startsWith('169.254.') || host.endsWith('.local')
          || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          errors.push(`${url}: private/internal URLs not allowed`);
          continue;
        }

        const response = await fetch(url);
        if (!response.ok) {
          errors.push(`${url}: HTTP ${response.status}`);
          continue;
        }

        // Extract filename from URL or Content-Disposition header
        const disposition = response.headers.get('content-disposition');
        let filename: string;
        if (disposition) {
          const match = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)/i);
          filename = match ? decodeURIComponent(match[1]) : basename(new URL(url).pathname);
        } else {
          filename = decodeURIComponent(basename(new URL(url).pathname));
        }
        // Sanitize filename — strip path components
        filename = basename(filename).replace(/[^\w.\-\u00C0-\u024F ]/g, '_');

        // Ensure valid extension
        const ext = extname(filename).toLowerCase();
        if (!allowedExts.includes(ext)) {
          // Try to infer from content-type
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('pdf')) filename += '.pdf';
          else if (ct.includes('word') || ct.includes('docx')) filename += '.docx';
          else if (ct.includes('spreadsheet') || ct.includes('xlsx')) filename += '.xlsx';
          else {
            errors.push(`${url}: unsupported file type (${ext || ct})`);
            continue;
          }
        }

        const filePath = join(dir, filename);
        const body = response.body;
        if (!body) {
          errors.push(`${url}: empty response body`);
          continue;
        }
        await pipeline(Readable.fromWeb(body as any), createWriteStream(filePath));
        downloaded.push(filename);
      } catch (err) {
        errors.push(`${url}: ${String(err)}`);
      }
    }

    // Save metadata if provided (e.g. from Hlídač státu)
    if (metadata) {
      await writeFile(join(dir, '_metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    }

    const status = await getPipelineStatus(tenderId);
    res.json({
      id: tenderId,
      downloadedFiles: downloaded,
      errors: errors.length > 0 ? errors : undefined,
      ...status,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/tenders/:id - delete a tender (input + output)
app.delete('/api/tenders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const inputPath = join(INPUT_DIR, id);
    const outputPath = join(OUTPUT_DIR, id);
    await rm(inputPath, { recursive: true, force: true });
    await rm(outputPath, { recursive: true, force: true });
    res.json({ success: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/tenders/:id/name - rename tender
app.put('/api/tenders/:id/name', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Name is required' });
  }
  try {
    const metaPath = join(OUTPUT_DIR, id, 'tender-meta.json');
    await mkdir(join(OUTPUT_DIR, id), { recursive: true });
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(await readFile(metaPath, 'utf-8')); } catch {}
    meta.name = name.trim();
    if (!meta.created_at) meta.created_at = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    res.json({ success: true, name: meta.name });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/cost - AI cost summary
app.get('/api/tenders/:id/cost', async (req, res) => {
  try {
    const summary = await getCostSummary(req.params.id);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/status - pipeline status
app.get('/api/tenders/:id/status', async (req, res) => {
  try {
    const status = await getPipelineStatus(req.params.id);
    let pdfAvailable = false;
    try {
      const outputDir = join(OUTPUT_DIR, req.params.id);
      const files = await readdir(outputDir);
      pdfAvailable = files.some(f => f.endsWith('.pdf'));
    } catch {
      // output dir may not exist yet
    }
    // CRM lifecycle stav (persistovaný ?? odvozený) + povolené přechody pro „Změnit stav".
    const done = stepsDone(status.steps);
    const crm = await getStatus(req.params.id);
    const effectiveStatus = crm?.status ?? deriveStageFromSteps(done);
    res.json({
      ...status,
      pdfAvailable,
      status: crm?.status ?? null,
      assignee: crm?.assignee ?? null,
      effectiveStatus,
      allowedNext: allowedTransitions(effectiveStatus, done),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/extracted-text
app.get('/api/tenders/:id/extracted-text', async (req, res) => {
  try {
    const data = await readFile(
      join(OUTPUT_DIR, req.params.id, 'extracted-text.json'),
      'utf-8'
    );
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: 'Not found — run extract step first' });
  }
});

// GET /api/tenders/:id/analysis
app.get('/api/tenders/:id/analysis', async (req, res) => {
  try {
    const data = await readFile(
      join(OUTPUT_DIR, req.params.id, 'analysis.json'),
      'utf-8'
    );
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: 'Not found — run analyze step first' });
  }
});

// GET /api/tenders/:id/product-match
app.get('/api/tenders/:id/product-match', async (req, res) => {
  try {
    const data = await readFile(
      join(OUTPUT_DIR, req.params.id, 'product-match.json'),
      'utf-8'
    );
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: 'Not found — run match step first' });
  }
});

// GET /api/tenders/:id/pricing-defaults — výchozí marže pro cenové potvrzení v UI.
// Resolve řetězec: firma zakázky → default firma → legacy config/company.json → 10 %.
// Záměrně vždy 200 (resolvePricingDefaults nikdy nevyhazuje) — je to UI default,
// ne kritická data; 5xx by zbytečně rozbilo cenový panel.
app.get('/api/tenders/:id/pricing-defaults', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  res.json(await resolvePricingDefaults(id));
});

// GET /api/tenders/:id/documents - list generated documents
app.get('/api/tenders/:id/documents', async (req, res) => {
  try {
    const outputDir = join(OUTPUT_DIR, req.params.id);
    const files = await readdir(outputDir);
    const docFiles = files.filter((f) => f.endsWith('.docx') || f.endsWith('.xlsx') || f.endsWith('.pdf'));
    // U vícedílných soupisů může poslední část vzniknout dvakrát: finální `soupis_filled_<X>.xlsx`
    // (krok 4D) i surová template-fill meziverze `<X>.xlsx` — tu skryj, ať uchazeč nepřiloží
    // špatnou verzi. Skrýváme jen když finální protějšek existuje.
    const rawSoupisWithFilled = new Set(
      docFiles.filter((f) => f.startsWith('soupis_filled_')).map((f) => f.slice('soupis_filled_'.length)),
    );
    const visible = docFiles.filter((f) => !rawSoupisWithFilled.has(f));
    res.json(visible);
  } catch {
    res.status(404).json({ error: 'No documents found — run generate step first' });
  }
});

// GET /api/tenders/:id/documents/:filename - download document
app.get('/api/tenders/:id/documents/:filename', async (req, res) => {
  try {
    const filePath = join(OUTPUT_DIR, req.params.id, req.params.filename);
    await stat(filePath);
    res.download(filePath);
  } catch {
    res.status(404).json({ error: 'Document not found' });
  }
});

// POST /api/tenders/:id/documents/:filename/convert-pdf
app.post('/api/tenders/:id/documents/:filename/convert-pdf', async (req, res) => {
  try {
    if (!isGotenbergConfigured()) {
      return res.status(503).json({ error: 'Gotenberg is not configured (GOTENBERG_URL not set)' });
    }
    const { id, filename } = req.params;
    const decodedFilename = decodeURIComponent(filename);
    if (!decodedFilename.endsWith('.docx') && !decodedFilename.endsWith('.xlsx')) {
      return res.status(400).json({ error: 'Only .docx and .xlsx files can be converted to PDF' });
    }
    const docxPath = join(OUTPUT_DIR, id, decodedFilename);
    if (!existsSync(docxPath)) {
      return res.status(404).json({ error: `File not found: ${decodedFilename}` });
    }
    const pdfBuffer = await convertToPdf(docxPath);
    if (!pdfBuffer) {
      return res.status(500).json({ error: 'PDF conversion returned empty result' });
    }
    const pdfFilename = decodedFilename.replace(/\.(docx|xlsx)$/, '.pdf');
    await writeFile(join(OUTPUT_DIR, id, pdfFilename), pdfBuffer);
    res.json({ success: true, pdfFilename });
  } catch (err) {
    res.status(500).json({ error: `PDF conversion failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// GET /api/tenders/:id/documents/:filename/validation - field-by-field validation
app.get('/api/tenders/:id/documents/:filename/validation', async (req, res) => {
  try {
    const { id, filename } = req.params;
    const fieldValidationPath = join(OUTPUT_DIR, id, 'field-validation.json');
    if (!existsSync(fieldValidationPath)) {
      return res.status(404).json({ error: 'Field validation not found — run validate step first' });
    }
    const allResults = JSON.parse(await readFile(fieldValidationPath, 'utf-8'));
    const result = allResults.find((r: any) => r.document === decodeURIComponent(filename));
    if (!result) {
      return res.status(404).json({ error: `No validation data for ${filename}` });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/tenders/:id/documents/:filename/mode - set generation mode override
app.put('/api/tenders/:id/documents/:filename/mode', async (req, res) => {
  try {
    const { id, filename } = req.params;
    const { mode } = req.body;
    if (!['clean', 'reconstruct', 'fill'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Must be: clean, reconstruct, or fill' });
    }
    const modesPath = join(OUTPUT_DIR, id, 'document-modes.json');
    let modes: Record<string, string> = {};
    try {
      modes = JSON.parse(await readFile(modesPath, 'utf-8'));
    } catch {}
    modes[decodeURIComponent(filename)] = mode;
    await writeFile(modesPath, JSON.stringify(modes, null, 2), 'utf-8');
    res.json({ success: true, modes });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Pozn.: dřívější `POST /api/tenders/:id/documents/:filename/regenerate` byl odstraněn — nic
// nereregeneroval, jen vracel textový návod „spusť generate znovu" a neměl žádného konzumenta
// ve frontendu. Regenerace jednoho dokumentu se dělá přes plný generate krok
// (`POST /api/tenders/:id/run/generate`), který respektuje uložené mode-overrides.

// GET /api/tenders/:id/generation-meta - generation metadata (modes, costs per document)
app.get('/api/tenders/:id/generation-meta', async (req, res) => {
  try {
    const data = await readFile(join(OUTPUT_DIR, req.params.id, 'generation-meta.json'), 'utf-8');
    res.json(JSON.parse(data));
  } catch {
    // Před prvním generováním soubor neexistuje — prázdný objekt místo 404 (console noise v UI).
    res.json({});
  }
});

// GET /api/tenders/:id/field-validation - all field validation results
app.get('/api/tenders/:id/field-validation', async (req, res) => {
  try {
    const data = await readFile(join(OUTPUT_DIR, req.params.id, 'field-validation.json'), 'utf-8');
    res.json(JSON.parse(data));
  } catch {
    // Před první validací soubor neexistuje — prázdné pole místo 404 (console noise v UI).
    res.json([]);
  }
});

// GET /api/tenders/:id/download/documents - ZIP of generated docs (DOCX/XLSX/PDF)
app.get('/api/tenders/:id/download/documents', async (req, res) => {
  const { id } = req.params;
  try {
    const outputDir = join(OUTPUT_DIR, id);
    const files = await readdir(outputDir);
    const docFiles = files.filter(f =>
      f.endsWith('.docx') || f.endsWith('.xlsx') || f.endsWith('.pdf')
    );
    if (docFiles.length === 0) {
      return res.status(404).json({ error: 'No documents found' });
    }
    // Get tender name for filename
    let zipName = id;
    try {
      const meta = JSON.parse(await readFile(join(outputDir, 'tender-meta.json'), 'utf-8'));
      if (meta.name) zipName = meta.name.replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, '').substring(0, 60);
    } catch {}
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}_dokumenty.zip"`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    for (const f of docFiles) {
      archive.file(join(outputDir, f), { name: f });
    }
    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/download/bundle - ZIP of docs + prilohy attachments
app.get('/api/tenders/:id/download/bundle', async (req, res) => {
  const { id } = req.params;
  try {
    const outputDir = join(OUTPUT_DIR, id);
    const files = await readdir(outputDir);
    const docFiles = files.filter(f =>
      f.endsWith('.docx') || f.endsWith('.xlsx') || f.endsWith('.pdf')
    );
    // Get attachments
    let attachmentFiles: string[] = [];
    const prilohyDir = join(outputDir, 'prilohy');
    try {
      attachmentFiles = (await readdir(prilohyDir)).filter(f => !f.startsWith('.'));
    } catch {}
    if (docFiles.length === 0 && attachmentFiles.length === 0) {
      return res.status(404).json({ error: 'No files to bundle' });
    }
    let zipName = id;
    try {
      const meta = JSON.parse(await readFile(join(outputDir, 'tender-meta.json'), 'utf-8'));
      if (meta.name) zipName = meta.name.replace(/[^a-zA-Z0-9\u00C0-\u024F _-]/g, '').substring(0, 60);
    } catch {}
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}_kompletni_nabidka.zip"`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);
    for (const f of docFiles) {
      archive.file(join(outputDir, f), { name: f });
    }
    for (const f of attachmentFiles) {
      archive.file(join(prilohyDir, f), { name: `prilohy/${f}` });
    }
    await archive.finalize();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/parts - get parts and selection
app.get('/api/tenders/:id/parts', async (req, res) => {
  const { id } = req.params;
  try {
    // Read casti from analysis.json
    let casti: any[] = [];
    try {
      const analysis = JSON.parse(await readFile(join(OUTPUT_DIR, id, 'analysis.json'), 'utf-8'));
      casti = analysis.casti || [];
    } catch {}

    // Read selected parts from parts-selection.json
    let selected_parts: string[] = [];
    try {
      const sel = JSON.parse(await readFile(join(OUTPUT_DIR, id, 'parts-selection.json'), 'utf-8'));
      selected_parts = sel.selected_parts || [];
    } catch {
      // Default: all parts selected
      selected_parts = casti.map((c: any) => c.id);
    }

    res.json({ casti, selected_parts });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/tenders/:id/parts - save parts selection
app.put('/api/tenders/:id/parts', async (req, res) => {
  const { id } = req.params;
  try {
    const { selected_parts } = req.body;
    if (!Array.isArray(selected_parts)) {
      return res.status(400).json({ error: 'selected_parts must be an array' });
    }
    const outputDir = join(OUTPUT_DIR, id);
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      join(outputDir, 'parts-selection.json'),
      JSON.stringify({ selected_parts, updated_at: new Date().toISOString() }, null, 2),
      'utf-8',
    );
    res.json({ success: true, selected_parts });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/validation
app.get('/api/tenders/:id/validation', async (req, res) => {
  try {
    const data = await readFile(
      join(OUTPUT_DIR, req.params.id, 'validation-report.json'),
      'utf-8'
    );
    res.json(JSON.parse(data));
  } catch {
    res.status(404).json({ error: 'Not found — run validate step first' });
  }
});

// PUT /api/tenders/:id/product-match/price - save price override (legacy single-product)
app.put('/api/tenders/:id/product-match/price', async (req, res) => {
  const { id } = req.params;
  const matchPath = join(OUTPUT_DIR, id, 'product-match.json');

  try {
    const raw = await readFile(matchPath, 'utf-8');
    const productMatch = JSON.parse(raw);

    // Validate the incoming price override
    const parsed = PriceOverrideSchema.parse(req.body);

    // Merge into product-match.json
    productMatch.cenova_uprava = parsed;
    await writeFile(matchPath, JSON.stringify(productMatch, null, 2), 'utf-8');

    res.json({ success: true, cenova_uprava: parsed });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'product-match.json not found — run match step first' });
    }
    res.status(400).json({ error: `Invalid price data: ${String(err.message || err)}` });
  }
});

/** Přepočítá a uloží flagy všech položek v objektu, aniž by měnil jejich ceny nebo potvrzení. */
function refreshPriceSanityFlags(productMatch: any): PriceSanityFlag[] {
  if (!Array.isArray(productMatch.polozky_match)) return [];
  const findings = checkPriceSanity(productMatch.polozky_match, {});
  for (const item of productMatch.polozky_match) {
    item.sanity_flags = findings.filter((finding) => finding.polozka_index === item.polozka_index);
  }
  return findings;
}

/** Vrátí nálezy patřící pozicím položek, které právě potvrzujeme. */
function findingsForItemPositions(
  productMatch: any,
  findings: PriceSanityFlag[],
  itemPositions: readonly number[],
): PriceSanityFlag[] {
  const polozkaIndexes = new Set(
    itemPositions.map((position) => productMatch.polozky_match[position]?.polozka_index),
  );
  return findings.filter((finding) => polozkaIndexes.has(finding.polozka_index));
}

function formatSanityBlockingMessage(productMatch: any, findings: PriceSanityFlag[]): string {
  const names = new Map(
    productMatch.polozky_match.map((item: any) => [item.polozka_index, item.polozka_nazev]),
  );
  return findings
    .map((finding) => `„${names.get(finding.polozka_index) ?? `položka #${finding.polozka_index + 1}`}“: ${finding.message}`)
    .join(' ');
}

// PUT /api/tenders/:id/product-match/price/bulk - hromadné potvrzení cen více položek.
// MUSÍ být registrováno PŘED `/price/:itemIndex`, jinak by Express „bulk" chytil jako :itemIndex.
// Transakčně nad souborem product-match.json: jedno čtení → aplikace všech → jeden zápis
// (ceny žijí v souboru, ne v DB), takže hromadné potvrzení = jeden atomický zápis, ne N souběžných.
app.put('/api/tenders/:id/product-match/price/bulk', async (req, res) => {
  const { id } = req.params;
  const matchPath = join(OUTPUT_DIR, id, 'product-match.json');

  try {
    const items = (req.body as any)?.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Očekávám neprázdné pole `items`.' });
    }
    // Zvaliduj každou položku (index + PriceOverrideSchema) do dočasného pole — teprve po
    // úspěšné validaci VŠECH se zapisuje (buď projde vše, nebo nic → žádný částečný zápis).
    const validated = items.map((it: any, i: number) => {
      const idx = Number(it?.itemIndex);
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error(`items[${i}].itemIndex musí být nezáporné celé číslo`);
      }
      return { idx, cenova_uprava: PriceOverrideSchema.parse(it?.cenova_uprava) };
    });

    const raw = await readFile(matchPath, 'utf-8');
    const productMatch = JSON.parse(raw);

    if (!Array.isArray(productMatch.polozky_match)) {
      return res.status(400).json({ error: 'Tato zakázka nemá víc položek (polozky_match) — použij single-item endpoint.' });
    }
    const len = productMatch.polozky_match.length;

    for (const v of validated) {
      if (v.idx >= len) {
        return res.status(400).json({ error: `Neplatný index položky ${v.idx}` });
      }
    }
    for (const v of validated) {
      productMatch.polozky_match[v.idx].cenova_uprava = v.cenova_uprava;
    }

    let warnings: PriceSanityFlag[] = [];
    const confirmedPositions = validated
      .filter((value) => value.cenova_uprava.potvrzeno)
      .map((value) => value.idx);
    if (confirmedPositions.length > 0) {
      const findings = refreshPriceSanityFlags(productMatch);
      const confirmedFindings = findingsForItemPositions(productMatch, findings, confirmedPositions);
      const hardFindings = confirmedFindings.filter((finding) => finding.level === 'hard');
      if (hardFindings.length > 0) {
        return res.status(409).json({
          error: `Ceny nelze potvrdit: ${formatSanityBlockingMessage(productMatch, hardFindings)}`,
          sanity_flags: hardFindings,
        });
      }
      warnings = confirmedFindings.filter((finding) => finding.level === 'warn');
    }
    await writeFile(matchPath, JSON.stringify(productMatch, null, 2), 'utf-8');

    res.json({ success: true, updated: validated.length, warnings });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'product-match.json not found — run match step first' });
    }
    res.status(400).json({ error: `Invalid price data: ${String(err.message || err)}` });
  }
});

// PUT /api/tenders/:id/product-match/price/:itemIndex - save price override for a specific item
app.put('/api/tenders/:id/product-match/price/:itemIndex', async (req, res) => {
  const { id, itemIndex } = req.params;
  const idx = parseInt(itemIndex, 10);
  const matchPath = join(OUTPUT_DIR, id, 'product-match.json');

  try {
    const raw = await readFile(matchPath, 'utf-8');
    const productMatch = JSON.parse(raw);

    if (!productMatch.polozky_match || idx < 0 || idx >= productMatch.polozky_match.length) {
      return res.status(400).json({ error: `Invalid item index ${idx}` });
    }

    const parsed = PriceOverrideSchema.parse(req.body);
    productMatch.polozky_match[idx].cenova_uprava = parsed;

    let warnings: PriceSanityFlag[] = [];
    if (parsed.potvrzeno) {
      const findings = refreshPriceSanityFlags(productMatch);
      const itemFindings = findingsForItemPositions(productMatch, findings, [idx]);
      const hardFindings = itemFindings.filter((finding) => finding.level === 'hard');
      if (hardFindings.length > 0) {
        return res.status(409).json({
          error: `Cenu nelze potvrdit: ${formatSanityBlockingMessage(productMatch, hardFindings)}`,
          sanity_flags: hardFindings,
        });
      }
      warnings = itemFindings.filter((finding) => finding.level === 'warn');
    }
    await writeFile(matchPath, JSON.stringify(productMatch, null, 2), 'utf-8');

    res.json({ success: true, itemIndex: idx, cenova_uprava: parsed, warnings });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'product-match.json not found — run match step first' });
    }
    res.status(400).json({ error: `Invalid price data: ${String(err.message || err)}` });
  }
});

// PUT /api/tenders/:id/product-match/select - ruční výběr produktového kandidáta operátorem.
// Body: { itemIndex, candidateIndex }. AI někdy vybere špatného kandidáta (vybrany_index) a
// operátor to musí umět přepnout. U multi-item zakázky se položka hledá dle `polozka_index`
// (ne dle pozice v poli — verify-prices používá stejný klíč), u legacy single-product formátu
// se pracuje s kořenovým `kandidati`/`vybrany_index` a itemIndex se ignoruje.
//
// MONEY-PATH: pokud položka měla potvrzenou `cenova_uprava`, byla vázaná na PŘEDCHOZÍ produkt.
// Změnou kandidáta ji smažeme (`priceCleared: true`) — cenu musí operátor potvrdit znovu, ať
// se do nabídky nedostane cena od jiného produktu. Zápis atomicky (tmp + rename) a soubor se
// čte těsně před zápisem (vzor verify-prices), aby souběžné potvrzení ceny nepřepsal stale snapshotem.
app.put('/api/tenders/:id/product-match/select', async (req, res) => {
  const { id } = req.params;
  const matchPath = join(OUTPUT_DIR, id, 'product-match.json');

  try {
    const { itemIndex, candidateIndex } = (req.body ?? {}) as { itemIndex?: unknown; candidateIndex?: unknown };
    const candIdx = Number(candidateIndex);
    if (!Number.isInteger(candIdx) || candIdx < 0) {
      return res.status(400).json({ error: 'candidateIndex musí být nezáporné celé číslo' });
    }

    // Čtení těsně před zápisem = nejčerstvější stav (lost-update ochrana proti souběžnému potvrzení ceny).
    const productMatch = JSON.parse(await readFile(matchPath, 'utf-8'));

    // Vyber cílovou položku: multi-item dle polozka_index, jinak legacy kořen.
    let target: { kandidati?: unknown[]; vybrany_index?: number; cenova_uprava?: unknown };
    if (Array.isArray(productMatch.polozky_match)) {
      const itemIdx = Number(itemIndex);
      if (!Number.isInteger(itemIdx)) {
        return res.status(400).json({ error: 'itemIndex musí být celé číslo' });
      }
      const found = productMatch.polozky_match.find((p: any) => p?.polozka_index === itemIdx);
      if (!found) {
        return res.status(404).json({ error: `Položka s polozka_index ${itemIdx} nenalezena` });
      }
      target = found;
    } else if (Array.isArray(productMatch.kandidati)) {
      target = productMatch;
    } else {
      return res.status(404).json({ error: 'product-match.json nemá kandidáty' });
    }

    const kandidati = target.kandidati;
    if (!Array.isArray(kandidati) || candIdx >= kandidati.length) {
      return res.status(400).json({ error: `Neplatný index kandidáta ${candIdx}` });
    }

    // Změnou kandidáta se ruší dřív potvrzená cena (vázaná na jiný produkt).
    let priceCleared = false;
    if (target.cenova_uprava !== undefined) {
      delete target.cenova_uprava;
      priceCleared = true;
    }
    target.vybrany_index = candIdx;

    const tmpPath = `${matchPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(productMatch, null, 2), 'utf-8');
    await rename(tmpPath, matchPath);

    res.json({ success: true, itemIndex: Number(itemIndex), candidateIndex: candIdx, priceCleared });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'product-match.json not found — run match step first' });
    }
    res.status(400).json({ error: `Nepodařilo se vybrat produkt: ${String(err.message || err)}` });
  }
});

// --- Attachments (qualification documents) ---

const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const dir = join(OUTPUT_DIR, req.params.id as string, 'prilohy');
      await mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (['.pdf', '.docx', '.doc', '.xls', '.xlsx', '.jpg', '.jpeg', '.png'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, XLS/XLSX, and image files are allowed'));
    }
  },
});

// POST /api/tenders/:id/attachments - upload qualification documents
app.post('/api/tenders/:id/attachments', attachmentUpload.array('files', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const dir = join(OUTPUT_DIR, req.params.id as string, 'prilohy');
    const allFiles = await readdir(dir);
    res.json({
      uploaded: files.map(f => f.filename),
      attachments: allFiles.filter(f => !f.startsWith('.')),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/attachments - list attachments
app.get('/api/tenders/:id/attachments', async (req, res) => {
  try {
    const dir = join(OUTPUT_DIR, req.params.id, 'prilohy');
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    res.json(files.filter(f => !f.startsWith('.')));
  } catch {
    res.json([]);
  }
});

// DELETE /api/tenders/:id/attachments/:filename - delete an attachment
app.delete('/api/tenders/:id/attachments/:filename', async (req, res) => {
  try {
    const filePath = join(OUTPUT_DIR, req.params.id, 'prilohy', req.params.filename);
    await rm(filePath, { force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/attachments/:filename - download an attachment
app.get('/api/tenders/:id/attachments/:filename', async (req, res) => {
  try {
    const filePath = join(OUTPUT_DIR, req.params.id, 'prilohy', req.params.filename);
    await stat(filePath);
    res.download(filePath);
  } catch {
    res.status(404).json({ error: 'Attachment not found' });
  }
});

// --- Company management API ---

app.param('companyId', (req, res, next, value) => {
  if (!isSafePath(value)) {
    return res.status(400).json({ error: 'Invalid company ID' });
  }
  next();
});

// GET /api/companies - list all companies
app.get('/api/companies', async (_req, res) => {
  try {
    const companies = await getAllCompanies();
    res.json(companies);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/companies/:companyId - get company detail
app.get('/api/companies/:companyId', async (req, res) => {
  try {
    const company = await getCompany(req.params.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(company);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/companies - create company
app.post('/api/companies', async (req, res) => {
  try {
    const { nazev, ico, dic, sidlo, jednajici_osoba, ...rest } = req.body;
    if (!nazev || !ico || !sidlo || !jednajici_osoba) {
      return res.status(400).json({ error: 'nazev, ico, sidlo, and jednajici_osoba are required' });
    }
    const company = await createCompany({ nazev, ico, dic: dic || '', sidlo, jednajici_osoba, ...rest });
    res.json(company);
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// PUT /api/companies/:companyId - update company
app.put('/api/companies/:companyId', async (req, res) => {
  try {
    const updated = await updateCompany(req.params.companyId, req.body);
    if (!updated) return res.status(404).json({ error: 'Company not found' });
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// DELETE /api/companies/:companyId - delete company
app.delete('/api/companies/:companyId', async (req, res) => {
  try {
    const ok = await deleteCompanyById(req.params.companyId);
    if (!ok) return res.status(404).json({ error: 'Company not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Company document upload
const companyDocUpload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const dir = getCompanyDocumentsDir(req.params.companyId);
      await mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (['.pdf', '.docx', '.doc', '.xls', '.xlsx', '.jpg', '.jpeg', '.png'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, XLS/XLSX, and image files are allowed'));
    }
  },
});

// POST /api/companies/:companyId/documents - upload company docs (with slot)
app.post('/api/companies/:companyId/documents', companyDocUpload.array('files', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const slot = (req.body?.slot || 'ostatni') as DocSlotType;
    let manifest = await getDocManifest(req.params.companyId);
    for (const f of files) {
      manifest = await addDocToSlot(req.params.companyId, slot, f.filename);
    }
    const allFiles = await getCompanyDocuments(req.params.companyId);
    res.json({ uploaded: files.map(f => f.filename), entries: manifest.entries, files: allFiles });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/companies/:companyId/documents - list company docs (with manifest entries)
app.get('/api/companies/:companyId/documents', async (req, res) => {
  try {
    const manifest = await getDocManifest(req.params.companyId);
    const files = await getCompanyDocuments(req.params.companyId);
    res.json({ entries: manifest.entries, files });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/companies/:companyId/documents/:filename - delete company doc (with slot)
app.delete('/api/companies/:companyId/documents/:filename', async (req, res) => {
  try {
    const slot = (req.query.slot || 'ostatni') as DocSlotType;
    const manifest = await removeDocFromSlot(req.params.companyId, slot, req.params.filename);
    res.json({ success: true, entries: manifest.entries });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/companies/:companyId/documents/:filename - download company doc
app.get('/api/companies/:companyId/documents/:filename', async (req, res) => {
  try {
    const filePath = join(getCompanyDocumentsDir(req.params.companyId), req.params.filename);
    await stat(filePath);
    res.download(filePath);
  } catch {
    res.status(404).json({ error: 'Document not found' });
  }
});

// GET /api/tenders/:id/priloha-checklist — checklist kvalifikačních příloh (M-followup d):
// požadované doc-sloty z analysis.kvalifikace × dokumenty firmy (manifest) × přílohy zakázky.
// Read-only; bez analýzy vrací prázdno (checklist se odvozuje z kvalifikačních požadavků).
app.get('/api/tenders/:id/priloha-checklist', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    let analysis: any = null;
    try { analysis = JSON.parse(await readFile(join(OUTPUT_DIR, id, 'analysis.json'), 'utf-8')); } catch {}
    const kval = analysis?.kvalifikace ?? analysis?.kvalifikacni_pozadavky;
    if (!Array.isArray(kval) || kval.length === 0) {
      return res.json({ items: [], company_id: null, analyza_hotova: !!analysis });
    }
    const requiredSlots = mapQualifikaceToSlots(kval);

    // Firma zakázky (tender-meta.json) → manifest jejích dokladů.
    let companyId: string | null = null;
    try {
      const meta = JSON.parse(await readFile(join(OUTPUT_DIR, id, 'tender-meta.json'), 'utf-8'));
      companyId = typeof meta.company_id === 'string' ? meta.company_id : null;
    } catch {}
    const slotToCompanyFile = new Map<string, string>();
    if (companyId) {
      try {
        const manifest = await getDocManifest(companyId);
        for (const e of manifest.entries) {
          if (!slotToCompanyFile.has(e.slot)) slotToCompanyFile.set(e.slot, e.filename);
        }
      } catch {}
    }

    // Přílohy nahrané přímo k zakázce (output/<id>/prilohy).
    let attachments: string[] = [];
    try {
      attachments = (await readdir(join(OUTPUT_DIR, id, 'prilohy'))).filter((f) => !f.startsWith('.'));
    } catch {}
    const attachmentsLower = attachments.map((f) => f.toLowerCase());

    const items = requiredSlots.map((slot) => {
      const label = DOC_SLOTS.find((s) => s.type === slot)?.label ?? slot;
      const companyFile = slotToCompanyFile.get(slot);
      // Příloha zakázky se páruje volně dle názvu slotu/souboru firmy (přílohy nemají sloty).
      const attMatch = attachments.find((f, i) =>
        (companyFile && f === companyFile) || attachmentsLower[i].includes(slot.replace(/_/g, '')));
      if (attMatch) return { slot, label, status: 'nahrano' as const, zdroj: 'zakazka' as const, filename: attMatch };
      if (companyFile) return { slot, label, status: 'nahrano' as const, zdroj: 'firma' as const, filename: companyFile };
      return { slot, label, status: 'chybi' as const };
    });

    res.json({ items, company_id: companyId, analyza_hotova: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/tenders/:id/company - set company for tender → auto-copy docs
app.put('/api/tenders/:id/company', async (req, res) => {
  const { id } = req.params;
  const { company_id } = req.body;
  if (!company_id || typeof company_id !== 'string') {
    return res.status(400).json({ error: 'company_id is required' });
  }
  try {
    const metaPath = join(OUTPUT_DIR, id, 'tender-meta.json');
    await mkdir(join(OUTPUT_DIR, id), { recursive: true });
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(await readFile(metaPath, 'utf-8')); } catch {}
    meta.company_id = company_id;
    if (!meta.created_at) meta.created_at = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    // Map kvalifikace to required slots if analysis exists
    let requiredSlots: DocSlotType[] | undefined;
    try {
      const analysisPath = join(OUTPUT_DIR, id, 'analysis.json');
      const analysis = JSON.parse(await readFile(analysisPath, 'utf-8'));
      // Analýza používá pole `kvalifikace` (starší název `kvalifikacni_pozadavky` jen fallback).
      const kval = analysis.kvalifikace ?? analysis.kvalifikacni_pozadavky;
      if (Array.isArray(kval)) {
        requiredSlots = mapQualifikaceToSlots(kval);
      }
    } catch {}

    // Copy company docs to prilohy (selective if we have kvalifikace info)
    const { copied, missing } = await copyCompanyDocsToTender(company_id, id, requiredSlots);
    res.json({ success: true, company_id, copied_documents: copied, missing_documents: missing });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Job Queue API ---

// GET /api/jobs - list all jobs (optional ?tenderId= filter)
app.get('/api/jobs', (req, res) => {
  const tenderId = req.query.tenderId as string | undefined;
  let allJobs = [...jobs.values()];
  if (tenderId) {
    allJobs = allJobs.filter(j => j.tenderId === tenderId);
  }
  // Return without full logs for list endpoint
  res.json(allJobs.map(j => ({
    id: j.id,
    tenderId: j.tenderId,
    step: j.step,
    status: j.status,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    error: j.error,
    kind: j.kind,
    parentJobId: j.parentJobId,
    currentStep: j.currentStep,
    failedStep: j.failedStep,
    logLines: j.logs.length,
  })));
});

// GET /api/jobs/:jobId - get job status + logs
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  // Support ?since=N to only return new log lines
  const since = parseInt(String(req.query.since || '0')) || 0;
  res.json({
    id: job.id,
    tenderId: job.tenderId,
    step: job.step,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    kind: job.kind,
    parentJobId: job.parentJobId,
    currentStep: job.currentStep,
    failedStep: job.failedStep,
    logs: job.logs.slice(since),
    totalLogLines: job.logs.length,
  });
});

// POST /api/tenders/:id/run/all - zařadí celý pipeline jako jeden řetězený job
app.post('/api/tenders/:id/run/all', async (req, res) => {
  const { id } = req.params;
  try {
    await stat(join(INPUT_DIR, id));
  } catch {
    return res.status(404).json({ error: `Tender "${id}" not found in input/` });
  }

  const existing = [...jobs.values()].find((job) =>
    job.tenderId === id && job.kind === 'pipeline'
    && (job.status === 'running' || job.status === 'queued'));
  if (existing) {
    return res.json({ jobId: existing.id, status: existing.status, message: 'Pipeline already in progress' });
  }

  let jobId = randomUUID().slice(0, 8);
  while (jobs.has(jobId)) jobId = randomUUID().slice(0, 8);
  const parent: Job = {
    id: jobId,
    tenderId: id,
    step: 'all',
    status: 'queued',
    logs: [],
    startedAt: new Date().toISOString(),
    kind: 'pipeline',
    currentStep: RUN_ALL_STEPS[0],
  };
  jobs.set(parent.id, parent);
  enqueueStepJob(id, RUN_ALL_STEPS[0], parent.id);
  scheduleJobsPersist();

  console.log(`Pipeline job ${parent.id} queued for ${id}`);
  res.json({ jobId: parent.id, status: parent.status, currentStep: parent.currentStep });
});

// POST /api/tenders/:id/run/:step - enqueue a pipeline step
// Sdílí STEP_FILES s frontou (processQueue) — obě mapy musí znát stejné kroky (vč. verify-prices).
app.post('/api/tenders/:id/run/:step', async (req, res) => {
  const { id, step } = req.params;

  if (!STEP_FILES[step]) {
    return res.status(400).json({ error: `Unknown step: ${step}` });
  }

  // Check input exists
  try {
    await stat(join(INPUT_DIR, id));
  } catch {
    return res.status(404).json({ error: `Tender "${id}" not found in input/` });
  }

  // Check if this step is already running/queued for this tender
  for (const job of jobs.values()) {
    if (job.tenderId === id && job.step === step && (job.status === 'running' || job.status === 'queued')) {
      return res.json({ jobId: job.id, status: job.status, message: 'Step already in progress' });
    }
  }

  // Gate: require confirmed prices before document generation
  const gateError = await getStepGateError(id, step);
  if (gateError) return res.status(400).json({ error: gateError });

  const job = enqueueStepJob(id, step);
  res.json({ jobId: job.id, status: job.status });
});

// POST /api/tenders/:id/output — upload a file to output directory (for syncing between environments)
app.post('/api/tenders/:id/output', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const id = req.params.id;
    const { filename, content } = req.body;
    if (!filename || !content) {
      return res.status(400).json({ error: 'Missing filename or content' });
    }
    // Sanitize filename
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const outputDir = join(OUTPUT_DIR, id);
    await mkdir(outputDir, { recursive: true });
    const buffer = Buffer.from(content, 'base64');
    await writeFile(join(outputDir, safeName), buffer);
    res.json({ success: true, filename: safeName, size: buffer.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- CRM: lifecycle status + aktivita (M2) ---

// PATCH /api/tenders/:id/status — změna fáze přes state-machine guardy.
app.patch('/api/tenders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status: target, reason } = req.body ?? {};
  if (!target || typeof target !== 'string' || !ALL_STAGES.includes(target as StageKey)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (!(await isDbAvailable())) {
    return res.status(503).json({ error: 'db_unavailable' });
  }
  try {
    const pipeline = await getPipelineStatus(id);
    const done = stepsDone(pipeline.steps);
    const crm = await getStatus(id);
    const current = crm?.status ?? deriveStageFromSteps(done);
    if (target === 'nepodano' && (!reason || !String(reason).trim())) {
      return res.status(409).json({ error: 'reason_required', reason: 'Vyžadován důvod' });
    }
    const check = canTransition(current, target as StageKey, done);
    if (!check.ok) {
      return res.status(409).json({ error: 'illegal_transition', reason: check.reason });
    }
    await setStatus(id, target as StageKey);
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    await logActivity(id, 'status_change', actor, {
      old: current, new: target, reason: reason ?? null, actor_name: actorName,
    });
    if (crm?.assignee) {
      await notify({ user_id: crm.assignee, typ: 'status_change', text: 'Změnil se stav přiřazené zakázky.', url: `#/tender/${encodeURIComponent(id)}`, tender_id: id, actor_id: actor, dedup_key: `status_change:${id}` });
    }
    res.json({ success: true, status: target });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/tenders/:id/assignee — přiřazení řešitele.
app.put('/api/tenders/:id/assignee', async (req, res) => {
  const { id } = req.params;
  const { assignee } = req.body ?? {};
  if (!(await isDbAvailable())) {
    return res.status(503).json({ error: 'db_unavailable' });
  }
  try {
    const pipeline = await getPipelineStatus(id);
    const done = stepsDone(pipeline.steps);
    const crm = await getStatus(id);
    const current = crm?.status ?? deriveStageFromSteps(done);
    const value = assignee && typeof assignee === 'string' ? assignee : null;
    await setAssignee(id, value, current);
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    await logActivity(id, 'assignment', actor, { assignee: value, actor_name: actorName });
    if (value) {
      await notify({ user_id: value, typ: 'assigned', text: 'Byla vám přiřazena zakázka.', url: `#/tender/${encodeURIComponent(id)}`, tender_id: id, actor_id: actor, dedup_key: `assigned:${id}` });
    }
    res.json({ success: true, assignee: value });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/tenders/:id/activity — historie zakázky.
app.get('/api/tenders/:id/activity', async (req, res) => {
  try {
    const activity = await getActivity(req.params.id);
    res.json({ activity });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/activity/recent — nedávná aktivita napříč zakázkami (dashboard).
app.get('/api/activity/recent', async (_req, res) => {
  try {
    const activity = await getRecentActivity(20);
    res.json({ activity });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Úkoly + checklisty (M3) ---
// Vzor = M2 status/aktivita: GET routy public (resilientní čtení), zápisy guardují isDbAvailable→503,
// actor z JWT (req.user), na změny logActivity. tender_id = název složky (žádný FK).

const TASK_STAVY = ['k_vyrizeni', 'probiha', 'hotovo', 'blokovano'];
const TASK_PRIORITY = ['nizka', 'stredni', 'vysoka'];

// Guard proti path traversal u endpointů, které z tender_id skládají cestu k souboru.
// tender_id = název složky (může obsahovat mezery i „&", takže žádný striktní allowlist —
// jen odmítnutí separátorů, „..", NUL a prázdna).
function isSafeTenderId(id: string): boolean {
  return !!id && !id.includes('..') && !id.includes('/') && !id.includes('\\') && !id.includes('\0');
}

// GET úkoly zakázky (public GET → degraduje na [] bez DB, neshazuje 401-loop)
app.get('/api/tenders/:id/tasks', async (req, res) => {
  try {
    res.json({ tasks: await getTasks(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET „Moje úkoly" napříč zakázkami — příjemce VÝHRADNĚ z JWT sub (requireJwt), NIKDY z ?assignee.
// Jinak IDOR: GET obchází auth middleware → kdokoli by přes ?assignee=<cizí id> četl cizí úkoly.
// Vzor /api/notifications; resilientní klient si 401 přeloží na prázdno (žádný reload loop).
app.get('/api/tasks/mine', requireJwt, async (req, res) => {
  const assignee = (req as any).user?.sub as string | undefined;
  if (!assignee) return res.json({ tasks: [] });
  try {
    res.json({ tasks: await getMyTasks(assignee) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST vytvoření úkolu
app.post('/api/tenders/:id/tasks', async (req, res) => {
  const { id } = req.params;
  const { title, assignee, due_date, stav, priorita, je_checklist } = req.body ?? {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title_required' });
  }
  if (stav && !TASK_STAVY.includes(stav)) return res.status(400).json({ error: 'invalid_stav' });
  if (priorita && !TASK_PRIORITY.includes(priorita)) return res.status(400).json({ error: 'invalid_priorita' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    const task = await createTask({
      tender_id: id,
      title: title.trim(),
      assignee: assignee ?? null,
      due_date: due_date || null,
      stav,
      priorita,
      je_checklist: !!je_checklist,
      created_by: actor,
    });
    await logActivity(id, 'task_created', actor, { task_id: task.id, title: task.title, actor_name: actorName });
    if (task.assignee) {
      await notify({ user_id: task.assignee, typ: 'task_assigned', text: `Nový úkol: ${task.title}`, url: `#/tender/${encodeURIComponent(id)}?tab=ukoly`, tender_id: id, entity_typ: 'task', entity_id: task.id, actor_id: actor, dedup_key: `task_assigned:${task.id}` });
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH částečná aktualizace úkolu
app.patch('/api/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  if (!/^\d+$/.test(taskId)) return res.status(400).json({ error: 'invalid_id' });
  const body = req.body ?? {};
  if (body.stav !== undefined && !TASK_STAVY.includes(body.stav)) return res.status(400).json({ error: 'invalid_stav' });
  if (body.priorita !== undefined && !TASK_PRIORITY.includes(body.priorita)) return res.status(400).json({ error: 'invalid_priorita' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const before = await getTask(taskId);
    if (!before) return res.status(404).json({ error: 'not_found' });
    const task = await updateTask(taskId, body);
    if (!task) return res.status(404).json({ error: 'not_found' });
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    // Aktivitu „dokončeno" logujeme jen při přechodu do 'hotovo' (ne při opakovaném uložení).
    if (before.stav !== 'hotovo' && task.stav === 'hotovo') {
      await logActivity(task.tender_id, 'task_completed', actor, {
        task_id: task.id, title: task.title, actor_name: actorName,
      });
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE úkol
app.delete('/api/tasks/:taskId', async (req, res) => {
  const { taskId } = req.params;
  if (!/^\d+$/.test(taskId)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    res.json({ success: await deleteTask(taskId) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST auto-seed checklistu z analysis.kvalifikace[] (idempotentní).
app.post('/api/tenders/:id/tasks/seed', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    let analysis: any;
    try {
      analysis = JSON.parse(await readFile(join(OUTPUT_DIR, id, 'analysis.json'), 'utf-8'));
    } catch {
      return res.status(400).json({
        error: 'analysis_required',
        reason: 'Nejprve spusťte AI analýzu — checklist se generuje z kvalifikačních požadavků.',
      });
    }
    const kval: Array<{ typ?: string; popis?: string }> = Array.isArray(analysis?.kvalifikace) ? analysis.kvalifikace : [];
    const items = kval
      .filter((k) => k && typeof k.popis === 'string' && k.popis.trim())
      .map((k) => ({
        title: k.popis!.trim(),
        seed_key: 'kval:' + createHash('sha1').update(`${k.typ ?? ''}\n${k.popis}`).digest('hex').slice(0, 16),
      }));
    const inserted = await seedChecklist(id, items);
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    if (inserted > 0) {
      await logActivity(id, 'checklist_seeded', actor, { count: inserted, actor_name: actorName });
    }
    res.json({ seeded: inserted, tasks: await getTasks(id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST finalize — gate na kompletní podatelnou nabídku, pak přechod pripravena→odeslana.
// FE po úspěchu stáhne kompletní balík přes existující GET /download/bundle.
app.post('/api/tenders/:id/finalize', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const gate = await computeSubmitGate(join(OUTPUT_DIR, id));
    if (!gate.ready) {
      return res.status(409).json({
        error: 'not_ready',
        reason: 'Nabídka není připravená k podání.',
        problems: gate.problems,
        warnings: gate.warnings,
      });
    }
    const pipeline = await getPipelineStatus(id);
    const done = stepsDone(pipeline.steps);
    const crm = await getStatus(id);
    const current = crm?.status ?? deriveStageFromSteps(done);
    const check = canTransition(current, 'odeslana' as StageKey, done);
    if (!check.ok) {
      return res.status(409).json({ error: 'illegal_transition', reason: check.reason });
    }
    await setStatus(id, 'odeslana' as StageKey);
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    await logActivity(id, 'finalized', actor, { actor_name: actorName });
    res.json({ success: true, status: 'odeslana', warnings: gate.warnings });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Termíny + Kalendář (M6) ---
const TERMIN_TYPY = ['lhuta_nabidek', 'otevirani_obalek', 'doba_plneni', 'prohlidka', 'vlastni'];

// GET termíny zakázky (public GET → resilientní)
app.get('/api/tenders/:id/terminy', async (req, res) => {
  try {
    res.json({ terminy: await getTerminy(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET kalendář — termíny napříč zakázkami v rozsahu (resilientní)
app.get('/api/calendar', async (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  try {
    const terminy = await getAllTerminy(from, to);
    const items = terminy.map((t) => ({
      id: t.id, tender_id: t.tender_id, typ: t.typ, datum: t.datum, cas: t.cas, popis: t.popis, kind: 'termin' as const,
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST vytvoření termínu
app.post('/api/tenders/:id/terminy', async (req, res) => {
  const { id } = req.params;
  const { typ, datum, cas, popis, pripominka } = req.body ?? {};
  if (!typ || !TERMIN_TYPY.includes(typ)) return res.status(400).json({ error: 'invalid_typ' });
  if (!datum || typeof datum !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return res.status(400).json({ error: 'invalid_datum' });
  if (pripominka != null && (typeof pripominka !== 'number' || pripominka < 0)) return res.status(400).json({ error: 'invalid_pripominka' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    const termin = await createTermin({ tender_id: id, typ, datum, cas: cas ?? null, popis: popis ?? null, pripominka: pripominka ?? null, created_by: actor });
    await logActivity(id, 'termin_created', actor, { termin_id: termin.id, typ, datum, actor_name: actorName });
    res.json(termin);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PATCH úprava termínu
app.patch('/api/terminy/:terminId', async (req, res) => {
  const { terminId } = req.params;
  if (!/^\d+$/.test(terminId)) return res.status(400).json({ error: 'invalid_id' });
  const body = req.body ?? {};
  if (body.typ !== undefined && !TERMIN_TYPY.includes(body.typ)) return res.status(400).json({ error: 'invalid_typ' });
  if (body.datum !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.datum)) return res.status(400).json({ error: 'invalid_datum' });
  if (body.pripominka !== undefined && body.pripominka !== null && (typeof body.pripominka !== 'number' || body.pripominka < 0)) return res.status(400).json({ error: 'invalid_pripominka' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const termin = await updateTermin(terminId, body);
    if (!termin) return res.status(404).json({ error: 'not_found' });
    res.json(termin);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE termín
app.delete('/api/terminy/:terminId', async (req, res) => {
  const { terminId } = req.params;
  if (!/^\d+$/.test(terminId)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    res.json({ success: await deleteTermin(terminId) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST seed termínů z analysis.terminy (idempotentní)
app.post('/api/tenders/:id/terminy/seed', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    let analysis: any;
    try {
      analysis = JSON.parse(await readFile(join(OUTPUT_DIR, id, 'analysis.json'), 'utf-8'));
    } catch {
      return res.status(400).json({ error: 'analysis_required', reason: 'Nejprve spusťte AI analýzu — termíny se generují z analýzy.' });
    }
    const src = analysis?.terminy ?? {};
    const mapping: Array<{ field: string; typ: string }> = [
      { field: 'lhuta_nabidek', typ: 'lhuta_nabidek' },
      { field: 'otevirani_obalek', typ: 'otevirani_obalek' },
      { field: 'doba_plneni_od', typ: 'doba_plneni' },
      { field: 'doba_plneni_do', typ: 'doba_plneni' },
      { field: 'prohlidka_mista', typ: 'prohlidka' },
    ];
    const items = mapping
      .map((m) => ({ raw: src[m.field], typ: m.typ, field: m.field }))
      .filter((x) => typeof x.raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x.raw))
      .map((x) => {
        const raw = x.raw as string;
        const timeMatch = raw.match(/T(\d{2}:\d{2})/); // zachovat čas (lhůta 10:00 = submission cutoff)
        return { typ: x.typ, datum: raw.slice(0, 10), cas: timeMatch ? timeMatch[1] : null, seed_key: `analysis:${x.field}` };
      });
    const inserted = await seedTerminy(id, items);
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    if (inserted > 0) await logActivity(id, 'terminy_seeded', actor, { count: inserted, actor_name: actorName });
    res.json({ seeded: inserted, terminy: await getTerminy(id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Komentáře + @mention (M8) ---
const MAX_COMMENT_LEN = 5000;
const MAX_MENTIONS = 50;

// GET komentáře zakázky (public GET → [] bez DB, neshazuje 401-loop, vzor /tasks).
app.get('/api/tenders/:id/comments', async (req, res) => {
  try {
    res.json({ comments: await getComments(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST komentář — text povinný (cap). mentions se NEDŮVĚŘUJÍ z klienta: filtrují se na reálné
// uživatele (anti-IDOR/spam), dedup a cap. notify: každý zmíněný ('mention') + řešitel zakázky
// ('comment'); self a duplicity (assignee už zmíněný) se přeskočí. Autor z JWT (global auth mw).
app.post('/api/tenders/:id/comments', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  const body = req.body ?? {};
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'text_required' });
  if (text.length > MAX_COMMENT_LEN) return res.status(400).json({ error: 'text_too_long' });
  const rawMentions: string[] = Array.isArray(body.mentions)
    ? body.mentions.filter((m: unknown): m is string => typeof m === 'string')
    : [];
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    // mentions ověř proti reálným uživatelům (nedůvěřuj klientovi) + dedup + cap.
    const users = await getAllUsers().catch(() => [] as Array<{ id: string }>);
    const validIds = new Set(users.map((u) => u.id));
    const mentions = Array.from(new Set(rawMentions)).filter((m) => validIds.has(m)).slice(0, MAX_MENTIONS);
    const comment = await createComment({ tender_id: id, text, mentions, author_id: actor, author_name: actorName });
    await logActivity(id, 'comment_added', actor, { comment_id: comment.id, actor_name: actorName });
    const notified = new Set<string>();
    for (const uid of mentions) {
      if (uid === actor) continue;
      notified.add(uid);
      await notify({
        user_id: uid, typ: 'mention', text: `${actorName ?? 'Někdo'} vás zmínil v komentáři.`,
        url: `#/tender/${encodeURIComponent(id)}?tab=komentare`, tender_id: id, entity_typ: 'comment', entity_id: comment.id,
        actor_id: actor, dedup_key: `mention:${comment.id}:${uid}`,
      });
    }
    // řešitel zakázky (pokud existuje, není autor ani už zmíněný).
    const crm = await getStatus(id).catch(() => null);
    if (crm?.assignee && crm.assignee !== actor && !notified.has(crm.assignee)) {
      await notify({
        user_id: crm.assignee, typ: 'comment', text: 'Nový komentář u přiřazené zakázky.',
        url: `#/tender/${encodeURIComponent(id)}?tab=komentare`, tender_id: id, entity_typ: 'comment', entity_id: comment.id,
        actor_id: actor, dedup_key: `comment:${comment.id}`,
      });
    }
    res.json(comment);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE komentář — soft-delete; jen autor NEBO admin (role z user-store dle sub, ne JWT claim).
app.delete('/api/comments/:commentId', async (req, res) => {
  const { commentId } = req.params;
  // \d{1,18} — vejde se do bigintu (jinak ::bigint cast hodí 22003 → 500), vzor markRead v notif-store.
  if (!/^\d{1,18}$/.test(commentId)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const comment = await getComment(commentId);
    if (!comment) return res.status(404).json({ error: 'not_found' });
    const sub = (req as any).user?.sub ?? null;
    let isAdmin = false;
    if (sub) {
      const u = await getUserById(sub);
      isAdmin = u?.role === 'admin';
    } else if (!isJwtEnabled()) {
      isAdmin = true; // dev bez JWT = single-user, smí mazat
    }
    if (!isAdmin && (!comment.author_id || comment.author_id !== sub)) {
      return res.status(403).json({ error: 'forbidden', reason: 'Smazat komentář může jen autor nebo administrátor.' });
    }
    const ok = await softDeleteComment(commentId);
    if (ok) await logActivity(comment.tender_id, 'comment_deleted', sub, { comment_id: comment.id });
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Uložené pohledy (M9b, saved views) ---
// GET pohledy viditelné uživateli (vlastní + sdílené) — vlastník z JWT sub (requireJwt), resilientní klient.
app.get('/api/views', requireJwt, async (req, res) => {
  const userId = (req as any).user?.sub as string | undefined;
  if (!userId) return res.json({ views: [] });
  try {
    res.json({ views: await getViews(userId) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST pohled — vlastník VÝHRADNĚ z JWT sub (ne z body). nazev povinný, definice = objekt filtru.
app.post('/api/views', requireJwt, async (req, res) => {
  const userId = (req as any).user?.sub as string | undefined;
  if (!userId) return res.status(401).json({ error: 'auth_required' });
  const body = req.body ?? {};
  const nazev = typeof body.nazev === 'string' ? body.nazev.trim() : '';
  if (!nazev) return res.status(400).json({ error: 'nazev_required' });
  if (nazev.length > 120) return res.status(400).json({ error: 'nazev_too_long' });
  const definice = body.definice && typeof body.definice === 'object' && !Array.isArray(body.definice) ? body.definice : {};
  // Cap serializované velikosti definice (nazev je capnutý taky) — brání storage-exhaustion přes uložené pohledy.
  if (JSON.stringify(definice).length > 8192) return res.status(400).json({ error: 'definice_too_large' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const view = await createView({ user_id: userId, nazev, definice, je_sdileny: !!body.je_sdileny });
    res.json(view);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE pohled — jen vlastník NEBO admin (role z user-store dle sub).
app.delete('/api/views/:id', requireJwt, async (req, res) => {
  const { id } = req.params;
  if (!/^\d{1,18}$/.test(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const view = await getView(id);
    if (!view) return res.status(404).json({ error: 'not_found' });
    const sub = (req as any).user?.sub ?? null;
    let isAdmin = false;
    if (sub) { const u = await getUserById(sub); isAdmin = u?.role === 'admin'; }
    if (!isAdmin && view.user_id !== sub) {
      return res.status(403).json({ error: 'forbidden', reason: 'Smazat pohled může jen jeho autor nebo administrátor.' });
    }
    res.json({ success: await deleteView(id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Štítky (M9b, tags) ---
const TAG_COLORS = new Set(['neutral', 'primary', 'success', 'warning', 'danger']);

// GET globální číselník štítků (public GET → [] bez DB).
app.get('/api/stitky', async (_req, res) => {
  try {
    res.json({ stitky: await getTags() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST nový štítek (název povinný + cap, barva z presetů). Mutace → global auth mw blokne viewera.
app.post('/api/stitky', async (req, res) => {
  const body = req.body ?? {};
  const nazev = typeof body.nazev === 'string' ? body.nazev.trim() : '';
  if (!nazev) return res.status(400).json({ error: 'nazev_required' });
  if (nazev.length > 40) return res.status(400).json({ error: 'nazev_too_long' });
  const barva = typeof body.barva === 'string' && TAG_COLORS.has(body.barva) ? body.barva : 'neutral';
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const actor = (req as any).user?.sub ?? null;
    res.json(await createTag(nazev, barva, actor));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE štítek — jen admin (globální číselník; kaskádně odpojí vazby).
app.delete('/api/stitky/:id', requireJwt, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  if (!/^\d{1,18}$/.test(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    res.json({ success: await deleteTag(id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET štítky zakázky (public GET → []).
app.get('/api/tenders/:id/stitky', async (req, res) => {
  try {
    res.json({ stitky: await getTenderTags(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST přiřadit štítek zakázce ({ stitek_id }).
app.post('/api/tenders/:id/stitky', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  const stitekId = String((req.body ?? {}).stitek_id ?? '');
  if (!/^\d{1,18}$/.test(stitekId)) return res.status(400).json({ error: 'invalid_stitek_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    await attachTag(id, stitekId);
    res.json({ success: true, stitky: await getTenderTags(id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE odebrat štítek ze zakázky.
app.delete('/api/tenders/:id/stitky/:stitekId', async (req, res) => {
  const { id, stitekId } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  if (!/^\d{1,18}$/.test(stitekId)) return res.status(400).json({ error: 'invalid_stitek_id' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    res.json({ success: await detachTag(id, stitekId) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Notifikace (M7, zvonek) ---
// GET notifikace uživatele — příjemce VÝHRADNĚ z JWT sub (ne z ?userId, jinak IDOR — čtení cizích
// notifikací). requireJwt nastaví req.user; resilientní klient si 401 přeloží na prázdný zvonek.
app.get('/api/notifications', requireJwt, async (req, res) => {
  const userId = (req as any).user?.sub as string | undefined;
  const unreadOnly = req.query.unread === '1';
  if (!userId) return res.json({ items: [], unread: 0 });
  try {
    const [items, unread] = await Promise.all([
      getNotifications(userId, { limit: 30, unreadOnly }),
      getUnreadCount(userId),
    ]);
    res.json({ items, unread });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST označit přečtené — příjemce VÝHRADNĚ z autentizovaného principalu (JWT sub), nikdy z body
// (jinak by šlo označit cizí notifikace jako přečtené — IDOR).
app.post('/api/notifications/read', async (req, res) => {
  const body = req.body ?? {};
  const userId = (req as any).user?.sub;
  if (!userId) return res.status(401).json({ error: 'auth_required' });
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : undefined;
    const updated = await markRead(userId, ids);
    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Výsledky podání (win-rate feedback loop) ---
// Vzor terminy/tasks: GET resilientní (bez DB → null/prázdné statistiky), PUT guarduje
// isDbAvailable → 503. Vítězná cena se navíc best-effort propisuje do win_prices
// (zdroj 'vlastni_vysledek') — vlastní výsledky jsou nejrelevantnější učicí data.

const OutcomeInputSchema = z.object({
  vysledek: z.enum(['vyhra', 'prohra', 'zruseno']),
  vitezna_cena_bez_dph: z.number().nonnegative().nullish(),
  nase_cena_bez_dph: z.number().nonnegative().nullish(),
  pocet_uchazecu: z.number().int().nonnegative().nullish(),
  vitez_nazev: z.string().trim().max(500).nullish(),
  poznamka: z.string().trim().max(5000).nullish(),
});

/**
 * Propíše vítěznou cenu z výsledku do win_prices (zdroj 'vlastni_vysledek',
 * zdroj_id = tender_id → UNIQUE(zdroj, zdroj_id) drží idempotenci, opakovaný
 * upsert záznam jen aktualizuje). Výhra → naše cena, prohra → vítězná cena;
 * jinak (zrušeno / bez ceny) se případný dřívější feedback řádek smaže, aby
 * v učicích datech nezůstala zastaralá cena. Vrací true, když řádek existuje.
 */
async function syncOutcomeToWinPrices(
  tenderId: string,
  data: { vysledek: VysledekPodani; nase_cena_bez_dph?: number | null; vitezna_cena_bez_dph?: number | null; pocet_uchazecu?: number | null; vitez_nazev?: string | null },
): Promise<boolean> {
  const cena = data.vysledek === 'vyhra'
    ? data.nase_cena_bez_dph
    : data.vysledek === 'prohra' ? data.vitezna_cena_bez_dph : null;

  if (!(typeof cena === 'number' && cena > 0)) {
    await deleteWinPrice('vlastni_vysledek', tenderId);
    return false;
  }

  // Předmět = název zakázky z analysis.json, fallback tender_id (analýza nemusí existovat).
  let predmet = tenderId;
  let zadavatelNazev: string | null = null;
  let zadavatelIco: string | null = null;
  try {
    const analysis = JSON.parse(await readFile(join(OUTPUT_DIR, tenderId, 'analysis.json'), 'utf-8'));
    if (typeof analysis?.zakazka?.nazev === 'string' && analysis.zakazka.nazev.trim()) {
      predmet = analysis.zakazka.nazev.trim();
    }
    zadavatelNazev = typeof analysis?.zakazka?.zadavatel?.nazev === 'string' ? analysis.zakazka.zadavatel.nazev : null;
    zadavatelIco = typeof analysis?.zakazka?.zadavatel?.ico === 'string' ? analysis.zakazka.zadavatel.ico : null;
  } catch {
    // analysis.json nečitelný → fallback tender_id
  }

  await upsertWinPrices([{
    zdroj: 'vlastni_vysledek',
    zdroj_id: tenderId,
    datum: new Date().toISOString().slice(0, 10),
    zadavatel_ico: zadavatelIco,
    zadavatel_nazev: zadavatelNazev,
    dodavatel_ico: null,
    dodavatel_nazev: data.vysledek === 'prohra' ? (data.vitez_nazev ?? null) : null,
    predmet,
    komodita_kategorie: categorizeCommodity(predmet),
    cena_bez_dph: cena,
    cena_s_dph: null,
    mena: 'CZK',
    pocet_uchazecu: data.pocet_uchazecu ?? null,
    url: null,
    raw: {
      tender_id: tenderId,
      vysledek: data.vysledek,
      nase_cena_bez_dph: data.nase_cena_bez_dph ?? null,
      vitezna_cena_bez_dph: data.vitezna_cena_bez_dph ?? null,
    },
  }]);
  return true;
}

// GET výsledek zakázky (public GET → { outcome: null } bez DB/záznamu, neshazuje 401-loop)
app.get('/api/tenders/:id/outcome', async (req, res) => {
  try {
    res.json({ outcome: await getOutcome(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// PUT uložení/aktualizace výsledku zakázky (idempotentní upsert dle tender_id)
app.put('/api/tenders/:id/outcome', async (req, res) => {
  const { id } = req.params;
  if (!isSafeTenderId(id)) return res.status(400).json({ error: 'invalid_id' });
  const parsed = OutcomeInputSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_outcome', detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  if (!(await isDbAvailable())) return res.status(503).json({ error: 'db_unavailable' });
  try {
    const outcome = await upsertOutcome(id, parsed.data);
    const actor = (req as any).user?.sub ?? null;
    const actorName = (req as any).user?.name ?? null;
    await logActivity(id, 'vysledek_ulozen', actor, {
      vysledek: outcome.vysledek,
      vitezna_cena_bez_dph: outcome.vitezna_cena_bez_dph,
      nase_cena_bez_dph: outcome.nase_cena_bez_dph,
      actor_name: actorName,
    });
    // Feedback do win_prices je best-effort — selhání nesmí shodit uložení výsledku.
    let winpriceFeedback = false;
    try {
      winpriceFeedback = await syncOutcomeToWinPrices(id, parsed.data);
    } catch (err) {
      console.error(`Outcome: win_prices feedback pro ${id} selhal:`, err);
    }
    res.json({ outcome, winprice_feedback: winpriceFeedback });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET souhrnné win-rate statistiky (resilientní — bez DB prázdné nuly)
app.get('/api/outcomes/stats', async (_req, res) => {
  try {
    res.json(await getOutcomeStats());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Win-price API (historické vítězné ceny, pouze informační vrstva) ---

app.get('/api/winprice/band', winPriceBandHandler);
app.get('/api/winprice/stats', winPriceStatsHandler);

// --- Warehouse API (cenový sklad) ---

// Middleware: warehouse DB availability check
const requireWarehouse = async (_req: any, res: any, next: any) => {
  if (!(await isDbAvailable())) {
    return res.status(503).json({ error: 'Warehouse database not available' });
  }
  next();
};

// GET /api/warehouse/stats — přehled skladu
app.get('/api/warehouse/stats', requireWarehouse, async (_req, res) => {
  try {
    const stats = await getWarehouseStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/quality-stats — rozšířené statistiky kvality dat
app.get('/api/warehouse/quality-stats', requireWarehouse, async (_req, res) => {
  try {
    const stats = await getWarehouseQualityStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/categories — seznam kategorií (flat)
app.get('/api/warehouse/categories', requireWarehouse, async (req, res) => {
  try {
    const tree = req.query.tree === '1';
    const data = tree ? await getCategoryTree() : await getCategories();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/manufacturers — unikátní výrobci
app.get('/api/warehouse/manufacturers', requireWarehouse, async (_req, res) => {
  try {
    const data = await getManufacturers();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/sources — datové zdroje
app.get('/api/warehouse/sources', requireWarehouse, async (_req, res) => {
  try {
    const data = await getDataSources();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/products — vyhledávání a listing produktů
app.get('/api/warehouse/products', requireWarehouse, async (req, res) => {
  try {
    const params = {
      q: req.query.q as string | undefined,
      category_id: req.query.category_id ? parseInt(req.query.category_id as string) : undefined,
      manufacturer: req.query.manufacturer as string | undefined,
      price_min: req.query.price_min ? parseFloat(req.query.price_min as string) : undefined,
      price_max: req.query.price_max ? parseFloat(req.query.price_max as string) : undefined,
      is_active: req.query.is_active !== undefined ? req.query.is_active === 'true' : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
      offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
      sort_by: (req.query.sort_by as any) || 'name',
      sort_dir: (req.query.sort_dir as any) || 'asc',
    };
    const result = await searchProducts(params);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/products/:productId — detail produktu
app.get('/api/warehouse/products/:productId', requireWarehouse, async (req, res) => {
  try {
    const product = await getProduct(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const prices = await getProductPrices(req.params.productId);
    res.json({ ...product, prices });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/warehouse/products — vytvořit produkt
app.post('/api/warehouse/products', requireWarehouse, async (req, res) => {
  try {
    const { manufacturer, model } = req.body;
    if (!manufacturer || !model) {
      return res.status(400).json({ error: 'manufacturer and model are required' });
    }
    const product = await createProduct(req.body);
    res.json(product);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Product already exists (duplicate EAN, MPN, or manufacturer+model)' });
    }
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/warehouse/products/:productId — update produkt
app.put('/api/warehouse/products/:productId', requireWarehouse, async (req, res) => {
  try {
    const product = await updateProduct(req.params.productId, req.body);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/warehouse/products/:productId — smazat produkt
app.delete('/api/warehouse/products/:productId', requireWarehouse, async (req, res) => {
  try {
    const ok = await deleteProduct(req.params.productId);
    if (!ok) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/products/:productId/prices/history — cenová historie
app.get('/api/warehouse/products/:productId/prices/history', requireWarehouse, async (req, res) => {
  try {
    const sourceId = req.query.source_id ? parseInt(req.query.source_id as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const history = await getPriceHistory(req.params.productId, sourceId, limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Warehouse Import API ---

const importUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      const dir = join(ROOT, 'data', 'imports');
      await mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const name = `${Date.now()}-${Buffer.from(file.originalname, 'latin1').toString('utf8')}`;
      cb(null, name);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    if (['.csv', '.xlsx', '.xls'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV, XLSX, and XLS files are allowed'));
    }
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

// POST /api/warehouse/import/preview — nahrát soubor a získat preview s mapováním
app.post('/api/warehouse/import/preview', requireWarehouse, importUpload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    const preview = await getImportPreview(file.path);
    res.json({ ...preview, upload_path: file.path });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/warehouse/import/run — spustit import s potvrzeným mapováním
app.post('/api/warehouse/import/run', requireWarehouse, async (req, res) => {
  try {
    const { upload_path, mapping, source_id, category_id, enrich_params } = req.body;
    if (!upload_path || !mapping || !source_id) {
      return res.status(400).json({ error: 'upload_path, mapping, and source_id are required' });
    }
    const result = await runImport(upload_path, mapping as ColumnMapping[], {
      source_id,
      category_id: category_id || undefined,
      enrich_params: enrich_params ?? false,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/warehouse/products/:productId/prices — přidat/aktualizovat cenu
app.post('/api/warehouse/products/:productId/prices', requireWarehouse, async (req, res) => {
  try {
    const { source_id, price_bez_dph, price_s_dph, currency, availability, stock_quantity, delivery_days, source_url, source_sku } = req.body;
    if (!source_id || price_bez_dph === undefined) {
      return res.status(400).json({ error: 'source_id and price_bez_dph are required' });
    }
    await upsertPrice({
      product_id: req.params.productId,
      source_id,
      price_bez_dph,
      price_s_dph,
      currency,
      availability,
      stock_quantity,
      delivery_days,
      source_url,
      source_sku,
    });
    const prices = await getProductPrices(req.params.productId);
    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/warehouse/embeddings/generate — vygenerovat chybějící embeddingy
app.post('/api/warehouse/embeddings/generate', requireWarehouse, async (req, res) => {
  try {
    const limit = req.body.limit ?? 500;
    const count = await generateMissingEmbeddings(limit);
    res.json({ processed: count });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Scraping API ---

// D2: Rate limiting pro scraping — max 3 concurrent, max 10/h
const scrapeRateLimit = { active: 0, hourlyCount: 0, hourlyReset: Date.now() };
const SCRAPE_MAX_CONCURRENT = 3;
const SCRAPE_MAX_HOURLY = 10;
const SCRAPE_MAX_ITEMS_CAP = 500;

// POST /api/warehouse/scrape — spustit scraping
app.post('/api/warehouse/scrape', requireWarehouse, async (req, res) => {
  try {
    const { source_id, query: searchQuery, category_url, max_items, category_id } = req.body;
    if (!source_id) {
      return res.status(400).json({ error: 'source_id is required' });
    }

    // Rate limit check
    const now = Date.now();
    if (now - scrapeRateLimit.hourlyReset > 3600000) {
      scrapeRateLimit.hourlyCount = 0;
      scrapeRateLimit.hourlyReset = now;
    }
    if (scrapeRateLimit.active >= SCRAPE_MAX_CONCURRENT) {
      return res.status(429).json({ error: `Max ${SCRAPE_MAX_CONCURRENT} souběžných scraping jobů. Počkejte na dokončení.` });
    }
    if (scrapeRateLimit.hourlyCount >= SCRAPE_MAX_HOURLY) {
      return res.status(429).json({ error: `Max ${SCRAPE_MAX_HOURLY} scraping jobů za hodinu.` });
    }

    // Najdi zdroj
    const source = await import('./lib/warehouse-store.js').then(m => m.getDataSources())
      .then(sources => sources.find(s => s.id === source_id));
    if (!source) return res.status(404).json({ error: 'Source not found' });

    const config: ScrapeConfig = {
      source_id,
      source_name: source.name,
      query: searchQuery,
      category_url,
      max_items: Math.min(max_items || 100, SCRAPE_MAX_ITEMS_CAP),
      category_id,
    };

    // Spustit async — neblokovat request
    scrapeRateLimit.active++;
    scrapeRateLimit.hourlyCount++;
    runScraping(config).catch(err => {
      console.error('Scrape job failed:', err);
    }).finally(() => {
      scrapeRateLimit.active--;
    });

    res.json({ status: 'started', source: source.name });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/warehouse/scrape/jobs — seznam jobů
app.get('/api/warehouse/scrape/jobs', requireWarehouse, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;
    const jobs = await getScrapeJobs(limit);
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/warehouse/enrich/icecat — obohatit produkty přes Icecat
app.post('/api/warehouse/enrich/icecat', requireWarehouse, async (req, res) => {
  try {
    const limit = req.body.limit ?? 50;
    const result = await enrichProductsFromIcecat(limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Static file serving for production (React build)
const staticDir = join(ROOT, 'apps', 'web', 'dist');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  console.log(`Serving static files from: ${staticDir}`);
}

// Startup: migrate legacy company.json + DB migrace
async function startup() {
  try {
    const restored = await loadPipelineJobs(JOBS_FILE);
    for (const [jobId, job] of restored.jobs) jobs.set(jobId, job);
    jobQueue.push(...restored.queuedJobIds);
    if (restored.interruptedCount > 0) {
      await savePipelineJobs(JOBS_FILE, jobs.values());
      console.log(`Marked ${restored.interruptedCount} pipeline job(s) as interrupted after restart`);
    }
    if (jobs.size > 0) {
      console.log(`Restored ${jobs.size} pipeline job(s), ${jobQueue.length} queued`);
    }
  } catch (err) {
    // Poškozený pomocný soubor nesmí shodit celé API; nová fronta začne prázdná.
    console.error('Job queue restore error:', err);
  }

  await migrateCompanies().catch(err => console.error('Company migration error:', err));

  // PostgreSQL: migrace (pokud DATABASE_URL nastavena)
  try {
    await runMigrations();
    if (await isDbAvailable()) {
      const stats = await getWarehouseStats();
      console.log(`Warehouse DB: ${stats.products} products, ${stats.sources} sources, ${stats.categories} categories`);

      // D1: Cleanup stuck scrape jobs (zůstaly "running" po restartu serveru)
      try {
        const { query: dbQuery } = await import('./lib/db.js');
        const { rows } = await dbQuery<{ count: string }>(
          `UPDATE scrape_jobs SET status = 'error', errors = '["Server restarted"]'
           WHERE status = 'running' RETURNING id`,
        );
        if (rows.length > 0) {
          console.log(`Cleaned up ${rows.length} stuck scrape jobs`);
        }
      } catch (cleanupErr) {
        console.error('Stuck job cleanup error:', cleanupErr);
      }
    }
  } catch (err) {
    console.error('Warehouse DB migration error:', err);
    console.log('Warehouse features will be unavailable');
  }
}

startup().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`\nVZ AI Tool API server running on http://localhost:${PORT}`);
    console.log(`Input dir: ${INPUT_DIR}`);
    console.log(`Output dir: ${OUTPUT_DIR}`);
    processQueue();
  });

  // Reminder sweep (M7): periodicky notifikuje řešitele o blížících se termínech (getDueReminders
  // z M6). Best-effort, guard bez DB. Immediate run + interval; timer se ruší při shutdownu.
  let reminderTimer: NodeJS.Timeout | null = null;
  const runReminderSweep = async () => {
    if (!(await isDbAvailable())) return;
    try {
      const due = await getDueReminders();
      for (const t of due) {
        const crm = await getStatus(t.tender_id);
        const recipient = crm?.assignee;
        if (recipient) {
          await notify({
            user_id: recipient, typ: 'deadline', text: 'Blíží se termín přiřazené zakázky.',
            url: `#/tender/${encodeURIComponent(t.tender_id)}`, tender_id: t.tender_id, entity_typ: 'termin', entity_id: t.id,
            actor_id: null, dedup_key: `deadline:${t.id}`,
          });
          await markReminded(t.id);
        }
      }
    } catch {
      // best-effort — sweep nikdy neshodí server
    }
  };
  void runReminderSweep();
  reminderTimer = setInterval(() => { void runReminderSweep(); }, 15 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    if (reminderTimer) clearInterval(reminderTimer);
    server.close();
    await flushJobsPersist();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
});
