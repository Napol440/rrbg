// ─── Rooms: authoritative multi-game state (pure logic, no sockets) ─────────
// One room = one game. The server owns the board seed, round scatter, race
// clock, and solution validation; clients only hold private sandboxes and
// send move COUNTS + claimed SOLUTIONS.

import { buildBoard, placeRobots, makeDeck } from '../src/game/board.js';
import { solveMinMoves } from '../src/game/engine.js';
import { isOptimalSolve, validateSolution, meetsMinPar, MAX_DEAL_ATTEMPTS } from '../src/game/race.js';
import { solvePath } from '../src/game/engine.js';

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
      raceSeconds: clampInt(cfg.raceSeconds, 10, 300, 60),
      targetCount: clampInt(cfg.targetCount, 1, 3, 1),
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

// Host-tunable settings (lobby phase only — caller enforces).
export function updateConfig(room, cfg = {}) {
  if (cfg.roundsTotal !== undefined) room.config.roundsTotal = clampInt(cfg.roundsTotal, 1, 40, 15);
  if (cfg.robotCount !== undefined) room.config.robotCount = cfg.robotCount === 5 ? 5 : 4;
  if (cfg.chaos !== undefined) room.config.chaos = !!cfg.chaos;
  if (cfg.raceSeconds !== undefined) room.config.raceSeconds = clampInt(cfg.raceSeconds, 10, 300, 60);
  if (cfg.targetCount !== undefined) room.config.targetCount = clampInt(cfg.targetCount, 1, 3, 1);
  return { ...room.config };
}

// Remove a player (kick or disconnect). Promotes a new host if needed.
// Returns true when the room is now empty.
export function removePlayer(room, pid) {
  room.players = room.players.filter((p) => p.id !== pid);
  room.conns.delete(pid);
  delete room.presence[pid];
  if (room.players.length === 0) return true;
  if (room.hostId === pid) room.hostId = room.players[0].id;
  return false;
}

export function startGame(room) {
  const board = buildBoard({ robotCount: room.config.robotCount, randomExtraWalls: room.config.chaos });
  placeRobots(board);
  room.walls = board.walls;
  room.targets = board.targets;
  room.deck = makeDeck(board.targets);
  room.deckPos = 0;
  room.round = 0;
  room.robotTemplate = board.robots.map(({ id, color }) => ({ id, color, x: 0, y: 0, dir: 'up' }));
  room.scores = Object.fromEntries(room.players.map((p) => [p.id, 0]));
  return beginRound(room);
}

export function beginRound(room) {
  room.round += 1;
  // Re-scatter until the puzzle needs MIN_ROUND_PAR moves (or is beyond
  // solver search — accepted as hard enough). Multi-target rounds skip par.
  const actives = roomActiveTargets(room);
  for (let attempt = 0; attempt < MAX_DEAL_ATTEMPTS; attempt++) {
    room.startRobots = scatter(room);
    room.par = actives.length === 1 ? solveMinMoves(room.walls, room.startRobots, actives[0]) : null;
    if (meetsMinPar(room.par)) break;
  }
  room.phase = 'thinking';
  room.race = null;
  room.presence = Object.fromEntries(
    room.players.map((p) => [p.id, { movesUsed: 0, solved: false, best: null, givenUp: false }]),
  );
  return roundPayload(room);
}

/** Active target set: targetCount consecutive deck entries. */
export function roomActiveTargets(room) {
  const out = [];
  if (!room.deck.length) return out;
  const count = room.config.targetCount ?? 1;
  for (let k = 0; k < count; k++) {
    const t = room.targets[room.deck[(room.deckPos + k) % room.deck.length]];
    if (t) out.push(t);
  }
  return out;
}

export function roundPayload(room) {
  const deck = roomActiveTargets(room).map((t) => room.targets.findIndex((q) => q.id === t.id));
  return {
    t: 'ROUND',
    round: room.round,
    roundsTotal: room.config.roundsTotal,
    raceSeconds: room.config.raceSeconds,
    targetCount: room.config.targetCount ?? 1,
    walls: [...room.walls],
    targets: room.targets,
    deck,
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
  const v = validateSolution(room.walls, room.startRobots, roomActiveTargets(room), moves);
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
    room.race = { leaderId: pid, bestMoves: n, timeLeft: room.config.raceSeconds, total: room.config.raceSeconds };
    return { type: 'race', race: { ...room.race } };
  }
  if (room.phase === 'race' && n < room.race.bestMoves) {
    room.race = { leaderId: pid, bestMoves: n, timeLeft: room.config.raceSeconds, total: room.config.raceSeconds };
    return { type: 'steal', race: { ...room.race } };
  }
  return { type: 'ack', best: room.race?.bestMoves ?? null };
}

export function applyGiveUp(room, pid) {
  if (room.presence[pid]) room.presence[pid].givenUp = true;
  // Race: the shortest solver wins as soon as everyone else gives up.
  if (room.phase === 'race' && room.race) {
    const rivalsIn = Object.entries(room.presence).some(([id, r]) => id !== room.race.leaderId && !r.givenUp);
    if (!rivalsIn) return finishRound(room, room.race.leaderId, room.race.bestMoves, false);
    return { type: 'ok' };
  }
  const all = Object.values(room.presence);
  if (all.length && all.every((r) => r.givenUp)) {
    // Nobody solved it: attach the solver's answer for single-target rounds
    // (null for multi-target or beyond-search) so clients can play it back.
    const actives = roomActiveTargets(room);
    const answer = actives.length === 1 ? solvePath(room.walls, room.startRobots, actives[0]) : null;
    room.phase = 'reveal';
    return { type: 'end', winnerId: null, reason: 'gave-up', scores: { ...room.scores }, answer };
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
  room.deckPos += room.config.targetCount ?? 1;
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
  // Robots never spawn on ANY target cell — not even the goal.
  const taken = new Set(room.targets.map((t) => `${t.x},${t.y}`));
  for (const r of robots) {
    for (let tries = 0; tries < 500; tries++) {
      const x = Math.floor(Math.random() * 16);
      const y = Math.floor(Math.random() * 16);
      if ((x >= 7 && x <= 8 && y >= 7 && y <= 8) || taken.has(`${x},${y}`)) continue;
      taken.add(`${x},${y}`);
      r.x = x;
      r.y = y;
      r.dir = 'up';
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
