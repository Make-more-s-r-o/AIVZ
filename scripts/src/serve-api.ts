import express from 'express';
import cors from 'cors';
import multer from 'multer';
import archiver from 'archiver';
import { readFile, readdir, mkdir, stat, writeFile, rm } from 'fs/promises';
import { getCostSummary } from './lib/cost-tracker.js';
import { join, extname, basename } from 'path';
import { existsSync, createWriteStream } from 'fs';
import { spawn } from 'child_process';
import { config } from 'dotenv';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { PriceOverrideSchema, ProductMatchSchema } from './lib/types.js';
import { randomUUID } from 'crypto';
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
} from './lib/company-store.js';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;
const INPUT_DIR = join(ROOT, 'input');
const OUTPUT_DIR = join(ROOT, 'output');
const SCRIPTS_DIR = join(ROOT, 'scripts', 'src');
const PORT = process.env.API_PORT || 3001;

// Startup validation
const companyConfigPath = join(ROOT, 'config', 'company.json');
if (!existsSync(companyConfigPath)) {
  console.error('WARNING: config/company.json not found — generate step will fail');
}

const app = express();
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
  if (req.method === 'GET') return next();

  // 1. Check JWT Bearer token
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

  // 2. Support ?token= query param (for download links in <a href>)
  if (req.query.token) {
    const qToken = req.query.token as string;
    const jwtPayload = verifyToken(qToken);
    if (jwtPayload) {
      (req as any).user = jwtPayload;
      return next();
    }
    if (API_TOKEN && qToken === API_TOKEN) return next();
  }

  // 3. Allow same-origin browser requests (localhost dev without JWT_SECRET)
  try {
    const origin = req.headers.origin || req.headers.referer;
    if (origin) {
      const originHost = new URL(origin).hostname;
      if (originHost === req.hostname) return next();
    }
  } catch {}

  res.status(401).json({ error: 'Unauthorized' });
});

// --- Async Job Queue ---

interface Job {
  id: string;
  tenderId: string;
  step: string;
  status: 'queued' | 'running' | 'done' | 'error';
  logs: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

const jobs = new Map<string, Job>();
let currentJob: string | null = null;
const jobQueue: string[] = [];

function processQueue() {
  if (currentJob) return;
  const nextId = jobQueue.shift();
  if (!nextId) return;

  const job = jobs.get(nextId);
  if (!job) return;

  currentJob = nextId;
  job.status = 'running';

  const stepFiles: Record<string, string> = {
    extract: 'extract-tender.ts',
    analyze: 'analyze-tender.ts',
    match: 'match-product.ts',
    generate: 'generate-bid.ts',
    validate: 'validate-bid.ts',
  };

  const scriptFile = stepFiles[job.step];
  if (!scriptFile) {
    job.status = 'error';
    job.error = `Unknown step: ${job.step}`;
    job.finishedAt = new Date().toISOString();
    currentJob = null;
    processQueue();
    return;
  }

  const stepTimeout = (job.step === 'match' || job.step === 'generate') ? 600000 : 300000;

  const child = spawn(
    'node',
    ['--import', 'tsx', join(SCRIPTS_DIR, scriptFile), `--tender-id=${job.tenderId}`],
    {
      cwd: join(ROOT, 'scripts'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
    job.logs.push(`[TIMEOUT] Process killed after ${stepTimeout / 1000}s`);
  }, stepTimeout);

  child.stdout.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    job.logs.push(...lines);
  });

  child.stderr.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean);
    job.logs.push(...lines);
  });

  let finished = false;
  const finishJob = (status: 'done' | 'error', error?: string) => {
    if (finished) return; // Guard against double-fire (error + close)
    finished = true;
    clearTimeout(timeout);
    job.status = status;
    if (error) job.error = error;
    job.finishedAt = new Date().toISOString();
    currentJob = null;
    console.log(`Job ${job.id} (${job.step}/${job.tenderId}) ${job.status}`);
    processQueue();
  };

  child.on('close', (code) => {
    finishJob(code === 0 ? 'done' : 'error', code !== 0 ? `Process exited with code ${code}` : undefined);
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
    .filter(j => j.status === 'done' || j.status === 'error')
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
    if (job.tenderId === tenderId && (job.status === 'running' || job.status === 'queued')) {
      steps[job.step as keyof typeof steps] = 'running';
    }
  }

  return { tenderId, steps };
}

// GET /api/health - health check (no auth required)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: process.env.npm_package_version || '0.1.0' });
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
      const token = signToken(user);
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
    const { email, password } = req.body;
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
    const token = signToken(safeUser);
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

// GET /api/users - list all users
app.get('/api/users', requireJwt, async (_req, res) => {
  try {
    const users = await getAllUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/users - create a new user
app.post('/api/users', requireJwt, async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const user = await createUser(email, name, password);
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message || String(err) });
  }
});

// DELETE /api/users/:userId - delete a user (self-deletion blocked)
app.delete('/api/users/:userId', requireJwt, async (req, res) => {
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
app.get('/api/tenders', async (_req, res) => {
  try {
    await mkdir(INPUT_DIR, { recursive: true });
    const dirs = await readdir(INPUT_DIR);
    const tenders = await Promise.all(
      dirs
        .filter((d) => !d.startsWith('.'))
        .map(async (tenderId) => {
          const inputFiles = await readdir(join(INPUT_DIR, tenderId));
          const status = await getPipelineStatus(tenderId);
          // Read tender display name from meta
          let name: string | undefined;
          try {
            const meta = JSON.parse(await readFile(join(OUTPUT_DIR, tenderId, 'tender-meta.json'), 'utf-8'));
            name = meta.name;
          } catch {}
          return {
            id: tenderId,
            name,
            inputFiles: inputFiles.filter((f) => !f.startsWith('.')),
            ...status,
          };
        })
    );
    res.json(tenders);
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
    res.json(status);
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

// GET /api/tenders/:id/documents - list generated documents
app.get('/api/tenders/:id/documents', async (req, res) => {
  try {
    const outputDir = join(OUTPUT_DIR, req.params.id);
    const files = await readdir(outputDir);
    const docFiles = files.filter((f) => f.endsWith('.docx') || f.endsWith('.xlsx') || f.endsWith('.pdf'));
    res.json(docFiles);
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
    await writeFile(matchPath, JSON.stringify(productMatch, null, 2), 'utf-8');

    res.json({ success: true, itemIndex: idx, cenova_uprava: parsed });
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'product-match.json not found — run match step first' });
    }
    res.status(400).json({ error: `Invalid price data: ${String(err.message || err)}` });
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

// POST /api/companies/:companyId/documents - upload company docs
app.post('/api/companies/:companyId/documents', companyDocUpload.array('files', 20), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    const docs = await getCompanyDocuments(req.params.companyId);
    res.json({ uploaded: files.map(f => f.filename), documents: docs });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/companies/:companyId/documents - list company docs
app.get('/api/companies/:companyId/documents', async (req, res) => {
  try {
    const docs = await getCompanyDocuments(req.params.companyId);
    res.json(docs);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// DELETE /api/companies/:companyId/documents/:filename - delete company doc
app.delete('/api/companies/:companyId/documents/:filename', async (req, res) => {
  try {
    await deleteCompanyDocument(req.params.companyId, req.params.filename);
    res.json({ success: true });
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
    // Copy company docs to prilohy
    const copied = await copyCompanyDocsToTender(company_id, id);
    res.json({ success: true, company_id, copied_documents: copied });
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
    logs: job.logs.slice(since),
    totalLogLines: job.logs.length,
  });
});

// POST /api/tenders/:id/run/:step - enqueue a pipeline step
const stepFiles: Record<string, string> = {
  extract: 'extract-tender.ts',
  analyze: 'analyze-tender.ts',
  match: 'match-product.ts',
  generate: 'generate-bid.ts',
  validate: 'validate-bid.ts',
};

app.post('/api/tenders/:id/run/:step', async (req, res) => {
  const { id, step } = req.params;

  if (!stepFiles[step]) {
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
  if (step === 'generate') {
    try {
      const matchRaw = await readFile(join(OUTPUT_DIR, id, 'product-match.json'), 'utf-8');
      const matchData = ProductMatchSchema.parse(JSON.parse(matchRaw));

      if (matchData.polozky_match) {
        // Multi-product: all items must have confirmed prices
        const unconfirmed = matchData.polozky_match.filter(pm => !pm.cenova_uprava?.potvrzeno);
        if (unconfirmed.length > 0) {
          const names = unconfirmed.map(pm => pm.polozka_nazev).join(', ');
          return res.status(400).json({
            error: `Nejprve potvrďte ceny u všech položek. Nepotvrzené: ${names}`,
          });
        }
      } else if (!matchData.cenova_uprava?.potvrzeno) {
        return res.status(400).json({
          error: 'Nejprve potvrďte ceny v záložce Produkty. Bez potvrzené cenové kalkulace nelze generovat dokumenty.',
        });
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(400).json({ error: 'Nejprve spusťte krok "Produkty" a potvrďte ceny.' });
      }
      return res.status(400).json({ error: `Chyba při čtení product-match.json: ${String(err)}` });
    }
  }

  // Create job and enqueue
  const jobId = randomUUID().slice(0, 8);
  const job: Job = {
    id: jobId,
    tenderId: id,
    step,
    status: 'queued',
    logs: [],
    startedAt: new Date().toISOString(),
  };
  jobs.set(jobId, job);
  jobQueue.push(jobId);
  cleanupJobs();
  processQueue();

  console.log(`Job ${jobId} queued: ${step} for ${id}`);
  res.json({ jobId, status: job.status });
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

// Static file serving for production (React build)
const staticDir = join(ROOT, 'apps', 'web', 'dist');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  console.log(`Serving static files from: ${staticDir}`);
}

// Startup: migrate legacy company.json
migrateCompanies().catch(err => console.error('Company migration error:', err));

app.listen(PORT, () => {
  console.log(`\nVZ AI Tool API server running on http://localhost:${PORT}`);
  console.log(`Input dir: ${INPUT_DIR}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
});
