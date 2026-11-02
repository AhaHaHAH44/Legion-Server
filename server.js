
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);

app.use(express.json());

const players = new Map();

const PLAYER_TIMEOUT = 60000;

// ========================================
// HEALTH CHECK
// ========================================

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        name: 'Legion Server',
        message: 'Legion multiplayer server is running!'
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ========================================
// PLAYER REGISTRATION
// ========================================

app.post('/api/players/heartbeat', (req, res) => {
    const { id, nickname } = req.body || {};

    if (
        typeof id !== 'string' ||
        id.length < 10 ||
        id.length > 100 ||
        typeof nickname !== 'string' ||
        nickname.trim().length === 0 ||
        nickname.length > 32
    ) {
        return res.status(400).json({
            error: 'Invalid player data'
        });
    }

    const cleanNickname = nickname.trim();

    const isNewPlayer = !players.has(id);

    players.set(id, {
        id,
        nickname: cleanNickname,
        lastSeen: Date.now()
    });

    if (isNewPlayer) {
        console.log(`Player joined: ${cleanNickname} (${id})`);
    }

    res.json({
        success: true,
        message: 'Player registered',
        playerId: id
    });
});

// ========================================
// ONLINE PLAYERS
// ========================================

app.get('/api/players', (req, res) => {
    const now = Date.now();

    // Remove inactive players
    for (const [id, player] of players.entries()) {
        if (now - player.lastSeen > PLAYER_TIMEOUT) {
            console.log(`Player left: ${player.nickname}`);
            players.delete(id);
        }
    }

    const onlinePlayers = Array.from(players.values()).map(player => ({
        id: player.id,
        nickname: player.nickname
    }));

    res.json({
        success: true,
        count: onlinePlayers.length,
        players: onlinePlayers
    });
});

// ========================================
// SERVER START
// ========================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Legion Server started on port ${PORT}`);
});
