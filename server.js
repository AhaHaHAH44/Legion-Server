const express = require('express');
const http = require('http');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '10kb' }));

const players = new Map();
const invitations = new Map();
const matches = new Map();

// Кото-рулетка: временные данные хранятся в памяти сервера.
const rouletteCooldowns = new Map();
const rouletteInvitations = new Map();
const rouletteMatches = new Map();

const ROULETTE_COOLDOWN = 5 * 60 * 1000;
const ROULETTE_INVITE_TIMEOUT = 30000;
const ROULETTE_MATCH_TIMEOUT = 180000;

const ROULETTE_RESOURCES = [
    { id: 'pebble', name: 'Камушек', emoji: '🪨', points: 1, weight: 32 },
    { id: 'limestone', name: 'Известняк', emoji: '⚪', points: 2, weight: 26 },
    { id: 'iron', name: 'Железо', emoji: '⛓️', points: 3, weight: 15 },
    { id: 'coal', name: 'Уголь', emoji: '⬛', points: 3, weight: 15 },
    { id: 'gold', name: 'Золото', emoji: '🟡', points: 5, weight: 10 },
    { id: 'topaz', name: 'Топаз', emoji: '💎', points: 8, weight: 2 }
];

const PLAYER_TIMEOUT = 60000;
const INVITE_TIMEOUT = 30000;
const MATCH_TIMEOUT = 300000;

// ========================================
// HELPERS
// ========================================

function cleanup() {
    const now = Date.now();

    for (const [id, player] of players) {
        if (now - player.lastSeen > PLAYER_TIMEOUT) {
            console.log(`Player left: ${player.nickname}`);
            players.delete(id);
        }
    }

    for (const [id, invite] of rouletteInvitations) {
        if (now > invite.expiresAt) rouletteInvitations.delete(id);
    }

    for (const [id, match] of rouletteMatches) {
        if (
            match.status === 'finished' &&
            now - match.finishedAt > 120000
        ) {
            rouletteMatches.delete(id);
        } else if (
            match.status !== 'finished' &&
            now - match.createdAt > ROULETTE_MATCH_TIMEOUT
        ) {
            match.status = 'expired';
            match.finishedAt = now;
        }
    }

    for (const [id, invite] of invitations) {
        if (now > invite.expiresAt) {
            invitations.delete(id);
        }
    }

    for (const [id, match] of matches) {
        if (
            match.status === 'finished' &&
            now - match.finishedAt > 120000
        ) {
            matches.delete(id);
        } else if (
            match.status === 'playing' &&
            now - match.createdAt > MATCH_TIMEOUT
        ) {
            match.status = 'expired';
            match.finishedAt = now;
        }
    }
}

function getMatchForPlayer(playerId) {
    for (const match of matches.values()) {
        if (
            match.status === 'playing' &&
            match.players.some(player => player.id === playerId)
        ) {
            return match;
        }
    }

    return null;
}

function getRouletteResource() {
    const total = ROULETTE_RESOURCES.reduce(
        (sum, item) => sum + item.weight,
        0
    );

    let roll = crypto.randomInt(total);

    for (const resource of ROULETTE_RESOURCES) {
        roll -= resource.weight;

        if (roll < 0) {
            return {
                id: resource.id,
                name: resource.name,
                emoji: resource.emoji,
                points: resource.points
            };
        }
    }

    return { ...ROULETTE_RESOURCES[0] };
}

function spinRoulette() {
    return [
        getRouletteResource(),
        getRouletteResource(),
        getRouletteResource()
    ];
}

function getRouletteScore(reels) {
    return reels.reduce((sum, item) => sum + item.points, 0);
}

function getRouletteJackpot(reels) {
    return reels.length === 3 &&
        reels.every(item => item.id === reels[0].id);
}

function getRouletteMatchForPlayer(playerId) {
    const matches = [...rouletteMatches.values()]
        .filter(match =>
            match.players.some(player => player.id === playerId)
        )
        .sort((a, b) => b.createdAt - a.createdAt);

    return matches[0] || null;
}

function getActiveRouletteMatchForPlayer(playerId) {
    return [...rouletteMatches.values()].find(match =>
        match.status === 'waiting' &&
        match.players.some(player => player.id === playerId)
    ) || null;
}

function getWinner(move1, move2) {
    if (move1 === move2) return 'draw';

    const wins = {
        rock: 'scissors',
        scissors: 'paper',
        paper: 'rock'
    };

    return wins[move1] === move2 ? 'first' : 'second';
}

// ========================================
// HEALTH
// ========================================

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        name: 'Legion Server'
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ========================================
// PLAYER REGISTRATION
// ========================================

app.post('/api/players/heartbeat', (req, res) => {
    const { id, nickname, doNotDisturb } = req.body || {};

    if (
        typeof id !== 'string' ||
        id.length < 10 ||
        id.length > 100 ||
        typeof nickname !== 'string' ||
        !nickname.trim() ||
        nickname.trim().length > 32
    ) {
        return res.status(400).json({
            error: 'Invalid player data'
        });
    }

    if (
        doNotDisturb !== undefined &&
        typeof doNotDisturb !== 'boolean'
    ) {
        return res.status(400).json({
            error: 'Invalid doNotDisturb value'
        });
    }

    cleanup();

    const cleanNickname = nickname.trim();
    const existingPlayer = players.get(id);
    const isNew = !existingPlayer;

    players.set(id, {
        id,
        nickname: cleanNickname,
        lastSeen: Date.now(),
        doNotDisturb: doNotDisturb !== undefined
            ? doNotDisturb
            : (existingPlayer?.doNotDisturb ?? false)
    });

    if (isNew) {
        console.log(`Player joined: ${cleanNickname} (${id})`);
    }

    res.json({
        success: true,
        playerId: id,
        doNotDisturb: players.get(id).doNotDisturb
    });
});

// ========================================
// DO NOT DISTURB
// ========================================

app.post('/api/players/:playerId/do-not-disturb', (req, res) => {
    const playerId = req.params.playerId;
    const { enabled } = req.body || {};

    if (typeof enabled !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid doNotDisturb value'
        });
    }

    const player = players.get(playerId);

    if (!player) {
        return res.status(404).json({
            error: 'Player not found'
        });
    }

    player.doNotDisturb = enabled;

    console.log(
        `Do Not Disturb ${enabled ? 'enabled' : 'disabled'}: ${player.nickname}`
    );

    res.json({
        success: true,
        doNotDisturb: player.doNotDisturb
    });
});

// ========================================
// ONLINE PLAYERS
// ========================================

app.get('/api/players', (req, res) => {
    cleanup();

    const onlinePlayers = Array.from(players.values()).map(player => ({
        id: player.id,
        nickname: player.nickname,
        doNotDisturb: player.doNotDisturb ?? false
    }));

    res.json({
        success: true,
        count: onlinePlayers.length,
        players: onlinePlayers
    });
});

// ========================================
// INVITATIONS
// ========================================

app.post('/api/invites', (req, res) => {
    cleanup();

    const { fromId, toId } = req.body || {};

    if (
        typeof fromId !== 'string' ||
        typeof toId !== 'string' ||
        fromId === toId
    ) {
        return res.status(400).json({
            error: 'Invalid invitation'
        });
    }

    const sender = players.get(fromId);
    const recipient = players.get(toId);

    if (!sender || !recipient) {
        return res.status(404).json({
            error: 'Player not found or offline'
        });
    }

    if (recipient.doNotDisturb) {
        return res.status(403).json({
            error: 'Player does not accept invitations'
        });
    }

    if (getMatchForPlayer(fromId) || getMatchForPlayer(toId)) {
        return res.status(409).json({
            error: 'A player is already in a match'
        });
    }

    const existing = Array.from(invitations.values()).find(invite =>
        invite.fromId === fromId &&
        invite.toId === toId
    );

    if (existing) {
        return res.status(409).json({
            error: 'Invitation already sent'
        });
    }

    const invite = {
        id: crypto.randomUUID(),
        fromId,
        fromNickname: sender.nickname,
        toId,
        toNickname: recipient.nickname,
        expiresAt: Date.now() + INVITE_TIMEOUT
    };

    invitations.set(invite.id, invite);

    console.log(
        `Invitation: ${sender.nickname} -> ${recipient.nickname}`
    );

    res.json({
        success: true,
        invitationId: invite.id
    });
});

// ========================================
// GET INVITATIONS
// ========================================

app.get('/api/invites/:playerId', (req, res) => {
    cleanup();

    const playerId = req.params.playerId;

    if (!players.has(playerId)) {
        return res.status(404).json({
            error: 'Player not found'
        });
    }

    const incoming = Array.from(invitations.values())
        .filter(invite => invite.toId === playerId)
        .map(invite => ({
            id: invite.id,
            fromId: invite.fromId,
            fromNickname: invite.fromNickname,
            expiresAt: invite.expiresAt
        }));

    res.json({
        success: true,
        invitations: incoming
    });
});

// ========================================
// RESPOND TO INVITATION
// ========================================

app.post('/api/invites/:inviteId/respond', (req, res) => {
    cleanup();

    const { playerId, accept } = req.body || {};
    const invite = invitations.get(req.params.inviteId);

    if (!invite) {
        return res.status(404).json({
            error: 'Invitation expired or not found'
        });
    }

    if (invite.toId !== playerId) {
        return res.status(403).json({
            error: 'This invitation belongs to another player'
        });
    }

    if (typeof accept !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid response'
        });
    }

    if (!players.has(invite.fromId) || !players.has(invite.toId)) {
        invitations.delete(invite.id);

        return res.status(409).json({
            error: 'A player is offline'
        });
    }

    invitations.delete(invite.id);

    if (!accept) {
        console.log(`Invitation rejected: ${invite.toNickname}`);

        return res.json({
            success: true,
            status: 'rejected'
        });
    }

    if (
        getMatchForPlayer(invite.fromId) ||
        getMatchForPlayer(invite.toId)
    ) {
        return res.status(409).json({
            error: 'A player is already in a match'
        });
    }

    const first = players.get(invite.fromId);
    const second = players.get(invite.toId);

    const match = {
        id: crypto.randomUUID(),
        game: 'rock-paper-scissors',
        status: 'playing',
        createdAt: Date.now(),
        players: [
            {
                id: first.id,
                nickname: first.nickname,
                move: null
            },
            {
                id: second.id,
                nickname: second.nickname,
                move: null
            }
        ],
        winner: null,
        finishedAt: null
    };

    matches.set(match.id, match);

    console.log(
        `Match created: ${first.nickname} vs ${second.nickname}`
    );

    res.json({
        success: true,
        status: 'accepted',
        matchId: match.id
    });
});

// ========================================
// GET PLAYER MATCH
// ========================================

app.get('/api/matches/player/:playerId', (req, res) => {
    cleanup();

    const playerId = req.params.playerId;
    const match = getMatchForPlayer(playerId);

    if (!match) {
        return res.json({
            success: true,
            match: null
        });
    }

    res.json({
        success: true,
        match: {
            id: match.id,
            game: match.game,
            status: match.status,
            players: match.players.map(player => ({
                id: player.id,
                nickname: player.nickname,
                hasMoved: player.move !== null
            })),
            winner: match.winner
        }
    });
});

// ========================================
// SUBMIT MOVE
// ========================================

app.post('/api/matches/:matchId/move', (req, res) => {
    cleanup();

    const { playerId, move } = req.body || {};
    const match = matches.get(req.params.matchId);

    if (!match || match.status !== 'playing') {
        return res.status(404).json({
            error: 'Match not found or finished'
        });
    }

    if (!['rock', 'paper', 'scissors'].includes(move)) {
        return res.status(400).json({
            error: 'Invalid move'
        });
    }

    const player = match.players.find(p => p.id === playerId);

    if (!player) {
        return res.status(403).json({
            error: 'You are not a participant'
        });
    }

    if (player.move !== null) {
        return res.status(409).json({
            error: 'You have already moved'
        });
    }

    player.move = move;

    console.log(`Move submitted in match ${match.id}`);

    const bothMoved = match.players.every(p => p.move !== null);

    if (bothMoved) {
        const result = getWinner(
            match.players[0].move,
            match.players[1].move
        );

        match.winner = result === 'draw'
            ? 'draw'
            : match.players[result === 'first' ? 0 : 1].id;

        match.status = 'finished';
        match.finishedAt = Date.now();

        console.log(`Match finished: ${match.winner}`);
    }

    res.json({
        success: true,
        waitingForOpponent: !bothMoved
    });
});

// ========================================
// GET MATCH RESULT
// ========================================

app.get('/api/matches/:matchId', (req, res) => {
    cleanup();

    const { playerId } = req.query;
    const match = matches.get(req.params.matchId);

    if (!match) {
        return res.status(404).json({
            error: 'Match not found'
        });
    }

    const currentPlayer = match.players.find(p => p.id === playerId);

    if (!currentPlayer) {
        return res.status(403).json({
            error: 'You are not a participant'
        });
    }

    const bothMoved = match.players.every(p => p.move !== null);

    res.json({
        success: true,
        match: {
            id: match.id,
            status: match.status,
            players: match.players.map(player => ({
                id: player.id,
                nickname: player.nickname,
                move: bothMoved ? player.move : null,
                hasMoved: player.move !== null
            })),
            winner: bothMoved ? match.winner : null
        }
    });
});

// ========================================
// КОТО-РУЛЕТКА
// ========================================

// Состояние одиночной шахты и время следующей попытки
app.get('/api/roulette/status/:playerId', (req, res) => {
    const playerId = req.params.playerId;
    const nextAt = rouletteCooldowns.get(playerId) || 0;

    res.json({
        success: true,
        cooldownMs: Math.max(0, nextAt - Date.now()),
        nextAt
    });
});

// Одиночная прокрутка: результат и кулдаун рассчитываются сервером
app.post('/api/roulette/solo', (req, res) => {
    cleanup();

    const { playerId } = req.body || {};

    if (typeof playerId !== 'string' || !players.has(playerId)) {
        return res.status(404).json({
            error: 'Player not found or offline'
        });
    }

    const now = Date.now();
    const nextAt = rouletteCooldowns.get(playerId) || 0;

    if (now < nextAt) {
        return res.status(429).json({
            error: 'Попытка ещё восстанавливается',
            cooldownMs: nextAt - now,
            nextAt
        });
    }

    const reels = spinRoulette();
    const jackpot = getRouletteJackpot(reels);

    rouletteCooldowns.set(playerId, now + ROULETTE_COOLDOWN);

    res.json({
        success: true,
        mode: 'solo',
        reels,
        score: getRouletteScore(reels),
        jackpot,
        nextAt: now + ROULETTE_COOLDOWN,
        cooldownMs: ROULETTE_COOLDOWN
    });
});

// Создать приглашение в совместную шахту
app.post('/api/roulette/invites', (req, res) => {
    cleanup();

    const { fromId, toId } = req.body || {};

    if (
        typeof fromId !== 'string' ||
        typeof toId !== 'string' ||
        fromId === toId
    ) {
        return res.status(400).json({
            error: 'Invalid invitation'
        });
    }

    const sender = players.get(fromId);
    const recipient = players.get(toId);

    if (!sender || !recipient) {
        return res.status(404).json({
            error: 'Player not found or offline'
        });
    }

    if (recipient.doNotDisturb) {
        return res.status(403).json({
            error: 'Player does not accept invitations'
        });
    }

    if (
        getRouletteMatchForPlayer(fromId) ||
        getRouletteMatchForPlayer(toId)
    ) {
        return res.status(409).json({
            error: 'A player is already in a roulette round'
        });
    }

    const alreadyInvited = Array.from(rouletteInvitations.values()).some(invite =>
        invite.fromId === fromId &&
        invite.toId === toId
    );

    if (alreadyInvited) {
        return res.status(409).json({
            error: 'Invitation already sent'
        });
    }

    const invite = {
        id: crypto.randomUUID(),
        fromId,
        fromNickname: sender.nickname,
        toId,
        toNickname: recipient.nickname,
        expiresAt: Date.now() + ROULETTE_INVITE_TIMEOUT
    };

    rouletteInvitations.set(invite.id, invite);

    res.json({
        success: true,
        invitationId: invite.id
    });
});

// Получить входящие приглашения в рулетку
app.get('/api/roulette/invites/:playerId', (req, res) => {
    cleanup();

    const playerId = req.params.playerId;

    if (!players.has(playerId)) {
        return res.status(404).json({
            error: 'Player not found'
        });
    }

    const incoming = Array.from(rouletteInvitations.values())
        .filter(invite => invite.toId === playerId)
        .map(invite => ({
            id: invite.id,
            fromId: invite.fromId,
            fromNickname: invite.fromNickname,
            expiresAt: invite.expiresAt
        }));

    res.json({
        success: true,
        invitations: incoming
    });
});

// Принять или отклонить приглашение
app.post('/api/roulette/invites/:inviteId/respond', (req, res) => {
    cleanup();

    const { playerId, accept } = req.body || {};
    const invite = rouletteInvitations.get(req.params.inviteId);

    if (!invite) {
        return res.status(404).json({
            error: 'Invitation expired or not found'
        });
    }

    if (invite.toId !== playerId) {
        return res.status(403).json({
            error: 'This invitation belongs to another player'
        });
    }

    if (typeof accept !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid response'
        });
    }

    rouletteInvitations.delete(invite.id);

    if (!accept) {
        return res.json({
            success: true,
            status: 'rejected'
        });
    }

    const first = players.get(invite.fromId);
    const second = players.get(invite.toId);

    if (!first || !second) {
        return res.status(409).json({
            error: 'A player is offline'
        });
    }

    if (
        getActiveRouletteMatchForPlayer(first.id) ||
        getActiveRouletteMatchForPlayer(second.id)
    ) {
        return res.status(409).json({
            error: 'A player is already in a roulette round'
        });
    }

    const match = {
        id: crypto.randomUUID(),
        game: 'koto-roulette',
        status: 'waiting',
        createdAt: Date.now(),
        finishedAt: null,
        winner: null,
        players: [
            {
                id: first.id,
                nickname: first.nickname,
                reels: null,
                score: null
            },
            {
                id: second.id,
                nickname: second.nickname,
                reels: null,
                score: null
            }
        ]
    };

    rouletteMatches.set(match.id, match);

    res.json({
        success: true,
        status: 'accepted',
        matchId: match.id
    });
});

// Получить активную совместную игру
app.get('/api/roulette/matches/player/:playerId', (req, res) => {
    cleanup();

    const match = getRouletteMatchForPlayer(req.params.playerId);

    if (!match) {
        return res.json({
            success: true,
            match: null
        });
    }

    res.json({
        success: true,
        match: {
            id: match.id,
            status: match.status,
            players: match.players.map(player => ({
                id: player.id,
                nickname: player.nickname,
                hasSpun: !!player.reels,
                reels: player.reels,
                score: player.score
            })),
            winner: match.winner
        }
    });
});

// Каждый участник делает одну прокрутку.
// Оба сохраняют свои результаты.
app.post('/api/roulette/matches/:matchId/spin', (req, res) => {
    cleanup();

    const { playerId } = req.body || {};
    const match = rouletteMatches.get(req.params.matchId);

    if (!match || !['waiting', 'finished'].includes(match.status)) {
        return res.status(404).json({
            error: 'Roulette match not found'
        });
    }

    const player = match.players.find(item => item.id === playerId);

    if (!player) {
        return res.status(403).json({
            error: 'You are not a participant'
        });
    }

    if (player.reels) {
        return res.status(409).json({
            error: 'You have already spun'
        });
    }

    player.reels = spinRoulette();
    player.score = getRouletteScore(player.reels);

    const bothSpun = match.players.every(item => item.reels);

    if (bothSpun) {
        const firstScore = match.players[0].score;
        const secondScore = match.players[1].score;

        match.winner = firstScore === secondScore
            ? 'draw'
            : match.players[firstScore > secondScore ? 0 : 1].id;

        match.status = 'finished';
        match.finishedAt = Date.now();
    }

    res.json({
        success: true,
        reels: player.reels,
        score: player.score,
        jackpot: getRouletteJackpot(player.reels),
        waitingForOpponent: !bothSpun
    });
});

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Legion Server started on port ${PORT}`);
});
