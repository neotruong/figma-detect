const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const Jimp       = require('jimp');      // v0.22 — default export
const pixelmatch = require('pixelmatch');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ─── CORE: pixel diff ────────────────────────────────────────────────────────
async function detectChanges(beforeInput, afterInput) {
  const imgBefore = await Jimp.read(beforeInput);
  const imgAfter  = await Jimp.read(afterInput);

  const w = imgBefore.bitmap.width;
  const h = imgBefore.bitmap.height;
  if (imgAfter.bitmap.width !== w || imgAfter.bitmap.height !== h) {
    imgAfter.resize(w, h);
  }

  const rawBefore = imgBefore.bitmap.data;
  const rawAfter  = imgAfter.bitmap.data;
  const diffData  = Buffer.alloc(rawBefore.length);

  const diffPixels = pixelmatch(rawBefore, rawAfter, diffData, w, h, {
    threshold: 0.1,
    includeAA: false,
    diffColor: [255, 0, 255],
    alpha: 0.15
  });

  const percentage = (diffPixels / (w * h)) * 100;

  const diffImg = await new Promise((resolve, reject) => {
    new Jimp(w, h, (err, img) => {
      if (err) return reject(err);
      img.bitmap.data = diffData;
      resolve(img);
    });
  });

  const diffBuffer = await diffImg.getBufferAsync(Jimp.MIME_PNG);
  return { percentage, diffBuffer };
}

// ─── SCAN all case_ folders ──────────────────────────────────────────────────
async function runAllCases(rootDir, { includeImages = false } = {}) {
  const caseFolders = fs.readdirSync(rootDir)
    .filter(item =>
      fs.statSync(path.join(rootDir, item)).isDirectory() &&
      item.startsWith('case_')
    )
    .sort();

  const cases = {};

  for (const folder of caseFolders) {
    const casePath   = path.join(rootDir, folder);
    const beforePath = path.join(casePath, 'before.png');
    const afterPath  = path.join(casePath, 'after.png');

    // Missing images
    if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
      cases[folder] = {
        status: 'skipped',
        reason: !fs.existsSync(beforePath) ? 'before.png not found' : 'after.png not found'
      };
      continue;
    }

    try {
      const { percentage, diffBuffer } = await detectChanges(beforePath, afterPath);
      const severity = percentage >= 5 ? 'major' : percentage >= 0.1 ? 'minor' : 'none';

      const entry = {
        status:      'ok',
        percentage:  parseFloat(percentage.toFixed(4)),
        severity,
        processedAt: new Date().toISOString()
      };

      if (includeImages) {
        entry.images = {
          before: 'data:image/png;base64,' + fs.readFileSync(beforePath).toString('base64'),
          after:  'data:image/png;base64,' + fs.readFileSync(afterPath).toString('base64'),
          diff:   'data:image/png;base64,' + diffBuffer.toString('base64')
        };
      }

      cases[folder] = entry;
    } catch (err) {
      cases[folder] = { status: 'error', reason: err.message };
    }
  }

  const processed = Object.values(cases).filter(c => c.status === 'ok');

  return {
    generatedAt:    new Date().toISOString(),
    rootDir,
    totalFolders:   caseFolders.length,
    processed:      processed.length,
    skipped:        Object.values(cases).filter(c => c.status === 'skipped').length,
    errors:         Object.values(cases).filter(c => c.status === 'error').length,
    summary: {
      major: processed.filter(c => c.severity === 'major').length,
      minor: processed.filter(c => c.severity === 'minor').length,
      none:  processed.filter(c => c.severity === 'none').length
    },
    cases
  };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health check — n8n can poll this to confirm the service is up
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /api/scan  — trigger a full scan (called by n8n)
 * GET  /api/scan  — same, via GET for simple webhook nodes
 *
 * Query params:
 *   ?images=true   include base64 before/after/diff images in response
 *   ?dir=path      override the scan root directory (default: cwd)
 *
 * Response: JSON results dict with all cases
 */
async function handleScan(req, res) {
  try {
    const includeImages = (req.query.images === 'true');
    const rootDir = req.query.dir
      ? path.resolve(req.query.dir)
      : process.cwd();

    if (!fs.existsSync(rootDir)) {
      return res.status(400).json({ error: `Directory not found: ${rootDir}` });
    }

    console.log(`[scan] rootDir=${rootDir} includeImages=${includeImages}`);
    const result = await runAllCases(rootDir, { includeImages });
    console.log(`[scan] done — ${result.processed}/${result.totalFolders} processed`);

    res.json(result);
  } catch (err) {
    console.error('[scan] error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/scan',  handleScan);
app.post('/api/scan', handleScan);

/**
 * POST /api/scan/:caseName — scan a single case folder
 * Useful for n8n to re-check one specific case after an update.
 */
app.post('/api/scan/:caseName', async (req, res) => {
  try {
    const { caseName } = req.params;
    const includeImages = (req.query.images === 'true');
    const rootDir = req.query.dir ? path.resolve(req.query.dir) : process.cwd();
    const casePath   = path.join(rootDir, caseName);
    const beforePath = path.join(casePath, 'before.png');
    const afterPath  = path.join(casePath, 'after.png');

    if (!fs.existsSync(casePath)) {
      return res.status(404).json({ error: `Folder not found: ${caseName}` });
    }
    if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
      return res.status(422).json({ error: 'before.png or after.png missing in folder' });
    }

    const { percentage, diffBuffer } = await detectChanges(beforePath, afterPath);
    const severity = percentage >= 5 ? 'major' : percentage >= 0.1 ? 'minor' : 'none';

    const result = {
      caseName,
      status:      'ok',
      percentage:  parseFloat(percentage.toFixed(4)),
      severity,
      processedAt: new Date().toISOString()
    };

    if (includeImages) {
      result.images = {
        before: 'data:image/png;base64,' + fs.readFileSync(beforePath).toString('base64'),
        after:  'data:image/png;base64,' + fs.readFileSync(afterPath).toString('base64'),
        diff:   'data:image/png;base64,' + diffBuffer.toString('base64')
      };
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Catch-all: simple status page (not the main use case)
app.get('/', (_req, res) => {
  res.json({
    service:   'pix-diff',
    version:   '1.0.0',
    endpoints: {
      'GET  /health':              'Health check',
      'GET  /api/scan':            'Scan all case_ folders → JSON results',
      'POST /api/scan':            'Same, via POST (n8n HTTP Request node)',
      'POST /api/scan/:caseName':  'Scan a single case folder',
    },
    queryParams: {
      'images=true': 'Include base64 before/after/diff images in response',
      'dir=path':    'Override root directory to scan (default: cwd)'
    }
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Pix Diff API running on http://localhost:${PORT}`);
  console.log(`   n8n endpoint: POST http://localhost:${PORT}/api/scan\n`);
});
