const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Server } = require('socket.io');

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is missing. Configure it in Render Environment.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Комнаты подключённых игроков
io.on('connection', (socket) => {
    socket.on('inventory:subscribe', async (playerId) => {
        if (typeof playerId !== 'string' || !playerId.trim()) {
            return;
        }

        try {
            const canonicalId = await resolvePlayerId(playerId);

            socket.join(`inventory:${canonicalId}`);
        } catch (error) {
            console.error('Inventory subscription failed:', error);
        }
    });
});

app.use(express.json({ limit: '10kb' }));

const players = new Map();
const invitations = new Map();
const matches = new Map();

// Приглашения остаются временными; балансы, кулдауны и матчи хранятся в PostgreSQL.
const rouletteInvitations = new Map();

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

// Преобразует дополнительный UUID в основной UUID аккаунта
async function resolvePlayerId(playerId, db = pool) {
    const result = await db.query(
        `SELECT player_id
         FROM roulette_player_aliases
         WHERE alias_id = $1`,
        [playerId]
    );

    return result.rowCount
        ? result.rows[0].player_id
        : playerId;
}

// Создаёт игроку стандартные слоты инвентаря
async function ensurePlayerInventorySlots(db, playerId) {
    await db.query(
        `
        INSERT INTO inventory_slots (
            player_id,
            slot_type,
            slot_number
        )
        SELECT
            $1,
            types.slot_type,
            slots.slot_number
        FROM inventory_slot_types AS types
        CROSS JOIN LATERAL generate_series(
            1,
            types.default_slots
        ) AS slots(slot_number)
        WHERE types.is_active = TRUE
        ON CONFLICT (
            player_id,
            slot_type,
            slot_number
        ) DO NOTHING
        `,
        [playerId]
    );
}

// Выдать предмет игроку
async function grantInventoryItem(db, playerId, itemCode, quantity = 1) {
    if (
        typeof playerId !== 'string' ||
        typeof itemCode !== 'string' ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1
    ) {
        throw new Error('INVALID_ITEM_GRANT');
    }

    // Блокируем запись каталога для безопасной выдачи
    const itemResult = await db.query(
        `SELECT
            code,
            is_stackable,
            max_stack
         FROM inventory_items
         WHERE code = $1
           AND is_active = TRUE
         FOR UPDATE`,
        [itemCode]
    );

    if (!itemResult.rowCount) {
        throw new Error('INVENTORY_ITEM_NOT_FOUND');
    }

    const item = itemResult.rows[0];

    if (!item.is_stackable && quantity !== 1) {
        throw new Error('ITEM_NOT_STACKABLE');
    }

    // Проверяем, есть ли предмет у игрока
    const existing = await db.query(
        `SELECT quantity
         FROM player_inventory
         WHERE player_id = $1
           AND item_code = $2
         FOR UPDATE`,
        [playerId, itemCode]
    );

    if (existing.rowCount) {
        if (!item.is_stackable) {
            throw new Error('ITEM_ALREADY_OWNED');
        }

        const newQuantity =
            Number(existing.rows[0].quantity) + quantity;

        if (newQuantity > item.max_stack) {
            throw new Error('ITEM_STACK_LIMIT');
        }

        await db.query(
            `UPDATE player_inventory
             SET quantity = $3,
                 updated_at = NOW()
             WHERE player_id = $1
               AND item_code = $2`,
            [playerId, itemCode, newQuantity]
        );

        return {
            itemCode,
            quantity: newQuantity,
            added: quantity
        };
    }

    if (quantity > item.max_stack) {
        throw new Error('ITEM_STACK_LIMIT');
    }

    await db.query(
        `INSERT INTO player_inventory (
            player_id,
            item_code,
            quantity
         )
         VALUES ($1, $2, $3)`,
        [playerId, itemCode, quantity]
    );

    return {
        itemCode,
        quantity,
        added: quantity
    };
}

// Уведомить игрока об изменении инвентаря
function notifyInventoryUpdated(playerId, itemCode, quantity) {
    io.to(`inventory:${playerId}`).emit('inventory:updated', {
        itemCode,
        quantity
    });
}

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
    const total = ROULETTE_RESOURCES.reduce((sum, item) => sum + item.weight, 0);
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
    return [getRouletteResource(), getRouletteResource(), getRouletteResource()];
}

function getRouletteMultiplier(reels) {
    const counts = new Map();
    for (const item of reels) counts.set(item.id, (counts.get(item.id) || 0) + 1);
    const highestCount = counts.size ? Math.max(...counts.values()) : 0;
    return highestCount === 3 ? 2 : highestCount === 2 ? 1.5 : 1;
}

function getRouletteScore(reels) {
    const base = reels.reduce((sum, item) => sum + item.points, 0);
    return base * getRouletteMultiplier(reels);
}

function getRouletteJackpot(reels) {
    return reels.length === 3 && reels.every(item => item.id === reels[0].id);
}

// ========================================
// ВЫДАЧА МОДИФИКАТОРОВ ЗА СОЛО-ДЖЕКПОТ
// ========================================

async function grantRouletteJackpotModifier(db, playerId, reels) {
    // Проверяем, что выпал джекпот из трёх одинаковых ресурсов
    if (!getRouletteJackpot(reels)) {
        return null;
    }

    // Какой модификатор соответствует каждому ресурсу
    const rewards = {
        pebble: {
            unlockCode: 'roulette_unlock_pebble',
            itemCode: 'roulette_mod_reroll',
            name: 'Переброс'
        },
        limestone: {
            unlockCode: 'roulette_unlock_limestone',
            itemCode: 'roulette_mod_pair_save',
            name: 'Страховка'
        },
        iron: {
            unlockCode: 'roulette_unlock_iron',
            itemCode: 'roulette_mod_lock',
            name: 'Повтор'
        },
        coal: {
            unlockCode: 'roulette_unlock_coal',
            itemCode: 'roulette_mod_duplicate',
            name: 'Дублирование'
        },
        gold: {
            unlockCode: 'roulette_unlock_gold',
            itemCode: 'roulette_mod_second_chance',
            name: 'Лихорадка'
        },
        topaz: {
            unlockCode: 'roulette_unlock_topaz',
            itemCode: 'roulette_mod_transmutation',
            name: 'Трансмутация'
        }
    };

    const reward = rewards[reels[0].id];

    if (!reward) {
        return null;
    }

    // Проверяем, купил ли игрок соответствующую разблокировку
    const unlocked = await db.query(
        `SELECT id
         FROM player_purchases
         WHERE player_id = $1
           AND item_code = $2`,
        [playerId, reward.unlockCode]
    );

    // Без разблокировки модификатор не выдаётся
    if (!unlocked.rowCount) {
        return null;
    }

    // Выдаём один экземпляр модификатора
    try {
        await grantInventoryItem(
            db,
            playerId,
            reward.itemCode,
            1
        );
    
        return {
            code: reward.itemCode,
            name: reward.name,
            granted: true
        };
    
    } catch (error) {
        // Переполненная стопка не должна отменять результат рулетки
        if (error.message === 'ITEM_STACK_LIMIT') {
            return {
                code: reward.itemCode,
                name: reward.name,
                granted: false,
                reason: 'stack_full'
            };
        }
    
        // Остальные ошибки по-прежнему должны отменять транзакцию
        throw error;
    }
}

// Сериализуем создание совместных матчей для одних и тех же игроков.
// Advisory-lock берётся в стабильном порядке, чтобы избежать взаимных блокировок.
async function lockRoulettePlayers(client, playerIds) {
    const ids = [...new Set(playerIds)].sort();
    for (const id of ids) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
    }
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

app.post('/api/players/heartbeat', async (req, res) => {
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

    try {
        const canonicalId = await resolvePlayerId(id);

        const existingPlayer = players.get(canonicalId);
        const isNew = !existingPlayer;

        await pool.query(
            `INSERT INTO roulette_accounts (player_id, nickname)
             VALUES ($1, $2)
             ON CONFLICT (player_id)
             DO UPDATE SET nickname = EXCLUDED.nickname`,
            [canonicalId, cleanNickname]
        );

        players.set(canonicalId, {
            id: canonicalId,
            nickname: cleanNickname,
            lastSeen: Date.now(),
            doNotDisturb: doNotDisturb !== undefined
                ? doNotDisturb
                : (existingPlayer?.doNotDisturb ?? false)
        });

        if (isNew) {
            console.log(`Player joined: ${cleanNickname} (${canonicalId})`);
        }

        return res.json({
            success: true,
            playerId: canonicalId,
            doNotDisturb: players.get(canonicalId).doNotDisturb
        });

    } catch (error) {
        console.error('Player balance registration failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// DO NOT DISTURB
// ========================================

app.post('/api/players/:playerId/do-not-disturb', async (req, res) => {
    const { enabled } = req.body || {};

    if (typeof enabled !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid doNotDisturb value'
        });
    }

    try {
        const canonicalId = await resolvePlayerId(req.params.playerId);
        const player = players.get(canonicalId);

        if (!player) {
            return res.status(404).json({
                error: 'Player not found'
            });
        }

        player.doNotDisturb = enabled;

        console.log(
            `Do Not Disturb ${enabled ? 'enabled' : 'disabled'}: ${player.nickname}`
        );

        return res.json({
            success: true,
            doNotDisturb: player.doNotDisturb
        });

    } catch (error) {
        console.error('Do Not Disturb update failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
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

app.post('/api/invites', async (req, res) => {
    cleanup();

    const { fromId, toId } = req.body || {};

    if (
        typeof fromId !== 'string' ||
        typeof toId !== 'string'
    ) {
        return res.status(400).json({
            error: 'Invalid invitation'
        });
    }

    try {
        const canonicalFromId = await resolvePlayerId(fromId);
        const canonicalToId = await resolvePlayerId(toId);

        if (canonicalFromId === canonicalToId) {
            return res.status(400).json({
                error: 'Invalid invitation'
            });
        }

        // Проверяем, не участвует ли кто-либо из игроков в активном матче
        const activeMatch = await pool.query(
            `SELECT id
             FROM knb_matches
             WHERE status IN ('choosing_mode', 'negotiating', 'playing')
               AND (
                   players @> $1::jsonb
                   OR players @> $2::jsonb
               )
             LIMIT 1`,
            [
                JSON.stringify([{ id: canonicalFromId }]),
                JSON.stringify([{ id: canonicalToId }])
            ]
        );
        
        if (activeMatch.rowCount > 0) {
            return res.status(409).json({
                error: 'A player is already in a match'
            });
        }

        const sender = players.get(canonicalFromId);
        const recipient = players.get(canonicalToId);

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

        const existing = Array.from(invitations.values()).find(invite =>
            invite.fromId === canonicalFromId &&
            invite.toId === canonicalToId
        );

        if (existing) {
            return res.status(409).json({
                error: 'Invitation already sent'
            });
        }

        const invite = {
            id: crypto.randomUUID(),
            fromId: canonicalFromId,
            fromNickname: sender.nickname,
            toId: canonicalToId,
            toNickname: recipient.nickname,
            expiresAt: Date.now() + INVITE_TIMEOUT
        };

        invitations.set(invite.id, invite);

        console.log(
            `Invitation: ${sender.nickname} -> ${recipient.nickname}`
        );

        return res.json({
            success: true,
            invitationId: invite.id
        });

    } catch (error) {
        console.error('Invitation creation failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// GET INVITATIONS
// ========================================

app.get('/api/invites/:playerId', async (req, res) => {
    cleanup();

    try {
        const playerId = await resolvePlayerId(req.params.playerId);

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

        return res.json({
            success: true,
            invitations: incoming
        });

    } catch (error) {
        console.error('Invitation retrieval failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// RESPOND TO INVITATION
// ========================================

app.post('/api/invites/:inviteId/respond', async (req, res) => {
    cleanup();

    const { playerId, accept } = req.body || {};

    if (typeof playerId !== 'string') {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    if (typeof accept !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid response'
        });
    }

    try {
        const canonicalId = await resolvePlayerId(playerId);
        const invite = invitations.get(req.params.inviteId);

        if (!invite) {
            return res.status(404).json({
                error: 'Invitation expired or not found'
            });
        }

        if (invite.toId !== canonicalId) {
            return res.status(403).json({
                error: 'This invitation belongs to another player'
            });
        }

        if (!players.has(invite.fromId) || !players.has(invite.toId)) {
            invitations.delete(invite.id);

            return res.status(409).json({
                error: 'A player is offline'
            });
        }

        if (!accept) {
            invitations.delete(invite.id);
        
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
        
        const matchId = crypto.randomUUID();
        const createdAt = Date.now();
        
        const matchPlayers = [
            {
                id: first.id,
                nickname: first.nickname,
                mode: null,
                move: null
            },
            {
                id: second.id,
                nickname: second.nickname,
                mode: null,
                move: null
            }
        ];
        
        let client;

        try {
            client = await pool.connect();
        
            await client.query('BEGIN');
        
            // Блокируем обоих игроков, чтобы не создать им два матча одновременно
            await lockRoulettePlayers(client, [first.id, second.id]);
        
            // Проверяем, не участвует ли кто-нибудь уже в другом матче Кото-КНБ
            const active = await client.query(
                `SELECT id
                 FROM knb_matches
                 WHERE status IN (
                     'choosing_mode',
                     'negotiating',
                     'playing'
                 )
                 AND (
                     players @> $1::jsonb
                     OR players @> $2::jsonb
                 )
                 LIMIT 1`,
                [
                    JSON.stringify([{ id: first.id }]),
                    JSON.stringify([{ id: second.id }])
                ]
            );
        
            if (active.rowCount) {
                throw new Error('PLAYER_ALREADY_IN_MATCH');
            }
        
            // Создаём матч в PostgreSQL
            await client.query(
                `INSERT INTO knb_matches (
                    id,
                    status,
                    players,
                    created_at
                )
                VALUES ($1, 'choosing_mode', $2::jsonb, $3)`,
                [
                    matchId,
                    JSON.stringify(matchPlayers),
                    createdAt
                ]
            );
        
            await client.query('COMMIT');
        
        } catch (error) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
            }
        
            throw error;
        } finally {
            if (client) {
                client.release();
            }
        }

        invitations.delete(invite.id);
        
        console.log(
            `Koto-KNB match created: ${first.nickname} vs ${second.nickname}`
        );
        
        return res.json({
            success: true,
            status: 'accepted',
            matchId
        });
        
    } catch (error) {
        console.error('Invitation response failed:', error);
    
        if (error.message === 'PLAYER_ALREADY_IN_MATCH') {
            return res.status(409).json({
                error: 'A player is already in a match'
            });
        }
    
        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// KNB MATCH EXPIRATION
// ========================================

async function expireKnbMatches() {
    const expired = await pool.query(
        `SELECT id
         FROM knb_matches
         WHERE status IN (
             'choosing_mode',
             'negotiating',
             'playing'
         )
         AND updated_at < NOW() - INTERVAL '5 minutes'
         ORDER BY updated_at
         LIMIT 30`
    );

    for (const item of expired.rows) {
        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `SELECT *
                 FROM knb_matches
                 WHERE id = $1
                 FOR UPDATE`,
                [item.id]
            );

            if (!result.rowCount) {
                await client.query('ROLLBACK');
                continue;
            }

            const match = result.rows[0];

            // Повторно проверяем срок после получения блокировки
            if (
                !['choosing_mode', 'negotiating', 'playing']
                    .includes(match.status) ||
                new Date(match.updated_at).getTime() >=
                    Date.now() - 5 * 60 * 1000
            ) {
                await client.query('ROLLBACK');
                continue;
            }

                        // Возвращаем ставки только в завершившейся по таймауту
            // ставочной игре, где деньги уже были зарезервированы
            if (
                match.status === 'playing' &&
                match.mode === 'betting'
            ) {
                const stake = Number(match.stake);

                if (
                    !Number.isSafeInteger(stake) ||
                    stake < 50
                ) {
                    throw new Error('INVALID_RESERVED_STAKE');
                }

                // Проверяем, что обе ставки действительно были списаны
                const ledger = await client.query(
                    `SELECT player_id, amount
                     FROM knb_transactions
                     WHERE match_id = $1
                       AND type = 'stake'`,
                    [match.id]
                );

                if (
                    ledger.rowCount !== 2 ||
                    ledger.rows.some(row => Number(row.amount) !== stake) ||
                    match.players.some(player =>
                        !ledger.rows.some(
                            row => String(row.player_id) === String(player.id)
                        )
                    )
                ) {
                    throw new Error('INCOMPLETE_STAKE_LEDGER');
                }

                // Возвращаем деньги обоим игрокам
                for (const player of match.players) {
                    const refund = await client.query(
                        `INSERT INTO knb_transactions
                            (match_id, player_id, type, amount, details)
                         VALUES ($1, $2, 'refund', $3, $4::jsonb)
                         ON CONFLICT (match_id, player_id, type)
                         DO NOTHING
                         RETURNING id`,
                        [
                            match.id,
                            player.id,
                            stake,
                            JSON.stringify({ reason: 'timeout' })
                        ]
                    );

                    // Начисляем деньги только при новой записи возврата
                    if (refund.rowCount > 0) {
                        const update = await client.query(
                            `UPDATE roulette_accounts
                             SET balance = balance + $2,
                                 updated_at = NOW()
                             WHERE player_id = $1`,
                            [player.id, stake]
                        );

                        if (update.rowCount !== 1) {
                            throw new Error('REFUND_ACCOUNT_NOT_FOUND');
                        }
                    }
                }
            }
            await client.query(
                `UPDATE knb_matches
                 SET status = 'expired',
                     finished_at = NOW(),
                     updated_at = NOW()
                 WHERE id = $1`,
                [match.id]
            );

            await client.query('COMMIT');

            console.log(`KNB match expired: ${match.id}`);

        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});

            console.error(
                'KNB match expiration failed:',
                item.id,
            );

        } finally {
            client.release();
        }
    }
}

// Запускаем очистку не чаще одного раза в 5 секунд
let knbCleanupPromise = null;
let knbLastCleanup = 0;

async function ensureKnbCleanup() {
    if (
        !knbCleanupPromise &&
        Date.now() - knbLastCleanup > 5000
    ) {
        knbCleanupPromise = expireKnbMatches()
            .then(() => {
                knbLastCleanup = Date.now();
            })
            .finally(() => {
                knbCleanupPromise = null;
            });
    }

    if (knbCleanupPromise) {
        await knbCleanupPromise;
    }
}

// Проверяем истёкшие матчи перед обработкой запросов Кото-КНБ
app.use('/api/matches', async (req, res, next) => {
    try {
        await ensureKnbCleanup();
        next();
    } catch (error) {
        console.error('KNB cleanup failed:', error);

        res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// GET PLAYER MATCH
// ========================================

app.get('/api/matches/player/:playerId', async (req, res) => {
    cleanup();

    try {
        const playerId = await resolvePlayerId(req.params.playerId);

        const result = await pool.query(
            `SELECT id, status, mode, players, stake, pot, winner
             FROM knb_matches
             WHERE status IN ('choosing_mode', 'negotiating', 'playing', 'cancelled')
             AND players @> $1::jsonb
             ORDER BY created_at DESC
             LIMIT 1`,
            [JSON.stringify([{ id: playerId }])]
        );

        if (result.rowCount === 0) {
            return res.json({
                success: true,
                match: null
            });
        }

        const match = result.rows[0];

        return res.json({
            success: true,
            match: {
                id: match.id,
                game: 'rock-paper-scissors',
                status: match.status,
                mode: match.mode,
                stake: match.stake,
                pot: match.pot,
                players: match.players.map(player => ({
                    id: player.id,
                    nickname: player.nickname,
                    mode: player.mode ?? null,
                    bet: player.bet ?? null,
                    hasMoved: player.move !== null
                })),
                winner: match.winner
            }
        });

    } catch (error) {
        console.error('Player match lookup failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// CHOOSE KNB MODE
// ========================================

app.post('/api/matches/:matchId/mode', async (req, res) => {
    const { playerId, mode } = req.body || {};

    if (typeof playerId !== 'string') {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    if (!['free', 'betting'].includes(mode)) {
        return res.status(400).json({
            error: 'Invalid game mode'
        });
    }

    const client = await pool.connect();

    try {
        const canonicalId = await resolvePlayerId(playerId);

        await client.query('BEGIN');

        const result = await client.query(
            `SELECT id, status, mode, players
             FROM knb_matches
             WHERE id = $1
             FOR UPDATE`,
            [req.params.matchId]
        );

        if (!result.rowCount) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Match not found'
            });
        }

        const match = result.rows[0];

        if (match.status !== 'choosing_mode') {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'Mode selection is no longer available'
            });
        }

        const players = match.players;

        const player = players.find(p => p.id === canonicalId);

        if (!player) {
            await client.query('ROLLBACK');

            return res.status(403).json({
                error: 'You are not a participant'
            });
        }

        // Для ставок разблокировка должна быть у обоих игроков
        if (mode === 'betting') {
            const ownership = await client.query(
                `SELECT player_id
                 FROM player_purchases
                 WHERE item_code = 'knb_betting'
                 AND player_id = ANY($1::text[])`,
                [players.map(p => p.id)]
            );

            if (ownership.rowCount !== 2) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    error: 'BETTING_LOCK_REQUIRED'
                });
            }
        }

        // Сохраняем выбор текущего игрока
        player.mode = mode;

        const bothSelected = players.every(p => p.mode !== null);

        const sameMode = bothSelected &&
            players[0].mode === players[1].mode;

        let status = 'choosing_mode';
        let selectedMode = null;

        if (sameMode) {
            selectedMode = mode;
            status = mode === 'free'
                ? 'playing'
                : 'negotiating';
        }

        await client.query(
            `UPDATE knb_matches
             SET players = $1::jsonb,
                 mode = $2,
                 status = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [
                JSON.stringify(players),
                selectedMode,
                status,
                match.id
            ]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            status,
            mode: selectedMode,
            waitingForOpponent: !bothSelected,
            modeMismatch: bothSelected && !sameMode
        });

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});

        console.error('KNB mode selection failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });

    } finally {
        client.release();
    }
});

// ========================================
// SUBMIT KNB BET
// ========================================

app.post('/api/matches/:matchId/bet', async (req, res) => {
    const { playerId, amount } = req.body || {};

    if (typeof playerId !== 'string') {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    const stake = Number(amount);

    if (!Number.isSafeInteger(stake) || stake < 50) {
        return res.status(400).json({
            error: 'Минимальная ставка — 50 мяукоинов'
        });
    }

    const client = await pool.connect();

    try {
        const canonicalId = await resolvePlayerId(playerId);

        await client.query('BEGIN');

        // Блокируем матч на время согласования ставок
        const result = await client.query(
            `SELECT id, status, mode, players, stake, pot
             FROM knb_matches
             WHERE id = $1
             FOR UPDATE`,
            [req.params.matchId]
        );

        if (!result.rowCount) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Match not found'
            });
        }

        const match = result.rows[0];

        if (
            match.status !== 'negotiating' ||
            match.mode !== 'betting'
        ) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'Match is not accepting bets'
            });
        }

        const players = match.players;

        const player = players.find(p => p.id === canonicalId);

        if (!player) {
            await client.query('ROLLBACK');

            return res.status(403).json({
                error: 'You are not a participant'
            });
        }

        // Проверяем, что оба игрока купили разблокировку
        const ownership = await client.query(
            `SELECT player_id
             FROM player_purchases
             WHERE item_code = 'knb_betting'
             AND player_id = ANY($1::text[])`,
            [players.map(p => p.id)]
        );

        if (ownership.rowCount !== 2) {
            await client.query('ROLLBACK');

            return res.status(403).json({
                error: 'BETTING_LOCK_REQUIRED'
            });
        }

        // Проверяем баланс игрока, который сейчас предлагает ставку
        const account = await client.query(
            `SELECT balance
             FROM roulette_accounts
             WHERE player_id = $1`,
            [canonicalId]
        );

        if (
            !account.rowCount ||
            Number(account.rows[0].balance) < stake
        ) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'INSUFFICIENT_BALANCE'
            });
        }

        // Сохраняем предложение игрока
        player.bet = stake;

        const other = players.find(p => p.id !== canonicalId);

        const betsMatch = other && other.bet === stake;

        // Если ставки ещё не совпали — сохраняем предложение
        if (!betsMatch) {
            await client.query(
                `UPDATE knb_matches
                 SET players = $1::jsonb,
                     updated_at = NOW()
                 WHERE id = $2`,
                [JSON.stringify(players), match.id]
            );

            await client.query('COMMIT');

            return res.json({
                success: true,
                status: 'negotiating',
                waitingForOpponent: true,
                players: players.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    bet: p.bet ?? null
                }))
            });
        }

        // Обе ставки совпали. Блокируем счета обоих игроков.
        const playerIds = players.map(p => p.id).sort();

        const balances = await client.query(
            `SELECT player_id, balance
             FROM roulette_accounts
             WHERE player_id = ANY($1::text[])
             ORDER BY player_id
             FOR UPDATE`,
            [playerIds]
        );

        if (
            balances.rowCount !== 2 ||
            balances.rows.some(
                row => Number(row.balance) < stake
            )
        ) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'INSUFFICIENT_BALANCE'
            });
        }

        // Резервируем одинаковую сумму у обоих игроков
        for (const p of players) {
            const debit = await client.query(
                `UPDATE roulette_accounts
                 SET balance = balance - $2,
                     updated_at = NOW()
                 WHERE player_id = $1
                 AND balance >= $2`,
                [p.id, stake]
            );

            if (debit.rowCount !== 1) {
                throw new Error('INSUFFICIENT_BALANCE');
            }

            await client.query(
                `INSERT INTO knb_transactions
                    (match_id, player_id, type, amount, details)
                 VALUES ($1, $2, 'stake', $3, $4::jsonb)`,
                [
                    match.id,
                    p.id,
                    stake,
                    JSON.stringify({
                        nickname: p.nickname
                    })
                ]
            );
        }

        const pot = stake * 2;

        // Матч готов к игре
        await client.query(
            `UPDATE knb_matches
             SET players = $1::jsonb,
                 stake = $2,
                 pot = $3,
                 status = 'playing',
                 updated_at = NOW()
             WHERE id = $4`,
            [
                JSON.stringify(players),
                stake,
                pot,
                match.id
            ]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            status: 'playing',
            stake,
            pot,
            players: players.map(p => ({
                id: p.id,
                nickname: p.nickname,
                bet: p.bet
            }))
        });

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});

        console.error('KNB bet submission failed:', error);

        if (error.message === 'INSUFFICIENT_BALANCE') {
            return res.status(409).json({
                error: 'INSUFFICIENT_BALANCE'
            });
        }

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });

    } finally {
        client.release();
    }
});

// CANCEL KNB MATCH
    app.post('/api/matches/:matchId/cancel', async (req, res) => {
    const { matchId } = req.params;
    const { playerId } = req.body || {};

    if (!playerId) {
        return res.status(400).json({
            success: false,
            error: 'PLAYER_ID_REQUIRED'
        });
    }

    let client;

    try {
        client = await pool.connect();

        await client.query('BEGIN');

        const resolvedPlayerId = await resolvePlayerId(playerId, client);

        const result = await client.query(
            `SELECT *
             FROM knb_matches
             WHERE id = $1
             FOR UPDATE`,
            [matchId]
        );

        if (!result.rowCount) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                success: false,
                error: 'MATCH_NOT_FOUND'
            });
        }

        const match = result.rows[0];

        const player = match.players.find(
            p => String(p.id) === String(resolvedPlayerId)
        );

        if (!player) {
            await client.query('ROLLBACK');

            return res.status(403).json({
                success: false,
                error: 'NOT_A_MATCH_PLAYER'
            });
        }

        const activeStatuses = [
            'choosing_mode',
            'negotiating',
            'playing'
        ];

        if (!activeStatuses.includes(match.status)) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                success: false,
                error: 'MATCH_NOT_ACTIVE'
            });
        }

        let refunded = false;

        // Возвращаем ставки, если они уже были списаны
        if (match.status === 'playing' && match.mode === 'betting') {
            const stake = Number(match.stake);

            if (!Number.isSafeInteger(stake) || stake < 50) {
                throw new Error('INVALID_MATCH_STAKE');
            }

            const ledger = await client.query(
                `SELECT player_id, amount
                 FROM knb_transactions
                 WHERE match_id = $1
                   AND type = 'stake'`,
                [matchId]
            );

            if (
                ledger.rowCount !== 2 ||
                ledger.rows.some(row => Number(row.amount) !== stake) ||
                match.players.some(p =>
                    !ledger.rows.some(
                        row => String(row.player_id) === String(p.id)
                    )
                )
            ) {
                throw new Error('INCOMPLETE_STAKE_LEDGER');
            }

            for (const matchPlayer of match.players) {
                const refund = await client.query(
                    `INSERT INTO knb_transactions
                        (match_id, player_id, type, amount, details)
                     VALUES ($1, $2, 'refund', $3, $4::jsonb)
                     ON CONFLICT (match_id, player_id, type)
                     DO NOTHING
                     RETURNING id`,
                    [
                        matchId,
                        matchPlayer.id,
                        stake,
                        JSON.stringify({ reason: 'match_cancelled' })
                    ]
                );

                if (refund.rowCount > 0) {
                    const accountUpdate = await client.query(
                        `UPDATE roulette_accounts
                         SET balance = balance + $2,
                             updated_at = NOW()
                         WHERE player_id = $1`,
                        [matchPlayer.id, stake]
                    );

                    if (accountUpdate.rowCount !== 1) {
                        throw new Error('REFUND_ACCOUNT_NOT_FOUND');
                    }
                }
            }

            refunded = true;
        }

        await client.query(
            `UPDATE knb_matches
             SET status = 'cancelled',
                 finished_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [matchId]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            status: 'cancelled',
            refunded
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('[KNB CANCEL ERROR]', error);

        return res.status(503).json({
            success: false,
            error: error.message || 'CANCEL_FAILED'
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

// ========================================
// SUBMIT MOVE
// ========================================

app.post('/api/matches/:matchId/move', async (req, res) => {
    const { playerId, move } = req.body || {};

    if (!['rock', 'paper', 'scissors'].includes(move)) {
        return res.status(400).json({
            error: 'Invalid move'
        });
    }

    if (typeof playerId !== 'string') {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    const client = await pool.connect();

    try {
        const canonicalId = await resolvePlayerId(playerId);

        await client.query('BEGIN');

        const result = await client.query(
            `SELECT *
             FROM knb_matches
             WHERE id = $1
             FOR UPDATE`,
            [req.params.matchId]
        );

        if (!result.rowCount) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Match not found'
            });
        }

        const match = result.rows[0];

        if (match.status !== 'playing') {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'Match is not playing'
            });
        }

        const players = match.players;

        const player = players.find(p => p.id === canonicalId);

        if (!player) {
            await client.query('ROLLBACK');

            return res.status(403).json({
                error: 'You are not a participant'
            });
        }

        if (player.move !== null) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                error: 'You have already moved'
            });
        }

        player.move = move;

        const bothMoved = players.every(p => p.move !== null);

        let winner = null;
        let status = 'playing';
        let payout = 0;
        let refund = false;

        if (bothMoved) {
            const result = getWinner(
                players[0].move,
                players[1].move
            );

            winner = result === 'draw'
                ? 'draw'
                : players[result === 'first' ? 0 : 1].id;

            status = 'finished';

            // Расчёт для игры на мяукоины
            if (match.mode === 'betting') {
                const stake = Number(match.stake);
                const pot = Number(match.pot);

                if (
                    !Number.isSafeInteger(stake) ||
                    stake < 50 ||
                    !Number.isSafeInteger(pot) ||
                    pot !== stake * 2
                ) {
                    throw new Error('INVALID_BET_DATA');
                }

                 // Проверяем, что обе ставки действительно были списаны
                const ledger = await client.query(
                    `SELECT player_id, amount
                     FROM knb_transactions
                     WHERE match_id = $1
                       AND type = 'stake'`,
                    [match.id]
                );

                if (
                    ledger.rowCount !== 2 ||
                    ledger.rows.some(
                        row => Number(row.amount) !== stake
                    ) ||
                    players.some(player =>
                        !ledger.rows.some(
                            row =>
                                String(row.player_id) === String(player.id)
                        )
                    )
                ) {
                    throw new Error('INCOMPLETE_STAKE_LEDGER');
                }

                const playerIds = players
                    .map(p => p.id)
                    .sort();

                // Блокируем счета обоих игроков
                const accounts = await client.query(
                    `SELECT player_id, balance
                     FROM roulette_accounts
                     WHERE player_id = ANY($1::text[])
                     ORDER BY player_id
                     FOR UPDATE`,
                    [playerIds]
                );

                if (accounts.rowCount !== 2) {
                    throw new Error('PLAYER_ACCOUNT_NOT_FOUND');
                }

                if (winner === 'draw') {
                    // При ничьей возвращаем каждому его ставку
                    for (const p of players) {
                        const update = await client.query(
                            `UPDATE roulette_accounts
                             SET balance = balance + $2,
                                 updated_at = NOW()
                             WHERE player_id = $1`,
                            [p.id, stake]
                        );

                        if (update.rowCount !== 1) {
                            throw new Error('REFUND_FAILED');
                        }

                        await client.query(
                            `INSERT INTO knb_transactions
                                (match_id, player_id, type, amount, details)
                             VALUES ($1, $2, 'refund', $3, $4::jsonb)`,
                            [
                                match.id,
                                p.id,
                                stake,
                                JSON.stringify({
                                    reason: 'draw'
                                })
                            ]
                        );
                    }

                    refund = true;

                } else {
                    // Победитель получает весь банк
                    const update = await client.query(
                        `UPDATE roulette_accounts
                         SET balance = balance + $2,
                             updated_at = NOW()
                         WHERE player_id = $1`,
                        [winner, pot]
                    );

                    if (update.rowCount !== 1) {
                        throw new Error('PAYOUT_FAILED');
                    }

                    await client.query(
                        `INSERT INTO knb_transactions
                            (match_id, player_id, type, amount, details)
                         VALUES ($1, $2, 'payout', $3, $4::jsonb)`,
                        [
                            match.id,
                            winner,
                            pot,
                            JSON.stringify({
                                stake,
                                pot
                            })
                        ]
                    );

                    payout = pot;
                }
            }
        }

        await client.query(
            `UPDATE knb_matches
             SET players = $1::jsonb,
                 status = $2,
                 winner = $3,
                 finished_at = CASE
                     WHEN $2 = 'finished' THEN NOW()
                     ELSE finished_at
                 END,
                 updated_at = NOW()
             WHERE id = $4`,
            [
                JSON.stringify(players),
                status,
                winner,
                match.id
            ]
        );

        await client.query('COMMIT');

        if (bothMoved) {
            console.log(
                `KNB match finished: ${winner}, mode: ${match.mode}`
            );
        }

        return res.json({
            success: true,
            waitingForOpponent: !bothMoved,
            status,
            winner: bothMoved ? winner : null,
            payout,
            refund
        });

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});

        console.error('Move submission failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });

    } finally {
        client.release();
    }
});

// ========================================
// GET MATCH RESULT
// ========================================

app.get('/api/matches/:matchId', async (req, res) => {
    const { playerId } = req.query;

    if (typeof playerId !== 'string') {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    try {
        const canonicalId = await resolvePlayerId(playerId);

        const result = await pool.query(
            `SELECT id, status, mode, players, stake, pot, winner
             FROM knb_matches
             WHERE id = $1`,
            [req.params.matchId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Match not found'
            });
        }

        const match = result.rows[0];

        const currentPlayer = match.players.find(
            player => player.id === canonicalId
        );

        if (!currentPlayer) {
            return res.status(403).json({
                error: 'You are not a participant'
            });
        }

        const bothMoved = match.players.every(
            player => player.move !== null
        );

        return res.json({
            success: true,
            match: {
                id: match.id,
                status: match.status,
                mode: match.mode,
                stake: match.stake,
                pot: match.pot,
                players: match.players.map(player => ({
                    id: player.id,
                    nickname: player.nickname,
                    move: bothMoved ? player.move : null,
                    hasMoved: player.move !== null
                })),
                winner: bothMoved ? match.winner : null
            }
        });

    } catch (error) {
        console.error('Match result lookup failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// КОТО-РУЛЕТКА
// ========================================

// Состояние одиночной шахты и время следующей попытки
app.get('/api/roulette/status/:playerId', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req.params.playerId);

        const result = await pool.query(
            `SELECT a.balance, COALESCE(c.next_at, 0) AS next_at
             FROM roulette_accounts a
             LEFT JOIN roulette_cooldowns c
                 ON c.player_id = a.player_id
             WHERE a.player_id = $1`,
            [playerId]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                error: 'Player not found'
            });
        }

        const balance = Number(result.rows[0].balance);
        const nextAt = Number(result.rows[0].next_at);

        return res.json({
            success: true,
            balance,
            nextAt,
            cooldownMs: Math.max(0, nextAt - Date.now())
        });

    } catch (error) {
        console.error('Roulette status failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

app.post('/api/roulette/solo', async (req, res) => {
    cleanup();

    const { playerId } = req.body || {};

    if (typeof playerId !== 'string') {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    let client;

    try {
        const canonicalId = await resolvePlayerId(playerId);

        if (!players.has(canonicalId)) {
            return res.status(404).json({
                error: 'Player not found or offline'
            });
        }

        client = await pool.connect();
        await client.query('BEGIN');

        // Блокируем счёт игрока, чтобы не запустить два вращения одновременно
        const account = await client.query(
            `SELECT balance
             FROM roulette_accounts
             WHERE player_id = $1
             FOR UPDATE`,
            [canonicalId]
        );

        if (!account.rowCount) {
            throw new Error('PLAYER_NOT_FOUND');
        }

        // Ищем незавершённое вращение
        const pending = await client.query(
            `SELECT *
             FROM roulette_solo_sessions
             WHERE player_id = $1
               AND status = 'pending'
             FOR UPDATE`,
            [canonicalId]
        );

        // Если вращение ещё не истекло — возвращаем его
        if (pending.rowCount) {
            const session = pending.rows[0];
            const expiresAt = new Date(session.expires_at).getTime();

            if (expiresAt > Date.now()) {
                const cooldown = await client.query(
                    `SELECT next_at
                     FROM roulette_cooldowns
                     WHERE player_id = $1`,
                    [canonicalId]
                );

                const nextAt = cooldown.rowCount
                    ? Number(cooldown.rows[0].next_at)
                    : 0;

                await client.query('COMMIT');

                return res.json({
                    success: true,
                    mode: 'solo',
                    pending: true,
                    rerollUsed: Boolean(session.reroll_used),
                    insuranceUsed: Boolean(session.insurance_used),
                    sessionId: session.id,
                    reels: session.reels,
                    score: getRouletteScore(session.reels),
                    multiplier: getRouletteMultiplier(session.reels),
                    jackpot: getRouletteJackpot(session.reels),
                    balance: Number(account.rows[0].balance),
                    nextAt,
                    cooldownMs: Math.max(0, nextAt - Date.now())
                });
            }

            // Истёкшее вращение больше нельзя продолжить
            await client.query(
                `UPDATE roulette_solo_sessions
                 SET status = 'expired'
                 WHERE id = $1`,
                [session.id]
            );
        }

        // Проверяем кулдаун
        const cooldown = await client.query(
            `SELECT next_at
             FROM roulette_cooldowns
             WHERE player_id = $1
             FOR UPDATE`,
            [canonicalId]
        );

        const now = Date.now();
        const nextAt = cooldown.rowCount
            ? Number(cooldown.rows[0].next_at)
            : 0;

        if (now < nextAt) {
            await client.query('ROLLBACK');

            return res.status(429).json({
                error: 'Попытка ещё восстанавливается',
                cooldownMs: nextAt - now,
                nextAt
            });
        }

        // Генерируем предварительный результат
        const reels = spinRoulette();
        const sessionId = crypto.randomUUID();

        // Сохраняем вращение на 30 минут
        const expiresAt = new Date(now + 30 * 60 * 1000);

        await client.query(
            `INSERT INTO roulette_solo_sessions (
                id,
                player_id,
                nickname,
                reels,
                expires_at
            )
            VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [
                sessionId,
                canonicalId,
                players.get(canonicalId).nickname,
                JSON.stringify(reels),
                expiresAt
            ]
        );

        // Запускаем кулдаун уже при начале вращения
        const newNextAt = now + ROULETTE_COOLDOWN;

        await client.query(
            `INSERT INTO roulette_cooldowns (player_id, next_at)
             VALUES ($1, $2)
             ON CONFLICT (player_id)
             DO UPDATE SET next_at = EXCLUDED.next_at`,
            [canonicalId, newNextAt]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            mode: 'solo',
            pending: true,
            sessionId,
            reels,
            score: getRouletteScore(reels),
            multiplier: getRouletteMultiplier(reels),
            jackpot: getRouletteJackpot(reels),
            balance: Number(account.rows[0].balance),
            nextAt: newNextAt,
            cooldownMs: ROULETTE_COOLDOWN
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('Solo roulette failed:', error);

        return res.status(
            error.message === 'PLAYER_NOT_FOUND' ? 404 : 503
        ).json({
            error: error.message === 'PLAYER_NOT_FOUND'
                ? 'Player not found'
                : 'Database temporarily unavailable'
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

// Переброс одного выбранного символа в соло-рулетке
app.post('/api/roulette/solo/reroll', async (req, res) => {
    const { playerId, sessionId, index } = req.body || {};

    if (
        typeof playerId !== 'string' ||
        typeof sessionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index > 2
    ) {
        return res.status(400).json({
            error: 'Invalid reroll data'
        });
    }

    let client;

    try {
        const canonicalId = await resolvePlayerId(playerId);

        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '15s'`);

        // Блокируем аккаунт игрока
        const account = await client.query(
            `SELECT player_id
             FROM roulette_accounts
             WHERE player_id = $1
             FOR UPDATE`,
            [canonicalId]
        );

        if (!account.rowCount) {
            throw new Error('PLAYER_NOT_FOUND');
        }

        // Блокируем незавершённое вращение
        const sessionResult = await client.query(
            `SELECT *
             FROM roulette_solo_sessions
             WHERE id = $1
               AND player_id = $2
             FOR UPDATE`,
            [sessionId, canonicalId]
        );

        if (!sessionResult.rowCount) {
            throw new Error('SESSION_NOT_FOUND');
        }
        
        const session = sessionResult.rows[0];

        // Если вращение уже завершено — возвращаем сохранённый результат
        if (session.status === 'completed') {
            if (session.completion_result) {
                const savedResult = typeof session.completion_result === 'string'
                    ? JSON.parse(session.completion_result)
                    : session.completion_result;
        
                await client.query('COMMIT');
        
                return res.json({
                    ...savedResult,
                    alreadyCompleted: true
                });
            }
        
            throw new Error('SESSION_NOT_PENDING');
        }
        
        if (session.status !== 'pending') {
            throw new Error('SESSION_NOT_PENDING');
        }

        if (new Date(session.expires_at).getTime() <= Date.now()) {
            await client.query(
                `UPDATE roulette_solo_sessions
                 SET status = 'expired'
                 WHERE id = $1`,
                [sessionId]
            );
        
            await client.query('COMMIT');
        
            return res.status(409).json({
                error: 'Время вращения истекло'
            });
        }

        if (session.reroll_used) {
            throw new Error('REROLL_ALREADY_USED');
        }

        // Проверяем, что игрок разблокировал механику переброса
        const unlocked = await client.query(
            `SELECT id
             FROM player_purchases
             WHERE player_id = $1
               AND item_code = 'roulette_unlock_pebble'`,
            [canonicalId]
        );

        if (!unlocked.rowCount) {
            throw new Error('REROLL_NOT_UNLOCKED');
        }

        // Проверяем наличие предмета и его экипировку
        const modifier = await client.query(
            `SELECT
                pi.quantity,
                pe.slot_type,
                pe.slot_number
             FROM player_inventory pi
             JOIN player_equipment pe
                ON pe.player_id = pi.player_id
                AND pe.item_code = pi.item_code
             JOIN inventory_items i
                ON i.code = pi.item_code
             WHERE pi.player_id = $1
               AND pi.item_code = 'roulette_mod_reroll'
               AND pi.quantity > 0
               AND i.is_active = TRUE
               AND pe.slot_type = 'roulette_modifier'
             FOR UPDATE OF pi`,
            [canonicalId]
        );

        if (!modifier.rowCount) {
            throw new Error('REROLL_ITEM_NOT_EQUIPPED');
        }

        const reels = session.reels;

        if (
            !Array.isArray(reels) ||
            reels.length !== 3 ||
            !reels[index]
        ) {
            throw new Error('INVALID_SESSION_REELS');
        }

        // Генерируем новый символ для выбранной позиции
        const previousItem = reels[index];
        const newItem = getRouletteResource();

        reels[index] = newItem;

        // Списываем один экземпляр модификатора
        const quantity = Number(modifier.rows[0].quantity);

        if (quantity === 1) {
            // Удаление предмета автоматически снимет его с экипировки
            await client.query(
                `DELETE FROM player_inventory
                 WHERE player_id = $1
                   AND item_code = 'roulette_mod_reroll'`,
                [canonicalId]
            );
        } else {
            await client.query(
                `UPDATE player_inventory
                 SET quantity = quantity - 1,
                     updated_at = NOW()
                 WHERE player_id = $1
                   AND item_code = 'roulette_mod_reroll'`,
                [canonicalId]
            );
        }

        // Сохраняем обновлённый результат и отмечаем использование
        await client.query(
            `UPDATE roulette_solo_sessions
             SET reels = $2::jsonb,
                 reroll_used = TRUE
             WHERE id = $1`,
            [sessionId, JSON.stringify(reels)]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            sessionId,
            reels,
            replacedIndex: index,
            previousItem,
            newItem,
            score: getRouletteScore(reels),
            multiplier: getRouletteMultiplier(reels),
            jackpot: getRouletteJackpot(reels),
            rerollUsed: true,
            remainingQuantity: quantity - 1
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        const errors = {
            PLAYER_NOT_FOUND: [404, 'Player not found'],
            SESSION_NOT_FOUND: [404, 'Вращение не найдено'],
            SESSION_NOT_PENDING: [409, 'Вращение уже завершено'],
            SESSION_EXPIRED: [409, 'Время вращения истекло'],
            REROLL_ALREADY_USED: [409, 'Переброс уже использован'],
            REROLL_NOT_UNLOCKED: [403, 'Механика переброса не разблокирована'],
            REROLL_ITEM_NOT_EQUIPPED: [403, 'Экипируйте модификатор «Переброс»'],
            INVALID_SESSION_REELS: [409, 'Некорректный результат вращения']
        };

        const [status, message] = errors[error.message] || [
            503,
            'Database temporarily unavailable'
        ];

        console.error('Solo roulette reroll failed:', error);

        return res.status(status).json({
            error: message
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

// Страховка: сохранить один символ и перебросить два остальных
app.post('/api/roulette/solo/insurance', async (req, res) => {
    const { playerId, sessionId, keepIndex } = req.body || {};

    if (
        typeof playerId !== 'string' ||
        typeof sessionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId) ||
        !Number.isInteger(keepIndex) ||
        keepIndex < 0 ||
        keepIndex > 2
    ) {
        return res.status(400).json({
            error: 'Invalid insurance data'
        });
    }

    let client;

    try {
        const canonicalId = await resolvePlayerId(playerId);

        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '15s'`);

        // Блокируем аккаунт игрока
        const account = await client.query(
            `SELECT player_id
             FROM roulette_accounts
             WHERE player_id = $1
             FOR UPDATE`,
            [canonicalId]
        );

        if (!account.rowCount) {
            throw new Error('PLAYER_NOT_FOUND');
        }

        // Блокируем незавершённое вращение
        const sessionResult = await client.query(
            `SELECT *
             FROM roulette_solo_sessions
             WHERE id = $1
               AND player_id = $2
             FOR UPDATE`,
            [sessionId, canonicalId]
        );

        if (!sessionResult.rowCount) {
            throw new Error('SESSION_NOT_FOUND');
        }

        const session = sessionResult.rows[0];

        // Уже завершённое вращение нельзя изменить
        if (session.status === 'completed') {
            if (session.completion_result) {
                const savedResult =
                    typeof session.completion_result === 'string'
                        ? JSON.parse(session.completion_result)
                        : session.completion_result;

                await client.query('COMMIT');

                return res.json({
                    ...savedResult,
                    alreadyCompleted: true
                });
            }

            throw new Error('SESSION_NOT_PENDING');
        }

        if (session.status !== 'pending') {
            throw new Error('SESSION_NOT_PENDING');
        }

        if (new Date(session.expires_at).getTime() <= Date.now()) {
            await client.query(
                `UPDATE roulette_solo_sessions
                 SET status = 'expired'
                 WHERE id = $1`,
                [sessionId]
            );

            await client.query('COMMIT');

            return res.status(409).json({
                error: 'Время вращения истекло'
            });
        }

        // Проверяем, использовалась ли уже Страховка
        if (session.insurance_used) {
            throw new Error('INSURANCE_ALREADY_USED');
        }

        // Проверяем разблокировку механики
        const unlocked = await client.query(
            `SELECT id
             FROM player_purchases
             WHERE player_id = $1
               AND item_code = 'roulette_unlock_limestone'`,
            [canonicalId]
        );

        if (!unlocked.rowCount) {
            throw new Error('INSURANCE_NOT_UNLOCKED');
        }

        // Проверяем наличие и экипировку Страховки
        const modifier = await client.query(
            `SELECT pi.quantity
             FROM player_inventory pi
             JOIN player_equipment pe
                ON pe.player_id = pi.player_id
                AND pe.item_code = pi.item_code
             JOIN inventory_items i
                ON i.code = pi.item_code
             WHERE pi.player_id = $1
               AND pi.item_code = 'roulette_mod_pair_save'
               AND pi.quantity > 0
               AND i.is_active = TRUE
               AND pe.slot_type = 'roulette_modifier'
             FOR UPDATE OF pi`,
            [canonicalId]
        );

        if (!modifier.rowCount) {
            throw new Error('INSURANCE_ITEM_NOT_EQUIPPED');
        }

        const reels = session.reels;

        if (
            !Array.isArray(reels) ||
            reels.length !== 3 ||
            !reels[keepIndex]
        ) {
            throw new Error('INVALID_SESSION_REELS');
        }

        // Сохраняем выбранный символ, два других перебрасываем
        const keptItem = reels[keepIndex];
        const replacedItems = [];

        for (let index = 0; index < 3; index++) {
            if (index === keepIndex) continue;

            const previousItem = reels[index];
            const newItem = getRouletteResource();

            reels[index] = newItem;

            replacedItems.push({
                index,
                previousItem,
                newItem
            });
        }

        // Списываем одну Страховку
        const quantity = Number(modifier.rows[0].quantity);

        if (quantity === 1) {
            await client.query(
                `DELETE FROM player_inventory
                 WHERE player_id = $1
                   AND item_code = 'roulette_mod_pair_save'`,
                [canonicalId]
            );
        } else {
            await client.query(
                `UPDATE player_inventory
                 SET quantity = quantity - 1,
                     updated_at = NOW()
                 WHERE player_id = $1
                   AND item_code = 'roulette_mod_pair_save'`,
                [canonicalId]
            );
        }

        // Сохраняем результат и отмечаем использование Страховки
        await client.query(
            `UPDATE roulette_solo_sessions
             SET reels = $2::jsonb,
                 insurance_used = TRUE
             WHERE id = $1`,
            [sessionId, JSON.stringify(reels)]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            sessionId,
            reels,
            keptIndex: keepIndex,
            keptItem,
            replacedItems,
            score: getRouletteScore(reels),
            multiplier: getRouletteMultiplier(reels),
            jackpot: getRouletteJackpot(reels),
            insuranceUsed: true,
            remainingQuantity: quantity - 1
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        const errors = {
            PLAYER_NOT_FOUND: [404, 'Player not found'],
            SESSION_NOT_FOUND: [404, 'Вращение не найдено'],
            SESSION_NOT_PENDING: [409, 'Вращение уже завершено'],
            INSURANCE_ALREADY_USED: [409, 'Страховка уже использована'],
            INSURANCE_NOT_UNLOCKED: [403, 'Механика Страховки не разблокирована'],
            INSURANCE_ITEM_NOT_EQUIPPED: [403, 'Экипируйте модификатор «Страховка»'],
            INVALID_SESSION_REELS: [409, 'Некорректный результат вращения']
        };

        const [status, message] = errors[error.message] || [
            503,
            'Database temporarily unavailable'
        ];

        console.error('Solo roulette insurance failed:', error);

        return res.status(status).json({
            error: message
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

// Завершение соло-вращения и начисление награды
app.post('/api/roulette/solo/complete', async (req, res) => {
    const { playerId, sessionId } = req.body || {};

    if (
        typeof playerId !== 'string' ||
        typeof sessionId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
    ) {
        return res.status(400).json({
            error: 'Invalid completion data'
        });
    }

    let client;

    try {
        const canonicalId = await resolvePlayerId(playerId);

        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query(`SET LOCAL statement_timeout = '15s'`);

        // Блокируем счёт игрока
        const account = await client.query(
            `SELECT balance
             FROM roulette_accounts
             WHERE player_id = $1
             FOR UPDATE`,
            [canonicalId]
        );

        if (!account.rowCount) {
            throw new Error('PLAYER_NOT_FOUND');
        }

        // Блокируем сессию, чтобы исключить повторное начисление
        const sessionResult = await client.query(
            `SELECT *
             FROM roulette_solo_sessions
             WHERE id = $1
               AND player_id = $2
             FOR UPDATE`,
            [sessionId, canonicalId]
        );

        if (!sessionResult.rowCount) {
            throw new Error('SESSION_NOT_FOUND');
        }
        
        const session = sessionResult.rows[0];

        // Если вращение уже завершено — возвращаем сохранённый результат
        if (session.status === 'completed') {
            if (session.completion_result) {
                const savedResult = typeof session.completion_result === 'string'
                    ? JSON.parse(session.completion_result)
                    : session.completion_result;
        
                await client.query('COMMIT');
        
                return res.json({
                    ...savedResult,
                    alreadyCompleted: true
                });
            }
        
            throw new Error('SESSION_NOT_PENDING');
        }
        
        if (session.status !== 'pending') {
            throw new Error('SESSION_NOT_PENDING');
        }

        if (new Date(session.expires_at).getTime() <= Date.now()) {
            await client.query(
                `UPDATE roulette_solo_sessions
                 SET status = 'expired'
                 WHERE id = $1`,
                [sessionId]
            );

            await client.query('COMMIT');

            return res.status(409).json({
                error: 'Время вращения истекло'
            });
        }

        const reels = session.reels;

        if (!Array.isArray(reels) || reels.length !== 3) {
            throw new Error('INVALID_SESSION_REELS');
        }

        // Рассчитываем окончательный результат
        const score = getRouletteScore(reels);
        const multiplier = getRouletteMultiplier(reels);
        const jackpot = getRouletteJackpot(reels);

        // Проверяем джекпот и выдаём модификатор
        const modifierDrop = await grantRouletteJackpotModifier(
            client,
            canonicalId,
            reels
        );

        // Начисляем очки
        const newBalance = Number(account.rows[0].balance) + score;

        await client.query(
            `UPDATE roulette_accounts
             SET balance = $2,
                 updated_at = NOW()
             WHERE player_id = $1`,
            [canonicalId, newBalance]
        );

        // Записываем финансовую операцию
        await client.query(
            `INSERT INTO roulette_transactions
                (player_id, type, amount, details)
             VALUES ($1, 'solo_reward', $2, $3::jsonb)`,
            [
                canonicalId,
                score,
                JSON.stringify({
                    sessionId,
                    reels,
                    multiplier,
                    modifierDrop
                })
            ]
        );

        // Записываем результат в историю вращений
        await client.query(
            `INSERT INTO roulette_spins
                (player_id, nickname, mode, score, jackpot, reels)
             VALUES ($1, $2, 'solo', $3, $4, $5::jsonb)`,
            [
                canonicalId,
                session.nickname,
                score,
                jackpot,
                JSON.stringify(reels)
            ]
        );

        // Закрываем сессию
        // Формируем результат вращения
        const completionResult = {
            success: true,
            mode: 'solo',
            sessionId,
            reels,
            score,
            multiplier,
            jackpot,
            modifierDrop,
            balance: newBalance
        };
        
        // Закрываем сессию и сохраняем результат
        await client.query(
            `UPDATE roulette_solo_sessions
             SET status = 'completed',
                 completed_at = NOW(),
                 completion_result = $2::jsonb
             WHERE id = $1`,
            [sessionId, JSON.stringify(completionResult)]
        );
        
        await client.query('COMMIT');

        if (modifierDrop?.granted) {
            notifyInventoryUpdated(
                canonicalId,
                modifierDrop.code,
                1
            );
        }
        
        return res.json(completionResult);

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        const errors = {
            PLAYER_NOT_FOUND: [404, 'Player not found'],
            SESSION_NOT_FOUND: [404, 'Вращение не найдено'],
            SESSION_NOT_PENDING: [409, 'Вращение уже завершено'],
            INVALID_SESSION_REELS: [409, 'Некорректный результат вращения']
        };

        const [status, message] = errors[error.message] || [
            503,
            'Database temporarily unavailable'
        ];

        console.error('Solo roulette completion failed:', error);

        return res.status(status).json({
            error: message
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

app.get('/api/roulette/balance/:playerId', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req.params.playerId);

        const result = await pool.query(
            'SELECT balance FROM roulette_accounts WHERE player_id = $1',
            [playerId]
        );

        if (!result.rowCount) {
            return res.status(404).json({
                error: 'Player not found'
            });
        }

        return res.json({
            success: true,
            balance: Number(result.rows[0].balance)
        });

    } catch (error) {
        console.error('Balance read failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// ========================================
// ТАБЛИЦА ЛИДЕРОВ КОТО-РУЛЕТКИ
// ========================================

app.get('/api/roulette/leaderboard/:playerId', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req.params.playerId);

        // Баланс, заработанные очки и статистика джекпотов
        const leaderboardResult = await pool.query(`
            SELECT
            a.player_id,
            a.nickname,
            a.balance,
            COALESCE(t.total_earned, 0) AS total_earned,
            COALESCE(s.jackpots, 0) AS jackpots,
            COALESCE(s.personal_max_jackpot, 0) AS personal_max_jackpot,
            COALESCE(s.total_spins, 0) AS total_spins
        
            FROM roulette_accounts a
            
            LEFT JOIN (
                SELECT
                    tr.player_id,
                    SUM(
                        CASE
                            WHEN tr.type = 'solo_reward'
                                THEN tr.amount
            
                            WHEN tr.type = 'match_payout'
                                THEN GREATEST(
                                    tr.amount - COALESCE(m.stake, 0),
                                    0
                                )
            
                            ELSE 0
                        END
                    ) AS total_earned
            
                FROM roulette_transactions tr
            
                LEFT JOIN roulette_matches m
                    ON m.id = tr.match_id
            
                GROUP BY tr.player_id
            ) t ON t.player_id = a.player_id
            
            LEFT JOIN (
                SELECT
                    player_id,
                    COUNT(*) FILTER (
                        WHERE jackpot = TRUE
                    ) AS jackpots,
            
                    COALESCE(
                        MAX(score) FILTER (
                            WHERE jackpot = TRUE
                        ),
                        0
                    ) AS personal_max_jackpot,
            
                    COUNT(*) AS total_spins

                FROM roulette_spins
                GROUP BY player_id
            ) s ON s.player_id = a.player_id
            
            -- Для leaderboardResult:
            ORDER BY a.balance DESC, a.nickname ASC
            LIMIT 10
        `);

        // Личная статистика текущего игрока
        const personalResult = await pool.query(`
            SELECT
            a.player_id,
            a.nickname,
            a.balance,
            COALESCE(t.total_earned, 0) AS total_earned,
            COALESCE(s.jackpots, 0) AS jackpots,
            COALESCE(s.personal_max_jackpot, 0) AS personal_max_jackpot,
            COALESCE(s.total_spins, 0) AS total_spins
        
            FROM roulette_accounts a
            
            LEFT JOIN (
                SELECT
                    tr.player_id,
                    SUM(
                        CASE
                            WHEN tr.type = 'solo_reward'
                                THEN tr.amount
            
                            WHEN tr.type = 'match_payout'
                                THEN GREATEST(
                                    tr.amount - COALESCE(m.stake, 0),
                                    0
                                )
            
                            ELSE 0
                        END
                    ) AS total_earned
            
                FROM roulette_transactions tr
            
                LEFT JOIN roulette_matches m
                    ON m.id = tr.match_id
            
                GROUP BY tr.player_id
            ) t ON t.player_id = a.player_id
            
            LEFT JOIN (
                SELECT
                    player_id,
                    COUNT(*) FILTER (
                        WHERE jackpot = TRUE
                    ) AS jackpots,
            
                    COALESCE(
                        MAX(score) FILTER (
                            WHERE jackpot = TRUE
                        ),
                        0
                    ) AS personal_max_jackpot,
            
                    COUNT(*) AS total_spins

                FROM roulette_spins
                GROUP BY player_id
            ) s ON s.player_id = a.player_id
            
            -- Для leaderboardResult:
            WHERE a.player_id = $1
        `, [playerId]);

        if (!personalResult.rowCount) {
            return res.status(404).json({
                error: 'Player not found'
            });
        }

        // Максимальный джекпот за всю историю
        const jackpotResult = await pool.query(`
            SELECT
                s.player_id,
                a.nickname,
                s.score,
                s.reels,
                s.created_at

            FROM roulette_spins s

            JOIN roulette_accounts a
                ON a.player_id = s.player_id

            WHERE s.jackpot = TRUE
              AND s.score = (
                  SELECT MAX(score)
                  FROM roulette_spins
                  WHERE jackpot = TRUE
              )

            ORDER BY s.created_at ASC
        `);

        // Топ-3 самых удачливых котика
        const luckiestResult = await pool.query(`
            SELECT
                a.player_id,
                a.nickname,
                COUNT(s.id) AS jackpots
        
            FROM roulette_accounts a
        
            JOIN roulette_spins s
                ON s.player_id = a.player_id
        
            WHERE s.jackpot = TRUE
        
            GROUP BY a.player_id, a.nickname
        
            ORDER BY COUNT(s.id) DESC, a.nickname ASC
        
            LIMIT 3
        `);

        const convertNumbers = rows => rows.map(row => ({
            ...row,
            balance: Number(row.balance),
            total_earned: Number(row.total_earned),
            jackpots: Number(row.jackpots),
            personal_max_jackpot: Number(row.personal_max_jackpot),
            total_spins: Number(row.total_spins)
        }));

        res.json({
            success: true,

            leaderboard: convertNumbers(leaderboardResult.rows),

            personal: convertNumbers(personalResult.rows)[0],

            maxJackpot: jackpotResult.rowCount
                ? {
                    score: Number(jackpotResult.rows[0].score),
                    players: jackpotResult.rows.map(row => ({
                        playerId: row.player_id,
                        nickname: row.nickname,
                        reels: row.reels,
                        createdAt: row.created_at
                    }))
                }
                : null,

            luckiest: luckiestResult.rows.map(row => ({
                playerId: row.player_id,
                nickname: row.nickname,
                jackpots: Number(row.jackpots)
            }))
        });

    } catch (error) {
        console.error('Leaderboard request failed:', error);

        res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// Истёкшие матчи закрываются в БД, а зарезервированные ставки возвращаются.
// Блокировка строки матча сериализует возврат с одновременным броском.
async function expireRouletteMatches() {
    const expired = await pool.query(
        `SELECT id FROM roulette_matches WHERE status IN ('negotiating', 'playing')
         AND created_at < $1 ORDER BY created_at LIMIT 30`,
        [Date.now() - ROULETTE_MATCH_TIMEOUT]
    );
    for (const item of expired.rows) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const found = await client.query('SELECT * FROM roulette_matches WHERE id=$1 FOR UPDATE', [item.id]);
            if (!found.rowCount) { await client.query('ROLLBACK'); continue; }
            const match = found.rows[0];
            if (!['negotiating', 'playing'].includes(match.status) ||
                Number(match.created_at) >= Date.now() - ROULETTE_MATCH_TIMEOUT) {
                await client.query('ROLLBACK'); continue;
            }
            if (match.status === 'playing') {
                for (const player of match.players) {
                    const amount = Number(match.stake);
                    if (!Number.isSafeInteger(amount) || amount < 50) throw new Error('INVALID_RESERVED_STAKE');
                    const logged = await client.query(
                        `INSERT INTO roulette_transactions(player_id,match_id,type,amount)
                         VALUES ($1,$2,'stake_refund',$3) ON CONFLICT DO NOTHING RETURNING id`,
                        [player.id, match.id, amount]
                    );
                    if (logged.rowCount) {
                        await client.query('UPDATE roulette_accounts SET balance=balance+$2,updated_at=NOW() WHERE player_id=$1', [player.id, amount]);
                    }
                }
            }
            await client.query("UPDATE roulette_matches SET status='expired',finished_at=NOW(),updated_at=NOW() WHERE id=$1", [match.id]);
            await client.query('COMMIT');
        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            console.error('Roulette expiration failed:', item.id, error);
            throw error;
        } finally { if (client) client.release(); }
    }
}

// Периодическая очистка также работает после перезапуска Render.
let rouletteCleanupPromise = null;
let rouletteLastCleanup = 0;
async function ensureRouletteCleanup() {
    if (!rouletteCleanupPromise && Date.now() - rouletteLastCleanup > 5000) {
        rouletteCleanupPromise = expireRouletteMatches().then(() => {
            rouletteLastCleanup = Date.now();
        }).finally(() => { rouletteCleanupPromise = null; });
    }
    if (rouletteCleanupPromise) await rouletteCleanupPromise;
}
app.use('/api/roulette', async (req, res, next) => {
    try { await ensureRouletteCleanup(); next(); }
    catch (error) { res.status(503).json({ error: 'Database temporarily unavailable' }); }
});

// Создать приглашение в совместную шахту
app.post('/api/roulette/invites', async (req, res) => {
    cleanup();

    const { fromId, toId } = req.body || {};

    if (
        typeof fromId !== 'string' ||
        typeof toId !== 'string'
    ) {
        return res.status(400).json({
            error: 'Invalid invitation'
        });
    }

    try {
        const canonicalFromId = await resolvePlayerId(fromId);
        const canonicalToId = await resolvePlayerId(toId);

        if (canonicalFromId === canonicalToId) {
            return res.status(400).json({
                error: 'Invalid invitation'
            });
        }

        const sender = players.get(canonicalFromId);
        const recipient = players.get(canonicalToId);

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

        const active = await pool.query(
            `SELECT id
             FROM roulette_matches
             WHERE status IN ('negotiating', 'playing')
               AND (
                   players @> $1::jsonb
                   OR players @> $2::jsonb
               )
             LIMIT 1`,
            [
                JSON.stringify([{ id: canonicalFromId }]),
                JSON.stringify([{ id: canonicalToId }])
            ]
        );

        if (active.rowCount) {
            return res.status(409).json({
                error: 'A player is already in a roulette round'
            });
        }

        const alreadyInvited = Array.from(
            rouletteInvitations.values()
        ).some(invite =>
            invite.fromId === canonicalFromId &&
            invite.toId === canonicalToId
        );

        if (alreadyInvited) {
            return res.status(409).json({
                error: 'Invitation already sent'
            });
        }

        const invite = {
            id: crypto.randomUUID(),
            fromId: canonicalFromId,
            fromNickname: sender.nickname,
            toId: canonicalToId,
            toNickname: recipient.nickname,
            expiresAt: Date.now() + ROULETTE_INVITE_TIMEOUT
        };

        rouletteInvitations.set(invite.id, invite);

        return res.json({
            success: true,
            invitationId: invite.id
        });

    } catch (error) {
        console.error('Create roulette invitation failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// Получить входящие приглашения в рулетку
app.get('/api/roulette/invites/:playerId', async (req, res) => {
    cleanup();

    try {
        const playerId = await resolvePlayerId(req.params.playerId);

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

        return res.json({
            success: true,
            invitations: incoming
        });

    } catch (error) {
        console.error('Roulette invitation retrieval failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// Принять или отклонить приглашение
app.post('/api/roulette/invites/:inviteId/respond', async (req, res) => {
    cleanup();

    const { playerId, accept } = req.body || {};
    const invite = rouletteInvitations.get(req.params.inviteId);

    if (!invite) {
        return res.status(404).json({
            error: 'Invitation expired or not found'
        });
    }

    if (typeof playerId !== 'string') {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    if (typeof accept !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid response'
        });
    }

    let client;

    try {
        const canonicalId = await resolvePlayerId(playerId);

        if (invite.toId !== canonicalId) {
            return res.status(403).json({
                error: 'This invitation belongs to another player'
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

        const matchId = crypto.randomUUID();
        const createdAt = Date.now();

        const matchPlayers = [
            {
                id: first.id,
                nickname: first.nickname,
                offer: null,
                reels: null,
                score: null
            },
            {
                id: second.id,
                nickname: second.nickname,
                offer: null,
                reels: null,
                score: null
            }
        ];

        client = await pool.connect();
        await client.query('BEGIN');

        await lockRoulettePlayers(client, [first.id, second.id]);

        const active = await client.query(
            `SELECT id
             FROM roulette_matches
             WHERE status IN ('negotiating', 'playing')
               AND (
                   players @> $1::jsonb
                   OR players @> $2::jsonb
               )
             LIMIT 1 FOR UPDATE`,
            [
                JSON.stringify([{ id: first.id }]),
                JSON.stringify([{ id: second.id }])
            ]
        );

        if (active.rowCount) {
            throw new Error('PLAYER_ALREADY_IN_MATCH');
        }

        await client.query(
            `INSERT INTO roulette_matches
                (id, status, players, created_at)
             VALUES ($1, 'negotiating', $2::jsonb, $3)`,
            [matchId, JSON.stringify(matchPlayers), createdAt]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            status: 'accepted',
            matchId
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        if (error.message === 'PLAYER_ALREADY_IN_MATCH') {
            return res.status(409).json({
                error: 'A player is already in a roulette round'
            });
        }

        console.error('Create roulette match failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

// Игрок изменяет только собственное предложение. Списание происходит лишь при совпадении ставок.
app.post('/api/roulette/matches/:matchId/offer', async (req, res) => {
    const { playerId, amount } = req.body || {};

    if (typeof playerId !== 'string' || !playerId.trim()) {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    const stake = Number(amount);

    if (!Number.isSafeInteger(stake) || stake < 50) {
        return res.status(400).json({
            error: 'Минимальная ставка — 50 очков'
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const canonicalId = await resolvePlayerId(playerId, client);

        const row = await client.query(
            'SELECT * FROM roulette_matches WHERE id = $1 FOR UPDATE',
            [req.params.matchId]
        );

        if (!row.rowCount) {
            throw new Error('MATCH_NOT_FOUND');
        }

        const match = row.rows[0];

        if (match.status !== 'negotiating') {
            throw new Error('MATCH_NOT_NEGOTIATING');
        }

        const playersData = match.players;
        const me = playersData.find(p => p.id === canonicalId);

        if (!me) {
            throw new Error('NOT_PARTICIPANT');
        }

        const account = await client.query(
            'SELECT balance FROM roulette_accounts WHERE player_id = $1 FOR UPDATE',
            [canonicalId]
        );

        if (
            !account.rowCount ||
            Number(account.rows[0].balance) < stake
        ) {
            throw new Error('INSUFFICIENT_BALANCE');
        }

        me.offer = stake;

        const other = playersData.find(p => p.id !== canonicalId);

        let status = 'negotiating';
        let totalPot = null;

        if (other && other.offer === stake) {
            const ids = playersData.map(p => p.id).sort();

            const balances = await client.query(
                `SELECT player_id, balance
                 FROM roulette_accounts
                 WHERE player_id = ANY($1::text[])
                 ORDER BY player_id
                 FOR UPDATE`,
                [ids]
            );

            if (
                balances.rowCount !== 2 ||
                balances.rows.some(r => Number(r.balance) < stake)
            ) {
                throw new Error('INSUFFICIENT_BALANCE');
            }

            for (const p of playersData) {
                const debit = await client.query(
                    `UPDATE roulette_accounts
                     SET balance = balance - $2,
                         updated_at = NOW()
                     WHERE player_id = $1
                       AND balance >= $2`,
                    [p.id, stake]
                );

                if (debit.rowCount !== 1) {
                    throw new Error('INSUFFICIENT_BALANCE');
                }

                await client.query(
                    `INSERT INTO roulette_transactions
                        (player_id, match_id, type, amount)
                     VALUES ($1, $2, 'stake_reserved', $3)`,
                    [p.id, req.params.matchId, -stake]
                );
            }

            match.status = 'playing';
            match.stake = stake;
            match.pot = stake * 2;
            match.round = 1;

            status = 'playing';
            totalPot = match.pot;
        }

        await client.query(
            `UPDATE roulette_matches
             SET status = $2,
                 players = $3::jsonb,
                 stake = $4,
                 pot = $5,
                 round_number = $6,
                 updated_at = NOW()
             WHERE id = $1`,
            [
                req.params.matchId,
                match.status || status,
                JSON.stringify(playersData),
                match.stake,
                match.pot,
                match.round || 0
            ]
        );

        await client.query('COMMIT');

        return res.json({
            success: true,
            status,
            players: playersData,
            stake: match.stake,
            pot: totalPot,
            balance: Number(account.rows[0].balance) -
                (status === 'playing' ? stake : 0)
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        const map = {
            MATCH_NOT_FOUND: [404, 'Match not found'],
            MATCH_NOT_NEGOTIATING: [409, 'Переговоры уже завершены'],
            NOT_PARTICIPANT: [403, 'You are not a participant'],
            INSUFFICIENT_BALANCE: [409, 'Недостаточно очков для этой ставки']
        };

        const [code, message] = map[error.message] || [
            503,
            'Database temporarily unavailable'
        ];

        console.error('Roulette offer failed:', error);

        return res.status(code).json({
            error: message
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

app.post('/api/roulette/matches/:matchId/decline', async (req, res) => {
    const { playerId } = req.body || {};

    if (typeof playerId !== 'string' || !playerId.trim()) {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    try {
        const canonicalId = await resolvePlayerId(playerId);

        const result = await pool.query(
            `UPDATE roulette_matches
             SET status = 'cancelled',
                 finished_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1
               AND status = 'negotiating'
               AND EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(players) AS participant
                   WHERE participant->>'id' = $2
               )
             RETURNING id`,
            [req.params.matchId, canonicalId]
        );

        if (!result.rowCount) {
            return res.status(409).json({
                error: 'Не удалось отменить переговоры'
            });
        }

        return res.json({
            success: true,
            status: 'cancelled'
        });

    } catch (error) {
        console.error('Decline roulette match failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

// Получить активную совместную игру
app.get('/api/roulette/matches/player/:playerId', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req.params.playerId);

        const result = await pool.query(
            `SELECT *
             FROM roulette_matches
             WHERE players @> $1::jsonb
               AND status IN (
                   'negotiating',
                   'playing',
                   'finished',
                   'cancelled',
                   'expired'
               )
             ORDER BY created_at DESC
             LIMIT 1`,
            [JSON.stringify([{ id: playerId }])]
        );

        if (!result.rowCount) {
            return res.json({
                success: true,
                match: null
            });
        }

        const row = result.rows[0];

        return res.json({
            success: true,
            match: {
                id: row.id,
                status: row.status,
                stake: row.stake,
                pot: row.pot,
                round: row.round_number,
                winner: row.winner,
                lastRound: row.last_round,
                players: row.players.map(p => ({
                    ...p,
                    hasSpun: !!p.reels
                }))
            }
        });

    } catch (error) {
        console.error('Match read failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});

app.post('/api/roulette/matches/:matchId/spin', async (req, res) => {
    const { playerId } = req.body || {};

    if (typeof playerId !== 'string' || !playerId.trim()) {
        return res.status(400).json({
            error: 'Invalid playerId'
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const canonicalId = await resolvePlayerId(playerId, client);

        const row = await client.query(
            'SELECT * FROM roulette_matches WHERE id = $1 FOR UPDATE',
            [req.params.matchId]
        );

        if (!row.rowCount) {
            throw new Error('MATCH_NOT_FOUND');
        }

        const match = row.rows[0];

        if (match.status !== 'playing') {
            throw new Error('MATCH_NOT_PLAYING');
        }

        const playersData = match.players;
        const player = playersData.find(p => p.id === canonicalId);

        if (!player) {
            throw new Error('NOT_PARTICIPANT');
        }

        if (player.reels) {
            throw new Error('ALREADY_SPUN');
        }

        player.reels = spinRoulette();
        player.score = getRouletteScore(player.reels);

        await client.query(
            `INSERT INTO roulette_spins
                (player_id, nickname, mode, match_id, round_number, score, jackpot, reels)
             VALUES ($1, $2, 'coop', $3, $4, $5, $6, $7::jsonb)`,
            [
                player.id,
                player.nickname,
                req.params.matchId,
                match.round_number,
                player.score,
                getRouletteJackpot(player.reels),
                JSON.stringify(player.reels)
            ]
        );

        const bothSpun = playersData.every(p => p.reels);
        let winner = null;
        let lastRound = match.last_round;
        let nextRound = false;

        if (bothSpun) {
            const [a, b] = playersData;

            winner = a.score === b.score
                ? 'draw'
                : (a.score > b.score ? a.id : b.id);

            lastRound = {
                round: match.round_number,
                players: playersData.map(p => ({
                    id: p.id,
                    nickname: p.nickname,
                    reels: p.reels,
                    score: p.score
                })),
                winner
            };

            if (winner === 'draw') {
                nextRound = true;

                for (const p of playersData) {
                    p.reels = null;
                    p.score = null;
                }

                await client.query(
                    `UPDATE roulette_matches
                     SET players = $2::jsonb,
                         last_round = $3::jsonb,
                         round_number = round_number + 1,
                         updated_at = NOW()
                     WHERE id = $1`,
                    [
                        req.params.matchId,
                        JSON.stringify(playersData),
                        JSON.stringify(lastRound)
                    ]
                );

            } else {
                const payout = Number(match.pot);

                const winnerAccount = await client.query(
                    'SELECT balance FROM roulette_accounts WHERE player_id = $1 FOR UPDATE',
                    [winner]
                );

                if (!winnerAccount.rowCount) {
                    throw new Error('WINNER_ACCOUNT_MISSING');
                }

                const payoutLog = await client.query(
                    `INSERT INTO roulette_transactions
                        (player_id, match_id, type, amount)
                     VALUES ($1, $2, 'match_payout', $3)
                     ON CONFLICT DO NOTHING
                     RETURNING id`,
                    [winner, req.params.matchId, payout]
                );

                if (payoutLog.rowCount !== 1) {
                    throw new Error('PAYOUT_ALREADY_RECORDED');
                }

                await client.query(
                    `UPDATE roulette_accounts
                     SET balance = balance + $2,
                         updated_at = NOW()
                     WHERE player_id = $1`,
                    [winner, payout]
                );

                await client.query(
                    `UPDATE roulette_matches
                     SET status = 'finished',
                         players = $2::jsonb,
                         winner = $3,
                         last_round = $4::jsonb,
                         finished_at = NOW(),
                         updated_at = NOW()
                     WHERE id = $1`,
                    [
                        req.params.matchId,
                        JSON.stringify(playersData),
                        winner,
                        JSON.stringify(lastRound)
                    ]
                );
            }

        } else {
            await client.query(
                `UPDATE roulette_matches
                 SET players = $2::jsonb,
                     updated_at = NOW()
                 WHERE id = $1`,
                [req.params.matchId, JSON.stringify(playersData)]
            );
        }

        await client.query('COMMIT');

        const playedReels =
            player.reels ||
            lastRound?.players?.find(p => p.id === canonicalId)?.reels ||
            [];

        const playedScore =
            player.score ??
            lastRound?.players?.find(p => p.id === canonicalId)?.score;

        return res.json({
            success: true,
            reels: playedReels,
            score: playedScore,
            multiplier: getRouletteMultiplier(playedReels),
            jackpot: getRouletteJackpot(playedReels),
            waitingForOpponent: !bothSpun,
            status: nextRound
                ? 'draw'
                : (bothSpun ? 'finished' : 'playing'),
            round: Number(match.round_number) + (nextRound ? 1 : 0),
            lastRound
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        const map = {
            MATCH_NOT_FOUND: [404, 'Match not found'],
            MATCH_NOT_PLAYING: [409, 'Матч сейчас не принимает броски'],
            NOT_PARTICIPANT: [403, 'You are not a participant'],
            ALREADY_SPUN: [409, 'Вы уже сделали бросок'],
            WINNER_ACCOUNT_MISSING: [503, 'Winner account missing'],
            PAYOUT_ALREADY_RECORDED: [409, 'Payout already recorded']
        };

        const [code, message] = map[error.message] || [
            503,
            'Database temporarily unavailable'
        ];

        console.error('Roulette spin failed:', error);

        return res.status(code).json({
            error: message
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

 // ========================================
 // INVENTORY API
 // ========================================

 // Получить общий каталог предметов и типы слотов
 app.get('/api/inventory/catalog', async (req, res) => {
     try {
         const items = await pool.query(
             `SELECT
                 code,
                 name,
                 description,
                 category,
                 rarity,
                 icon,
                 is_stackable,
                 max_stack,
                 metadata
              FROM inventory_items
              WHERE is_active = TRUE
              ORDER BY category, sort_order, name`
         );

         const slotTypes = await pool.query(
             `SELECT
                 slot_type,
                 name,
                 accepted_categories,
                 default_slots
              FROM inventory_slot_types
              WHERE is_active = TRUE
              ORDER BY sort_order`
         );

         return res.json({
             success: true,
             items: items.rows,
             slotTypes: slotTypes.rows
         });

     } catch (error) {
         console.error('Inventory catalog retrieval failed:', error);

         return res.status(503).json({
             error: 'Database temporarily unavailable'
         });
     }
 });

 // Получить инвентарь конкретного игрока
 app.get('/api/inventory/:playerId', async (req, res) => {
     try {
         const playerId = await resolvePlayerId(req.params.playerId);

         // Проверяем существование аккаунта
         const account = await pool.query(
             `SELECT player_id
              FROM roulette_accounts
              WHERE player_id = $1`,
             [playerId]
         );

         if (!account.rowCount) {
             return res.status(404).json({
                 error: 'Player not found'
             });
         }

         // Создаём стандартные слоты, если их ещё нет
         await ensurePlayerInventorySlots(pool, playerId);

         // Получаем предметы игрока
         const items = await pool.query(
             `SELECT
                 i.code,
                 i.name,
                 i.description,
                 i.category,
                 i.rarity,
                 i.icon,
                 i.metadata,
                 pi.quantity,
                 e.slot_type,
                 e.slot_number,
                 (e.item_code IS NOT NULL) AS equipped
              FROM player_inventory pi
              JOIN inventory_items i
                 ON i.code = pi.item_code
              LEFT JOIN player_equipment e
                 ON e.player_id = pi.player_id
                 AND e.item_code = pi.item_code
              WHERE pi.player_id = $1
              ORDER BY i.category, i.sort_order, i.name`,
             [playerId]
         );

         // Получаем все слоты игрока
         const slots = await pool.query(
             `SELECT
                 s.slot_type,
                 t.name AS slot_name,
                 s.slot_number,
                 t.accepted_categories,
                 e.item_code,
                 i.name AS item_name,
                 i.icon AS item_icon,
                 i.rarity AS item_rarity
              FROM inventory_slots s
              JOIN inventory_slot_types t
                 ON t.slot_type = s.slot_type
              LEFT JOIN player_equipment e
                 ON e.player_id = s.player_id
                 AND e.slot_type = s.slot_type
                 AND e.slot_number = s.slot_number
              LEFT JOIN inventory_items i
                 ON i.code = e.item_code
              WHERE s.player_id = $1
              ORDER BY t.sort_order, s.slot_number`,
             [playerId]
         );

         return res.json({
             success: true,
             playerId,
             items: items.rows,
             slots: slots.rows
         });

     } catch (error) {
         console.error('Player inventory retrieval failed:', error);

         return res.status(503).json({
             error: 'Database temporarily unavailable'
         });
     }
 });

 // Экипировать предмет в слот
 app.post('/api/inventory/equip', async (req, res) => {
     const { playerId, itemCode, slotType, slotNumber } = req.body || {};

     if (
         typeof playerId !== 'string' ||
         typeof itemCode !== 'string' ||
         typeof slotType !== 'string' ||
         !Number.isSafeInteger(slotNumber) ||
         slotNumber < 1
     ) {
         return res.status(400).json({
             error: 'Invalid equipment data'
         });
     }

     let client;

     try {
         const canonicalId = await resolvePlayerId(playerId);

         client = await pool.connect();
         await client.query('BEGIN');

         // Проверяем существование игрока
         const account = await client.query(
             `SELECT player_id
              FROM roulette_accounts
              WHERE player_id = $1
              FOR UPDATE`,
             [canonicalId]
         );

         if (!account.rowCount) {
             throw new Error('PLAYER_NOT_FOUND');
         }

         // Создаём стандартные слоты, если их ещё нет
         await ensurePlayerInventorySlots(client, canonicalId);

         // Блокируем выбранный слот
         const slot = await client.query(
             `SELECT
                 s.slot_type,
                 s.slot_number,
                 t.accepted_categories,
                 e.item_code
              FROM inventory_slots s
              JOIN inventory_slot_types t
                 ON t.slot_type = s.slot_type
              LEFT JOIN player_equipment e
                 ON e.player_id = s.player_id
                 AND e.slot_type = s.slot_type
                 AND e.slot_number = s.slot_number
              WHERE s.player_id = $1
                AND s.slot_type = $2
                AND s.slot_number = $3
                AND t.is_active = TRUE
              FOR UPDATE OF s`,
             [canonicalId, slotType, slotNumber]
         );

         if (!slot.rowCount) {
             throw new Error('SLOT_NOT_FOUND');
         }

         if (slot.rows[0].item_code !== null) {
             throw new Error('SLOT_OCCUPIED');
         }

         // Проверяем владение предметом и совместимость категории
         const item = await client.query(
             `SELECT i.code, i.category
              FROM player_inventory pi
              JOIN inventory_items i
                 ON i.code = pi.item_code
              WHERE pi.player_id = $1
                AND pi.item_code = $2
                AND pi.quantity > 0
                AND i.is_active = TRUE
              FOR UPDATE OF pi`,
             [canonicalId, itemCode]
         );

         if (!item.rowCount) {
             throw new Error('ITEM_NOT_OWNED');
         }

         if (
             !slot.rows[0].accepted_categories.includes(
                 item.rows[0].category
             )
         ) {
             throw new Error('CATEGORY_MISMATCH');
         }

         // Добавляем предмет в экипировку
         await client.query(
             `INSERT INTO player_equipment (
                 player_id,
                 item_code,
                 slot_type,
                 slot_number
              )
              VALUES ($1, $2, $3, $4)`,
             [canonicalId, itemCode, slotType, slotNumber]
         );

         await client.query('COMMIT');

         return res.json({
             success: true,
             message: 'Item equipped',
             itemCode,
             slotType,
             slotNumber
         });

     } catch (error) {
         if (client) {
             await client.query('ROLLBACK').catch(() => {});
         }

         const errors = {
             PLAYER_NOT_FOUND: [404, 'Player not found'],
             SLOT_NOT_FOUND: [404, 'Slot not found'],
             SLOT_OCCUPIED: [409, 'Slot is already occupied'],
             ITEM_NOT_OWNED: [403, 'You do not own this item'],
             CATEGORY_MISMATCH: [400, 'Item category is not accepted by this slot']
         };

         const [status, message] = errors[error.message] || (
             error.code === '23505'
                 ? [409, 'Item or slot is already equipped']
                 : [503, 'Database temporarily unavailable']
         );

         console.error('Item equipment failed:', error);

         return res.status(status).json({
             error: message
         });

     } finally {
         if (client) {
             client.release();
         }
     }
 });

 // Снять предмет со слота
 app.post('/api/inventory/unequip', async (req, res) => {
     const { playerId, slotType, slotNumber } = req.body || {};

     if (
         typeof playerId !== 'string' ||
         typeof slotType !== 'string' ||
         !Number.isSafeInteger(slotNumber) ||
         slotNumber < 1
     ) {
         return res.status(400).json({
             error: 'Invalid unequip data'
         });
     }

     let client;

     try {
         const canonicalId = await resolvePlayerId(playerId);

         client = await pool.connect();
         await client.query('BEGIN');

         // Проверяем существование игрока
         const account = await client.query(
             `SELECT player_id
              FROM roulette_accounts
              WHERE player_id = $1
              FOR UPDATE`,
             [canonicalId]
         );

         if (!account.rowCount) {
             throw new Error('PLAYER_NOT_FOUND');
         }

         // Блокируем выбранный слот
         const slot = await client.query(
             `SELECT
                 s.slot_type,
                 s.slot_number,
                 e.item_code
              FROM inventory_slots s
              LEFT JOIN player_equipment e
                 ON e.player_id = s.player_id
                 AND e.slot_type = s.slot_type
                 AND e.slot_number = s.slot_number
              WHERE s.player_id = $1
                AND s.slot_type = $2
                AND s.slot_number = $3
              FOR UPDATE OF s`,
             [canonicalId, slotType, slotNumber]
         );

         if (!slot.rowCount) {
             throw new Error('SLOT_NOT_FOUND');
         }

         const itemCode = slot.rows[0].item_code;

         if (!itemCode) {
             throw new Error('SLOT_EMPTY');
         }

         // Удаляем экипировку, но сохраняем предмет в инвентаре
         await client.query(
             `DELETE FROM player_equipment
              WHERE player_id = $1
                AND slot_type = $2
                AND slot_number = $3`,
             [canonicalId, slotType, slotNumber]
         );

         await client.query('COMMIT');

         return res.json({
             success: true,
             message: 'Item unequipped',
             itemCode,
             slotType,
             slotNumber
         });

     } catch (error) {
         if (client) {
             await client.query('ROLLBACK').catch(() => {});
         }

         const errors = {
             PLAYER_NOT_FOUND: [404, 'Player not found'],
             SLOT_NOT_FOUND: [404, 'Slot not found'],
             SLOT_EMPTY: [409, 'Slot is already empty']
         };

         const [status, message] = errors[error.message] || [
             503,
             'Database temporarily unavailable'
         ];

         console.error('Item unequipment failed:', error);

         return res.status(status).json({
             error: message
         });

     } finally {
         if (client) {
             client.release();
         }
     }
 });

 // Административная выдача предметов игрокам
 app.post('/api/inventory/grant', async (req, res) => {
     const adminKey = process.env.INVENTORY_ADMIN_KEY;
     const providedKey = req.get('x-inventory-admin-key');

     // Если секретный ключ не настроен, выдача отключена
     if (!adminKey) {
         return res.status(503).json({
             error: 'Inventory administration is not configured'
         });
     }

     if (typeof providedKey !== 'string') {
         return res.status(401).json({
             error: 'Unauthorized'
         });
     }

     // Безопасное сравнение ключей
     const expectedBuffer = Buffer.from(adminKey, 'utf8');
     const providedBuffer = Buffer.from(providedKey, 'utf8');

     if (
         expectedBuffer.length !== providedBuffer.length ||
         !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
     ) {
         return res.status(401).json({
             error: 'Unauthorized'
         });
     }

     const { playerId, itemCode, quantity = 1 } = req.body || {};

     if (
         typeof playerId !== 'string' ||
         !playerId.trim() ||
         typeof itemCode !== 'string' ||
         !itemCode.trim() ||
         !Number.isSafeInteger(quantity) ||
         quantity < 1 ||
         quantity > 100
     ) {
         return res.status(400).json({
             error: 'Invalid item grant data'
         });
     }

     let client;

     try {
         client = await pool.connect();
         await client.query('BEGIN');

         const canonicalId = await resolvePlayerId(playerId, client);

         // Проверяем существование аккаунта
         const account = await client.query(
             `SELECT player_id
              FROM roulette_accounts
              WHERE player_id = $1
              FOR UPDATE`,
             [canonicalId]
         );

         if (!account.rowCount) {
             throw new Error('PLAYER_NOT_FOUND');
         }

         // Выдаём предмет
         const result = await grantInventoryItem(
             client,
             canonicalId,
             itemCode,
             quantity
         );

         await client.query('COMMIT');

         notifyInventoryUpdated(canonicalId, itemCode, quantity);

         console.log(
             `Inventory item granted: ${itemCode} x${quantity} -> ${canonicalId}`
         );

         return res.json({
             success: true,
             message: 'Item granted',
             playerId: canonicalId,
             ...result
         });

     } catch (error) {
         if (client) {
             await client.query('ROLLBACK').catch(() => {});
         }

         const errors = {
             PLAYER_NOT_FOUND: [404, 'Player not found'],
             INVALID_ITEM_GRANT: [400, 'Invalid item grant'],
             INVENTORY_ITEM_NOT_FOUND: [404, 'Inventory item not found'],
             ITEM_NOT_STACKABLE: [409, 'This item cannot be stacked'],
             ITEM_ALREADY_OWNED: [409, 'Player already owns this item'],
             ITEM_STACK_LIMIT: [409, 'Maximum stack size exceeded']
         };

         const [status, message] = errors[error.message] || [
             503,
             'Database temporarily unavailable'
         ];

         console.error('Administrative item grant failed:', error);

         return res.status(status).json({
             error: message
         });

     } finally {
         if (client) {
             client.release();
         }
     }
 });

// ========================================
// LEGION SHOP API
// ========================================

// Получить каталог магазина, баланс и купленные товары
app.get('/api/shop/:playerId', async (req, res) => {
    try {
        const playerId = await resolvePlayerId(req.params.playerId);

        const account = await pool.query(
            `SELECT balance
             FROM roulette_accounts
             WHERE player_id = $1`,
            [playerId]
        );

        if (!account.rowCount) {
            return res.status(404).json({
                error: 'Player not found'
            });
        }

        const items = await pool.query(
            `SELECT
                s.code,
                s.name,
                s.description,
                s.category,
                s.price,
                s.metadata,
                (p.id IS NOT NULL) AS owned
             FROM shop_items s
             LEFT JOIN player_purchases p
                ON p.item_code = s.code
                AND p.player_id = $1
             WHERE s.is_active = TRUE
             ORDER BY s.price ASC, s.name ASC, s.code ASC`,
            [playerId]
        );

        return res.json({
            success: true,
            balance: Number(account.rows[0].balance),
            items: items.rows.map(item => ({
                ...item,
                price: Number(item.price),
                owned: item.owned
            }))
        });

    } catch (error) {
        console.error('Shop catalog failed:', error);

        return res.status(503).json({
            error: 'Database temporarily unavailable'
        });
    }
});


// Купить товар
app.post('/api/shop/purchase', async (req, res) => {
    const { playerId, itemCode } = req.body || {};

    if (
        typeof playerId !== 'string' ||
        !playerId.trim() ||
        typeof itemCode !== 'string' ||
        !itemCode.trim()
    ) {
        return res.status(400).json({
            error: 'Invalid purchase data'
        });
    }

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Получаем основной UUID игрока
        const canonicalId = await resolvePlayerId(playerId, client);

        // Блокируем аккаунт на время покупки
        const account = await client.query(
            `SELECT balance
             FROM roulette_accounts
             WHERE player_id = $1
             FOR UPDATE`,
            [canonicalId]
        );

        if (!account.rowCount) {
            throw new Error('PLAYER_NOT_FOUND');
        }

        // Проверяем существование и доступность товара
        const item = await client.query(
            `SELECT
                code,
                name,
                price,
                category,
                inventory_item_code
             FROM shop_items
             WHERE code = $1
               AND is_active = TRUE`,
            [itemCode]
        );

        if (!item.rowCount) {
            throw new Error('ITEM_NOT_FOUND');
        }

        const product = item.rows[0];
        const price = Number(product.price);
        const balance = Number(account.rows[0].balance);

        // Проверяем, не куплен ли товар ранее
        const existing = await client.query(
            `SELECT id
             FROM player_purchases
             WHERE player_id = $1 AND item_code = $2`,
            [canonicalId, itemCode]
        );

        if (existing.rowCount) {
            throw new Error('ALREADY_OWNED');
        }

        // Проверяем баланс
        if (balance < price) {
            throw new Error('INSUFFICIENT_BALANCE');
        }

        // Списываем мяукоины
        const updatedAccount = await client.query(
            `UPDATE roulette_accounts
             SET balance = balance - $2,
                 updated_at = NOW()
             WHERE player_id = $1
               AND balance >= $2
             RETURNING balance`,
            [canonicalId, price]
        );

        if (!updatedAccount.rowCount) {
            throw new Error('INSUFFICIENT_BALANCE');
        }

        // Записываем покупку
        await client.query(
            `INSERT INTO player_purchases
                (player_id, item_code, price_paid)
             VALUES ($1, $2, $3)`,
            [canonicalId, itemCode, price]
        );

        // Если товар связан с предметом инвентаря,
        // выдаём его игроку в рамках текущей транзакции
        if (product.inventory_item_code) {
            await grantInventoryItem(
                client,
                canonicalId,
                product.inventory_item_code,
                1
            );
        }

        // Сохраняем операцию в истории транзакций
        await client.query(
            `INSERT INTO roulette_transactions
                (player_id, type, amount, details)
             VALUES ($1, 'shop_purchase', $2, $3::jsonb)`,
            [
                canonicalId,
                -price,
                JSON.stringify({
                    itemCode: product.code,
                    itemName: product.name,
                    category: product.category
                })
            ]
        );

        await client.query('COMMIT');
        
        if (product.inventory_item_code) {
            notifyInventoryUpdated(
                canonicalId,
                product.inventory_item_code,
                1
            );
        }
        
        return res.json({
            success: true,
            message: 'Purchase successful',
            item: {
                code: product.code,
                name: product.name,
                category: product.category
            },
            price,
            balance: Number(updatedAccount.rows[0].balance)
        });

    } catch (error) {
        if (client) {
            await client.query('ROLLBACK').catch(() => {});
        }

        const errors = {
            PLAYER_NOT_FOUND: [404, 'Player not found'],
            ITEM_NOT_FOUND: [404, 'Товар не найден или больше недоступен'],
            ALREADY_OWNED: [409, 'Этот товар уже куплен'],
            INSUFFICIENT_BALANCE: [409, 'Недостаточно мяукоинов'],
            INVALID_ITEM_GRANT: [400, 'Invalid item grant'],
            INVENTORY_ITEM_NOT_FOUND: [404, 'Предмет инвентаря не найден'],
            ITEM_NOT_STACKABLE: [409, 'Этот предмет нельзя складывать'],
            ITEM_ALREADY_OWNED: [409, 'Этот предмет уже есть в инвентаре'],
            ITEM_STACK_LIMIT: [409, 'Достигнут максимальный размер стопки']
        };

        const [status, message] = errors[error.message] || [
            503,
            'Database temporarily unavailable'
        ];

        console.error('Shop purchase failed:', error);

        return res.status(status).json({
            error: message
        });

    } finally {
        if (client) {
            client.release();
        }
    }
});

// ========================================
// START SERVER
// ========================================

async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS roulette_accounts (
            player_id TEXT PRIMARY KEY,
            nickname TEXT NOT NULL,
            balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS roulette_player_aliases (
            alias_id TEXT PRIMARY KEY,
            player_id TEXT NOT NULL
                REFERENCES roulette_accounts(player_id)
                ON DELETE CASCADE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (alias_id <> player_id)
        );

        CREATE INDEX IF NOT EXISTS idx_roulette_player_aliases_player
            ON roulette_player_aliases (player_id);

        CREATE TABLE IF NOT EXISTS roulette_cooldowns (
            player_id TEXT PRIMARY KEY REFERENCES roulette_accounts(player_id) ON DELETE CASCADE,
            next_at BIGINT NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS roulette_matches (
            id UUID PRIMARY KEY,
            status TEXT NOT NULL,
            players JSONB NOT NULL,
            stake INTEGER,
            pot INTEGER,
            round_number INTEGER NOT NULL DEFAULT 0,
            winner TEXT,
            last_round JSONB,
            created_at BIGINT NOT NULL,
            finished_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS roulette_transactions (
            id BIGSERIAL PRIMARY KEY,
            player_id TEXT NOT NULL REFERENCES roulette_accounts(player_id),
            match_id UUID REFERENCES roulette_matches(id),
            type TEXT NOT NULL,
            amount NUMERIC(14,2) NOT NULL,
            details JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (match_id, player_id, type)
        );

        CREATE TABLE IF NOT EXISTS roulette_spins (
        id BIGSERIAL PRIMARY KEY,
        player_id TEXT NOT NULL REFERENCES roulette_accounts(player_id),
        nickname TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('solo', 'coop')),
        match_id UUID REFERENCES roulette_matches(id),
        round_number INTEGER,
        score NUMERIC(14,2) NOT NULL,
        jackpot BOOLEAN NOT NULL DEFAULT FALSE,
        reels JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Незавершённые соло-вращения
        CREATE TABLE IF NOT EXISTS roulette_solo_sessions (
            id UUID PRIMARY KEY,
            player_id TEXT NOT NULL
                REFERENCES roulette_accounts(player_id)
                ON DELETE CASCADE,

            nickname TEXT NOT NULL,
            reels JSONB NOT NULL,

            reroll_used BOOLEAN NOT NULL DEFAULT FALSE,
            insurance_used BOOLEAN NOT NULL DEFAULT FALSE,

            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'expired')),

            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ,
            completion_result JSONB
            );

        -- Не допускаем несколько незавершённых вращений одного игрока
        CREATE UNIQUE INDEX IF NOT EXISTS idx_roulette_solo_one_pending
            ON roulette_solo_sessions (player_id)
            WHERE status = 'pending';

        -- Ускоряем поиск активных вращений игрока
        CREATE INDEX IF NOT EXISTS idx_roulette_solo_player_status
            ON roulette_solo_sessions (player_id, status);
        
        CREATE INDEX IF NOT EXISTS idx_roulette_spins_player
            ON roulette_spins (player_id);
        
        CREATE INDEX IF NOT EXISTS idx_roulette_spins_jackpot
            ON roulette_spins (jackpot, score DESC);

        -- Additive migrations for databases created by earlier 2.0.x builds.
        ALTER TABLE roulette_solo_sessions
        ADD COLUMN IF NOT EXISTS completion_result JSONB;

        ALTER TABLE roulette_solo_sessions
        ADD COLUMN IF NOT EXISTS reroll_used BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE roulette_solo_sessions
        ADD COLUMN IF NOT EXISTS insurance_used BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE roulette_accounts ADD COLUMN IF NOT EXISTS nickname TEXT NOT NULL DEFAULT 'Игрок';
        ALTER TABLE roulette_accounts ADD COLUMN IF NOT EXISTS balance NUMERIC(14,2) NOT NULL DEFAULT 0;
        ALTER TABLE roulette_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        ALTER TABLE roulette_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE roulette_cooldowns ADD COLUMN IF NOT EXISTS next_at BIGINT NOT NULL DEFAULT 0;

        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'negotiating';
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS players JSONB NOT NULL DEFAULT '[]'::jsonb;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS stake INTEGER;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS pot INTEGER;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS round_number INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS winner TEXT;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS last_round JSONB;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS created_at BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
        ALTER TABLE roulette_matches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        ALTER TABLE roulette_transactions ADD COLUMN IF NOT EXISTS player_id TEXT;
        ALTER TABLE roulette_transactions ADD COLUMN IF NOT EXISTS match_id UUID;
        ALTER TABLE roulette_transactions ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE roulette_transactions ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2) NOT NULL DEFAULT 0;
        ALTER TABLE roulette_transactions ADD COLUMN IF NOT EXISTS details JSONB;
        ALTER TABLE roulette_transactions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

        CREATE INDEX IF NOT EXISTS idx_roulette_matches_players
            ON roulette_matches USING GIN (players);
        CREATE INDEX IF NOT EXISTS idx_roulette_matches_created
            ON roulette_matches (created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_roulette_transactions_match_player_type
            ON roulette_transactions (match_id, player_id, type);

            -- ========================================
            -- KOTO-KNB MATCHES
            -- ========================================
            
            CREATE TABLE IF NOT EXISTS knb_matches (
                id UUID PRIMARY KEY,
            
                status TEXT NOT NULL
                    CHECK (status IN (
                        'choosing_mode',
                        'negotiating',
                        'playing',
                        'finished',
                        'cancelled',
                        'expired'
                    )),
            
                mode TEXT
                    CHECK (mode IS NULL OR mode IN ('free', 'betting')),
            
                players JSONB NOT NULL,
            
                stake INTEGER
                    CHECK (stake IS NULL OR stake >= 50),
            
                pot INTEGER
                    CHECK (pot IS NULL OR pot >= 0),
            
                winner TEXT,
            
                created_at BIGINT NOT NULL,
                finished_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS knb_transactions (
                id BIGSERIAL PRIMARY KEY,
            
                match_id UUID NOT NULL
                    REFERENCES knb_matches(id),
            
                player_id TEXT NOT NULL
                    REFERENCES roulette_accounts(player_id),
            
                type TEXT NOT NULL
                    CHECK (type IN ('stake', 'payout', 'refund')),
            
                amount NUMERIC(14,2) NOT NULL
                    CHECK (amount > 0),
            
                details JSONB NOT NULL DEFAULT '{}'::jsonb,
            
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            
                UNIQUE (match_id, player_id, type)
            );
            
            CREATE INDEX IF NOT EXISTS idx_knb_transactions_player
                ON knb_transactions (player_id);
            
            CREATE INDEX IF NOT EXISTS idx_knb_transactions_match
                ON knb_transactions (match_id);
            
            CREATE INDEX IF NOT EXISTS idx_knb_matches_players
                ON knb_matches USING GIN (players);
            
            CREATE INDEX IF NOT EXISTS idx_knb_matches_status
                ON knb_matches (status, created_at DESC);

            -- ========================================
            -- LEGION SHOP
            -- ========================================
    
            CREATE TABLE IF NOT EXISTS shop_items (
                code TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                category TEXT NOT NULL
                    CHECK (category IN ('cosmetic', 'unlock', 'boost')),
                price INTEGER NOT NULL CHECK (price >= 0),
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
    
            CREATE TABLE IF NOT EXISTS player_purchases (
                id BIGSERIAL PRIMARY KEY,
                player_id TEXT NOT NULL
                    REFERENCES roulette_accounts(player_id),
                item_code TEXT NOT NULL
                    REFERENCES shop_items(code),
                price_paid INTEGER NOT NULL CHECK (price_paid >= 0),
                purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
                UNIQUE (player_id, item_code)
            );

            
            -- ========================================
            -- INVENTORY SYSTEM
            -- ========================================
            
            -- Каталог всех предметов игры
            CREATE TABLE IF NOT EXISTS inventory_items (
                code TEXT PRIMARY KEY,
            
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
            
                category TEXT NOT NULL,
                rarity TEXT NOT NULL DEFAULT 'common',
            
                icon TEXT,
            
                is_stackable BOOLEAN NOT NULL DEFAULT FALSE,
                max_stack INTEGER NOT NULL DEFAULT 1
                    CHECK (max_stack >= 1),
            
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
            
                sort_order INTEGER NOT NULL DEFAULT 0,
            
                metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            
            
            -- Типы слотов и допустимые категории предметов
            CREATE TABLE IF NOT EXISTS inventory_slot_types (
                slot_type TEXT PRIMARY KEY,
            
                name TEXT NOT NULL,
            
                accepted_categories TEXT[] NOT NULL,
            
                default_slots INTEGER NOT NULL DEFAULT 1
                    CHECK (default_slots >= 0),
            
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
            
                sort_order INTEGER NOT NULL DEFAULT 0
            );
            
            
            -- Предметы, принадлежащие игрокам
            CREATE TABLE IF NOT EXISTS player_inventory (
                player_id TEXT NOT NULL
                    REFERENCES roulette_accounts(player_id)
                    ON DELETE CASCADE,
            
                item_code TEXT NOT NULL
                    REFERENCES inventory_items(code),
            
                quantity INTEGER NOT NULL DEFAULT 1
                    CHECK (quantity > 0),
            
                acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            
                PRIMARY KEY (player_id, item_code)
            );
            
            
            -- Слоты, принадлежащие игрокам
            CREATE TABLE IF NOT EXISTS inventory_slots (
                player_id TEXT NOT NULL
                    REFERENCES roulette_accounts(player_id)
                    ON DELETE CASCADE,
            
                slot_type TEXT NOT NULL
                    REFERENCES inventory_slot_types(slot_type),
            
                slot_number INTEGER NOT NULL
                    CHECK (slot_number >= 1),
            
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            
                PRIMARY KEY (player_id, slot_type, slot_number)
            );
            
            
            -- Экипированные предметы
            CREATE TABLE IF NOT EXISTS player_equipment (
                player_id TEXT NOT NULL,
            
                item_code TEXT NOT NULL,
            
                slot_type TEXT NOT NULL,
                slot_number INTEGER NOT NULL,
            
                equipped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            
                -- Один предмет не может находиться в нескольких слотах
                PRIMARY KEY (player_id, item_code),
            
                -- Один слот не может содержать несколько предметов
                UNIQUE (player_id, slot_type, slot_number),
            
                FOREIGN KEY (player_id, item_code)
                    REFERENCES player_inventory(player_id, item_code)
                    ON DELETE CASCADE,
            
                FOREIGN KEY (player_id, slot_type, slot_number)
                    REFERENCES inventory_slots(player_id, slot_type, slot_number)
                    ON DELETE CASCADE
            );
            
            
            -- Индексы для быстрого получения предметов игрока
            CREATE INDEX IF NOT EXISTS idx_player_inventory_player
                ON player_inventory (player_id);
            
            CREATE INDEX IF NOT EXISTS idx_player_equipment_player
                ON player_equipment (player_id);
            
            
            -- ========================================
            -- DEFAULT INVENTORY SLOT TYPES
            -- ========================================
            
            -- Два слота для модификаторов рулетки
            INSERT INTO inventory_slot_types (
                slot_type,
                name,
                accepted_categories,
                default_slots,
                sort_order
            )
            VALUES (
                'roulette_modifier',
                'Модификаторы рулетки',
                ARRAY['roulette_modifier'],
                2,
                1
            )
            ON CONFLICT (slot_type) DO NOTHING;
            
            
            -- Один слот для косметических предметов
            INSERT INTO inventory_slot_types (
                slot_type,
                name,
                accepted_categories,
                default_slots,
                sort_order
            )
            VALUES (
                'cosmetic',
                'Косметика',
                ARRAY['cosmetic'],
                1,
                2
            )
            ON CONFLICT (slot_type) DO NOTHING;

            -- Отдельные слоты косметики рулетки:
            -- эффект выпадения и оформление можно экипировать одновременно.
            INSERT INTO inventory_slot_types (
                slot_type,
                name,
                accepted_categories,
                default_slots,
                sort_order
            )
            VALUES
                (
                    'roulette_effect',
                    'Эффект рулетки',
                    ARRAY['roulette_effect'],
                    1,
                    3
                ),
                (
                    'roulette_theme',
                    'Оформление рулетки',
                    ARRAY['roulette_theme'],
                    1,
                    4
                )
            ON CONFLICT (slot_type) DO NOTHING;
            
            
            -- Тестовая косметика для Кото-рулетки
            INSERT INTO inventory_items (
                code,
                name,
                description,
                category,
                rarity,
                icon,
                is_stackable,
                max_stack,
                is_active,
                sort_order,
                metadata
            )
            VALUES
                (
                    'roulette_effect_sparkles',
                    'Искры',
                    'Добавляет эффект искр при выпадении результата в Кото-рулетке.',
                    'roulette_effect',
                    'uncommon',
                    '✨',
                    FALSE,
                    1,
                    TRUE,
                    10,
                    '{"cosmetic_type":"roulette_effect","effect_id":"sparkles"}'::jsonb
                ),
                (
                    'roulette_theme_winter',
                    'Зимняя рулетка',
                    'Зимнее оформление Кото-рулетки со снежинками и холодной цветовой гаммой.',
                    'roulette_theme',
                    'rare',
                    '❄️',
                    FALSE,
                    1,
                    TRUE,
                    20,
                    '{"cosmetic_type":"roulette_theme","theme_id":"winter"}'::jsonb
                )
            ON CONFLICT (code) DO NOTHING;

            -- ========================================
            -- КОТО-РУЛЕТКА: МОДИФИКАТОРЫ
            -- ========================================
            
            INSERT INTO inventory_items (
                code,
                name,
                description,
                category,
                rarity,
                icon,
                is_stackable,
                max_stack,
                is_active,
                sort_order,
                metadata
            )
            VALUES
            (
                'roulette_mod_reroll',
                'Переброс',
                'Позволяет перебросить один выбранный символ в Кото-рулетке.',
                'roulette_modifier',
                'common',
                '🔄',
                TRUE,
                99,
                TRUE,
                100,
                '{"modifier_id":"reroll","trigger":"pebble_triple"}'::jsonb
            ),
            (
                'roulette_mod_pair_save',
                'Страховка',
                'Позволяет выбрать один символ, который останется на месте, а два остальных будут переброшены.',
                'roulette_modifier',
                'uncommon',
                '🛡️',
                TRUE,
                99,
                TRUE,
                110,
                '{"modifier_id":"insurance","trigger":"limestone_triple"}'::jsonb
            ),
            (
                'roulette_mod_lock',
                'Повтор',
                'Модификатор Кото-рулетки, получаемый за джекпот из трёх железных символов.',
                'roulette_modifier',
                'uncommon',
                '🔁',
                TRUE,
                99,
                TRUE,
                120,
                '{"modifier_id":"repeat","trigger":"iron_triple"}'::jsonb
            ),
            (
                'roulette_mod_duplicate',
                'Дублирование',
                'Модификатор Кото-рулетки, получаемый за джекпот из трёх угольных символов.',
                'roulette_modifier',
                'rare',
                '✨',
                TRUE,
                99,
                TRUE,
                130,
                '{"modifier_id":"duplicate","trigger":"coal_triple"}'::jsonb
            ),
            (
                'roulette_mod_second_chance',
                'Лихорадка',
                'Модификатор Кото-рулетки, получаемый за джекпот из трёх золотых символов.',
                'roulette_modifier',
                'rare',
                '🔥',
                TRUE,
                99,
                TRUE,
                140,
                '{"modifier_id":"fever","trigger":"gold_triple"}'::jsonb
            ),
            (
                'roulette_mod_transmutation',
                'Трансмутация',
                'Позволяет заменить один символ на выбранный ресурс, включая топаз.',
                'roulette_modifier',
                'legendary',
                '💎',
                TRUE,
                99,
                TRUE,
                150,
                '{"modifier_id":"transmutation","trigger":"topaz_triple"}'::jsonb
            )
            ON CONFLICT (code) DO NOTHING;
            
            -- Связь товаров магазина с предметами инвентаря
            ALTER TABLE shop_items
            ADD COLUMN IF NOT EXISTS inventory_item_code TEXT
            REFERENCES inventory_items(code);
    
            CREATE INDEX IF NOT EXISTS idx_player_purchases_player
                ON player_purchases (player_id);
    
            -- Первый товар магазина: разблокировка ставок в Кото-КНБ
            INSERT INTO shop_items (
                code,
                name,
                description,
                category,
                price,
                is_active
            )
            VALUES (
                'knb_betting',
                'Ставки в Кото-КНБ',
                'Навсегда открывает возможность играть на мяукоины в Кото-КНБ.',
                'unlock',
                750,
                TRUE
            )
            ON CONFLICT (code) DO NOTHING;

            -- Тестовые косметические товары магазина
            INSERT INTO shop_items (
                code,
                name,
                description,
                category,
                price,
                is_active,
                metadata,
                inventory_item_code
            )
            VALUES
                (
                    'roulette_sparkles',
                    'Эффект «Искры»',
                    'Косметический эффект искр при выпадении результата в Кото-рулетке.',
                    'cosmetic',
                    250,
                    TRUE,
                    '{"cosmetic_type":"roulette_effect","effect_id":"sparkles"}'::jsonb,
                    'roulette_effect_sparkles'
                ),
                (
                    'roulette_winter_theme',
                    'Оформление «Зимняя рулетка»',
                    'Зимняя тема Кото-рулетки со снежинками и холодной цветовой гаммой.',
                    'cosmetic',
                    400,
                    TRUE,
                    '{"cosmetic_type":"roulette_theme","theme_id":"winter"}'::jsonb,
                    'roulette_theme_winter'
                )
            ON CONFLICT (code) DO NOTHING;

            -- ========================================
            -- КОТО-РУЛЕТКА: РАЗБЛОКИРОВКИ МЕХАНИК
            -- ========================================
            
            INSERT INTO shop_items (
                code,
                name,
                description,
                category,
                price,
                is_active,
                metadata,
                inventory_item_code
            )
            VALUES
            (
                'roulette_unlock_pebble',
                'Механика камушка',
                'Разблокирует получение модификатора «Переброс» за джекпот из трёх камушков 🪨🪨🪨. При покупке вы получите один «Переброс» в подарок.',
                'unlock',
                100,
                TRUE,
                '{"unlock_type":"roulette_modifier","trigger":"pebble_triple"}'::jsonb,
                'roulette_mod_reroll'
            ),
            (
                'roulette_unlock_limestone',
                'Механика известняка',
                'Разблокирует получение модификатора «Страховка» за джекпот из трёх известняков ⚪⚪⚪. При покупке вы получите одну «Страховку» в подарок.',
                'unlock',
                200,
                TRUE,
                '{"unlock_type":"roulette_modifier","trigger":"limestone_triple"}'::jsonb,
                'roulette_mod_pair_save'
            ),
            (
                'roulette_unlock_iron',
                'Механика железа',
                'Разблокирует получение модификатора «Повтор» за джекпот из трёх железных символов ⛓️⛓️⛓️. При покупке вы получите один модификатор в подарок.',
                'unlock',
                300,
                TRUE,
                '{"unlock_type":"roulette_modifier","trigger":"iron_triple"}'::jsonb,
                'roulette_mod_lock'
            ),
            (
                'roulette_unlock_coal',
                'Механика угля',
                'Разблокирует получение модификатора «Дублирование» за джекпот из трёх угольных символов ⬛⬛⬛. При покупке вы получите один модификатор в подарок.',
                'unlock',
                400,
                TRUE,
                '{"unlock_type":"roulette_modifier","trigger":"coal_triple"}'::jsonb,
                'roulette_mod_duplicate'
            ),
            (
                'roulette_unlock_gold',
                'Механика золота',
                'Разблокирует получение модификатора «Лихорадка» за джекпот из трёх золотых символов 🟡🟡🟡. При покупке вы получите один модификатор в подарок.',
                'unlock',
                500,
                TRUE,
                '{"unlock_type":"roulette_modifier","trigger":"gold_triple"}'::jsonb,
                'roulette_mod_second_chance'
            ),
            (
                'roulette_unlock_topaz',
                'Механика топаза',
                'Разблокирует получение модификатора «Трансмутация» за джекпот из трёх топазов 💎💎💎. При покупке вы получите один модификатор в подарок.',
                'unlock',
                750,
                TRUE,
                '{"unlock_type":"roulette_modifier","trigger":"topaz_triple"}'::jsonb,
                'roulette_mod_transmutation'
            )
            ON CONFLICT (code) DO NOTHING;

            -- Обновление уже существующего модификатора «Страховка»
            UPDATE inventory_items
            SET
                name = 'Страховка',
                description = 'Позволяет выбрать один символ, который останется на месте, а два остальных будут переброшены.',
                metadata = '{"modifier_id":"insurance","trigger":"limestone_triple"}'::jsonb
            WHERE code = 'roulette_mod_pair_save';
            
            -- Обновление описания разблокировки в магазине
            UPDATE shop_items
            SET
                description = 'Разблокирует получение модификатора «Страховка» за джекпот из трёх известняков ⚪⚪⚪. При покупке вы получите одну «Страховку» в подарок.',
                inventory_item_code = 'roulette_mod_pair_save'
            WHERE code = 'roulette_unlock_limestone';

            -- Обновление существующих модификаторов
            UPDATE inventory_items
            SET
                name = 'Повтор',
                description = 'Модификатор Кото-рулетки, получаемый за джекпот из трёх железных символов.',
                icon = '🔁',
                metadata = '{"modifier_id":"repeat","trigger":"iron_triple"}'::jsonb
            WHERE code = 'roulette_mod_lock';
            
            UPDATE inventory_items
            SET
                name = 'Дублирование',
                description = 'Модификатор Кото-рулетки, получаемый за джекпот из трёх угольных символов.',
                icon = '✨',
                metadata = '{"modifier_id":"duplicate","trigger":"coal_triple"}'::jsonb
            WHERE code = 'roulette_mod_duplicate';
            
            UPDATE inventory_items
            SET
                name = 'Лихорадка',
                description = 'Модификатор Кото-рулетки, получаемый за джекпот из трёх золотых символов.',
                icon = '🔥',
                metadata = '{"modifier_id":"fever","trigger":"gold_triple"}'::jsonb
            WHERE code = 'roulette_mod_second_chance';
            
            -- Обновление существующих разблокировок магазина
            UPDATE shop_items
            SET
                description = 'Разблокирует получение модификатора «Повтор» за джекпот из трёх железных символов ⛓️⛓️⛓️. При покупке вы получите один модификатор в подарок.',
                inventory_item_code = 'roulette_mod_lock'
            WHERE code = 'roulette_unlock_iron';
            
            UPDATE shop_items
            SET
                description = 'Разблокирует получение модификатора «Дублирование» за джекпот из трёх угольных символов ⬛⬛⬛. При покупке вы получите один модификатор в подарок.',
                inventory_item_code = 'roulette_mod_duplicate'
            WHERE code = 'roulette_unlock_coal';
            
            UPDATE shop_items
            SET
                description = 'Разблокирует получение модификатора «Лихорадка» за джекпот из трёх золотых символов 🟡🟡🟡. При покупке вы получите один модификатор в подарок.',
                inventory_item_code = 'roulette_mod_second_chance'
            WHERE code = 'roulette_unlock_gold';

            -- ========================================
            -- ПОДКАТЕГОРИИ МАГАЗИНА
            -- ========================================
            
            -- Модификаторы Кото-рулетки
            UPDATE shop_items
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                || '{"subcategory": "jackpots"}'::jsonb
            WHERE code IN (
                'roulette_unlock_pebble',
                'roulette_unlock_limestone',
                'roulette_unlock_iron',
                'roulette_unlock_coal',
                'roulette_unlock_gold',
                'roulette_unlock_topaz'
            );
            
            -- Игровые режимы
            UPDATE shop_items
            SET metadata = COALESCE(metadata, '{}'::jsonb)
                || '{"subcategory": "modes"}'::jsonb
            WHERE code = 'knb_betting';
                        
    `);
    console.log('PostgreSQL schema is ready.');
}

const PORT = process.env.PORT || 3000;
initializeDatabase().then(() => {
    server.listen(PORT, '0.0.0.0', () => console.log(`Legion Server started on port ${PORT}`));
}).catch(error => {
    console.error('Database initialization failed:', error);
    process.exit(1);
});

process.on('SIGTERM', async () => {
    server.close();
    await pool.end();
    process.exit(0);
});
