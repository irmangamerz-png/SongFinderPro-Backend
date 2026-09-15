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
const YTDLP_TIMEOUT_MS = 60 * 1000;
const AUDD_TIMEOUT_MS = 30 * 1000;
const FFPROBE_TIMEOUT_MS = 10 * 1000;

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || '*';

app.use(cors({
  origin: FRONTEND_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '100kb' }));
app.disable('x-powered-by');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak permintaan dari IP ini, silakan coba lagi nanti.'
  }
});

app.use('/api/', limiter);

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  }
});

const AUDD_TOKENS = (
  process.env.AUDD_API_TOKENS ||
  process.env.AUDD_API_TOKEN ||
  ''
)
  .split(',')
  .map(token => token.trim())
  .filter(Boolean);

function validatePublicUrlOrSearch(query) {
  if (typeof query !== 'string') return false;
  const value = query.trim();
  if (!value || value.length > 1000) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }
  return true;
}

function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.error('Gagal menghapus file temporary:', error.message);
  }
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

async function getFreeMetadataFallback(queryOrUrl) {
  try {
    const isUrl = /^https?:\/\//i.test(queryOrUrl);
    const target = isUrl ? queryOrUrl : `ytsearch1:${queryOrUrl}`;
    
    const { stdout } = await executeFile('yt-dlp', [
      target, '--dump-json', '--no-playlist', '--skip-download'
    ], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });

    const info = JSON.parse(stdout.trim().split('\n')[0]);
    const fullTitle = info.title || queryOrUrl;
    
    let cleanTitle = fullTitle
      .replace(/[\(\[\{](Official|Lyric|Audio|MV|Video|HD|HQ|Visualizer).*?[\)\]\}]/gi, '')
      .trim();

    return {
      title: cleanTitle || fullTitle,
      artist: info.uploader || info.channel || 'Unknown Artist',
      album: 'Pencarian Otomatis Gratis (yt-dlp)',
      spotify: null,
      apple_music: null,
      source_type: 'free_metadata_fallback'
    };
  } catch (err) {
    console.warn('Gagal mengambil metadata gratis:', err.message);
    return null;
  }
}

async function callAudDWithFailover(filePath) {
  if (AUDD_TOKENS.length === 0) throw new Error('Token AudD tidak tersedia.');
  let lastError = null;

  for (let index = 0; index < AUDD_TOKENS.length; index++) {
    const token = AUDD_TOKENS[index];
    let form = null;
    try {
      form = new FormData();
      form.append('file', fs.createReadStream(filePath));
      form.append('return', 'spotify,apple_music');
      form.append('api_token', token);

      const response = await fetchWithTimeout('https://api.audd.io/', {
        method: 'POST',
        headers: form.getHeaders(),
        body: form
      }, AUDD_TIMEOUT_MS);

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Respon dari server AudD tidak valid.');
      }

      if (data && data.status === 'success') return data.result || {};

      const errMsg = data?.error?.error_message || data?.error?.error_code || JSON.stringify(data);
      lastError = new Error(String(errMsg));

      if (/quota|limit|token|credits|credit/i.test(String(errMsg)) || response.status === 429) {
        continue;
      }
      throw lastError;
    } catch (error) {
      lastError = error;
      continue;
    } finally {
      form = null;
    }
  }
  throw lastError || new Error('Semua token AudD gagal.');
}

function executeFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    service: 'SongFinder Pro Hybrid',
    auddTokensConfigured: AUDD_TOKENS.length > 0,
    freeFallbackAvailable: true
  });
});

app.post('/api/recognize-url', async (req, res) => {
  const { query } = req.body || {};
  if (!query || typeof query !== 'string' || !validatePublicUrlOrSearch(query)) {
    return res.status(400).json({ success: false, message: 'URL atau judul lagu tidak valid.' });
  }

  const cleanQuery = query.trim();
  const isUrl = /^https?:\/\//i.test(cleanQuery);
  const randomId = Math.random().toString(36).substring(2, 7);
  const tmpBaseName = `audio_${Date.now()}_${randomId}`;
  const tmpOutputAudio = path.join(os.tmpdir(), `${tmpBaseName}.mp3`);
  let actualAudioPath = null;

  if (AUDD_TOKENS.length > 0 && isUrl) {
    try {
      const outputTemplate = path.join(os.tmpdir(), `${tmpBaseName}.%(ext)s`);
      await executeFile('yt-dlp', [
        cleanQuery, '-x', '--audio-format', 'mp3', '--no-playlist', '--max-filesize', '25M', '-o', outputTemplate
      ], { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

      if (fs.existsSync(tmpOutputAudio)) {
        actualAudioPath = tmpOutputAudio;
      } else {
        const dirFiles = fs.readdirSync(os.tmpdir());
        const matched = dirFiles.find(file => file.startsWith(`${tmpBaseName}.`));
        if (matched) actualAudioPath = path.join(os.tmpdir(), matched);
      }

      if (actualAudioPath && fs.existsSync(actualAudioPath)) {
        const auddResult = await callAudDWithFailover(actualAudioPath);
        if (auddResult && Object.keys(auddResult).length > 0) {
          safeUnlink(actualAudioPath);
          return res.json({ success: true, result: auddResult });
        }
      }
    } catch (err) {
      console.warn('AudD gagal/habis, beralih ke mode gratis...');
    } finally {
      safeUnlink(actualAudioPath);
    }
  }

  try {
    const freeResult = await getFreeMetadataFallback(cleanQuery);
    if (freeResult) {
      return res.json({ success: true, result: freeResult, note: 'Hasil diperoleh menggunakan sistem pencarian metadata gratis.' });
    }
  } catch (err) {
    console.error('Fallback error:', err.message);
  }

  return res.status(500).json({ success: false, message: 'Gagal mengenali lagu dari tautan tersebut.' });
});

app.post('/api/recognize-file', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;
  if (!filePath) return res.status(400).json({ success: false, message: 'File audio tidak ditemukan.' });

  try {
    try {
      await executeFile('ffprobe', ['-v', 'error', filePath], { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    } catch {
      throw new Error('File audio rusak atau format tidak didukung.');
    }

    if (AUDD_TOKENS.length > 0) {
      try {
        const result = await callAudDWithFailover(filePath);
        if (result && Object.keys(result).length > 0) {
          return res.json({ success: true, result });
        }
      } catch {}
    }

    return res.status(400).json({ success: false, message: 'Token AudD tidak aktif atau habis. Pengenalan via file audio memerlukan token AudD.' });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Terjadi kesalahan saat memproses file.' });
  } finally {
    safeUnlink(filePath);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server berjalan di port ${PORT}`);
});
