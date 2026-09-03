'use strict';

const LEVELS = [
  { id: 'ringan', label: 'Ringan', hint: 'Kualitas terbaik, ukuran turun sedikit.' },
  { id: 'sedang', label: 'Sedang', hint: 'Seimbang antara kualitas dan ukuran. (disarankan)' },
  { id: 'kuat', label: 'Kuat', hint: 'Ukuran jauh lebih kecil, kualitas menurun.' },
  { id: 'maksimal', label: 'Maksimal', hint: 'Ukuran sekecil mungkin.' },
];

let selectedLevel = 'sedang';
let queue = []; // { file, id }
let counter = 0;
let itemRefs = []; // referensi elemen hasil per index
let running = false; // sedang mengunggah/memproses?
let currentES = null; // EventSource yang sedang aktif

const $ = (id) => document.getElementById(id);
const levelsEl = $('levels');
const levelHint = $('levelHint');
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const folderInput = $('folderInput');
const queueEl = $('queue');
const compressBtn = $('compressBtn');
const resultsEl = $('results');
const resultList = $('resultList');

// --- Render level ---
function renderLevels() {
  levelsEl.innerHTML = '';
  for (const lv of LEVELS) {
    const b = document.createElement('button');
    b.className = 'level' + (lv.id === selectedLevel ? ' active' : '');
    b.textContent = lv.label;
    b.onclick = () => {
      selectedLevel = lv.id;
      renderLevels();
    };
    levelsEl.appendChild(b);
  }
  levelHint.textContent = LEVELS.find((l) => l.id === selectedLevel).hint;
}

// --- Util ---
function humanSize(bytes) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtTime(s) {
  if (s >= 3600) return `${Math.floor(s / 3600)}j ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}d`;
  return `${s}d`;
}

function kindOf(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'tiff', 'avif', 'gif'].includes(ext)) return 'IMG';
  if (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv'].includes(ext)) return 'VID';
  if (ext === 'pdf') return 'PDF';
  return '?';
}

// --- Queue ---
function addFiles(fileList) {
  for (const file of fileList) {
    if (kindOf(file.name) === '?') continue;
    queue.push({ file, id: ++counter });
  }
  renderQueue();
}

function renderQueue() {
  queueEl.innerHTML = '';
  for (const item of queue) {
    const li = document.createElement('li');
    li.className = 'q-item';
    li.innerHTML = `
      <div class="q-kind">${kindOf(item.file.name)}</div>
      <div class="q-meta">
        <div class="q-name"></div>
        <div class="q-size">${humanSize(item.file.size)}</div>
      </div>
      <button class="q-remove" title="Hapus">&times;</button>`;
    li.querySelector('.q-name').textContent = item.file.name;
    li.querySelector('.q-remove').onclick = () => {
      queue = queue.filter((q) => q.id !== item.id);
      renderQueue();
    };
    queueEl.appendChild(li);
  }
  compressBtn.disabled = queue.length === 0;
}

// --- Dropzone events ---
dropzone.onclick = () => fileInput.click();
dropzone.onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
};
fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };

$('pickFiles').onclick = (e) => { e.stopPropagation(); fileInput.click(); };
$('pickFolder').onclick = (e) => { e.stopPropagation(); folderInput.click(); };
folderInput.onchange = () => { addFiles(folderInput.files); folderInput.value = ''; };

['dragenter', 'dragover'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); })
);
['dragleave'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); })
);

// --- Jelajah folder yang di-drop (rekursif) lewat DataTransferItem entries ---
function readEntryFile(entry) {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve) => {
    let all = [];
    const readBatch = () => {
      // readEntries() cuma balikin maks ~100 per panggilan, jadi diulang sampai kosong
      reader.readEntries((entries) => {
        if (!entries.length) return resolve(all);
        all = all.concat(entries);
        readBatch();
      }, () => resolve(all));
    };
    readBatch();
  });
}

async function collectEntry(entry, out) {
  if (!entry) return;
  if (entry.isFile) {
    const file = await readEntryFile(entry);
    if (file) out.push(file);
  } else if (entry.isDirectory) {
    const entries = await readAllDirectoryEntries(entry.createReader());
    for (const e of entries) await collectEntry(e, out);
  }
}

async function filesFromDataTransfer(dataTransfer) {
  const items = dataTransfer.items;
  const supportsEntries = items && items.length && typeof items[0].webkitGetAsEntry === 'function';
  if (!supportsEntries) return Array.from(dataTransfer.files); // mobile/browser lama: jatuh balik ke daftar berkas biasa

  const entries = Array.from(items).map((it) => it.webkitGetAsEntry()).filter(Boolean);
  const out = [];
  for (const entry of entries) await collectEntry(entry, out);
  return out;
}

dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  const files = await filesFromDataTransfer(e.dataTransfer);
  addFiles(files);
});

// --- Bangun kartu hasil (status awal: menunggu) untuk tiap berkas ---
function buildResultCards(files) {
  resultList.innerHTML = '';
  itemRefs = [];
  for (const f of files) {
    const li = document.createElement('li');
    li.className = 'r-item';
    li.innerHTML = `
      <div class="r-top">
        <div class="r-kind">${f.kind === 'image' ? 'IMG' : f.kind === 'video' ? 'VID' : 'PDF'}</div>
        <div class="r-name"></div>
        <span class="r-badge wait">Menunggu</span>
      </div>
      <div class="r-bar"><i style="width:0%"></i></div>
      <div class="r-foot"></div>`;
    li.querySelector('.r-name').textContent = f.name;
    resultList.appendChild(li);
    itemRefs.push({
      li,
      badge: li.querySelector('.r-badge'),
      bar: li.querySelector('.r-bar i'),
      foot: li.querySelector('.r-foot'),
    });
  }
  resultsEl.hidden = false;
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- Kompres: unggah (progres) lalu proses (SSE per-berkas) ---
compressBtn.onclick = () => {
  if (queue.length === 0 || running) return; // cegah dobel-jalan
  running = true;
  if (currentES) { currentES.close(); currentES = null; } // tutup sisa koneksi lama
  const form = new FormData();
  form.append('level', selectedLevel);
  for (const item of queue) form.append('files', item.file);

  compressBtn.classList.add('loading');
  compressBtn.disabled = true;
  compressBtn.innerHTML = '<span class="spinner"></span>Mengunggah… 0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      compressBtn.innerHTML = `<span class="spinner"></span>Mengunggah… ${pct}%`;
    }
  };
  xhr.onload = () => {
    if (xhr.status !== 200) {
      let msg = 'Gagal mengunggah';
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
      finishWithError(msg);
      return;
    }
    const data = JSON.parse(xhr.responseText);
    compressBtn.innerHTML = '<span class="spinner"></span>Memproses…';
    buildResultCards(data.files);
    processJob(data.jobId);
  };
  xhr.onerror = () => finishWithError('Koneksi gagal saat mengunggah');
  xhr.send(form);
};

function processJob(jobId) {
  let finished = false;
  const es = new EventSource(`/api/process/${jobId}`);
  currentES = es;

  es.addEventListener('start', (ev) => {
    const { index } = JSON.parse(ev.data);
    const ref = itemRefs[index];
    if (!ref) return;
    ref.badge.textContent = 'Memproses';
    ref.badge.className = 'r-badge proc';
    ref.li.classList.add('active');
  });

  es.addEventListener('progress', (ev) => {
    const { index, percent, speed, etaSec } = JSON.parse(ev.data);
    const ref = itemRefs[index];
    if (!ref) return;
    ref.bar.style.width = percent + '%';
    ref.badge.textContent = `${percent}%`;
    const bits = [];
    if (etaSec != null && etaSec > 0) bits.push(`sisa ${fmtTime(etaSec)}`);
    if (speed) bits.push(`${speed.toFixed(1)}×`);
    ref.foot.innerHTML = bits.length ? `<span class="r-proc">${bits.join(' · ')}</span>` : '';
  });

  es.addEventListener('done', (ev) => {
    const r = JSON.parse(ev.data);
    renderDone(r);
  });

  es.addEventListener('complete', () => {
    finished = true;
    es.close();
    currentES = null;
    queue = [];        // mulai segar untuk kompresi berikutnya
    renderQueue();
    resetButton();
  });

  es.onerror = () => {
    // Abaikan error yang muncul setelah selesai (penutupan koneksi normal /
    // reconnect ke job yang sudah dihapus). Tangani hanya error sebenarnya.
    if (finished) return;
    es.close();
    currentES = null;
    resetButton();
  };
}

function renderDone(r) {
  const ref = itemRefs[r.index];
  if (!ref) return;
  ref.li.classList.remove('active');

  if (r.ok) {
    ref.bar.style.width = '100%';
    if (r.kept) {
      ref.badge.textContent = 'Sudah optimal';
      ref.badge.className = 'r-badge keep';
    } else {
      ref.badge.textContent = `−${r.savedPercent}%`;
      ref.badge.className = 'r-badge';
    }
    ref.foot.innerHTML = `
      <div class="r-stats">
        <span>${r.originalSizeText}</span>
        <span class="r-arrow">→</span>
        <span class="r-new">${r.compressedSizeText}</span>
      </div>
      <a class="r-download" href="/api/download/${encodeURIComponent(r.downloadName)}">Unduh</a>`;
  } else {
    ref.bar.style.width = '0%';
    ref.badge.textContent = 'Gagal';
    ref.badge.className = 'r-badge err';
    const div = document.createElement('div');
    div.className = 'r-err';
    div.textContent = r.error;
    ref.foot.innerHTML = '';
    ref.foot.appendChild(div);
  }
}

function resetButton() {
  running = false;
  compressBtn.classList.remove('loading');
  compressBtn.disabled = queue.length === 0;
  compressBtn.textContent = 'Kompres';
}

function finishWithError(msg) {
  buildResultCards([{ name: msg, kind: 'pdf' }]);
  const ref = itemRefs[0];
  ref.badge.textContent = 'Gagal';
  ref.badge.className = 'r-badge err';
  ref.bar.parentElement.style.display = 'none';
  resetButton();
}

renderLevels();
renderQueue();
