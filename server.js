// ============================================================
// PUYO BATTLE - Server (Node.js + Socket.io)
// Handles: Room management, matchmaking, game state sync
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────
const rooms = new Map();   // roomId -> Room
const players = new Map(); // socketId -> { roomId, playerNum, name }
let waitingPlayer = null;  // socket waiting for random match

class Room {
  constructor(id, mode) {
    this.id = id;
    this.mode = mode; // 'private' | 'random'
    this.players = [];  // [socket1, socket2]
    this.names = ['', ''];
    this.ready = [false, false];
    this.gameStarted = false;
    this.gameOver = false;
    this.settings = { colors: 4, speed: 500 };
    this.createdAt = Date.now();
  }

  isFull() { return this.players.length >= 2; }

  addPlayer(socket, name) {
    const num = this.players.length;
    this.players.push(socket);
    this.names[num] = name || `Player ${num + 1}`;
    players.set(socket.id, { roomId: this.id, playerNum: num, name: this.names[num] });
    socket.join(this.id);
    return num;
  }

  removePlayer(socket) {
    const idx = this.players.indexOf(socket);
    if (idx >= 0) {
      this.players[idx] = null;
      players.delete(socket.id);
    }
  }

  getOpponent(socket) {
    const idx = this.players.indexOf(socket);
    return idx === 0 ? this.players[1] : this.players[0];
  }

  bothReady() { return this.ready[0] && this.ready[1]; }
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(id) ? generateRoomId() : id;
}

// ── Cleanup stale rooms ────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const allGone = room.players.every(p => p === null);
    const stale = now - room.createdAt > 30 * 60 * 1000; // 30 min
    if (allGone || stale) rooms.delete(id);
  }
}, 60000);

// ── Socket Handlers ────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── Create private room ──
  socket.on('createRoom', ({ name, settings }) => {
    const roomId = generateRoomId();
    const room = new Room(roomId, 'private');
    if (settings) room.settings = { ...room.settings, ...settings };
    rooms.set(roomId, room);
    const num = room.addPlayer(socket, name);
    socket.emit('roomCreated', { roomId, playerNum: num });
    console.log(`[Room] ${roomId} created by ${name}`);
  });

  // ── Join private room ──
  socket.on('joinRoom', ({ roomId, name }) => {
    const room = rooms.get(roomId?.toUpperCase());
    if (!room) return socket.emit('joinError', { message: 'ルームが見つかりません' });
    if (room.isFull()) return socket.emit('joinError', { message: 'ルームが満員です' });

    const num = room.addPlayer(socket, name);
    socket.emit('roomJoined', { roomId: room.id, playerNum: num, settings: room.settings });

    // Notify both players
    io.to(room.id).emit('playerInfo', {
      players: room.names,
      count: room.players.filter(Boolean).length,
    });
    console.log(`[Room] ${name} joined ${room.id}`);
  });

  // ── Random matchmaking ──
  socket.on('findMatch', ({ name }) => {
    if (waitingPlayer && waitingPlayer.id !== socket.id && waitingPlayer.connected) {
      // Match found
      const roomId = generateRoomId();
      const room = new Room(roomId, 'random');
      rooms.set(roomId, room);

      const num0 = room.addPlayer(waitingPlayer, players.get(waitingPlayer.id)?.name || 'Player 1');
      const num1 = room.addPlayer(socket, name);

      waitingPlayer.emit('matchFound', { roomId, playerNum: 0 });
      socket.emit('matchFound', { roomId, playerNum: 1 });

      io.to(roomId).emit('playerInfo', {
        players: room.names,
        count: 2,
      });

      waitingPlayer = null;
      console.log(`[Match] ${room.names[0]} vs ${room.names[1]} in ${roomId}`);
    } else {
      // Wait for opponent
      waitingPlayer = socket;
      const pInfo = players.get(socket.id);
      if (!pInfo) {
        // Temp store name
        players.set(socket.id, { roomId: null, playerNum: -1, name: name });
      }
      socket.emit('waiting', { message: '対戦相手を探しています...' });
      console.log(`[Match] ${name} waiting...`);
    }
  });

  socket.on('cancelMatch', () => {
    if (waitingPlayer?.id === socket.id) {
      waitingPlayer = null;
      socket.emit('matchCancelled');
    }
  });

  // ── Ready ──
  socket.on('ready', () => {
    const pInfo = players.get(socket.id);
    if (!pInfo) return;
    const room = rooms.get(pInfo.roomId);
    if (!room) return;

    room.ready[pInfo.playerNum] = true;
    io.to(room.id).emit('readyState', { ready: room.ready });

    if (room.bothReady() && !room.gameStarted) {
      room.gameStarted = true;
      room.gameOver = false;
      // Generate shared random seed
      const seed = Math.floor(Math.random() * 999999);
      io.to(room.id).emit('gameStart', { seed, settings: room.settings });
      console.log(`[Game] Start in ${room.id} seed=${seed}`);
    }
  });

  // ── Game state sync ──
  // Each client sends their field state periodically
  socket.on('fieldUpdate', (data) => {
    const pInfo = players.get(socket.id);
    if (!pInfo) return;
    const room = rooms.get(pInfo.roomId);
    if (!room || room.gameOver) return;

    // Broadcast to opponent
    const opponent = room.getOpponent(socket);
    if (opponent) {
      opponent.emit('opponentField', {
        field: data.field,
        score: data.score,
        chain: data.chain,
        level: data.level,
      });
    }
  });

  // ── Garbage (ojama) puyo ──
  socket.on('sendGarbage', ({ lines }) => {
    const pInfo = players.get(socket.id);
    if (!pInfo) return;
    const room = rooms.get(pInfo.roomId);
    if (!room || room.gameOver) return;

    const opponent = room.getOpponent(socket);
    if (opponent) {
      opponent.emit('receiveGarbage', { lines });
    }
  });

  // ── Game Over ──
  socket.on('iLost', () => {
    const pInfo = players.get(socket.id);
    if (!pInfo) return;
    const room = rooms.get(pInfo.roomId);
    if (!room || room.gameOver) return;

    room.gameOver = true;
    const winnerNum = pInfo.playerNum === 0 ? 1 : 0;

    io.to(room.id).emit('gameEnd', {
      winner: winnerNum,
      winnerName: room.names[winnerNum],
      loserName: room.names[pInfo.playerNum],
    });

    // Reset ready state for rematch
    room.ready = [false, false];
    room.gameStarted = false;
    console.log(`[Game] ${room.names[winnerNum]} wins in ${room.id}`);
  });

  // ── Rematch ──
  socket.on('rematch', () => {
    const pInfo = players.get(socket.id);
    if (!pInfo) return;
    const room = rooms.get(pInfo.roomId);
    if (!room) return;

    room.ready[pInfo.playerNum] = true;
    io.to(room.id).emit('readyState', { ready: room.ready });

    if (room.bothReady()) {
      room.gameStarted = true;
      room.gameOver = false;
      const seed = Math.floor(Math.random() * 999999);
      io.to(room.id).emit('gameStart', { seed, settings: room.settings });
    }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);

    if (waitingPlayer?.id === socket.id) waitingPlayer = null;

    const pInfo = players.get(socket.id);
    if (!pInfo) return;
    const room = rooms.get(pInfo.roomId);
    if (room) {
      room.removePlayer(socket);
      io.to(room.id).emit('opponentLeft', { message: '相手が切断しました' });
      // Clean up empty rooms
      if (room.players.every(p => p === null)) rooms.delete(room.id);
    }
    players.delete(socket.id);
  });
});

// ── Start ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟢 Puyo Battle Server running on http://localhost:${PORT}\n`);
  console.log(`   LAN対戦: 同一ネットワーク内の端末から上記URLにアクセス`);
  console.log(`   ネット対戦: Render/Railway等にデプロイ\n`);
});
