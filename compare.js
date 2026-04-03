const Jimp        = require('jimp');       // v0.22 — default export
const pixelmatch  = require('pixelmatch');
const fs          = require('fs');
const path        = require('path');

// ─── DETECT CHANGES ──────────────────────────────────────────────────────────
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

  // Build diff Jimp image from pixel buffer
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

// ─── CREATE 3-PANEL COMPARISON ───────────────────────────────────────────────
async function createThreePanel(beforeInput, afterInput, diffBuffer) {
  const imgBefore = await Jimp.read(beforeInput);
  const imgAfter  = await Jimp.read(afterInput);
  const imgDiff   = await Jimp.read(diffBuffer);

  const w   = imgBefore.bitmap.width;
  const h   = imgBefore.bitmap.height;
  const PAD = 10;

  const canvas = await new Promise((resolve, reject) => {
    new Jimp(w * 3 + PAD * 4, h + PAD * 2, 0xffffffff, (err, img) => {
      if (err) return reject(err);
      resolve(img);
    });
  });

  canvas.composite(imgBefore, PAD,           PAD);
  canvas.composite(imgAfter,  PAD * 2 + w,   PAD);
  canvas.composite(imgDiff,   PAD * 3 + w*2, PAD);

  return canvas.getBufferAsync(Jimp.MIME_PNG);
}

// ─── PROCESS SINGLE CASE ─────────────────────────────────────────────────────
async function processCase(casePath, caseName) {
  console.log(`\n📁 Processing: ${caseName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const beforePath = path.join(casePath, 'before.png');
  const afterPath  = path.join(casePath, 'after.png');

  if (!fs.existsSync(beforePath)) { console.log('⚠️  Skipped: before.png not found'); return null; }
  if (!fs.existsSync(afterPath))  { console.log('⚠️  Skipped: after.png not found');  return null; }

  try {
    const { percentage, diffBuffer } = await detectChanges(beforePath, afterPath);
    console.log(`📊 Difference: ${percentage.toFixed(2)}%`);

    const panelBuffer = await createThreePanel(beforePath, afterPath, diffBuffer);
    const outputPath  = path.join(casePath, 'diff-result.png');
    fs.writeFileSync(outputPath, panelBuffer);
    console.log(`✅ Saved: ${outputPath}`);

    const severity = percentage >= 5 ? 'major' : percentage >= 0.1 ? 'minor' : 'none';
    return { caseName, percentage, severity, outputPath, beforePath, afterPath, diffPath: outputPath, processedAt: new Date().toISOString() };
  } catch (err) {
    console.log(`❌ Error: ${err.message}`);
    return null;
  }
}

// ─── BATCH: PROCESS ALL case_ FOLDERS ────────────────────────────────────────
async function processAllCases() {
  const rootDir = process.cwd();
  console.log('🚀 Starting batch comparison...');
  console.log(`📂 Root directory: ${rootDir}\n`);

  const caseFolders = fs.readdirSync(rootDir)
    .filter(item => fs.statSync(path.join(rootDir, item)).isDirectory() && item.startsWith('case_'))
    .sort();

  console.log(`Found ${caseFolders.length} case folders:\n`);
  caseFolders.forEach(f => console.log(`  - ${f}`));

  const results = [];
  for (const folder of caseFolders) {
    const r = await processCase(path.join(rootDir, folder), folder);
    if (r) results.push(r);
  }

  results.sort((a, b) => b.percentage - a.percentage);

  console.log('\n\n' + '═'.repeat(50));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(50));
  console.log(`Total cases processed: ${results.length}/${caseFolders.length}\n`);

  results.forEach((r, i) => {
    const icon = r.severity === 'major' ? '🔴' : r.severity === 'minor' ? '🟡' : '🟢';
    console.log(`${i + 1}. ${icon} ${r.caseName}`);
    console.log(`   Difference: ${r.percentage.toFixed(2)}% [${r.severity}]`);
    console.log(`   Output: ${r.outputPath}\n`);
  });

  // Build results dict
  const allResults = {
    generatedAt: new Date().toISOString(),
    rootDir,
    totalCases: caseFolders.length,
    processedCases: results.length,
    cases: {}
  };
  results.forEach(r => {
    allResults.cases[r.caseName] = {
      percentage: r.percentage, severity: r.severity,
      beforePath: r.beforePath, afterPath: r.afterPath,
      diffPath: r.diffPath, processedAt: r.processedAt
    };
  });

  fs.writeFileSync(path.join(rootDir, 'results.json'), JSON.stringify(allResults, null, 2));
  console.log(`\n💾 Results saved to: results.json`);

  await generateHTMLReport(allResults, rootDir);
  console.log('✅ Batch processing complete!\n');
}

// ─── GENERATE HTML REPORT ────────────────────────────────────────────────────
async function generateHTMLReport(allResults, rootDir) {
  const toB64 = p => { try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch { return ''; } };

  const majorCount   = Object.values(allResults.cases).filter(c => c.severity === 'major').length;
  const minorCount = Object.values(allResults.cases).filter(c => c.severity === 'minor').length;
  const noneCount    = Object.values(allResults.cases).filter(c => c.severity === 'none').length;

  const cardsHTML = Object.entries(allResults.cases).map(([name, c]) => {
    const label = c.severity === 'major' ? '🔴 Major' : c.severity === 'minor' ? '🟡 Minor' : '🟢 No Change';
    const b64Before = toB64(c.beforePath);
    const b64After  = toB64(c.afterPath);
    const b64Diff   = toB64(c.diffPath);
    return `
    <div class="case-card severity-${c.severity}">
      <div class="case-header">
        <h2 class="case-name">${name}</h2>
        <span class="badge badge-${c.severity}">${label}</span>
        <span class="pct">${c.percentage.toFixed(2)}% diff</span>
      </div>
      <div class="images">
        <div class="img-block">
          <div class="img-label">BEFORE</div>
          <img src="${b64Before}" onclick="openLightbox(this.src,'BEFORE — ${name}')" />
        </div>
        <div class="img-block">
          <div class="img-label">AFTER</div>
          <img src="${b64After}" onclick="openLightbox(this.src,'AFTER — ${name}')" />
        </div>
        <div class="img-block">
          <div class="img-label">DIFF</div>
          <img src="${b64Diff}" onclick="openLightbox(this.src,'DIFF — ${name}')" />
        </div>
      </div>
    </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Pixel Diff Report</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f5f7;color:#172b4d}
    header{background:#0052cc;color:#fff;padding:20px 32px}
    header h1{font-size:1.4rem;font-weight:700}
    header p{font-size:.85rem;opacity:.75;margin-top:4px}
    .summary{display:flex;gap:16px;padding:24px 32px;flex-wrap:wrap}
    .stat-card{background:#fff;border-radius:8px;padding:16px 24px;min-width:130px;box-shadow:0 1px 3px rgba(0,0,0,.1);text-align:center}
    .stat-card .value{font-size:2rem;font-weight:700}
    .stat-card .label{font-size:.78rem;color:#6b778c;margin-top:4px}
    .stat-card.major .value{color:#de350b}.stat-card.minor .value{color:#ff8b00}.stat-card.none .value{color:#00875a}
    .filters{padding:0 32px 16px;display:flex;gap:8px;flex-wrap:wrap}
    .filter-btn{padding:6px 14px;border-radius:20px;border:1px solid #dfe1e6;background:#fff;cursor:pointer;font-size:.85rem;transition:.15s}
    .filter-btn.active,.filter-btn:hover{background:#0052cc;color:#fff;border-color:#0052cc}
    .cases{padding:0 32px 40px;display:flex;flex-direction:column;gap:20px}
    .case-card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.1);overflow:hidden;border-left:5px solid #dfe1e6}
    .case-card.severity-major{border-left-color:#de350b}.case-card.severity-minor{border-left-color:#ff8b00}.case-card.severity-none{border-left-color:#00875a}
    .case-header{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid #f4f5f7;flex-wrap:wrap}
    .case-name{font-size:1rem;font-weight:600;flex:1}
    .pct{font-size:.85rem;color:#6b778c}
    .badge{padding:3px 10px;border-radius:12px;font-size:.78rem;font-weight:600}
    .badge-major{background:#ffebe6;color:#de350b}.badge-minor{background:#fffae6;color:#ff8b00}.badge-none{background:#e3fcef;color:#00875a}
    .images{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:#f4f5f7}
    .img-block{background:#fff;padding:12px;display:flex;flex-direction:column;align-items:center;gap:8px}
    .img-label{font-size:.72rem;font-weight:700;letter-spacing:.06em;color:#6b778c}
    .img-block img{width:100%;max-height:240px;object-fit:contain;border-radius:4px;border:1px solid #ebecf0;cursor:zoom-in;transition:opacity .15s}
    .img-block img:hover{opacity:.85}

    /* ── Lightbox ── */
    #lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:1000;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:20px}
    #lightbox.open{display:flex}
    #lightbox-img{max-width:100%;max-height:calc(100vh - 80px);object-fit:contain;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.6)}
    #lightbox-label{color:#fff;font-size:.85rem;font-weight:600;letter-spacing:.04em;opacity:.8}
    #lightbox-close{position:fixed;top:16px;right:20px;background:rgba(255,255,255,.15);border:none;color:#fff;font-size:1.5rem;line-height:1;width:36px;height:36px;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s}
    #lightbox-close:hover{background:rgba(255,255,255,.3)}
    #lightbox-nav{display:flex;gap:12px}
    .nav-btn{background:rgba(255,255,255,.15);border:none;color:#fff;font-size:1.2rem;padding:8px 18px;border-radius:6px;cursor:pointer;transition:.15s}
    .nav-btn:hover{background:rgba(255,255,255,.3)}
    .nav-btn:disabled{opacity:.25;cursor:default}
  </style>
</head>
<body>
  <header>
    <h1>🔍 Pixel Diff Report</h1>
    <p>Generated: ${allResults.generatedAt} · ${allResults.processedCases}/${allResults.totalCases} cases</p>
  </header>
  <div class="summary">
    <div class="stat-card"><div class="value">${allResults.processedCases}</div><div class="label">Processed</div></div>
    <div class="stat-card major"><div class="value">${majorCount}</div><div class="label">Major (&ge;5%)</div></div>
    <div class="stat-card minor"><div class="value">${minorCount}</div><div class="label">Minor (0.1–5%)</div></div>
    <div class="stat-card none"><div class="value">${noneCount}</div><div class="label">No Change (&lt;0.1%)</div></div>
  </div>
  <div class="filters">
    <button class="filter-btn active" onclick="filter('all',this)">All</button>
    <button class="filter-btn" onclick="filter('major',this)">🔴 Major</button>
    <button class="filter-btn" onclick="filter('minor',this)">🟡 Minor</button>
    <button class="filter-btn" onclick="filter('none',this)">🟢 No Change</button>
  </div>
  <div class="cases">${cardsHTML}</div>

  <!-- Lightbox -->
  <div id="lightbox" onclick="closeLightboxOnBackdrop(event)">
    <button id="lightbox-close" onclick="closeLightbox()">✕</button>
    <img id="lightbox-img" src="" alt="" />
    <div id="lightbox-label"></div>
    <div id="lightbox-nav">
      <button class="nav-btn" id="nav-prev" onclick="navigate(-1)">← Prev</button>
      <button class="nav-btn" id="nav-next" onclick="navigate(1)">Next →</button>
    </div>
  </div>

  <script>
    // ── Filter ──
    function filter(s, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.case-card').forEach(c => {
        c.style.display = (s === 'all' || c.classList.contains('severity-' + s)) ? '' : 'none';
      });
    }

    // ── Lightbox ──
    let allImgs = [];
    let currentIdx = 0;

    function buildImgList() {
      allImgs = Array.from(document.querySelectorAll('.img-block img'));
    }

    function openLightbox(src, label) {
      buildImgList();
      currentIdx = allImgs.findIndex(img => img.src === src);
      showAt(currentIdx);
      document.getElementById('lightbox').classList.add('open');
      document.body.style.overflow = 'hidden';
    }

    function showAt(idx) {
      const img = allImgs[idx];
      document.getElementById('lightbox-img').src = img.src;
      document.getElementById('lightbox-label').textContent =
        img.closest('.img-block').querySelector('.img-label').textContent +
        ' — ' +
        img.closest('.case-card').querySelector('.case-name').textContent;
      document.getElementById('nav-prev').disabled = idx === 0;
      document.getElementById('nav-next').disabled = idx === allImgs.length - 1;
    }

    function navigate(dir) {
      const next = currentIdx + dir;
      if (next < 0 || next >= allImgs.length) return;
      currentIdx = next;
      showAt(currentIdx);
    }

    function closeLightbox() {
      document.getElementById('lightbox').classList.remove('open');
      document.body.style.overflow = '';
    }

    function closeLightboxOnBackdrop(e) {
      if (e.target === document.getElementById('lightbox')) closeLightbox();
    }

    // Keyboard: arrow keys + Escape
    document.addEventListener('keydown', e => {
      if (!document.getElementById('lightbox').classList.contains('open')) return;
      if (e.key === 'Escape')      closeLightbox();
      if (e.key === 'ArrowRight')  navigate(1);
      if (e.key === 'ArrowLeft')   navigate(-1);
    });
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(rootDir, 'report.html'), html);
  console.log(`🌐 HTML report saved to: report.html`);
}

module.exports = { detectChanges, createThreePanel };

if (require.main === module) {
  processAllCases().catch(err => { console.error('Fatal error:', err); process.exit(1); });
}
