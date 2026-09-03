'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const { compressFile, detectKind } = require('./lib/compress');
const { LEVELS } = require('./lib/levels');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(os.tmpdir(), 'kompres-uploads');
const OUTPUT_DIR = path.join(os.tmpdir(), 'kompres-outputs');
const JOB_TTL = 60 * 60 * 1000; // hasil disimpan 1 jam

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Penyimpanan job sementara di memori: jobId -> { level, files: [{path, name}] }
const jobs = new Map();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString('hex');
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, `${id}-${path.basename(safe)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10 GB
  fileFilter: (req, file, cb) => {
    const ok = detectKind(file.originalname) !== null;
    cb(ok ? null : new Error('Jenis berkas tidak didukung'), ok);
  },
});

function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// 1) Unggah berkas (progres unggah dipantau klien lewat XHR) -> buat job
app.post('/api/upload', upload.array('files', 10000), (req, res) => {
  const level = LEVELS.includes(req.body.level) ? req.body.level : 'sedang';
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'Tidak ada berkas diunggah' });
  }

  const jobId = crypto.randomBytes(10).toString('hex');
  jobs.set(jobId, {
    level,
    files: files.map((f) => ({
      path: f.path,
      name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
    })),
  });
  // Bersihkan job bila tak pernah diproses
  setTimeout(() => jobs.delete(jobId), JOB_TTL);

  res.json({
    jobId,
    level,
    files: jobs.get(jobId).files.map((f, i) => ({
      index: i,
      name: f.name,
      kind: detectKind(f.name),
      size: fs.statSync(f.path).size,
      sizeText: humanSize(fs.statSync(f.path).size),
    })),
  });
});

// 2) Proses job dengan progres real-time (Server-Sent Events)
app.get('/api/process/:jobId', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job tidak ditemukan atau kedaluwarsa' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const { level, files } = job;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    send('start', { index: i, name: f.name });
    try {
      let last = -1;
      const outputPath = await compressFile(f.path, OUTPUT_DIR, level, (p) => {
        if (p.percent !== last) {
          last = p.percent;
          send('progress', { index: i, percent: p.percent, speed: p.speed, etaSec: p.etaSec });
        }
      });

      let inSize = fs.statSync(f.path).size;
      let outSize = fs.statSync(outputPath).size;
      let finalPath = outputPath;
      let kept = false;

      // Pengaman: kalau hasil >= asli (mis. video HEVC iPhone), kembalikan berkas asli
      if (outSize >= inSize) {
        fs.rmSync(outputPath, { force: true });
        finalPath = path.join(OUTPUT_DIR, `${crypto.randomBytes(6).toString('hex')}-${f.name}`);
        fs.copyFileSync(f.path, finalPath);
        outSize = inSize;
        kept = true;
      }

      const saved = inSize > 0 ? Math.round((1 - outSize / inSize) * 100) : 0;
      send('done', {
        index: i,
        ok: true,
        name: f.name,
        kind: detectKind(f.name),
        kept,
        originalSizeText: humanSize(inSize),
        compressedSizeText: humanSize(outSize),
        savedPercent: saved,
        downloadName: path.basename(finalPath),
      });
    } catch (err) {
      send('done', { index: i, ok: false, name: f.name, error: err.message });
    } finally {
      fs.promises.unlink(f.path).catch(() => {});
    }
  }

  send('complete', { total: files.length });
  res.end();
  jobs.delete(req.params.jobId);
  // Bersihkan hasil unduhan setelah TTL
  setTimeout(() => {}, 0);
});

// 3) Unduh hasil kompresi
app.get('/api/download/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const filePath = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Berkas tidak ditemukan' });
  }
  res.download(filePath);
});

// Penanganan error multer/umum -> selalu JSON
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Terjadi kesalahan' });
});

app.listen(PORT, () => {
  console.log(`\n  Kompres berjalan di  →  http://localhost:${PORT}\n`);
});
