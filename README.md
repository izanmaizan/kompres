# Kompres

Aplikasi web untuk **mengompres Video, Foto, dan PDF** dengan banyak level kompresi.
UI bersih, modern, dan minimalis. Bisa banyak berkas sekaligus.

## Fitur
- 📹 **Video** → ffmpeg (H.264 + AAC), turunkan resolusi & bitrate
- ⚡ **Akselerasi hardware** (VideoToolbox) — encoding video puluhan kali lebih cepat, otomatis fallback ke CPU (libx264) bila tak tersedia
- 📱 **MOV/HEVC iPhone** didukung — codec HEVC didekode ke H.264, rotasi iPhone diterapkan otomatis
- ⏱️ Progres video menampilkan **kecepatan & estimasi sisa waktu (ETA)**
- 🖼️ **Foto** → sharp (JPG/PNG/WebP), kualitas & resize otomatis
- 📄 **PDF** → ghostscript, kompres gambar di dalam PDF
- 🎚️ **4 level**: Ringan · Sedang · Kuat · Maksimal
- 📦 Unggah & proses **banyak berkas** sekaligus (drag & drop)
- 📊 **Progres real-time** per berkas: progres unggah + persen pemrosesan video (lewat SSE)
- 🛡️ **Pengaman ukuran**: kalau hasil ternyata lebih besar dari asli (umum pada HEVC iPhone), berkas asli dikembalikan — tak pernah lebih besar
- 📥 Lihat persentase penghematan & unduh hasilnya

## Prasyarat
Aplikasi memanggil tool berikut dari sistem:

| Tool        | Untuk  | Cek versi          |
|-------------|--------|--------------------|
| Node.js 18+ | server | `node -v`          |
| ffmpeg      | video  | `ffmpeg -version`  |
| ghostscript | pdf    | `gs --version`     |

Di macOS: `brew install ffmpeg ghostscript`
(sharp untuk gambar terpasang otomatis lewat npm.)

## Menjalankan
```bash
npm install
npm start
```
Buka http://localhost:3000

Mode dev (auto-reload): `npm run dev`

## Level kompresi
| Level     | Foto (kualitas/skala) | Video (CRF/res)   | PDF (preset)  |
|-----------|-----------------------|-------------------|---------------|
| Ringan    | 85 / asli             | 23 / asli         | /prepress     |
| Sedang    | 70 / maks 2000px      | 28 / maks 1080p   | /printer      |
| Kuat      | 55 / maks 1440px      | 32 / maks 720p    | /ebook        |
| Maksimal  | 40 / maks 1080px      | 36 / maks 480p    | /screen       |

## Struktur
```
kompres/
├── server.js          # Express: /api/upload (XHR progress) + /api/process (SSE) + /api/download
├── lib/
│   ├── compress.js    # logika kompres image/video/pdf + progres ffmpeg
│   └── levels.js      # definisi level per jenis berkas
├── public/            # frontend (HTML/CSS/JS, tanpa framework)
└── package.json
```

Alur: berkas diunggah ke `/api/upload` (klien memantau progres unggah via XHR) → server
mengembalikan `jobId` → klien membuka `EventSource('/api/process/:jobId')` dan menerima
event `start`/`progress`/`done`/`complete` per berkas secara real-time.

## Catatan
- Berkas unggahan & hasil disimpan sementara di folder temp sistem.
- Batas ukuran: 10 GB per berkas, maks 20 berkas per permintaan.
