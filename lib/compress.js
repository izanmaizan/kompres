'use strict';

const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const levels = require('./levels');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.avif', '.gif'];
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.flv', '.wmv'];
const PDF_EXT = ['.pdf'];

/** Tentukan kategori berkas dari ekstensinya. */
function detectKind(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (PDF_EXT.includes(ext)) return 'pdf';
  return null;
}

/** Jalankan perintah eksternal (ffmpeg/gs) dan kumpulkan stderr untuk pesan error. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) =>
      reject(new Error(`Gagal menjalankan ${cmd}: ${err.message}`))
    );
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} keluar dengan kode ${code}\n${stderr.slice(-800)}`));
    });
  });
}

/** Ambil info video (durasi, dimensi, fps) untuk progres & perhitungan bitrate. */
function ffprobeInfo(input) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate:format=duration',
      '-of', 'json',
      input,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve({}));
    p.on('close', () => {
      try {
        const j = JSON.parse(out);
        const s = (j.streams && j.streams[0]) || {};
        let fps = 30;
        if (s.avg_frame_rate && s.avg_frame_rate.includes('/')) {
          const [a, b] = s.avg_frame_rate.split('/').map(Number);
          if (b) fps = a / b;
        }
        resolve({
          width: s.width || 0,
          height: s.height || 0,
          fps: fps || 30,
          duration: parseFloat(j.format && j.format.duration) || 0,
        });
      } catch (_) {
        resolve({});
      }
    });
  });
}

// Deteksi sekali apakah encoder hardware VideoToolbox tersedia (di-cache).
let _hwCache;
function hasVideoToolbox() {
  if (_hwCache !== undefined) return Promise.resolve(_hwCache);
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-encoders']);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve((_hwCache = false)));
    p.on('close', () => resolve((_hwCache = /h264_videotoolbox/.test(out))));
  });
}

/**
 * Jalankan ffmpeg sambil melaporkan progres lewat onProgress({percent, speed, etaSec, fps}).
 * Membaca aliran key=value dari `-progress pipe:1`.
 */
function runFFmpeg(args, duration, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    let buf = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // simpan baris terakhir yang mungkin belum lengkap
      const cur = {};
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        cur[line.slice(0, eq)] = line.slice(eq + 1);
        if (line.startsWith('progress=') && onProgress) {
          const us = parseInt(cur.out_time_us || cur.out_time_ms || '0', 10);
          const sec = us / 1e6;
          const speed = parseFloat(cur.speed) || 0;
          const percent = duration > 0 ? Math.min(99, Math.round((sec / duration) * 100)) : 0;
          let etaSec = null;
          if (duration > 0 && speed > 0) etaSec = Math.max(0, Math.round((duration - sec) / speed));
          onProgress({ percent, speed, etaSec, fps: parseFloat(cur.fps) || 0 });
        }
      }
    });
    proc.on('error', (err) => reject(new Error(`Gagal menjalankan ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg keluar dengan kode ${code}\n${stderr.slice(-800)}`));
    });
  });
}

/** Kompres gambar dengan sharp. Output selalu .jpg kecuali PNG transparan -> tetap PNG. */
async function compressImage(input, outDir, level) {
  const cfg = levels.IMAGE[level];
  const base = path.parse(input).name;
  const meta = await sharp(input).metadata();
  const hasAlpha = meta.hasAlpha && meta.format === 'png';

  const ext = hasAlpha ? '.png' : '.jpg';
  const output = path.join(outDir, `${base}-${level}${ext}`);

  let pipeline = sharp(input).rotate();
  if (cfg.maxWidth && meta.width && meta.width > cfg.maxWidth) {
    pipeline = pipeline.resize({ width: cfg.maxWidth, withoutEnlargement: true });
  }
  if (hasAlpha) {
    pipeline = pipeline.png({ quality: cfg.quality, compressionLevel: 9, palette: true });
  } else {
    pipeline = pipeline.jpeg({ quality: cfg.quality, mozjpeg: true });
  }
  await pipeline.toFile(output);
  return output;
}

/**
 * Kompres video dengan ffmpeg (H.264 + AAC).
 * Mendukung MOV/HEVC iPhone — codec HEVC otomatis didekode ke H.264 dan
 * metadata rotasi iPhone diterapkan otomatis (autorotate bawaan ffmpeg),
 * sehingga orientasi video tetap benar.
 */
async function compressVideo(input, outDir, level, onProgress) {
  const cfg = levels.VIDEO[level];
  const base = path.parse(input).name;
  const output = path.join(outDir, `${base}-${level}.mp4`);

  const info = await ffprobeInfo(input);
  const duration = info.duration || 0;

  // hitung dimensi keluaran setelah pembatasan tinggi (jaga lebar genap)
  let outW = info.width;
  let outH = info.height;
  if (cfg.maxHeight && outH > cfg.maxHeight) {
    outW = Math.round((info.width * (cfg.maxHeight / outH)) / 2) * 2;
    outH = cfg.maxHeight;
  }

  const args = ['-y', '-i', input];
  const hw = await hasVideoToolbox();

  if (hw && outW && outH) {
    // Jalur hardware (cepat): target bitrate dari resolusi keluaran x fps x bpp
    const bitrate = Math.max(200000, Math.round(outW * outH * info.fps * cfg.bpp));
    args.push(
      '-c:v', 'h264_videotoolbox',
      '-b:v', String(bitrate),
      '-maxrate', String(Math.round(bitrate * 1.5)),
      '-bufsize', String(bitrate * 2),
      '-pix_fmt', 'yuv420p', // pastikan 8-bit (kompatibel; tangani sumber HDR 10-bit iPhone)
      '-tag:v', 'avc1'
    );
  } else {
    // Jalur CPU (fallback): libx264 dengan CRF
    args.push('-c:v', 'libx264', '-crf', String(cfg.crf), '-preset', cfg.preset);
  }

  if (cfg.maxHeight) {
    args.push('-vf', `scale=-2:'min(${cfg.maxHeight},ih)'`);
  }
  args.push(
    '-c:a', 'aac', '-b:a', cfg.audioBitrate,
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    output
  );

  await runFFmpeg(args, duration, onProgress);
  return output;
}

/** Kompres PDF dengan ghostscript. */
async function compressPdf(input, outDir, level) {
  const cfg = levels.PDF[level];
  const base = path.parse(input).name;
  const output = path.join(outDir, `${base}-${level}.pdf`);

  const args = [
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.4',
    `-dPDFSETTINGS=${cfg.setting}`,
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dDetectDuplicateImages=true',
    `-dColorImageResolution=${cfg.dpi}`,
    `-dGrayImageResolution=${cfg.dpi}`,
    `-dMonoImageResolution=${cfg.dpi}`,
    `-sOutputFile=${output}`,
    input,
  ];
  await run('gs', args);
  return output;
}

/**
 * Kompres satu berkas sesuai jenis & level. Mengembalikan path output.
 * onProgress(persen 0-99) dipanggil selama proses (akurat untuk video).
 */
async function compressFile(input, outDir, level, onProgress) {
  const lvl = levels.normalizeLevel(level);
  const kind = detectKind(input);
  if (kind === 'image') return compressImage(input, outDir, lvl);
  if (kind === 'video') return compressVideo(input, outDir, lvl, onProgress);
  if (kind === 'pdf') return compressPdf(input, outDir, lvl);
  throw new Error('Jenis berkas tidak didukung');
}

module.exports = { compressFile, detectKind, IMAGE_EXT, VIDEO_EXT, PDF_EXT };
