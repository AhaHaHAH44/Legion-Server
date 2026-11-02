const express = require('express');
const http = require('http');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '10kb' }));

const players = new Map();
const invitations = new Map();

const PLAYER_TIMEOUT = 60000;
const INVITE_TIMEOUT = 30000;

// ========================================
// CLEANUP
// ========================================

function cleanup() {
    const now = Date.now();

    for (const [id, player] of players.entries()) {
        if (now - player.lastSeen > PLAYER_TIMEOUT) {
            console.log(`Player left: ${player.nickname}`);
            players.delete(id);
        }
    }

    for (const [id, invite] of invitations.entries()) {
        if (now > invite.expiresAt) {
            invitations.delete(id);
        }
    }
}

// ========================================
// HEALTH CHECK
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
// SEND INVITATION
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
        status: 'pending',
        createdAt: Date.now(),
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
// GET PLAYER INVITATIONS
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
        .filter(invite =>
            invite.toId === playerId &&
            invite.status === 'pending'
        )
        .map(invite => ({
            id: invite.id,
            fromId: invite.fromId,
            fromNickname: invite.fromNickname,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt
        }));

    res.json({
        success: true,
        invitations: incoming
    });
});

// ========================================
// ACCEPT OR REJECT INVITATION
// ========================================

app.post('/api/invites/:inviteId/respond', (req, res) => {
    cleanup();

    const { playerId, accept } = req.body || {};
    const invite = invitations.get(req.params.inviteId);

    if (!invite) {
        return res.status(404).json({
            error: 'Invitation not found or expired'
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

    invite.status = accept ? 'accepted' : 'rejected';

    invitations.delete(invite.id);

    console.log(
        `Invitation ${invite.status}: ${invite.fromNickname} -> ${invite.toNickname}`
    );

    res.json({
        success: true,
        status: invite.status,
        fromId: invite.fromId,
        fromNickname: invite.fromNickname
    });
});

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Legion Server started on port ${PORT}`);
});
