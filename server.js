const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { Jimp }   = require('jimp');
const pixelmatch = require('pixelmatch');

const app  = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR      = path.join(process.cwd(), 'data');
const BASELINE_PATH = path.join(DATA_DIR, 'baseline.png');
const REPORTS_DIR   = path.join(DATA_DIR, 'reports');

app.use(express.json({ limit: '25mb' }));
app.use('/reports', express.static(REPORTS_DIR)); // serve report.html files

fs.mkdirSync(DATA_DIR,    { recursive: true });
fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ─── UTILS ───────────────────────────────────────────────────────────────────

function getSeverity(pct) {
  if (pct >= 5)   return 'major';
  if (pct >= 0.1) return 'minor';
  return 'none';
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function toDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

// ─── REPORT HTML ─────────────────────────────────────────────────────────────

function buildReport({ beforeBuffer, afterBuffer, diffBuffer, severity, percentage }) {
  const ts    = new Date().toISOString();
  const color = severity === 'major' ? '#ef4444'
              : severity === 'minor' ? '#f59e0b'
              : '#22c55e';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Diff Report — ${ts.slice(0, 10)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 32px; }
    header { margin-bottom: 28px; }
    h1 { font-size: 22px; font-weight: 700; }
    .badge {
      display: inline-block; margin-left: 10px; padding: 3px 12px;
      border-radius: 99px; font-size: 12px; font-weight: 700;
      background: ${color}; color: #fff;
    }
    .sub { margin-top: 6px; font-size: 13px; color: #94a3b8; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .card { background: #1e293b; border-radius: 12px; overflow: hidden; }
    .card-title {
      padding: 10px 16px; font-size: 11px; font-weight: 600;
      letter-spacing: .08em; text-transform: uppercase; color: #64748b;
    }
    .card img { width: 100%; display: block; }
  </style>
</head>
<body>
  <header>
    <h1>Design Diff Report <span class="badge">${severity.toUpperCase()}</span></h1>
    <p class="sub">${percentage}% pixels changed &nbsp;·&nbsp; ${ts}</p>
  </header>
  <div class="grid">
    <div class="card">
      <div class="card-title">Before — Baseline</div>
      <img src="${toDataUrl(beforeBuffer)}" alt="before">
    </div>
    <div class="card">
      <div class="card-title">After — Latest</div>
      <img src="${toDataUrl(afterBuffer)}" alt="after">
    </div>
    <div class="card">
      <div class="card-title">Diff — Highlighted</div>
      <img src="${toDataUrl(diffBuffer)}" alt="diff">
    </div>
  </div>
</body>
</html>`;
}

// ─── CORE: pixel diff ────────────────────────────────────────────────────────

async function compare(beforeBuffer, afterBuffer) {
  const imgBefore = await Jimp.read(beforeBuffer);
  const imgAfter  = await Jimp.read(afterBuffer);

  const w = imgBefore.bitmap.width;
  const h = imgBefore.bitmap.height;

  if (imgAfter.bitmap.width !== w || imgAfter.bitmap.height !== h) {
    imgAfter.resize({ w, h });
  }

  const diffData   = new Uint8Array(w * h * 4);
  const diffPixels = pixelmatch(
    new Uint8Array(imgBefore.bitmap.data),
    new Uint8Array(imgAfter.bitmap.data),
    diffData, w, h,
    { threshold: 0.1, includeAA: false, diffColor: [255, 0, 255], alpha: 0.15 }
  );

  const percentage = (diffPixels / (w * h)) * 100;

  const diffImg = new Jimp({ width: w, height: h });
  diffImg.bitmap.data = Buffer.from(diffData);
  const diffBuffer = await diffImg.getBuffer('image/png');

  return { percentage, diffBuffer };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/*
  POST /api/compare
  Body : { imageUrl: "https://..." }

  1. Download image from imageUrl
  2. No baseline → save as baseline, return baseline_created
  3. Has baseline → pixel diff → generate report.html → update baseline
  4. Return { severity, percentage, reportUrl }
*/
app.post('/api/compare', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl in body' });

    const newestBuffer = await downloadImage(imageUrl);

    // First run — no baseline yet
    if (!fs.existsSync(BASELINE_PATH)) {
      fs.writeFileSync(BASELINE_PATH, newestBuffer);
      return res.status(201).json({
        status:      'baseline_created',
        severity:    'none',
        percentage:  0,
        reportUrl:   null,
        processedAt: new Date().toISOString()
      });
    }

    // Compare
    const beforeBuffer               = fs.readFileSync(BASELINE_PATH);
    const { percentage, diffBuffer } = await compare(beforeBuffer, newestBuffer);
    const rounded                    = parseFloat(percentage.toFixed(2));
    const severity                   = getSeverity(rounded);

    // Save self-contained report.html
    const dateKey   = new Date().toISOString().slice(0, 10);       // e.g. 2026-04-03
    const reportDir = path.join(REPORTS_DIR, dateKey);
    fs.mkdirSync(reportDir, { recursive: true });

    const fileName  = `${Date.now()}.html`;
    const html      = buildReport({ beforeBuffer, afterBuffer: newestBuffer, diffBuffer, severity, percentage: rounded });
    fs.writeFileSync(path.join(reportDir, fileName), html);

    // Update baseline to newest
    fs.writeFileSync(BASELINE_PATH, newestBuffer);

    const reportUrl = `${req.protocol}://${req.get('host')}/reports/${dateKey}/${fileName}`;

    return res.json({
      status:      'ok',
      severity,
      percentage:  rounded,
      reportUrl,
      processedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[compare]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nPix Diff → http://localhost:${PORT}`);
  console.log(`Endpoint  → POST /api/compare  { imageUrl }`);
  console.log(`Reports   → http://localhost:${PORT}/reports\n`);
});