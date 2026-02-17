import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { readFile, readdir, mkdir, stat, writeFile } from 'fs/promises';
import { join, extname } from 'path';
import { execSync } from 'child_process';
import { config } from 'dotenv';

config({ path: new URL('../../.env', import.meta.url).pathname });

const ROOT = new URL('../../', import.meta.url).pathname;
const INPUT_DIR = join(ROOT, 'input');
const OUTPUT_DIR = join(ROOT, 'output');
const SCRIPTS_DIR = join(ROOT, 'scripts', 'src');
const PORT = process.env.API_PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

// File upload config
const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, cb) => {
      const tenderId = req.params.id || `tender-${Date.now()}`;
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
    if (['.pdf', '.docx', '.doc'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOCX, and DOC files are allowed'));
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

  return { tenderId, steps };
}

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
app.post('/api/tenders/upload', upload.array('files', 20), async (req, res) => {
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
    const docxFiles = files.filter((f) => f.endsWith('.docx'));
    res.json(docxFiles);
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

// POST /api/tenders/:id/run/:step - run a pipeline step
const stepFiles: Record<string, string> = {
  extract: 'extract-tender.ts',
  analyze: 'analyze-tender.ts',
  match: 'match-product.ts',
  generate: 'generate-bid.ts',
  validate: 'validate-bid.ts',
};

app.post('/api/tenders/:id/run/:step', async (req, res) => {
  const { id, step } = req.params;
  const scriptFile = stepFiles[step];

  if (!scriptFile) {
    return res.status(400).json({ error: `Unknown step: ${step}` });
  }

  // Check input exists
  try {
    await stat(join(INPUT_DIR, id));
  } catch {
    return res.status(404).json({ error: `Tender "${id}" not found in input/` });
  }

  try {
    console.log(`Running ${step} for tender ${id}...`);
    execSync(
      `npx tsx "${join(SCRIPTS_DIR, scriptFile)}" --tender-id=${id}`,
      { cwd: join(ROOT, 'scripts'), timeout: 300000 }
    );
    const status = await getPipelineStatus(id);
    res.json({ success: true, ...status });
  } catch (err) {
    const status = await getPipelineStatus(id);
    res.status(500).json({
      error: `Step "${step}" failed: ${String(err)}`,
      ...status,
    });
  }
});

app.listen(PORT, () => {
  console.log(`\nVZ AI Tool API server running on http://localhost:${PORT}`);
  console.log(`Input dir: ${INPUT_DIR}`);
  console.log(`Output dir: ${OUTPUT_DIR}`);
});
