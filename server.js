const express = require('express');
const http = require('http');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '10kb' }));

const players = new Map();
const invitations = new Map();
const matches = new Map();

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
    const { id, nickname } = req.body || {};

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

    cleanup();

    const cleanNickname = nickname.trim();
    const isNew = !players.has(id);

    players.set(id, {
        id,
        nickname: cleanNickname,
        lastSeen: Date.now()
    });

    if (isNew) {
        console.log(`Player joined: ${cleanNickname} (${id})`);
    }

    res.json({
        success: true,
        playerId: id
    });
});

// ========================================
// ONLINE PLAYERS
// ========================================

app.get('/api/players', (req, res) => {
    cleanup();

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
// START SERVER
// ========================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Legion Server started on port ${PORT}`);
});
