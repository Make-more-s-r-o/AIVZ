import express from 'express';
import cors from 'cors';
import multer from 'multer';
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
app.use(express.json());

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

// Bearer token auth middleware (only active when API_TOKEN is set)
// GET requests are public (frontend reads), POST/PUT/DELETE require Bearer token or same-origin
const API_TOKEN = process.env.API_TOKEN;
if (API_TOKEN) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/health') return next();
    if (req.method === 'GET') return next();
    const auth = req.headers.authorization;
    if (auth === `Bearer ${API_TOKEN}`) return next();
    // Support ?token= query param (for download links in <a href>)
    if (req.query.token === API_TOKEN) return next();
    // Allow same-origin browser requests (frontend on same server)
    try {
      const origin = req.headers.origin || req.headers.referer;
      if (origin) {
        const originHost = new URL(origin).hostname;
        if (originHost === req.hostname) return next();
      }
    } catch {}
    res.status(401).json({ error: 'Unauthorized' });
  });
}

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
          return {
            id: tenderId,
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
    const docFiles = files.filter((f) => f.endsWith('.docx') || f.endsWith('.xlsx'));
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

// Static file serving for production (React build)
const staticDir = join(ROOT, 'apps', 'web', 'dist');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(join(staticDir, 'index.html')));
  console.log(`Serving static files from: ${staticDir}`);
}

app.listen(PORT, () => {
  console.log(`\nVZ AI Tool API server running on http://localhost:${PORT}`);
  console.log(`Input dir: ${INPUT_DIR}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
});
