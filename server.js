const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('.'));

const MAX_LIMIT = 20;
const COOLDOWN_HOURS = 20;
const FAMILY_PIN = "01092007";

let userSessions = {};

app.post('/api/trigger', (req, res) => {
    const { userId = 'default_user', pin } = req.body;
    const now = Date.now();

    if (pin === FAMILY_PIN) {
        return res.status(200).json({ 
            success: true, 
            message: "Mode keluarga tak terbatas diaktifkan (Batas dilewati)." 
        });
    }

    if (!userSessions[userId]) {
        userSessions[userId] = { count: 0, cooldownUntil: 0 };
    }

    let session = userSessions[userId];

    if (now < session.cooldownUntil) {
        const remainingHours = Math.ceil((session.cooldownUntil - now) / (1000 * 60 * 60));
        return res.status(429).json({ 
            error: `Cooldown aktif. Coba lagi dalam ${remainingHours} jam.` 
        });
    }

    if (session.count >= MAX_LIMIT) {
        session.cooldownUntil = now + (COOLDOWN_HOURS * 60 * 60 * 1000);
        session.count = 0;
        return res.status(429).json({ 
            error: "Batas 20 kali tercapai. Cooldown 20 jam dimulai." 
        });
    }

    session.count++;
    return res.status(200).json({ 
        success: true, 
        attemptsLeft: MAX_LIMIT - session.count,
        message: `Percobaan ke-${session.count} dari ${MAX_LIMIT}`
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server berjalan pada port ${PORT}`));
