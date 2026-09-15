const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fetch = require('node-fetch');
const FormData = require('form-data');
const rateLimit = require('express-rate-limit');

const app = express();

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const YTDLP_TIMEOUT_MS = 90 * 1000;
const AUDD_TIMEOUT_MS = 30 * 1000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

// Konfigurasi CORS (Batasi domain jika diperlukan, atau sesuaikan)
app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '100kb' }));
app.disable('x-powered-by');

// Rate Limiting untuk mencegah spam endpoint publik
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 100, // Batas maksimal request per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Terlalu banyak permintaan dari IP ini, silakan coba beberapa saat lagi." }
});
app.use('/api/', limiter);

// Konfigurasi Multer untuk penyimpanan sementara
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 } // Batas 25 MB
});

// Multi-token AudD dengan failover otomatis
const AUDD_TOKENS = (process.env.AUDD_API_TOKENS || process.env.AUDD_API_TOKEN || '').split(',').map(t => t.trim()).filter(Boolean);

function validatePublicUrlOrSearch(query) {
  const value = query.trim();
  if (!value) return false;
  if (value.length > 1000) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return true;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AUDD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callAudDWithFailover(formData) {
  if (AUDD_TOKENS.length === 0) {
    throw new Error("API token AudD belum dikonfigurasi di server backend.");
  }

  let lastError = null;
  for (const token of AUDD_TOKENS) {
    formData.set('api_token', token);
    try {
      const response = await fetch('https://api.audd.io/', {
        method: 'POST',
        body: formData
      });
      
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error("Respon dari server AudD tidak valid.");
      }

      if (data.status === 'success') {
        return data.result;
      } else {
        const errMsg = data.error?.error_message || JSON.stringify(data);
        // Jika token habis/quota limit, coba token berikutnya
        if (/quota|limit|token/i.test(errMsg)) {
          console.warn("Token AudD mencapai batas, beralih ke token cadangan...");
          lastError = new Error(errMsg);
          continue;
        }
        throw new Error(errMsg);
      }
    } catch (err) {
      lastError = err;
      continue;
    }
  }
  throw lastError || new Error("Semua token AudD gagal atau habis kuotanya.");
}

// Helper: Hapus file temporary secara aman
function safeUnlink(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error("Gagal menghapus file temporary:", e.message);
    }
  }
}

// Endpoint 1: POST /api/recognize-url
app.post('/api/recognize-url', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || !validatePublicUrlOrSearch(query)) {
    return res.status(400).json({ success: false, message: "URL atau judul lagu tidak valid." });
  }

  const tmpOutputAudio = path.join(os.tmpdir(), `audio_${Date.now()}.mp3`);
  let actualAudioPath = null;

  try {
    const isUrl = /^https?:\/\//i.test(query.trim());
    const ytArgs = isUrl 
      ? [query, '-x', '--audio-format', 'mp3', '--no-playlist', '--max-filesize', '25M', '-o', tmpOutputAudio.replace('.mp3', '.%(ext)s')]
      : [`ytsearch1:${query}`, '-x', '--audio-format', 'mp3', '--no-playlist', '--max-filesize', '25M', '-o', tmpOutputAudio.replace('.mp3', '.%(ext)s')];

    // Eksekusi yt-dlp secara aman dengan execFile
    await new Promise((resolve, reject) => {
      execFile('yt-dlp', ytArgs, { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          return reject(new Error("Gagal mengunduh media dari sumber yang diberikan."));
        }
        resolve(stdout);
      });
    });

    // Deteksi file hasil unduhan
    actualAudioPath = tmpOutputAudio;
    if (!fs.existsSync(actualAudioPath)) {
      const dirFiles = fs.readdirSync(os.tmpdir());
      const matched = dirFiles.find(f => f.startsWith(path.basename(tmpOutputAudio, '.mp3')));
      if (matched) {
        actualAudioPath = path.join(os.tmpdir(), matched);
      } else {
        throw new Error("File audio hasil unduhan tidak ditemukan.");
      }
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(actualAudioPath));
    form.append('return', 'spotify,apple_music');

    const result = await callAudDWithFailover(form);
    return res.json({ success: true, result: result || {} });

  } catch (err) {
    safeUnlink(actualAudioPath);
    console.error("Error recognize-url:", err.message);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan internal pada server." });
  }
});

// Endpoint 2: POST /api/recognize-file
app.post('/api/recognize-file', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) {
    return res.status(400).json({ success: false, message: "File audio tidak ditemukan." });
  }

  try {
    // Validasi file menggunakan ffprobe
    await new Promise((resolve, reject) => {
      execFile('ffprobe', [filePath], { timeout: 10000 }, (err) => {
        if (err) return reject(new Error("File audio rusak atau format tidak didukung."));
        resolve();
      });
    });

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    form.append('return', 'spotify,apple_music');

    const result = await callAudDWithFailover(form);
    return res.json({ success: true, result: result || {} });

  } catch (err) {
    safeUnlink(filePath);
    console.error("Error recognize-file:", err.message);
    return res.status(500).json({ success: false, message: "Terjadi kesalahan saat memproses file." });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'SongFinder Pro',
    auddTokensConfigured: AUDD_TOKENS.length > 0
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'Ukuran file terlalu besar. Maksimal 25 MB.' });
    }
    return res.status(400).json({ success: false, message: 'Upload file tidak valid.' });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ success: false, message: 'Terjadi kesalahan internal pada server.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});