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
  if (typeof query !== 'string') {
    return false;
  }
  const value = query.trim();
  if (!value || value.length > 1000) {
    return false;
  }
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
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Gagal menghapus file temporary:', error.message);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = AUDD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function callAudDWithFailover(filePath) {
  if (AUDD_TOKENS.length === 0) {
    throw new Error('API token AudD belum dikonfigurasi di server backend.');
  }

  let lastError = null;

  for (let index = 0; index < AUDD_TOKENS.length; index++) {
    const token = AUDD_TOKENS[index];
    let form = null;

    try {
      form = new FormData();
      form.append('file', fs.createReadStream(filePath));
      form.append('return', 'spotify,apple_music');
      form.append('api_token', token);

      const response = await fetchWithTimeout(
        'https://api.audd.io/',
        {
          method: 'POST',
          headers: form.getHeaders(),
          body: form
        },
        AUDD_TIMEOUT_MS
      );

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Respon dari server AudD tidak valid.');
      }

      if (data && data.status === 'success') {
        return data.result || {};
      }

      const errMsg = data?.error?.error_message || data?.error?.error_code || JSON.stringify(data);
      lastError = new Error(String(errMsg));

      if (/quota|limit|token|credits|credit/i.test(String(errMsg))) {
        console.warn(`Token AudD #${index + 1} bermasalah atau mencapai batas. Mencoba token berikutnya...`);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        console.warn(`AudD mengembalikan HTTP ${response.status}. Mencoba token berikutnya...`);
        continue;
      }

      throw lastError;
    } catch (error) {
      lastError = error;
      console.warn(`Percobaan AudD dengan token #${index + 1} gagal:`, error.message);
      continue;
    } finally {
      form = null;
    }
  }

  throw lastError || new Error('Semua token AudD gagal atau habis kuotanya.');
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
    service: 'SongFinder Pro',
    auddTokensConfigured: AUDD_TOKENS.length > 0,
    auddTokenCount: AUDD_TOKENS.length
  });
});

app.post('/api/recognize-url', async (req, res) => {
  const { query } = req.body || {};

  if (!query || typeof query !== 'string' || !validatePublicUrlOrSearch(query)) {
    return res.status(400).json({
      success: false,
      message: 'URL atau judul lagu tidak valid.'
    });
  }

  const randomId = Math.random().toString(36).substring(2, 7);
  const tmpBaseName = `audio_${Date.now()}_${randomId}`;
  const tmpOutputAudio = path.join(os.tmpdir(), `${tmpBaseName}.mp3`);
  let actualAudioPath = null;

  try {
    const cleanQuery = query.trim();
    const isUrl = /^https?:\/\//i.test(cleanQuery);
    const outputTemplate = path.join(os.tmpdir(), `${tmpBaseName}.%(ext)s`);

    const ytArgs = isUrl
      ? [cleanQuery, '-x', '--audio-format', 'mp3', '--no-playlist', '--max-filesize', '25M', '-o', outputTemplate]
      : [`ytsearch1:${cleanQuery}`, '-x', '--audio-format', 'mp3', '--no-playlist', '--max-filesize', '25M', '-o', outputTemplate];

    try {
      await executeFile('yt-dlp', ytArgs, {
        timeout: YTDLP_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      console.error('yt-dlp error:', error.message);
      throw new Error('Gagal mengunduh media dari sumber yang diberikan.');
    }

    if (fs.existsSync(tmpOutputAudio)) {
      actualAudioPath = tmpOutputAudio;
    } else {
      const dirFiles = fs.readdirSync(os.tmpdir());
      const matched = dirFiles.find(file => file.startsWith(`${tmpBaseName}.`));
      if (matched) {
        actualAudioPath = path.join(os.tmpdir(), matched);
      }
    }

    if (!actualAudioPath || !fs.existsSync(actualAudioPath)) {
      throw new Error('File audio hasil unduhan tidak ditemukan.');
    }

    const result = await callAudDWithFailover(actualAudioPath);

    return res.json({
      success: true,
      result: result || {}
    });
  } catch (error) {
    console.error('Error recognize-url:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan saat memproses URL atau media.'
    });
  } finally {
    safeUnlink(actualAudioPath);
    try {
      const files = fs.readdirSync(os.tmpdir());
      for (const file of files) {
        if (file.startsWith(`${tmpBaseName}.`)) {
          safeUnlink(path.join(os.tmpdir(), file));
        }
      }
    } catch (error) {
      console.error('Gagal membersihkan temporary files:', error.message);
    }
  }
});

app.post('/api/recognize-file', upload.single('audio'), async (req, res) => {
  const filePath = req.file?.path;

  if (!filePath) {
    return res.status(400).json({
      success: false,
      message: 'File audio tidak ditemukan.'
    });
  }

  try {
    try {
      await executeFile('ffprobe', ['-v', 'error', filePath], {
        timeout: FFPROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      console.error('ffprobe error:', error.message);
      throw new Error('File audio rusak atau format tidak didukung.');
    }

    const result = await callAudDWithFailover(filePath);

    return res.json({
      success: true,
      result: result || {}
    });
  } catch (error) {
    console.error('Error recognize-file:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Terjadi kesalahan saat memproses file.'
    });
  } finally {
    safeUnlink(filePath);
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: 'Ukuran file terlalu besar. Maksimal 25 MB.'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        message: 'Hanya satu file yang boleh diunggah.'
      });
    }
    return res.status(400).json({
      success: false,
      message: 'Upload file tidak valid.'
    });
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan internal pada server.'
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SongFinder Pro server berjalan di port ${PORT}`);
  console.log(`AudD token tersedia: ${AUDD_TOKENS.length}`);
});
