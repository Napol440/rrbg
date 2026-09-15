// ─── Rooms server: serves dist/ + authoritative race rooms over WS ──────────
// Dev:  `npm run server`  (port 8787; Vite dev talks to ws://localhost:8787/ws)
// Prod: `npm run build; npm start` (same port serves the built app + rooms).
// Rooms are in-memory: restarting the server drops them (documented).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { WebSocketServer } from 'ws';
import {
  createRoom, joinRoom, startGame, startGamePredealt, setupBoard, roundPayload,
  removePlayer, updateConfig,
  applyCount, applySolution, applyGiveUp, tickRoom, nextRound, nextRoundPredealt,
} from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8787);

const rooms = new Map(); // code -> room

// Background map builder: one shared worker pre-solves each room's NEXT
// round while the current one is played. Stale results are discarded via
// per-room generation counters; sync deal is always the fallback.
let dealWorker = null;
try {
  dealWorker = new Worker(new URL('./dealWorker.js', import.meta.url));
  dealWorker.on('message', (msg) => {
    if (!msg?.ok) return;
    const code = String(msg.jobId ?? '').split(':')[0];
    const room = rooms.get(code);
    if (!room || room._dealGen !== msg.gen) return; // stale: newer job issued
    room._pendingDeal = { deal: { robots: msg.robots, par: msg.par, deckPos: msg.deckPos }, forRound: room.round + 1 };
  });
  dealWorker.on('error', () => { dealWorker = null; });
} catch {
  dealWorker = null;
}

function queueNextDeal(room) {
  room._pendingDeal = null;
  if (!dealWorker) return;
  room._dealGen = (room._dealGen ?? 0) + 1;
  dealWorker.postMessage({
    jobId: `${room.code}:${room.round + 1}`,
    gen: room._dealGen,
    walls: [...room.walls],
    targets: room.targets,
    deck: room.deck,
    deckPos: room.deckPos + (room.config.targetCount ?? 1),
    targetCount: room.config.targetCount ?? 1,
    robotKinds: room.robotTemplate.map(({ id, color }) => ({ id, color, x: 0, y: 0, dir: 'up' })),
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('rooms server up (no dist/ built yet — run npm run build to serve the app)');
    return;
  }
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Support Vite base '/rrbg/'.
  if (urlPath.startsWith('/rrbg/')) urlPath = urlPath.slice('/rrbg'.length) || '/';
  let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath.slice(1));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) file = path.join(DIST, 'index.html'); // SPA fallback
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerId = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }
    try {
      handle(ws, m);
    } catch (err) {
      send(ws, { t: 'ERROR', message: String(err?.message ?? err) });
    }
  });
  ws.on('close', () => leaveRoom(ws));
});

function handle(ws, m) {
  switch (m.t) {
    case 'CREATE': {
      const room = createRoom(m.name, m.cfg);
      rooms.set(room.code, room);
      attach(ws, room, room.hostId);
      setupBoard(room); // arena exists from second zero…
      send(ws, welcome(room, room.hostId));
      queueNextDeal(room); // …and round 1 pre-solves while players gather
      break;
    }
    case 'JOIN': {
      const code = String(m.code ?? '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'ERROR', message: `No room ${code || '(empty)'}. Check the code.` });
      const r = joinRoom(room, m.name);
      if (r.error) return send(ws, { t: 'ERROR', message: r.error });
      attach(ws, room, r.player.id);
      send(ws, welcome(room, r.player.id));
      broadcast(room, lobbyPayload(room));
      if (room.phase === 'thinking' || room.phase === 'race') {
        // Mid-game joiner: catch up immediately, play this round.
        send(ws, roundPayload(room));
        if (room.race) send(ws, { t: 'RACE', ...room.race });
      }
      break;
    }
    case 'START': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.playerId !== room.hostId || room.phase !== 'lobby') return;
      const p = room._pendingDeal;
      room._pendingDeal = null;
      // Pre-dealt round 1 while lobbying → launch is instant.
      broadcast(room, (p && p.forRound === 1) ? startGamePredealt(room, p.deal) : startGame(room));
      queueNextDeal(room); // pre-build round 2 while round 1 is played
      break;
    }
    case 'NEXT': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.playerId !== room.hostId || room.phase !== 'reveal') return;
      const p = room._pendingDeal;
      room._pendingDeal = null;
      const ev = (p && p.forRound === room.round + 1)
        ? nextRoundPredealt(room, p.deal)
        : nextRound(room); // worker still busy → deal now (usual path for round 1)
      if (ev.type === 'gameover') broadcast(room, { t: 'GAMEOVER', scores: ev.scores });
      else {
        broadcast(room, ev); // ROUND payload
        queueNextDeal(room);
      }
      break;
    }
    case 'CONFIG': {
      // Host tunes timer/rounds/robots/chaos while still in the lobby.
      // Robot/wall changes rebuild the arena + restart the pre-deal.
      const room = rooms.get(ws.roomCode);
      if (!room || ws.playerId !== room.hostId || room.phase !== 'lobby') return;
      updateConfig(room, m.cfg);
      setupBoard(room);
      broadcast(room, lobbyPayload(room));
      queueNextDeal(room);
      break;
    }
    case 'KICK': {
      const room = rooms.get(ws.roomCode);
      if (!room || ws.playerId !== room.hostId) return;
      const target = room.conns.get(m.playerId);
      if (!target || m.playerId === room.hostId) return;
      send(target, { t: 'KICKED' });
      try { target.close(); } catch { /* already gone */ }
      if (removePlayer(room, m.playerId)) rooms.delete(room.code);
      else broadcast(room, lobbyPayload(room));
      break;
    }
    case 'COUNT': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.playerId) return;
      applyCount(room, ws.playerId, m.moves);
      broadcast(room, { t: 'PRESENCE', counts: presencePayload(room) });
      break;
    }
    case 'SOLUTION': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.playerId) return;
      if (room.phase !== 'thinking' && room.phase !== 'race') return;
      const ev = applySolution(room, ws.playerId, m.moves);
      broadcast(room, { t: 'PRESENCE', counts: presencePayload(room) });
      if (ev.type === 'race' || ev.type === 'steal') broadcast(room, { t: 'RACE', ...ev.race, par: room.par });
      else if (ev.type === 'end') broadcast(room, { t: 'END', ...endPayload(ev) });
      else if (ev.type === 'rejected') send(ws, { t: 'ERROR', message: `Solution rejected (${ev.reason}).` });
      break;
    }
    case 'GIVE_UP': {
      const room = rooms.get(ws.roomCode);
      if (!room || !ws.playerId) return;
      const ev = applyGiveUp(room, ws.playerId);
      broadcast(room, { t: 'PRESENCE', counts: presencePayload(room) });
      if (ev.type === 'end') broadcast(room, { t: 'END', ...endPayload(ev) });
      break;
    }
    default:
      break;
  }
}

function attach(ws, room, pid) {
  ws.roomCode = room.code;
  ws.playerId = pid;
  room.conns.set(pid, ws);
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  // Already removed (e.g. kicked) → nothing to do.
  if (!room.conns.has(ws.playerId) && !room.players.some((p) => p.id === ws.playerId)) return;
  if (removePlayer(room, ws.playerId)) {
    rooms.delete(room.code);
    return;
  }
  if (room.phase === 'lobby') broadcast(room, lobbyPayload(room));
  else {
    // Mid-game leave: keep playing; refresh presence + host view.
    broadcast(room, { t: 'PRESENCE', counts: presencePayload(room) });
    broadcast(room, lobbyPayload(room));
  }
}

function welcome(room, you) {
  return { t: 'WELCOME', code: room.code, you, isHost: you === room.hostId, ...lobbyFields(room) };
}

function lobbyPayload(room) {
  return { t: 'LOBBY', code: room.code, you: undefined, ...lobbyFields(room) };
}

function lobbyFields(room) {
  return {
    players: room.players.map((p) => ({ ...p })),
    hostId: room.hostId,
    roundsTotal: room.config.roundsTotal,
    robotCount: room.config.robotCount,
    targetCount: room.config.targetCount ?? 1,
    raceSeconds: room.config.raceSeconds,
    chaos: room.config.chaos,
    arenaReady: room.phase !== 'lobby' || !!room._pendingDeal,
  };
}

// LOBBY broadcasts need per-recipient `you`/`isHost` — patch on send.
const _origBroadcast = (room, msg) => {
  for (const [pid, ws] of room.conns) {
    if (ws.readyState !== 1) continue;
    if (msg.t === 'LOBBY') ws.send(JSON.stringify({ ...msg, you: pid, isHost: pid === room.hostId }));
    else ws.send(JSON.stringify(msg));
  }
};
function broadcast(room, msg) {
  _origBroadcast(room, msg);
}

function presencePayload(room) {
  return Object.fromEntries(Object.entries(room.presence).map(([pid, r]) => [pid, { ...r }]));
}

function endPayload(ev) {
  return { winnerId: ev.winnerId, movesUsed: ev.movesUsed, reason: ev.reason, optimal: !!ev.optimal, scores: ev.scores, answer: ev.answer ?? null, path: ev.path ?? null };
}

// Authoritative 1s race ticker.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== 'race') continue;
    const ev = tickRoom(room);
    if (!ev) continue;
    if (ev.type === 'tick') broadcast(room, { t: 'TICK', timeLeft: ev.timeLeft });
    else if (ev.type === 'end') broadcast(room, { t: 'END', ...endPayload(ev) });
  }
}, 1000);

server.listen(PORT, () => console.log(`rooms server on :${PORT} (ws path /ws)`));
