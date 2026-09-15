const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/' });

const MAX_LIMIT = parseInt(process.env.MAX_LIMIT) || 20;
const COOLDOWN_HOURS = parseInt(process.env.COOLDOWN_HOURS) || 20;
const FAMILY_PIN = process.env.FAMILY_PIN || "01092007";

let userSessions = {};

app.post('/api/songfinder', upload.single('audioFile'), (req, res) => {
    const { userId = 'default_user', pin, mediaUrl } = req.body;
    const uploadedFile = req.file;
    const now = Date.now();

    if (pin && pin === FAMILY_PIN) {
        return res.status(200).json({ 
            success: true, 
            familyMode: true,
            message: "Mode Keluarga Aktif: Pencarian tanpa batas!",
            result: {
                songName: "Special Family Track - Exclusive Remix",
                artist: "Keluarga Besar 0109",
                matchAccuracy: "100%",
                audioClipUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"
            }
        });
    }

    if (!userSessions[userId]) {
        userSessions[userId] = { count: 0, cooldownUntil: 0 };
    }

    let session = userSessions[userId];

    if (now < session.cooldownUntil) {
        const remainingHours = Math.ceil((session.cooldownUntil - now) / (1000 * 60 * 60));
        return res.status(429).json({ 
            success: false,
            error: `Batas harian habis. Cooldown aktif, coba lagi dalam ${remainingHours} jam.` 
        });
    }

    if (session.count >= MAX_LIMIT) {
        session.cooldownUntil = now + (COOLDOWN_HOURS * 60 * 60 * 1000);
        session.count = 0;
        return res.status(429).json({ 
            success: false,
            error: "Batas 20 kali pencarian tercapai. Cooldown 20 jam dimulai." 
        });
    }

    session.count++;
    const attemptsLeft = MAX_LIMIT - session.count;

    if (!mediaUrl && !uploadedFile) {
        return res.status(400).json({
            success: false,
            error: "Harap masukkan Link YouTube/TikTok atau Upload File Audio!"
        });
    }

    return res.status(200).json({ 
        success: true, 
        familyMode: false,
        attemptsLeft: attemptsLeft,
        message: `Pencarian berhasil (${session.count}/${MAX_LIMIT}). Sisa kuota: ${attemptsLeft}`,
        result: {
            songName: mediaUrl ? `Lagu dari link: ${mediaUrl}` : `Lagu dari file: ${uploadedFile.originalname}`,
            artist: "Artis Terdeteksi",
            matchAccuracy: "99.1%",
            audioClipUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3"
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SongFinder Pro berjalan di port ${PORT}`));