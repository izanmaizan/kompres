'use strict';

/**
 * Definisi level kompresi untuk setiap jenis berkas.
 * Setiap jenis punya 4 level: ringan -> sedang -> kuat -> maksimal.
 *  - ringan   : kualitas terbaik, ukuran turun sedikit
 *  - sedang   : keseimbangan kualitas & ukuran (default)
 *  - kuat     : ukuran jauh lebih kecil, kualitas menurun
 *  - maksimal : ukuran sekecil mungkin
 */

const LEVELS = ['ringan', 'sedang', 'kuat', 'maksimal'];

const LEVEL_LABELS = {
  ringan: 'Ringan',
  sedang: 'Sedang',
  kuat: 'Kuat',
  maksimal: 'Maksimal',
};

// Gambar (sharp): kualitas JPEG/WebP + skala lebar maksimum (px, null = asli)
const IMAGE = {
  ringan: { quality: 85, maxWidth: null },
  sedang: { quality: 70, maxWidth: 2000 },
  kuat: { quality: 55, maxWidth: 1440 },
  maksimal: { quality: 40, maxWidth: 1080 },
};

// Video:
//  - crf/preset : dipakai jalur CPU (libx264) sebagai fallback
//  - bpp        : bits-per-pixel untuk menghitung target bitrate jalur hardware
//                 (VideoToolbox) -> bitrate = lebar x tinggi x fps x bpp
//  - maxHeight  : batas tinggi keluaran (null = ikut asli)
const VIDEO = {
  ringan: { crf: 23, preset: 'medium', maxHeight: null, audioBitrate: '160k', bpp: 0.10 },
  sedang: { crf: 28, preset: 'medium', maxHeight: 1080, audioBitrate: '128k', bpp: 0.07 },
  kuat: { crf: 32, preset: 'faster', maxHeight: 720, audioBitrate: '96k', bpp: 0.045 },
  maksimal: { crf: 36, preset: 'faster', maxHeight: 480, audioBitrate: '64k', bpp: 0.03 },
};

// PDF (ghostscript): preset PDFSETTINGS + resolusi gambar (dpi)
const PDF = {
  ringan: { setting: '/prepress', dpi: 300 },
  sedang: { setting: '/printer', dpi: 200 },
  kuat: { setting: '/ebook', dpi: 150 },
  maksimal: { setting: '/screen', dpi: 72 },
};

function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : 'sedang';
}

module.exports = { LEVELS, LEVEL_LABELS, IMAGE, VIDEO, PDF, normalizeLevel };
