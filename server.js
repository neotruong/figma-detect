const express    = require('express');
const { put, head } = require('@vercel/blob');
const Jimp       = require('jimp');
const pixelmatch = require('pixelmatch');

const app = express();
app.use(express.json({ limit: '25mb' }));

const BASELINE_KEY = 'baseline.png';
const HISTORY_KEY  = 'history.json';
const TOKEN        = process.env.BLOB_READ_WRITE_TOKEN;

// ─── UTILS ───────────────────────────────────────────────────────────────────

function getBaselineKey(screen = 'default') {
  return screen === 'default' ? 'baseline.png' : `${screen}_baseline.png`;
}

function getHistoryKey(screen = 'default') {
  return screen === 'default' ? 'history.json' : `${screen}_history.json`;
}

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

// ─── HISTORY ──────────────────────────────────────────────────────────────────

async function getHistory(screen = 'default') {
  try {
    const historyKey = getHistoryKey(screen);
    const meta = await head(historyKey, { token: TOKEN }).catch(() => null);
    if (!meta) return [];
    const res = await fetch(meta.url);
    return await res.json();
  } catch (err) {
    console.warn('[getHistory] Failed to fetch history:', err.message);
    return [];
  }
}

async function saveHistory(history, screen = 'default') {
  try {
    const historyKey = getHistoryKey(screen);
    await put(historyKey, JSON.stringify(history, null, 2), {
      access: 'public', contentType: 'application/json', token: TOKEN
    });
  } catch (err) {
    console.warn('[saveHistory] Failed to save history:', err.message);
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/history', async (req, res) => {
  try {
    const { screen, baseline } = req.query;
    
    let screenName = screen || 'default';
    if (baseline && !screen) {
      screenName = baseline.replace(/_baseline\.png?$/, '') || 'default';
    }
    
    const history = await getHistory(screenName);
    return res.json({
      screen: screenName,
      history
    });
  } catch (err) {
    console.error('[history]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/compare', async (req, res) => {
  try {
    const { imageUrl, screen, baseline } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl in body' });

    // Support both 'screen' and 'baseline' parameters for backward compatibility
    let screenName = screen || 'default';
    if (baseline && !screen) {
      // Extract screen name from baseline filename (e.g., "onboarding_baseline.png" -> "onboarding")
      // Also handle cases with or without .png extension
      screenName = baseline.replace(/_baseline\.png?$/, '') || 'default';
    }

    const baselineKey = getBaselineKey(screenName);

    // Download newest image from Figma (sent by n8n)
    const newestBuffer = await downloadImage(imageUrl);

    // Check if baseline exists in Vercel Blob
    const baselineMeta = await head(baselineKey, { token: TOKEN }).catch(() => null);

    // First run — no baseline yet
    if (!baselineMeta) {
      await put(baselineKey, newestBuffer, {
        access: 'public', token: TOKEN, allowOverwrite: true
      });
      
      const history = await getHistory(screenName);
      const runData = {
        timestamp: new Date().toISOString(),
        percentage: 0,
        reportUrl: null,
        severity: 'none'
      };
      history.push(runData);
      await saveHistory(history, screenName);
      
      return res.status(201).json({
        status:      'baseline_created',
        severity:    'none',
        percentage:  0,
        reportUrl:   null,
        processedAt: new Date().toISOString(),
        screen:      screenName,
        baselineFile: getBaselineKey(screenName)
      });
    }

    // Download baseline from Blob
    const baselineRes  = await fetch(baselineMeta.url);
    const beforeBuffer = Buffer.from(await baselineRes.arrayBuffer());

    // Compare
    const { percentage, diffBuffer } = await compare(beforeBuffer, newestBuffer);
    const rounded  = parseFloat(percentage.toFixed(2));
    const severity = getSeverity(rounded);

    let reportUrl = null;

    // Only generate report if there are changes
    if (rounded > 0) {
      const reportKey = `reports/${screenName}/${new Date().toISOString().slice(0, 10)}/${Date.now()}.html`;
      const html      = buildReport({ beforeBuffer, afterBuffer: newestBuffer, diffBuffer, severity, percentage: rounded });
      const report = await put(reportKey, html, {
        access: 'public', contentType: 'text/html', token: TOKEN
      });
      reportUrl = report.url;
    }

    // Update baseline to latest
    await put(baselineKey, newestBuffer, {
      access: 'public', token: TOKEN, allowOverwrite: true
    });

    // Save run to history
    const history = await getHistory(screenName);
    const runData = {
      timestamp: new Date().toISOString(),
      percentage: rounded,
      reportUrl: reportUrl || null,
      severity
    };
    history.push(runData);
    await saveHistory(history, screenName);

    return res.json({
      status:      'ok',
      severity,
      percentage:  rounded,
      reportUrl,               // null if no changes, otherwise e.g. https://xxxx.public.blob.vercel-storage.com/reports/2026-04-03/xxx.html
      processedAt: new Date().toISOString(),
      screen:      screenName,
      baselineFile: getBaselineKey(screenName)
    });

  } catch (err) {
    console.error('[compare]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── EXPORT for Vercel (no app.listen) ───────────────────────────────────────
module.exports = app;