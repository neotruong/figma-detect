const express    = require('express');
const { put, head } = require('@vercel/blob');
const Jimp       = require('jimp');
const pixelmatch = require('pixelmatch');

const app = express();
app.use(express.json({ limit: '25mb' }));

const BASELINE_KEY = 'baseline.png';
const TOKEN        = process.env.BLOB_READ_WRITE_TOKEN;

// ─── UTILS ───────────────────────────────────────────────────────────────────

function getSeverity(pct) {
  if (pct >= 5)   return 'major';
  if (pct >= 0.1) return 'minor';
  return 'none';
}

async function downloadImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

function toDataUrl(buf) {
  return `data:image/png;base64,${buf.toString('base64')}`;
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
    h1 { font-size: 22px; font-weight: 700; }
    .badge {
      display: inline-block; margin-left: 10px; padding: 3px 12px;
      border-radius: 99px; font-size: 12px; font-weight: 700;
      background: ${color}; color: #fff;
    }
    .sub { margin-top: 6px; font-size: 13px; color: #94a3b8; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 24px; }
    .card { background: #1e293b; border-radius: 12px; overflow: hidden; }
    .card-title {
      padding: 10px 16px; font-size: 11px; font-weight: 600;
      letter-spacing: .08em; text-transform: uppercase; color: #64748b;
    }
    .card img { width: 100%; display: block; }
  </style>
</head>
<body>
  <h1>Design Diff Report <span class="badge">${severity.toUpperCase()}</span></h1>
  <p class="sub">${percentage}% pixels changed &nbsp;·&nbsp; ${ts}</p>
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
  const imgBefore = await new Promise((resolve, reject) => {
    Jimp.read(beforeBuffer, (err, img) => {
      if (err) reject(err);
      else resolve(img);
    });
  });
  const imgAfter = await new Promise((resolve, reject) => {
    Jimp.read(afterBuffer, (err, img) => {
      if (err) reject(err);
      else resolve(img);
    });
  });

  const w = imgBefore.bitmap.width;
  const h = imgBefore.bitmap.height;

  if (imgAfter.bitmap.width !== w || imgAfter.bitmap.height !== h) {
    imgAfter.resize(w, h);
  }

  const diffData   = new Uint8Array(w * h * 4);
  const diffPixels = pixelmatch(
    new Uint8Array(imgBefore.bitmap.data),
    new Uint8Array(imgAfter.bitmap.data),
    diffData, w, h,
    { threshold: 0.1, includeAA: false, diffColor: [255, 0, 255], alpha: 0.15 }
  );

  const percentage = (diffPixels / (w * h)) * 100;

  const diffImg = new Jimp(w, h);
  diffImg.bitmap.data = Buffer.from(diffData);
  const diffBuffer = await new Promise((resolve, reject) => {
    diffImg.getBuffer('image/png', (err, buf) => {
      if (err) reject(err);
      else resolve(buf);
    });
  });

  return { percentage, diffBuffer };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/compare', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl in body' });

    // Download newest image from Figma (sent by n8n)
    const newestBuffer = await downloadImage(imageUrl);

    // Check if baseline exists in Vercel Blob
    const baselineMeta = await head(BASELINE_KEY, { token: TOKEN }).catch(() => null);

    // First run — no baseline yet
    if (!baselineMeta) {
      await put(BASELINE_KEY, newestBuffer, {
        access: 'public', token: TOKEN, allowOverwrite: true
      });
      return res.status(201).json({
        status:      'baseline_created',
        severity:    'none',
        percentage:  0,
        reportUrl:   null,
        processedAt: new Date().toISOString()
      });
    }

    // Download baseline from Blob
    const baselineRes  = await fetch(baselineMeta.url);
    const beforeBuffer = Buffer.from(await baselineRes.arrayBuffer());

    // Compare
    const { percentage, diffBuffer } = await compare(beforeBuffer, newestBuffer);
    const rounded  = parseFloat(percentage.toFixed(2));
    const severity = getSeverity(rounded);

    // Upload self-contained report.html to Blob → get permanent public URL
    const reportKey = `reports/${new Date().toISOString().slice(0, 10)}/${Date.now()}.html`;
    const html      = buildReport({ beforeBuffer, afterBuffer: newestBuffer, diffBuffer, severity, percentage: rounded });
    const { url: reportUrl } = await put(reportKey, html, {
      access: 'public', contentType: 'text/html', token: TOKEN
    });

    // Update baseline to latest
    await put(BASELINE_KEY, newestBuffer, {
      access: 'public', token: TOKEN, allowOverwrite: true
    });

    return res.json({
      status:      'ok',
      severity,
      percentage:  rounded,
      reportUrl,               // e.g. https://xxxx.public.blob.vercel-storage.com/reports/2026-04-03/xxx.html
      processedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[compare]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── EXPORT for Vercel (no app.listen) ───────────────────────────────────────
module.exports = app;