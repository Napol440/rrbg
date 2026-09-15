// ─── Rooms: authoritative multi-game state (pure logic, no sockets) ─────────
// One room = one game. The server owns the board seed, round scatter, race
// clock, and solution validation; clients only hold private sandboxes and
// send move COUNTS + claimed SOLUTIONS.

import { buildBoard, placeRobots, makeDeck, pickActiveTargets, scatterRobots, generateTiles, POWER_TILES_ENABLED } from '../src/game/board.js';
import { solvePath, terrainOpts } from '../src/game/engine.js';
import { isOptimalSolve, validateSolution, findDeal, cleanMove } from '../src/game/race.js';

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
  room.presence[id] = { movesUsed: 0, solved: false, best: null, givenUp: false, powers: { breach: false, block: false } };
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
  setupBoard(room);
  return beginRound(room);
}

/** Build the arena immediately (fast: no solving) so round 1 can pre-deal
 * while players gather in the lobby. Safe to call again — rebuilds fresh. */
export function setupBoard(room) {
  const board = buildBoard({ robotCount: room.config.robotCount, randomExtraWalls: room.config.chaos });
  placeRobots(board);
  room.walls = board.walls;
  room.wallsAlt = board.wallsAlt;
  room.targets = board.targets;
  room.tiles = POWER_TILES_ENABLED ? generateTiles(board.targets, board.robots) : [];
  room.deck = makeDeck(board.targets);
  room.deckPos = 0;
  room.round = 0;
  room.robotTemplate = board.robots.map(({ id, color }) => ({ id, color, x: 0, y: 0, dir: 'up' }));
  room.scores = Object.fromEntries(room.players.map((p) => [p.id, 0]));
}

/**
 * Instant start using the lobby pre-deal. Late joiners are fine: only
 * robots/par/positions are reused, rosters/scores build from whoever is
 * present. Falls back to a fresh sync deal on corrupt payloads.
 */
export function startGamePredealt(room, deal) {
  if (!deal || !Array.isArray(deal.robots) || !deal.robots.length || !Number.isFinite(deal.deckPos)) {
    return startGame(room);
  }
  room.scores = Object.fromEntries(room.players.map((p) => [p.id, 0]));
  room.round = 1;
  room.startRobots = deal.robots;
  room.par = deal.par ?? null;
  room.deckPos = deal.deckPos;
  room.phase = 'thinking';
  room.race = null;
  room.presence = Object.fromEntries(
    room.players.map((p) => [p.id, { movesUsed: 0, solved: false, best: null, givenUp: false, powers: { breach: false, block: false } }]),
  );
  return roundPayload(room);
}

export function beginRound(room) {
  room.round += 1;
  // Shared budgeted search: proven 6+ lines preferred, sealed-looking
  // targets skipped (deckPos may advance), multi-target single-scattered.
  const kinds = room.robotTemplate.map(({ id, color }) => ({ id, color, x: 0, y: 0, dir: 'up' }));
  const tileCells = (room.tiles ?? []).map((t) => `${t.x},${t.y}`);
  const found = findDeal(
    {
      walls: room.walls,
      targets: room.targets,
      deck: room.deck,
      deckPos: room.deckPos,
      targetCount: room.config.targetCount ?? 1,
      robotKinds: kinds,
      tiles: room.tiles ?? [],
      terrain: terrainOpts(room.tiles ?? []),
    },
    { scatter: (ks) => scatterRobots(ks.map((k) => ({ ...k })), room.targets, tileCells) },
  );
  room.startRobots = found.robots;
  room.par = found.par;
  room.deckPos = found.deckPos;
  room.phase = 'thinking';
  room.race = null;
  room.presence = Object.fromEntries(
    room.players.map((p) => [p.id, { movesUsed: 0, solved: false, best: null, givenUp: false, powers: { breach: false, block: false } }]),
  );
  return roundPayload(room);
}

/** Active target set: distinct-colour deck entries. */
export function roomActiveTargets(room) {
  return pickActiveTargets(room.targets, room.deck, room.deckPos, room.config.targetCount ?? 1);
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
    wallsAlt: [...(room.wallsAlt ?? [])],
    tiles: (room.tiles ?? []).map((t) => ({ ...t })),
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
  if (room.presence[pid]) room.presence[pid].movesUsed = Math.max(0, Math.min(500, Math.round(moves * 2) / 2));
}

export function applySolution(room, pid, moves) {
  const pres = room.presence[pid];
  const spent = { breach: pres?.powers?.breach ? 1 : 0, block: pres?.powers?.block ? 1 : 0 };
  const v = validateSolution(room.walls, room.startRobots, roomActiveTargets(room), moves, {
    spent,
    altWalls: [...(room.wallsAlt ?? [])],
    tiles: (room.tiles ?? []).map((t) => ({ ...t })),
  });
  if (!v.ok) return { type: 'rejected', reason: v.reason };
  const n = v.moves;
  const used = powersIn(moves);
  if (pres) {
    pres.solved = true;
    pres.best = Math.min(n, pres.best ?? Infinity);
    pres.movesUsed = n;
    pres.powers = { breach: !!(pres.powers?.breach || used.breach), block: !!(pres.powers?.block || used.block) };
  }
  // Breach/block/flip lines are unmodeled: void par (no more instant wins).
  if (used.breach || used.block || (v.flips | 0) > 0) room.par = null;
  // Provably optimal → instant win.
  if (isOptimalSolve(n, room.par)) {
    return finishRound(room, pid, n, true, pathOf(moves));
  }
  if (room.phase === 'thinking') {
    room.phase = 'race';
    room.race = { leaderId: pid, bestMoves: n, timeLeft: room.config.raceSeconds, total: room.config.raceSeconds, path: pathOf(moves) };
    return { type: 'race', race: { ...room.race } };
  }
  if (room.phase === 'race' && n < room.race.bestMoves) {
    room.race = { leaderId: pid, bestMoves: n, timeLeft: room.config.raceSeconds, total: room.config.raceSeconds, path: pathOf(moves) };
    return { type: 'steal', race: { ...room.race } };
  }
  return { type: 'ack', best: room.race?.bestMoves ?? null };
}

export function applyGiveUp(room, pid) {
  if (room.presence[pid]) room.presence[pid].givenUp = true;
  // Race: the shortest solver wins as soon as everyone else gives up.
  if (room.phase === 'race' && room.race) {
    const rivalsIn = Object.entries(room.presence).some(([id, r]) => id !== room.race.leaderId && !r.givenUp);
    if (!rivalsIn) return finishRound(room, room.race.leaderId, room.race.bestMoves, false, room.race.path ?? null);
    return { type: 'ok' };
  }
  const all = Object.values(room.presence);
  if (all.length && all.every((r) => r.givenUp)) {
    // Nobody solved it: attach the solver's answer for single-target rounds
    // (null for multi-target or beyond-search) so clients can play it back.
    const actives = roomActiveTargets(room);
    const ground = terrainOpts(room.tiles ?? []);
    const answer = actives.length === 1
      ? solvePath(room.walls, room.startRobots, actives[0], 9, 120000, ground)
      : null;
    room.phase = 'reveal';
    return { type: 'end', winnerId: null, reason: 'gave-up', scores: { ...room.scores }, answer };
  }
  return { type: 'ok' };
}

/** 1s server tick for an active race. Returns an event for broadcast. */
export function tickRoom(room) {
  if (room.phase !== 'race' || !room.race) return null;
  room.race.timeLeft -= 1;
  if (room.race.timeLeft <= 0) return finishRound(room, room.race.leaderId, room.race.bestMoves, false, room.race.path ?? null);
  return { type: 'tick', timeLeft: room.race.timeLeft };
}

export function nextRound(room) {
  const over = checkGameOver(room);
  if (over) return over;
  room.deckPos += room.config.targetCount ?? 1;
  room.phase = 'thinking';
  return beginRound(room);
}

/**
 * Instant advance using a background pre-deal. Same win checks as nextRound;
 * the payload is self-consistent (robots/par paired with its own deckPos).
 */
export function nextRoundPredealt(room, deal) {
  const over = checkGameOver(room);
  if (over) return over;
  if (!deal || !Array.isArray(deal.robots) || !deal.robots.length || !Number.isFinite(deal.deckPos)) {
    return nextRound(room); // corrupt payload → sync deal instead
  }
  room.deckPos = deal.deckPos;
  room.round += 1;
  room.startRobots = deal.robots;
  room.par = deal.par ?? null;
  room.phase = 'thinking';
  room.race = null;
  room.presence = Object.fromEntries(
    room.players.map((p) => [p.id, { movesUsed: 0, solved: false, best: null, givenUp: false, powers: { breach: false, block: false } }]),
  );
  return roundPayload(room);
}

function checkGameOver(room) {
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
  return null;
}

// Power kinds already spent inside a submitted move list.
function powersIn(moves) {
  let breach = false;
  let block = false;
  for (const m of moves ?? []) {
    if (m.kind === 'breach') breach = true;
    else if (m.kind === 'block') block = true;
  }
  return { breach, block };
}

function finishRound(room, winnerId, movesUsed, optimal, path = null) {
  room.scores[winnerId] = (room.scores[winnerId] ?? 0) + 1;
  room.phase = 'reveal';
  room.race = null;
  return { type: 'end', winnerId, movesUsed, reason: 'solved', optimal, path, scores: { ...room.scores } };
}

// Sanitized winning line for broadcast (validated moves only).
function pathOf(moves) {
  return moves.map(cleanMove);
}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
