import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 3001);
const ROOM_TTL_MS = 60 * 60 * 1000;

const STATE_TYPES = new Set(['lobby-state', 'draft-state', 'tournament-state', 'match-state']);

interface Room {
  clients: Set<WebSocket>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  stateCache: Map<string, string>;
  playerIds: Map<WebSocket, string>;
}

const rooms = new Map<string, Room>();

function getOrCreateRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = { clients: new Set(), cleanupTimer: null, stateCache: new Map(), playerIds: new Map() };
    rooms.set(code, room);
  }
  return room;
}

function scheduleRoomCleanup(code: string, room: Room): void {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (room.clients.size === 0) {
      rooms.delete(code);
      log(code, 'sala expirada e removida da memória');
    }
  }, ROOM_TTL_MS);
}

function extractType(text: string): string | null {
  try {
    const msg = JSON.parse(text) as { type?: unknown };
    return typeof msg.type === 'string' ? msg.type : null;
  } catch {
    return null;
  }
}

function log(room: string, msg: string): void {
  const time = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`[${time}] [${room}] ${msg}`);
}

function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'desconhecido';
}

// ── HTTP health-check ──────────────────────────────────────────────────────
const server = http.createServer((_req, res) => {
  const info = {
    status: 'ok',
    rooms: rooms.size,
    clients: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(info));
});

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const match = req.url?.match(/^\/room\/([A-Z0-9]{1,16})$/i);

  if (!match) {
    log('?', `conexão rejeitada de ${ip} — URL inválida: ${req.url}`);
    ws.close(1008, 'invalid room path');
    return;
  }

  const roomCode = match[1].toUpperCase();
  const room = getOrCreateRoom(roomCode);

  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  room.clients.add(ws);
  log(roomCode, `✓ cliente conectado de ${ip} | total na sala: ${room.clients.size}`);

  // Replay de estado salvo (para clientes que reconectam)
  if (room.stateCache.size > 0) {
    log(roomCode, `  → enviando cache de estado (${[...room.stateCache.keys()].join(', ')})`);
    for (const key of ['lobby-state', 'draft-state', 'tournament-state', 'match-state']) {
      const cached = room.stateCache.get(key);
      if (cached) ws.send(cached);
    }
  } else {
    log(roomCode, '  → sem cache de estado (primeiro cliente ou sala nova)');
  }

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString();
    const msgType = extractType(text);

    if (msgType === 'player-identify') {
      try {
        const msg = JSON.parse(text) as { playerId?: unknown };
        if (typeof msg.playerId === 'string') {
          room.playerIds.set(ws, msg.playerId);
          log(roomCode, `  → identificado: ${msg.playerId} (${ip})`);
        }
      } catch { /* ignore malformed */ }
      return;
    }

    const recipients = [...room.clients].filter(
      (c) => c !== ws && c.readyState === WebSocket.OPEN,
    );

    if (msgType && STATE_TYPES.has(msgType)) {
      room.stateCache.set(msgType, text);
      log(roomCode, `↑ "${msgType}" recebido de ${ip} | cacheado | repassando para ${recipients.length} cliente(s)`);
    } else {
      log(roomCode, `↑ "${msgType ?? '?'}" recebido de ${ip} | repassando para ${recipients.length} cliente(s)`);
    }

    if (recipients.length === 0) {
      log(roomCode, '  ⚠ nenhum outro cliente na sala para receber a mensagem');
    }

    recipients.forEach((c) => c.send(text));
  });

  ws.on('close', (code, reason) => {
    const disconnectedPlayerId = room.playerIds.get(ws);
    room.playerIds.delete(ws);
    room.clients.delete(ws);
    log(roomCode, `✗ cliente ${ip} desconectou (código ${code}${reason.length ? `, motivo: ${reason}` : ''}) | restam: ${room.clients.size}`);

    if (disconnectedPlayerId) {
      const notice = JSON.stringify({ type: 'player-disconnected', playerId: disconnectedPlayerId });
      [...room.clients].filter((c) => c.readyState === WebSocket.OPEN).forEach((c) => c.send(notice));
      log(roomCode, `  → broadcast player-disconnected: ${disconnectedPlayerId}`);
    }

    if (room.clients.size === 0) {
      log(roomCode, '  sala vazia — agendando limpeza');
      scheduleRoomCleanup(roomCode, room);
    }
  });

  ws.on('error', (err) => {
    log(roomCode, `✗ erro no cliente ${ip}: ${err.message}`);
  });

  (ws as WebSocket & { isAlive: boolean }).isAlive = true;
  ws.on('pong', () => {
    (ws as WebSocket & { isAlive: boolean }).isAlive = true;
  });
});

// ── Heartbeat ──────────────────────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  let zombies = 0;
  wss.clients.forEach((ws) => {
    const sock = ws as WebSocket & { isAlive: boolean };
    if (!sock.isAlive) { sock.terminate(); zombies++; return; }
    sock.isAlive = false;
    sock.ping();
  });
  if (zombies > 0) console.log(`[heartbeat] ${zombies} cliente(s) zumbi(s) encerrado(s)`);
}, 30_000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log(`║  football-sim relay na porta ${String(PORT).padEnd(16)}║`);
  console.log('║  GET / → health-check (JSON)                 ║');
  console.log('║  WS  /room/<CODIGO> → entrar na sala         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
});
