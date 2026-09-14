// ─── Rooms: authoritative multi-game state (pure logic, no sockets) ─────────
// One room = one game. The server owns the board seed, round scatter, race
// clock, and solution validation; clients only hold private sandboxes and
// send move COUNTS + claimed SOLUTIONS.

import { buildBoard, placeRobots, makeDeck } from '../src/game/board.js';
import { solveMinMoves } from '../src/game/engine.js';
import { RACE_SECONDS, isOptimalSolve, validateSolution } from '../src/game/race.js';

const PALETTE = ['#e5484d', '#3e8ef7', '#46a758', '#f5a524', '#8e4ec6', '#12a594'];

export function makeCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  return code;
}

export function createRoom(name, cfg = {}) {
  const room = {
    code: makeCode(),
    hostId: 'p0',
    nextId: 1,
    players: [{ id: 'p0', name: name?.trim() || 'Host', color: PALETTE[0] }],
    conns: new Map(),
    config: {
      roundsTotal: clampInt(cfg.roundsTotal, 1, 40, 15),
      pointsToWin: clampInt(cfg.pointsToWin, 0, 30, 0),
      robotCount: cfg.robotCount === 5 ? 5 : 4,
      chaos: !!cfg.chaos,
    },
    round: 0,
    walls: new Set(),
    targets: [],
    deck: [],
    deckPos: 0,
    startRobots: [],
    par: null,
    phase: 'lobby', // lobby → thinking → race → reveal → over
    race: null,
    presence: {},
    scores: { p0: 0 },
  };
  return room;
}

export function joinRoom(room, name) {
  if (room.players.length >= 6) return { error: 'Room is full (6 max).' };
  const id = `p${room.nextId++}`;
  const player = { id, name: name?.trim() || `Player ${room.players.length + 1}`, color: PALETTE[room.players.length % PALETTE.length] };
  room.players.push(player);
  room.scores[id] = 0;
  room.presence[id] = { movesUsed: 0, solved: false, best: null, givenUp: false };
  return { player };
}

export function startGame(room) {
  const board = buildBoard({ robotCount: room.config.robotCount, randomExtraWalls: room.config.chaos });
  placeRobots(board);
  room.walls = board.walls;
  room.targets = board.targets;
  room.deck = makeDeck(board.targets);
  room.deckPos = 0;
  room.round = 0;
  room.robotTemplate = board.robots.map(({ id, color }) => ({ id, color, x: 0, y: 0 }));
  room.scores = Object.fromEntries(room.players.map((p) => [p.id, 0]));
  return beginRound(room);
}

export function beginRound(room) {
  room.round += 1;
  const target = room.targets[room.deck[room.deckPos % room.deck.length]];
  room.startRobots = scatter(room);
  room.par = solveMinMoves(room.walls, room.startRobots, target);
  room.phase = 'thinking';
  room.race = null;
  room.presence = Object.fromEntries(
    room.players.map((p) => [p.id, { movesUsed: 0, solved: false, best: null, givenUp: false }]),
  );
  return roundPayload(room);
}

export function roundPayload(room) {
  const target = room.targets[room.deck[room.deckPos % room.deck.length]];
  const ti = room.targets.findIndex((t) => t.id === target.id);
  return {
    t: 'ROUND',
    round: room.round,
    roundsTotal: room.config.roundsTotal,
    walls: [...room.walls],
    targets: room.targets,
    deck: [ti],
    deckPos: 0,
    startRobots: room.startRobots,
    par: room.par,
    scores: { ...room.scores },
    players: room.players.map((p) => ({ ...p })),
  };
}

export function applyCount(room, pid, moves) {
  if (room.presence[pid]) room.presence[pid].movesUsed = Math.max(0, Math.min(500, moves | 0));
}

export function applySolution(room, pid, moves) {
  const target = room.targets[room.deck[room.deckPos % room.deck.length]];
  const v = validateSolution(room.walls, room.startRobots, target, moves);
  if (!v.ok) return { type: 'rejected', reason: v.reason };
  const n = v.moves;
  const pres = room.presence[pid];
  if (pres) {
    pres.solved = true;
    pres.best = Math.min(n, pres.best ?? Infinity);
    pres.movesUsed = n;
  }
  // Provably optimal → instant win.
  if (isOptimalSolve(n, room.par)) {
    return finishRound(room, pid, n, true);
  }
  if (room.phase === 'thinking') {
    room.phase = 'race';
    room.race = { leaderId: pid, bestMoves: n, timeLeft: RACE_SECONDS };
    return { type: 'race', race: { ...room.race } };
  }
  if (room.phase === 'race' && n < room.race.bestMoves) {
    room.race = { leaderId: pid, bestMoves: n, timeLeft: RACE_SECONDS };
    return { type: 'steal', race: { ...room.race } };
  }
  return { type: 'ack', best: room.race?.bestMoves ?? null };
}

export function applyGiveUp(room, pid) {
  if (room.presence[pid]) room.presence[pid].givenUp = true;
  const all = Object.values(room.presence);
  if (all.length && all.every((r) => r.givenUp)) {
    if (room.phase === 'race' && room.race) return finishRound(room, room.race.leaderId, room.race.bestMoves, false);
    room.phase = 'reveal';
    return { type: 'end', winnerId: null, reason: 'gave-up', scores: { ...room.scores } };
  }
  return { type: 'ok' };
}

/** 1s server tick for an active race. Returns an event for broadcast. */
export function tickRoom(room) {
  if (room.phase !== 'race' || !room.race) return null;
  room.race.timeLeft -= 1;
  if (room.race.timeLeft <= 0) return finishRound(room, room.race.leaderId, room.race.bestMoves, false);
  return { type: 'tick', timeLeft: room.race.timeLeft };
}

export function nextRound(room) {
  if (room.config.pointsToWin > 0) {
    const champ = room.players.find((p) => (room.scores[p.id] ?? 0) >= room.config.pointsToWin);
    if (champ) {
      room.phase = 'over';
      return { type: 'gameover', scores: { ...room.scores } };
    }
  }
  if (room.round >= room.config.roundsTotal) {
    room.phase = 'over';
    return { type: 'gameover', scores: { ...room.scores } };
  }
  room.deckPos += 1;
  room.phase = 'thinking';
  return beginRound(room);
}

function finishRound(room, winnerId, movesUsed, optimal) {
  room.scores[winnerId] = (room.scores[winnerId] ?? 0) + 1;
  room.phase = 'reveal';
  room.race = null;
  return { type: 'end', winnerId, movesUsed, reason: 'solved', optimal, scores: { ...room.scores } };
}

function scatter(room) {
  // Fresh scatter every round from the robot template (ids/colors only).
  const robots = (room.robotTemplate ?? []).map((r) => ({ ...r }));
  const target = room.targets[room.deck[room.deckPos % room.deck.length]];
  const taken = new Set(room.targets.map((t) => `${t.x},${t.y}`));
  taken.delete(`${target.x},${target.y}`);
  for (const r of robots) {
    for (let tries = 0; tries < 500; tries++) {
      const x = Math.floor(Math.random() * 16);
      const y = Math.floor(Math.random() * 16);
      if ((x >= 7 && x <= 8 && y >= 7 && y <= 8) || taken.has(`${x},${y}`)) continue;
      taken.add(`${x},${y}`);
      r.x = x;
      r.y = y;
      break;
    }
  }
  return robots;
}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
