const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { Jimp }   = require('jimp');      // ✅ FIX 1: destructure for v0.22
const pixelmatch = require('pixelmatch');
const multer     = require('multer');

const app  = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage() });

const DATA_ROOT    = path.join(process.cwd(), 'data');
const BASELINE_DIR = path.join(DATA_ROOT, 'baselines');
const REPORTS_DIR  = path.join(DATA_ROOT, 'report-history');

app.use(express.json({ limit: '25mb' }));

function ensureDirectories() {
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  fs.mkdirSync(REPORTS_DIR,  { recursive: true });
}

function sanitizeCaseName(caseName) {
  return String(caseName || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getSeverity(percentage) {
  if (percentage >= 5)   return 'major';
  if (percentage >= 0.1) return 'minor';
  return 'none';
}

function saveReportHistory(caseName, payload, diffBuffer) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const dayDir  = path.join(REPORTS_DIR, dateKey);
  fs.mkdirSync(dayDir, { recursive: true });

  const ts       = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = `${ts}__${caseName}`;
  const jsonPath = path.join(dayDir, `${baseName}.json`);
  const diffPath = path.join(dayDir, `${baseName}.diff.png`);

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  if (diffBuffer) fs.writeFileSync(diffPath, diffBuffer);

  return { jsonPath, diffPath: diffBuffer ? diffPath : null };
}

async function fetchBufferFromUrl(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchNewestImageFromFigma(body) {
  const directImageUrl = body?.figmaImageUrl || body?.imageUrl;
  if (typeof directImageUrl === 'string' && directImageUrl.trim()) {
    const buffer = await fetchBufferFromUrl(directImageUrl.trim());
    return {
      newestBuffer: buffer,
      source: { mode: 'direct-image-url', url: directImageUrl.trim() }
    };
  }

  const figmaFileKey = body?.figmaFileKey;
  const figmaNodeId  = body?.figmaNodeId;
  const figmaToken   = body?.figmaToken || process.env.FIGMA_TOKEN;

  if (!figmaFileKey || !figmaNodeId) {
    throw new Error('Missing Figma input. Provide figmaImageUrl, or figmaFileKey + figmaNodeId.');
  }
  if (!figmaToken) {
    throw new Error('Missing Figma token. Provide figmaToken in body or set FIGMA_TOKEN env.');
  }

  const query = new URLSearchParams({ ids: String(figmaNodeId), format: 'png' }).toString();
  const imagesApiUrl = `https://api.figma.com/v1/images/${encodeURIComponent(String(figmaFileKey))}?${query}`;

  const imageMetaResponse = await fetch(imagesApiUrl, {
    headers: { 'X-Figma-Token': figmaToken }
  });
  if (!imageMetaResponse.ok) {
    throw new Error(`Figma images API failed: ${imageMetaResponse.status}`);
  }

  const imageMeta  = await imageMetaResponse.json();
  const renderedUrl = imageMeta?.images?.[String(figmaNodeId)];
  if (!renderedUrl) {
    throw new Error('Figma did not return a rendered image URL for figmaNodeId.');
  }

  const newestBuffer = await fetchBufferFromUrl(renderedUrl);
  return {
    newestBuffer,
    source: {
      mode: 'figma-api',
      fileKey: String(figmaFileKey),
      nodeId: String(figmaNodeId),
      renderedUrl
    }
  };
}

async function readImageSize(input) {
  const img = await Jimp.read(input);
  return { width: img.bitmap.width, height: img.bitmap.height };
}

async function runSizePrecheck({ baselinePath, body, newestBuffer }) {
  if (!fs.existsSync(baselinePath)) {
    return { baselineExists: false, sizeChanged: false, reason: 'baseline_not_found' };
  }

  const baselineSize = await readImageSize(baselinePath);
  const metaWidth    = Number(body?.figmaWidth);
  const metaHeight   = Number(body?.figmaHeight);
  const hasMetaSize  = Number.isFinite(metaWidth) && Number.isFinite(metaHeight) && metaWidth > 0 && metaHeight > 0;

  const newestSize = hasMetaSize
    ? { width: metaWidth, height: metaHeight, source: 'figma-metadata' }
    : { ...(await readImageSize(newestBuffer)), source: 'downloaded-image' };

  const widthDiff  = newestSize.width  - baselineSize.width;
  const heightDiff = newestSize.height - baselineSize.height;

  return {
    baselineExists:  true,
    baselineWidth:   baselineSize.width,
    baselineHeight:  baselineSize.height,
    newestWidth:     newestSize.width,
    newestHeight:    newestSize.height,
    widthDiff,
    heightDiff,
    sizeChanged: widthDiff !== 0 || heightDiff !== 0,
    source: newestSize.source
  };
}

// ─── CORE: pixel diff ────────────────────────────────────────────────────────
async function detectChanges(beforeInput, afterInput) {
  const imgBefore = await Jimp.read(beforeInput);
  const imgAfter  = await Jimp.read(afterInput);

  const w = imgBefore.bitmap.width;
  const h = imgBefore.bitmap.height;

  // ✅ FIX 2: Jimp 0.22 resize signature
  if (imgAfter.bitmap.width !== w || imgAfter.bitmap.height !== h) {
    imgAfter.resize({ w, h });
  }

  // ✅ FIX 3: cast to Uint8Array for pixelmatch safety
  const rawBefore = new Uint8Array(imgBefore.bitmap.data);
  const rawAfter  = new Uint8Array(imgAfter.bitmap.data);
  const diffData  = new Uint8Array(w * h * 4);

  const diffPixels = pixelmatch(rawBefore, rawAfter, diffData, w, h, {
    threshold:  0.1,
    includeAA:  false,
    diffColor:  [255, 0, 255],
    alpha:      0.15
  });

  const percentage = (diffPixels / (w * h)) * 100;

  // ✅ FIX 4: Jimp 0.22 constructor + getBuffer (replaces new Jimp callback + getBufferAsync)
  const diffImg = new Jimp({ width: w, height: h });
  diffImg.bitmap.data = Buffer.from(diffData);
  const diffBuffer = await diffImg.getBuffer('image/png');

  return { percentage, diffBuffer };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    directories: { dataRoot: DATA_ROOT, baselines: BASELINE_DIR, reportHistory: REPORTS_DIR }
  });
});

app.post('/api/figma/sync/:caseName', upload.single('image'), async (req, res) => {
  try {
    const caseName = sanitizeCaseName(req.params.caseName);
    if (!caseName) return res.status(400).json({ error: 'Invalid caseName' });

    const baselinePath = path.join(BASELINE_DIR, `${caseName}.png`);

    const { newestBuffer, source } = await fetchNewestImageFromFigma(req.body || {});
    if (!newestBuffer || newestBuffer.length === 0) {
      return res.status(400).json({ error: 'Could not fetch newest image from Figma.' });
    }

    const sizePrecheck = await runSizePrecheck({ baselinePath, body: req.body || {}, newestBuffer });

    // First run — no baseline yet, save and return
    if (!fs.existsSync(baselinePath)) {
      fs.writeFileSync(baselinePath, newestBuffer);
      const payload = {
        caseName,
        status:          'baseline_created',
        percentage:       0,
        severity:         'none',
        baselinePath,
        baselineUpdated:  true,
        processedAt:      new Date().toISOString(),
        source,
        sizePrecheck,
        note: 'No previous baseline existed. Stored newest image as baseline.'
      };
      const reportFiles = saveReportHistory(caseName, payload, null);
      return res.status(201).json({ ...payload, reportFiles });
    }

    // Run pixel diff
    const { percentage, diffBuffer } = await detectChanges(baselinePath, newestBuffer);
    const rounded  = parseFloat(percentage.toFixed(4));
    const severity = sizePrecheck.sizeChanged ? 'major' : getSeverity(rounded);

    // Always update baseline after comparison
    fs.writeFileSync(baselinePath, newestBuffer);

    const payload = {
      caseName,
      status:          'ok',
      percentage:       rounded,
      severity,
      baselinePath,
      baselineUpdated:  true,
      processedAt:      new Date().toISOString(),
      source,
      sizePrecheck
    };

    const reportFiles = saveReportHistory(caseName, payload, diffBuffer);
    return res.json({ ...payload, reportFiles });

  } catch (err) {
    console.error('[figma-sync] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports', (req, res) => {
  try {
    const date      = req.query.date ? String(req.query.date) : null;
    const targetDir = date ? path.join(REPORTS_DIR, date) : REPORTS_DIR;
    if (!fs.existsSync(targetDir)) return res.json({ root: targetDir, files: [] });
    return res.json({ root: targetDir, files: fs.readdirSync(targetDir).sort() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/', (_req, res) => {
  return res.json({
    service: 'pix-diff',
    version: '1.0.0',
    endpoints: {
      'GET  /health':                     'Health check',
      'POST /api/figma/sync/:caseName':   'Fetch from Figma → pixel diff → update baseline',
      'GET  /api/reports':                'List report history (optional ?date=YYYY-MM-DD)'
    },
    directories: { dataRoot: DATA_ROOT, baselines: BASELINE_DIR, reportHistory: REPORTS_DIR }
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
ensureDirectories();
app.listen(PORT, () => {
  console.log(`\nPix Diff API running on http://localhost:${PORT}`);
  console.log(`baseline dir : ${BASELINE_DIR}`);
  console.log(`report dir   : ${REPORTS_DIR}`);
  console.log(`n8n endpoint : POST http://localhost:${PORT}/api/figma/sync/:caseName\n`);
});