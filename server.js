const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Проверка работоспособности сервера
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        name: 'Legion Server',
        message: 'Legion multiplayer server is running!'
    });
});

// Проверка состояния сервера
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Подключение игроков
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.emit('server:ready', {
        message: 'Connected to Legion Server'
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Legion Server started on port ${PORT}`);
});
