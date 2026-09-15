// Race-mode tests: helpers, solution validation, reducer race flow,
// rooms-server round/race logic. Run with: npm test (node --test tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RACE_SECONDS, isBetterSolve, isOptimalSolve, validateSolution, meetsMinPar, MIN_ROUND_PAR, findDeal, previewPath } from '../src/game/race.js';
import { isSolved, isMultiSolved, solvePath, collectionComplete } from '../src/game/engine.js';
import { gameReducer, initialState, activeTargets } from '../src/state/useGame.js';
import { pickActiveTargets } from '../src/game/board.js';
import { createRoom, joinRoom, tickRoom, applySolution, applyGiveUp, updateConfig, removePlayer, nextRoundPredealt, setupBoard, startGamePredealt, roundPayload } from '../server/rooms.js';
import { buildBoard, generateTiles, placeRobots } from '../src/game/board.js';

// ─── helpers ───

test('isBetterSolve is strictly smaller', () => {
  assert.equal(isBetterSolve(4, 5), true);
  assert.equal(isBetterSolve(5, 5), false);
  assert.equal(isBetterSolve(6, 5), false);
});

test('isOptimalSolve needs a known par', () => {
  assert.equal(isOptimalSolve(1, 1), true);
  assert.equal(isOptimalSolve(3, 5), true);
  assert.equal(isOptimalSolve(6, 5), false);
  assert.equal(isOptimalSolve(1, null), false);
});

test('deal gate: rounds must need 6+ moves (unknown counts as hard)', () => {
  assert.equal(MIN_ROUND_PAR, 6);
  assert.equal(meetsMinPar(null), true);
  assert.equal(meetsMinPar(9), true);
  assert.equal(meetsMinPar(6), true);
  assert.equal(meetsMinPar(5), false);
  assert.equal(meetsMinPar(1), false);
});

// ─── validateSolution ───
// Board: red r0 at (0,2), target red at (5,2), wall '6,2:W' stops the slide ON it.

const WALLS = new Set(['6,2:W']);
const START = [
  { id: 'r0', color: 'red', x: 0, y: 2, dir: 'up' },
  { id: 'r1', color: 'silver', x: 10, y: 10, dir: 'up' },
];
const TARGET = { id: 't0', x: 5, y: 2, color: 'red', shape: 'circle' };

test('validateSolution accepts a legal 1-move solve', () => {
  const v = validateSolution(WALLS, START, TARGET, [{ robotId: 'r0', dir: 'right' }]);
  assert.deepEqual(v, { ok: true, moves: 1, flips: 0 });
});

test('validateSolution rejects zero-displacement slides', () => {
  const v = validateSolution(WALLS, START, TARGET, [{ robotId: 'r0', dir: 'left' }]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'illegal');
});

test('validateSolution rejects non-solving move lists', () => {
  const v = validateSolution(WALLS, START, TARGET, [{ robotId: 'r1', dir: 'down' }]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unsolved');
});

test('validateSolution rejects empty claims', () => {
  assert.equal(validateSolution(WALLS, START, TARGET, []).ok, false);
});

// ─── reducer race flow ───

function craftState(par) {
  const box = () => ({ robots: START.map((r) => ({ ...r })), movesUsed: 0, history: [] });
  return {
    ...initialState(),
    players: [
      { id: 'p0', name: 'Ada', color: '#e5484d' },
      { id: 'p1', name: 'Bob', color: '#3e8ef7' },
    ],
    walls: new Set(WALLS),
    targets: [TARGET],
    deck: [0],
    deckPos: 0,
    round: 1,
    startRobots: START.map((r) => ({ ...r })),
    sandboxes: { p0: box(), p1: box() },
    viewAs: 'p0',
    roster: {
      p0: { movesUsed: 0, solved: false, best: null, givenUp: false },
      p1: { movesUsed: 0, solved: false, best: null, givenUp: false },
    },
    race: null,
    scores: { p0: 0, p1: 0 },
    par,
    phase: 'thinking',
  };
}

const move = (s, robotId, dir) => gameReducer(s, { type: 'MOVE', robotId, dir });
const tick = (s, n = 1) => {
  for (let i = 0; i < n; i++) s = gameReducer(s, { type: 'RACE_TICK' });
  return s;
};

test('first solve starts the race; live counts track per player', () => {
  let s = craftState(null);
  s = move(s, 'r1', 'down'); // wasteful repositioning with the blocker
  s = move(s, 'r1', 'up');
  assert.equal(s.phase, 'thinking');
  assert.equal(s.roster.p0.movesUsed, 1); // two silver slides at 0.5 each
  s = move(s, 'r0', 'right'); // solves in 2
  assert.equal(s.phase, 'race');
  assert.deepEqual([s.race.leaderId, s.race.bestMoves, s.race.timeLeft], ['p0', 2, RACE_SECONDS]);
  assert.equal(s.roster.p0.solved, true);
  assert.equal(s.roster.p0.best, 2);
});

test('smaller solve steals the lead and restarts the clock; worse is ignored', () => {
  let s = craftState(null);
  s = move(s, 'r1', 'down');
  s = move(s, 'r1', 'up');
  s = move(s, 'r0', 'right'); // p0 leads with 2
  s = tick(s, 2);
  assert.equal(s.race.timeLeft, RACE_SECONDS - 2);
  s = gameReducer(s, { type: 'VIEW_AS', playerId: 'p1' });
  s = move(s, 'r0', 'right'); // p1 solves in 1
  assert.deepEqual([s.race.leaderId, s.race.bestMoves, s.race.timeLeft], ['p1', 1, RACE_SECONDS]);
  // p0 resets and re-solves in 2 — worse than 1, race untouched.
  s = gameReducer(s, { type: 'VIEW_AS', playerId: 'p0' });
  s = gameReducer(s, { type: 'RESET' });
  assert.equal(s.roster.p0.movesUsed, 0);
  s = move(s, 'r1', 'down');
  s = move(s, 'r1', 'up');
  s = move(s, 'r0', 'right');
  assert.deepEqual([s.race.leaderId, s.race.bestMoves, s.race.timeLeft], ['p1', 1, RACE_SECONDS]);
});

test('clock expiry awards the leader', () => {
  let s = craftState(null);
  s = move(s, 'r0', 'right'); // p0 leads with 1 (par unknown → race, no instant win)
  assert.equal(s.phase, 'race');
  s = tick(s, RACE_SECONDS);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual([s.lastResult.winnerId, s.lastResult.movesUsed], ['p0', 1]);
  assert.equal(s.scores.p0, 1);
});

test('optimal solve (≤ par) wins instantly without a race', () => {
  let s = craftState(1);
  s = move(s, 'r0', 'right');
  assert.equal(s.phase, 'reveal');
  assert.equal(s.lastResult.winnerId, 'p0');
  assert.equal(s.lastResult.optimal, true);
  assert.equal(s.scores.p0, 1);
});

test('non-optimal solve starts a race even when par is known', () => {
  // par is 1 here but p0 wastes two blocker moves first → 2 moves, not optimal.
  let s = craftState(1);
  s = move(s, 'r1', 'down');
  s = move(s, 'r1', 'up');
  s = move(s, 'r0', 'right');
  assert.equal(s.phase, 'race');
  assert.deepEqual([s.race.leaderId, s.race.bestMoves], ['p0', 2]);
  assert.equal(s.lastResult, null);
});

test('reset restores the round start with zero moves', () => {
  let s = craftState(null);
  s = move(s, 'r1', 'down');
  assert.equal(s.roster.p0.movesUsed, 0.5);
  s = gameReducer(s, { type: 'RESET' });
  assert.equal(s.roster.p0.movesUsed, 0);
  assert.deepEqual(
    s.sandboxes.p0.robots.map((r) => [r.x, r.y]),
    START.map((r) => [r.x, r.y]),
  );
});

// ─── rooms server ───

test('rooms isolate games; join fills seats with colors', () => {
  const a = createRoom('Ada', { roundsTotal: 5 });
  const b = createRoom('Zed', {});
  assert.notEqual(a.code, undefined);
  assert.equal(a.code.length, 4);
  assert.notEqual(a.code, b.code);
  const { player } = joinRoom(a, 'Bob');
  assert.equal(a.players.length, 2);
  assert.equal(player.color, a.players[1].color);
  assert.equal(a.scores[player.id], 0);
});

test('server tick ends the race for the leader', () => {
  const room = {
    phase: 'race',
    race: { leaderId: 'p0', bestMoves: 5, timeLeft: 2 },
    scores: { p0: 0, p1: 0 },
    players: [{ id: 'p0' }, { id: 'p1' }],
    config: { roundsTotal: 15, pointsToWin: 0 },
  };
  const t = tickRoom(room);
  assert.equal(t.type, 'tick');
  assert.equal(t.timeLeft, 1);
  const end = tickRoom(room);
  assert.equal(end.type, 'end');
  assert.equal(end.winnerId, 'p0');
  assert.equal(room.scores.p0, 1);
  assert.equal(room.phase, 'reveal');
});

test('server accepts first solve, steals on better, instant-wins optimal', () => {  const room = createRoom('Ada', {});
  room.walls = new Set(WALLS);
  room.targets = [TARGET];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = START.map((r) => ({ ...r }));
  room.robotTemplate = START.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = null;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } };
  const first = applySolution(room, 'p0', [{ robotId: 'r0', dir: 'right' }]);
  assert.equal(first.type, 'race');
  assert.equal(room.race.bestMoves, 1);
  // Optimal once par is known (1) → instant win path.
  room.phase = 'thinking';
  room.race = null;
  room.par = 1;
  const opt = applySolution(room, 'p0', [{ robotId: 'r0', dir: 'right' }]);
  assert.equal(opt.type, 'end');
  assert.equal(opt.optimal, true);
});

// ─── immediate-reverse cancel ───
// Corridor walls: r1 at (10,10) slides down to (10,11) and back up to exactly
// (10,10). Without the 'N' wall the up-slide would overshoot to the edge.

const CORRIDOR = new Set(['6,2:W', '10,11:S', '10,10:N']);

function craftCorridor() {
  const s = craftState(null);
  return { ...s, walls: CORRIDOR };
}

test('forth-back with the same robot cancels the pair', () => {
  let s = craftCorridor();
  s = move(s, 'r1', 'down');
  assert.deepEqual([s.sandboxes.p0.movesUsed, s.sandboxes.p0.history.length], [0.5, 1]);
  s = move(s, 'r1', 'up');
  assert.deepEqual([s.sandboxes.p0.movesUsed, s.sandboxes.p0.history.length], [0, 0]);
  assert.deepEqual(
    s.sandboxes.p0.robots.map((r) => [r.x, r.y]),
    START.map((r) => [r.x, r.y]),
  );
  assert.equal(s.phase, 'thinking'); // no phantom solve/race
});

test('reverse that overshoots the origin counts normally', () => {
  const s0 = craftState(null);
  const s = { ...s0, walls: new Set(['6,2:W', '10,11:S']) }; // no N wall: up overshoots
  let st = move(s, 'r1', 'down'); // (10,10) → (10,11)
  st = move(st, 'r1', 'up'); // (10,11) → (10,0), NOT the origin
  assert.equal(st.sandboxes.p0.movesUsed, 1); // two silver slides at 0.5 each
  assert.equal(st.sandboxes.p0.history.length, 2);
});

test('interleaved robots do not cancel', () => {
  let s = craftCorridor();
  s = move(s, 'r1', 'down'); // [0.5] last: r1
  s = move(s, 'r0', 'up'); // [1.5] last: r0 (0,2)→(0,0)
  s = move(s, 'r1', 'up'); // r1 returns, but last entry is r0 → counts
  assert.equal(s.sandboxes.p0.movesUsed, 2);
  assert.equal(s.sandboxes.p0.history.length, 3);
});

// ─── facing direction tracking (rocket nose follows last travel dir) ───

test('MOVE records facing dir; RESET restores up', () => {
  let s = craftState(null);
  assert.equal(s.sandboxes.p0.robots.find((r) => r.id === 'r1').dir, 'up');
  s = move(s, 'r1', 'down');
  assert.equal(s.sandboxes.p0.robots.find((r) => r.id === 'r1').dir, 'down');
  assert.equal(s.sandboxes.p0.robots.find((r) => r.id === 'r0').dir, 'up');
  s = gameReducer(s, { type: 'RESET' });
  assert.equal(s.sandboxes.p0.robots.find((r) => r.id === 'r1').dir, 'up');
});

// ─── net solve-submit flow (regression: server must hear about solves) ───

function craftNet() {
  return {
    ...craftState(null),
    mode: 'net',
    net: { code: 'ABCD', you: 'p0', isHost: true, status: 'playing', connected: true },
  };
}

test('net solve flags solved locally WITHOUT blocking the submit', () => {
  let s = craftNet();
  s = move(s, 'r0', 'right'); // solves in 1, par unknown
  assert.equal(s.phase, 'thinking'); // server owns the race — no local phase jump
  assert.equal(s.race, null);
  assert.equal(s.roster.p0.solved, true);
  assert.equal(s.roster.p0.best, 1);
  assert.equal(s.solutionSent, false); // App effect must still send SOLUTION
  s = gameReducer(s, { type: 'NET_SENT', moves: 1 });
  assert.equal(s.solutionSent, 1);
});

test('server presence never clears our own solved flag', () => {
  let s = craftNet();
  s = move(s, 'r0', 'right');
  s = gameReducer(s, {
    type: 'NET_PRESENCE',
    counts: {
      p0: { movesUsed: 1, solved: false, best: null, givenUp: false },
      p1: { movesUsed: 4, solved: false, best: null, givenUp: false },
    },
  });
  assert.equal(s.roster.p0.solved, true); // own sandbox is source of truth
  assert.equal(s.roster.p0.best, 1);
  assert.equal(s.roster.p1.movesUsed, 4); // opponents still update
});

// ─── answer playback ───

test('solvePath returns a legal minimal line', () => {
  const path = solvePath(WALLS, START, TARGET);
  assert.deepEqual(path, [{ robotId: 'r0', dir: 'right' }]);
  const open = solvePath(new Set(), [{ id: 'r0', color: 'red', x: 0, y: 0 }], { x: 15, y: 15, color: 'red' });
  assert.equal(open.length, 2);
  assert.deepEqual(validateSolution(new Set(), [{ id: 'r0', color: 'red', x: 0, y: 0 }], { x: 15, y: 15, color: 'red' }, open), { ok: true, moves: 2, flips: 0 });
});

test('everyone gave up → reveal plays the answer step by step', () => {
  let s = craftState(null);
  s = gameReducer(s, { type: 'GIVE_UP', playerId: 'p0' });
  s = gameReducer(s, { type: 'GIVE_UP', playerId: 'p1' });
  assert.equal(s.phase, 'reveal');
  assert.equal(s.lastResult.winnerId, null);
  assert.deepEqual(s.lastResult.answer, [{ robotId: 'r0', dir: 'right' }]);
  assert.equal(s.answerIdx, 0);
  // Board reset to the round origin for playback.
  assert.deepEqual(s.sandboxes.p0.robots.map((r) => [r.x, r.y]), START.map((r) => [r.x, r.y]));
  s = gameReducer(s, { type: 'ANSWER_STEP' });
  assert.equal(s.answerIdx, 1);
  assert.equal(isSolved(s.sandboxes.p0.robots, TARGET), true);
  // Replay restores the origin and the cursor.
  s = gameReducer(s, { type: 'ANSWER_REPLAY' });
  assert.equal(s.answerIdx, 0);
  assert.deepEqual(s.sandboxes.p0.robots.map((r) => [r.x, r.y]), START.map((r) => [r.x, r.y]));
  // Stepping past the end is a no-op.
  s = gameReducer(s, { type: 'ANSWER_STEP' });
  s = gameReducer(s, { type: 'ANSWER_STEP' });
  assert.equal(s.answerIdx, 1);
});

function craftSolo() {
  const s = craftState(null);
  return {
    ...s,
    players: [{ id: 'p0', name: 'Ada', color: '#e5484d' }],
    sandboxes: { p0: s.sandboxes.p0 },
    roster: { p0: s.roster.p0 },
    scores: { p0: 0 },
  };
}

test('solo give-up reveals the answer instead of skipping ahead', () => {
  let s = craftSolo();
  s = gameReducer(s, { type: 'GIVE_UP' });
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(s.soloMoves, [null]);
  assert.deepEqual(s.lastResult.answer, [{ robotId: 'r0', dir: 'right' }]);
  s = gameReducer(s, { type: 'NEXT_ROUND' });
  assert.equal(s.phase, 'thinking');
  assert.equal(s.round, 2);
});

test('server give-up-all attaches a validating answer', () => {
  const room = createRoom('Ada', {});
  room.walls = new Set(WALLS);
  room.targets = [TARGET];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = START.map((r) => ({ ...r }));
  room.robotTemplate = START.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = 1;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } };
  const ev = applyGiveUp(room, 'p0');
  assert.equal(ev.type, 'end');
  assert.equal(ev.winnerId, null);
  assert.deepEqual(ev.answer, [{ robotId: 'r0', dir: 'right' }]);
  assert.deepEqual(
    validateSolution(room.walls, room.startRobots, TARGET, ev.answer),
    { ok: true, moves: 1, flips: 0 },
  );
});

// ─── last solver standing wins ───

function raceLedByP0() {
  // p0 solves in 3 (par unknown) → race, clock running.
  let s = craftState(null);
  s = move(s, 'r1', 'down');
  s = move(s, 'r1', 'up');
  s = move(s, 'r0', 'right');
  assert.equal(s.phase, 'race');
  return s;
}

test('leader wins immediately when all rivals give up', () => {
  let s = raceLedByP0();
  s = gameReducer(s, { type: 'GIVE_UP', playerId: 'p1' });
  assert.equal(s.phase, 'reveal');
  assert.deepEqual([s.lastResult.winnerId, s.lastResult.movesUsed], ['p0', 2]);
  assert.equal(s.scores.p0, 1);
});

test('race continues while a rival is still in (even if leader gives up)', () => {
  let s = raceLedByP0();
  s = gameReducer(s, { type: 'VIEW_AS', playerId: 'p0' });
  s = gameReducer(s, { type: 'GIVE_UP', playerId: 'p0' }); // leader bows out
  assert.equal(s.phase, 'race'); // p1 still experimenting
  assert.equal(s.race.leaderId, 'p0');
});

test('server ends the race when all rivals give up', () => {
  const room = createRoom('Ada', {});
  const { player } = joinRoom(room, 'Bob');
  room.walls = new Set(WALLS);
  room.targets = [TARGET];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = START.map((r) => ({ ...r }));
  room.robotTemplate = START.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = null;
  room.presence = {
    p0: { movesUsed: 0, solved: false, best: null, givenUp: false },
    [player.id]: { movesUsed: 0, solved: false, best: null, givenUp: false },
  };
  const first = applySolution(room, 'p0', [
    { robotId: 'r1', dir: 'down' },
    { robotId: 'r1', dir: 'up' },
    { robotId: 'r0', dir: 'right' },
  ]);
  assert.equal(first.type, 'race');
  const ev = applyGiveUp(room, player.id);
  assert.equal(ev.type, 'end');
  assert.equal(ev.winnerId, 'p0');
  assert.equal(room.scores.p0, 1);
});

// ─── lobby: tunable config, kick, timer plumbing ───

test('room config defaults and clamps', () => {
  const room = createRoom('Ada', {});
  assert.equal(room.config.raceSeconds, 60);
  const cfg = updateConfig(room, { raceSeconds: 5, roundsTotal: 99, robotCount: 5, chaos: 1 });
  assert.deepEqual([cfg.raceSeconds, cfg.roundsTotal, cfg.robotCount, cfg.chaos], [10, 40, 5, true]);
  assert.equal(room.config.raceSeconds, 10);
});

test('walled core blocks would-be bank lines', () => {
  const room = createRoom('Ada', {});
  assert.equal(room.config.centerMode, undefined);
  room.walls = new Set();
  room.targets = [{ id: 't0', x: 6, y: 0, color: 'red', shape: 'circle' }];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = [{ id: 'r0', color: 'red', x: 3, y: 7, dir: 'up' }];
  room.robotTemplate = room.startRobots.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = null;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } };
  // Rightward slide stops at (6,7) — never reaches (6,0) in one move.
  assert.equal(applySolution(room, 'p0', [{ robotId: 'r0', dir: 'right' }]).type, 'rejected');
  const around = applySolution(room, 'p0', [
    { robotId: 'r0', dir: 'right' },
    { robotId: 'r0', dir: 'up' },
  ]);
  assert.equal(around.type, 'race');
  assert.equal(around.race.bestMoves, 2);
});

test('race clock uses the room timer setting', () => {
  const room = createRoom('Ada', { raceSeconds: 25 });
  room.walls = new Set(WALLS);
  room.targets = [TARGET];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = START.map((r) => ({ ...r }));
  room.robotTemplate = START.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = null;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } };
  const ev = applySolution(room, 'p0', [{ robotId: 'r0', dir: 'right' }]);
  assert.equal(ev.type, 'race');
  assert.deepEqual([ev.race.timeLeft, ev.race.total], [25, 25]);
});

test('removePlayer drops seats and promotes a new host', () => {
  const room = createRoom('Ada', {});
  const { player: bob } = joinRoom(room, 'Bob');
  room.conns.set('p0', {});
  room.conns.set(bob.id, {});
  assert.equal(removePlayer(room, bob.id), false);
  assert.deepEqual(room.players.map((p) => p.id), ['p0']);
  assert.equal(room.hostId, 'p0');
  joinRoom(room, 'Cid'); // gets p2 — seat ids keep incrementing
  assert.equal(removePlayer(room, 'p0'), false);
  assert.equal(room.hostId, 'p2'); // crown passes to the oldest remaining seat
  assert.equal(removePlayer(room, 'p2'), true); // empty
});

test('client stores lobby timer + host, race carries its total', () => {
  let s = gameReducer(initialState(), {
    type: 'NET_LOBBY', code: 'ABCD', you: 'p1', isHost: false, hostId: 'p0',
    players: [{ id: 'p0', name: 'Ada' }, { id: 'p1', name: 'Bob' }],
    roundsTotal: 10, robotCount: 5, raceSeconds: 30, chaos: true,
  });
  assert.equal(s.raceSeconds, 30);
  assert.equal(s.net.hostId, 'p0');
  assert.equal(s.robotCount, 5);
  assert.equal(s.centerMode, undefined);
  s = gameReducer(s, { type: 'NET_RACE', leaderId: 'p0', bestMoves: 7, timeLeft: 29, total: 30 });
  assert.deepEqual([s.race.timeLeft, s.race.total], [29, 30]);
  s = gameReducer(s, { type: 'NET_TICK', timeLeft: 28 });
  assert.deepEqual([s.race.timeLeft, s.race.total], [28, 30]);
});

// ─── multiple targets ───

const TARGET2 = { id: 't1', x: 10, y: 15, color: 'silver', shape: 'hex' };

function craftMulti() {
  const s = craftState(null);
  return { ...s, targetCount: 2, targets: [TARGET, TARGET2], deck: [0, 1], par: null };
}

test('isMultiSolved needs every target covered', () => {
  const both = [
    { id: 'r0', color: 'red', x: 5, y: 2 },
    { id: 'r1', color: 'silver', x: 10, y: 15 },
  ];
  assert.equal(isMultiSolved(both, [TARGET, TARGET2]), true);
  assert.equal(isMultiSolved([both[0], START[1]], [TARGET, TARGET2]), false);
  assert.equal(isMultiSolved(both, []), false);
});

test('round solves only when all active targets are covered', () => {
  let s = craftMulti();
  s = move(s, 'r0', 'right'); // red home, silver still out
  assert.equal(s.phase, 'thinking');
  assert.equal(s.roster.p0.solved, false);
  s = move(s, 'r1', 'down'); // silver home too → solved in 1.5
  assert.equal(s.phase, 'race');
  assert.deepEqual([s.race.leaderId, s.race.bestMoves], ['p0', 1.5]);
});

test('activeTargets slices consecutive deck entries', () => {
  const s = {
    ...craftState(null),
    targetCount: 2,
    targets: [TARGET, TARGET2, TARGET],
    deck: [0, 1, 2],
    deckPos: 1,
  };
  assert.deepEqual(activeTargets(s).map((t) => t.id), ['t1', 't0']);
});

test('deal skips same-colour neighbours (one robot per colour)', () => {
  const yellowHex = { id: 'y1', x: 1, y: 1, color: 'yellow', shape: 'hex' };
  const yellowCircle = { id: 'y2', x: 2, y: 2, color: 'yellow', shape: 'circle' };
  const blue = { id: 'b1', x: 3, y: 3, color: 'blue', shape: 'square' };
  // Deck order leads with two yellows — the pair must be yellow+blue.
  assert.deepEqual(
    pickActiveTargets([yellowHex, yellowCircle, blue], [0, 1, 2], 0, 2).map((t) => t.id),
    ['y1', 'b1'],
  );
  // Wraps around the deck end.
  assert.deepEqual(
    pickActiveTargets([yellowHex, yellowCircle, blue], [0, 1, 2], 2, 2).map((t) => t.id),
    ['b1', 'y1'],
  );
});

test('same-colour deck neighbours still complete in multi mode', () => {
  const redHex = { id: 'y1', x: 5, y: 2, color: 'red', shape: 'hex' };
  const redCircle = { id: 'y2', x: 9, y: 9, color: 'red', shape: 'circle' };
  const s0 = craftState(null);
  // Forced red+red neighbours resolve to red + the next distinct colour.
  const s = {
    ...s0,
    targetCount: 2,
    targets: [redHex, redCircle, TARGET2],
    deck: [0, 1, 2],
    par: null,
  };
  assert.deepEqual(activeTargets(s).map((t) => t.id), ['y1', 't1']);
  // r0 covers y1 in one slide, r1 covers silver — round completes.
  let st = gameReducer(s, { type: 'MOVE', robotId: 'r0', dir: 'right' });
  assert.equal(st.phase, 'thinking');
  st = gameReducer(st, { type: 'MOVE', robotId: 'r1', dir: 'down' });
  assert.equal(st.phase, 'race');
  assert.deepEqual([st.race.leaderId, st.race.bestMoves], ['p0', 1.5]);
});

test('deck advances by target count each round', () => {
  const colors = ['red', 'blue', 'green', 'yellow', 'silver', 'red'];
  const dummies = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, x: i, y: 0, color: colors[i], shape: 'circle' }));
  let s = { ...craftState(null), phase: 'reveal', targetCount: 2, targets: dummies, deck: [0, 1, 2, 3, 4, 5], deckPos: 0, round: 1 };
  s = gameReducer(s, { type: 'NEXT_ROUND' });
  assert.equal(s.deckPos, 2);
  assert.deepEqual(activeTargets(s).map((t) => t.id), ['t2', 't3']);
});

test('server validates multi-target lines with no par', () => {
  const room = createRoom('Ada', { targetCount: 2 });
  room.walls = new Set(WALLS);
  room.targets = [TARGET, TARGET2];
  room.deck = [0, 1];
  room.deckPos = 0;
  room.startRobots = START.map((r) => ({ ...r }));
  room.robotTemplate = START.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = null;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } };
  const partial = applySolution(room, 'p0', [{ robotId: 'r0', dir: 'right' }]);
  assert.equal(partial.type, 'rejected');
  const full = applySolution(room, 'p0', [
    { robotId: 'r0', dir: 'right' },
    { robotId: 'r1', dir: 'down' },
  ]);
  assert.equal(full.type, 'race');
  assert.equal(full.race.bestMoves, 1.5);
});

// ─── findDeal: budgeted, prefers proven, switches sealed targets ───

const DEAL_KINDS = [{ id: 'r0', color: 'red', x: 0, y: 0, dir: 'up' }];
const dealCfg = () => ({
  walls: new Set(),
  targets: [TARGET],
  deck: [0],
  deckPos: 0,
  targetCount: 1,
  robotKinds: DEAL_KINDS,
});
const stubScatter = () => [{ id: 'r0', color: 'red', x: 0, y: 0, dir: 'up' }];
const scriptSolver = (pars) => {
  let i = 0;
  return () => pars[Math.min(i++, pars.length - 1)];
};

test('findDeal takes the first 6+ line immediately', () => {
  let scatters = 0;
  const r = findDeal(dealCfg(), {
    scatter: () => { scatters++; return stubScatter(); },
    solver: scriptSolver([3, 7]),
  });
  assert.equal(r.par, 7);
  assert.equal(scatters, 2);
  assert.equal(r.deckPos, 0);
});

test('findDeal falls back to best proven line when budget dies', () => {
  let now = 0;
  const r = findDeal(dealCfg(), {
    scatter: stubScatter,
    solver: scriptSolver([3, 4]),
    now: () => (now += 1000),
    budgetMs: 1500,
  });
  assert.equal(r.par, 4);
  assert.equal(r.deckPos, 0);
});

test('findDeal switches target after a null streak', () => {
  const blue = { id: 't1', x: 1, y: 1, color: 'blue', shape: 'square' };
  const cfg = { ...dealCfg(), targets: [TARGET, blue], deck: [0, 1] };
  const r = findDeal(cfg, {
    scatter: stubScatter,
    solver: scriptSolver([null, null, null, null, null, null, null, null, 7]),
    nullsToSwitch: 8,
  });
  assert.equal(r.deckPos, 1);
  assert.equal(r.par, 7);
});

test('findDeal returns unknown rather than hanging', () => {
  let now = 0;
  const r = findDeal(dealCfg(), {
    scatter: stubScatter,
    solver: () => null,
    now: () => (now += 1000),
    budgetMs: 500,
    nullsToSwitch: 8,
  });
  assert.equal(r.par, null);
  assert.equal(r.deckPos, 0);
});

test('findDeal multi-target scatters once without solving', () => {
  let solves = 0;
  let scatters = 0;
  const r = findDeal({ ...dealCfg(), targetCount: 2 }, {
    scatter: () => { scatters++; return stubScatter(); },
    solver: () => { solves++; return 1; },
  });
  assert.equal(r.par, null);
  assert.equal(scatters, 1);
  assert.equal(solves, 0);
});

// ─── background pre-deal: instant apply ───

test('APPLY_PREDEALT advances instantly with the given deal', () => {
  const dealtRobots = [
    { id: 'r0', color: 'red', x: 1, y: 1, dir: 'up' },
    { id: 'r1', color: 'silver', x: 2, y: 2, dir: 'up' },
  ];
  let s = { ...craftState(null), phase: 'reveal', round: 1, deckPos: 0 };
  s = gameReducer(s, { type: 'APPLY_PREDEALT', robots: dealtRobots, par: 7, deckPos: 1 });
  assert.equal(s.phase, 'thinking');
  assert.equal(s.round, 2);
  assert.equal(s.deckPos, 1);
  assert.equal(s.par, 7);
  assert.deepEqual(s.startRobots.map((r) => [r.x, r.y]), [[1, 1], [2, 2]]);
  assert.deepEqual(s.sandboxes.p0.robots.map((r) => [r.x, r.y]), [[1, 1], [2, 2]]);
});

test('APPLY_PREDEALT rejects bad timing and bad payloads', () => {
  const s = craftState(null); // thinking, not reveal
  const same = gameReducer(s, { type: 'APPLY_PREDEALT', robots: [{ id: 'r0', x: 0, y: 0 }], par: 6, deckPos: 1 });
  assert.equal(same, s);
  const revealing = { ...s, phase: 'reveal' };
  assert.equal(gameReducer(revealing, { type: 'APPLY_PREDEALT', robots: [], par: 6, deckPos: 1 }), revealing);
  assert.equal(gameReducer(revealing, { type: 'APPLY_PREDEALT', robots: [{ id: 'r0' }], par: 6 }), revealing);
});

test('server nextRoundPredealt applies and still enforces game over', () => {
  const room = createRoom('Ada', { roundsTotal: 1 });
  room.walls = new Set(WALLS);
  room.targets = [TARGET];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = START.map((r) => ({ ...r }));
  room.robotTemplate = START.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'reveal';
  room.par = 1;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } };
  // Round 1 of 1 is done → game over even with a deal ready.
  const over = nextRoundPredealt(room, { robots: START, par: 7, deckPos: 1 });
  assert.equal(over.type, 'gameover');

  const room2 = createRoom('Ada', { roundsTotal: 5 });
  Object.assign(room2, {
    walls: new Set(WALLS), targets: [TARGET], deck: [0], deckPos: 0,
    robotTemplate: START.map((r) => ({ ...r })),
    round: 1, phase: 'reveal', par: 1,
    presence: { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } },
  });
  const payload = nextRoundPredealt(room2, {
    robots: [{ id: 'r0', color: 'red', x: 3, y: 3, dir: 'up' }, { id: 'r1', color: 'silver', x: 4, y: 4, dir: 'up' }],
    par: 8,
    deckPos: 2,
  });
  assert.equal(payload.t, 'ROUND');
  assert.equal(payload.round, 2);
  assert.equal(payload.par, 8);
  assert.equal(room2.deckPos, 2);
  // Corrupt payload → sync fallback (still advances, no crash).
  room2.phase = 'reveal';
  const fallback = nextRoundPredealt(room2, { robots: [], par: null, deckPos: 0 });
  assert.equal(fallback.t, 'ROUND');
  assert.equal(fallback.round, 3);
});

// ─── lobby pre-deal: first map built while waiting ───

test('setupBoard readies the arena without solving', () => {
  const room = createRoom('Ada', { robotCount: 4 });
  setupBoard(room);
  assert.ok(room.walls.size > 0);
  assert.ok(room.targets.length > 0);
  assert.equal(room.deck.length, room.targets.length);
  assert.equal(room.robotTemplate.length, 4);
  assert.equal(room.round, 0);
  assert.equal(room.par, null); // no solver ran yet
});

test('startGamePredealt launches instantly and seats late joiners', () => {
  const room = createRoom('Ada', {});
  setupBoard(room);
  const { player: bob } = joinRoom(room, 'Bob'); // joins during the wait
  const payload = startGamePredealt(room, {
    robots: START.map((r) => ({ ...r })),
    par: 7,
    deckPos: 2,
  });
  assert.equal(payload.t, 'ROUND');
  assert.equal(payload.round, 1);
  assert.equal(payload.par, 7);
  assert.equal(room.deckPos, 2);
  assert.deepEqual(Object.keys(room.presence).sort(), ['p0', bob.id].sort());
  assert.deepEqual(room.scores, { p0: 0, [bob.id]: 0 });
});

test('startGamePredealt falls back to a sync deal on bad payloads', () => {
  const room = createRoom('Ada', {});
  setupBoard(room);
  const payload = startGamePredealt(room, { robots: [], par: null, deckPos: 0 });
  assert.equal(payload.t, 'ROUND');
  assert.equal(payload.round, 1);
  assert.ok(room.startRobots.length > 0);
});

test('client tracks arena readiness from the lobby', () => {
  const base = {
    type: 'NET_LOBBY', code: 'ABCD', you: 'p0', isHost: true, hostId: 'p0',
    players: [{ id: 'p0', name: 'Ada' }],
    roundsTotal: 10, robotCount: 4, raceSeconds: 60, chaos: false,
  };
  assert.equal(gameReducer(initialState(), { ...base, arenaReady: true }).net.arenaReady, true);
  assert.equal(gameReducer(initialState(), { ...base }).net.arenaReady, false);
});

// ─── lead/winning line paths ───

test('previewPath replays a line into numbered stops', () => {
  assert.deepEqual(
    previewPath(WALLS, START, [{ robotId: 'r0', dir: 'right' }]),
    [{ x: 5, y: 2, n: 1 }],
  );
  assert.deepEqual(previewPath(WALLS, START, []), []);
  // Illegal step truncates the preview instead of crashing.
  assert.deepEqual(previewPath(WALLS, START, [{ robotId: 'r0', dir: 'left' }]), []);
  const two = previewPath(WALLS, START, [
    { robotId: 'r1', dir: 'down' },
    { robotId: 'r1', dir: 'up' },
  ]);
  assert.deepEqual(two.map((p) => p.n), [0.5, 1]);
});

test('local result keeps the winning line', () => {
  let s = raceLedByP0(); // p0 leads in 2
  s = tick(s, RACE_SECONDS);
  assert.equal(s.phase, 'reveal');
  assert.deepEqual(s.lastResult.path, [
    { kind: 'slide', robotId: 'r1', dir: 'down' },
    { kind: 'slide', robotId: 'r1', dir: 'up' },
    { kind: 'slide', robotId: 'r0', dir: 'right' },
  ]);
});

test('server broadcasts lead lines and winning lines', () => {
  const room = createRoom('Ada', {});
  room.walls = new Set(WALLS);
  room.targets = [TARGET];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = START.map((r) => ({ ...r }));
  room.robotTemplate = START.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = null;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } };
  const line = [
    { robotId: 'r1', dir: 'down' },
    { robotId: 'r1', dir: 'up' },
    { robotId: 'r0', dir: 'right' },
  ];
  const cleanLine = line.map((m) => ({ kind: 'slide', ...m }));
  const race = applySolution(room, 'p0', line);
  assert.equal(race.type, 'race');
  assert.deepEqual(race.race.path, cleanLine);
  assert.deepEqual(race.race.bestMoves, 2); // 0.5 + 0.5 + 1
  // Clock expiry ends with the leader's line attached.
  room.race.timeLeft = 1;
  const end = tickRoom(room);
  assert.equal(end.type, 'end');
  assert.deepEqual(end.path, cleanLine);
  // Optimal instant win carries the line too.
  room.phase = 'thinking';
  room.race = null;
  room.par = 1;
  const opt = applySolution(room, 'p0', [{ robotId: 'r0', dir: 'right' }]);
  assert.equal(opt.type, 'end');
  assert.deepEqual(opt.path, [{ kind: 'slide', robotId: 'r0', dir: 'right' }]);
});

// ─── rocket powers: red breach, green block ───

// Red r0 at (5,2) facing the '6,2:W' wall; green r1 parked at (10,10).
function craftRam(par = 5) {
  const s = craftState(par);
  const robots = [
    { id: 'r0', color: 'red', x: 5, y: 2, dir: 'up' },
    { id: 'r1', color: 'green', x: 10, y: 10, dir: 'up' },
  ];
  const box = () => ({ robots: robots.map((r) => ({ ...r })), movesUsed: 0, history: [] });
  return {
    ...s,
    startRobots: robots.map((r) => ({ ...r })),
    sandboxes: { p0: box(), p1: box() },
  };
}

test('red ramming breaks the wall, stays put, spends the charge', () => {
  let s = craftRam();
  s = move(s, 'r0', 'right'); // into '6,2:W' → breach, not illegal
  assert.equal(s.sandboxes.p0.movesUsed, 1);
  assert.deepEqual(s.sandboxes.p0.robots.map((r) => [r.x, r.y]), [[5, 2], [10, 10]]);
  assert.equal(s.sandboxes.p0.history[0].kind, 'breach');
  assert.equal(s.roster.p0.movesUsed, 1);
  assert.equal(s.par, null); // powers void par
  // The gap is real: next slide passes through.
  s = move(s, 'r0', 'right');
  assert.deepEqual([s.sandboxes.p0.robots[0].x, s.sandboxes.p0.robots[0].y], [15, 2]);
  assert.equal(s.sandboxes.p0.movesUsed, 2);
});

test('second breach is illegal; undo restores wall and charge', () => {
  // Two walls adjacent to red: east ('6,2:W') and north ('5,1:S').
  let s = { ...craftRam(), walls: new Set(['6,2:W', '5,1:S']) };
  s = move(s, 'r0', 'right'); // breach #1 (east)
  assert.equal(s.sandboxes.p0.history[0].kind, 'breach');
  s = move(s, 'r0', 'up'); // rams north wall, charge spent → illegal
  assert.equal(s.sandboxes.p0.movesUsed, 1);
  assert.ok(s.illegal);
  // Undo the breach → wall back, charge refunded, re-ram allowed.
  s = gameReducer(s, { type: 'UNDO' });
  assert.equal(s.sandboxes.p0.movesUsed, 0);
  assert.equal(s.sandboxes.p0.history.length, 0);
  s = move(s, 'r0', 'right');
  assert.equal(s.sandboxes.p0.history[0].kind, 'breach');
  assert.equal(s.sandboxes.p0.movesUsed, 1);
});

test('green ramming drops a block on the cell behind itself', () => {
  // '10,10:S' is green's own south edge → adjacent; behind is (10,9).
  let s = { ...craftRam(), walls: new Set(['6,2:W', '10,10:S']) };
  s = move(s, 'r1', 'down');
  const box = s.sandboxes.p0;
  assert.equal(box.movesUsed, 1);
  assert.equal(box.history[0].kind, 'block');
  assert.deepEqual([box.history[0].x, box.history[0].y], [10, 9]);
  assert.equal(s.par, null);
  // The block is terrain now: ramming down again finds the charge spent.
  s = move(s, 'r1', 'down');
  assert.equal(s.sandboxes.p0.movesUsed, 1);
  assert.ok(s.illegal);
});

test('block on occupied/target/edge cells is rejected', () => {
  // Behind-cell occupied by red.
  let s = craftRam();
  s = { ...s, walls: new Set(['6,2:W', '10,10:S']) };
  const robots = [
    { id: 'r0', color: 'red', x: 10, y: 9, dir: 'up' },
    { id: 'r1', color: 'green', x: 10, y: 10, dir: 'up' },
  ];
  const box = () => ({ robots: robots.map((r) => ({ ...r })), movesUsed: 0, history: [] });
  s = { ...s, startRobots: robots.map((r) => ({ ...r })), sandboxes: { p0: box(), p1: box() } };
  const before = s.sandboxes.p0.movesUsed;
  s = move(s, 'r1', 'down'); // behind (10,9) occupied → illegal
  assert.equal(s.sandboxes.p0.movesUsed, before);
  assert.ok(s.illegal);
});

test('blue slides never void par; breach lines validate end to end', () => {
  // A plain blue slide still counts as a plain legal line (robots block
  // blue mid-slide now, so red stands off the path).
  const walls = new Set();
  const bots = [
    { id: 'r0', color: 'blue', x: 0, y: 0 },
    { id: 'r1', color: 'red', x: 5, y: 1 },
  ];
  const target = { x: 15, y: 0, color: 'blue' };
  const v = validateSolution(walls, bots, target, [{ kind: 'slide', robotId: 'r0', dir: 'right' }]);
  assert.deepEqual(v, { ok: true, moves: 1, flips: 0 });
  // Breached line validates only with the breach entry present.
  const bw = new Set(['6,2:W']);
  const bs = [{ id: 'r0', color: 'red', x: 5, y: 2 }];
  const bt = { x: 15, y: 2, color: 'red' };
  assert.equal(validateSolution(bw, bs, bt, [{ kind: 'slide', robotId: 'r0', dir: 'right' }]).ok, false);
  const line = [
    { kind: 'breach', robotId: 'r0', wallKey: '6,2:W' },
    { kind: 'slide', robotId: 'r0', dir: 'right' },
  ];
  assert.deepEqual(validateSolution(bw, bs, bt, line), { ok: true, moves: 2, flips: 0 });
  // Same wall breached twice in one line → power-spent.
  const dbl = [...line, { kind: 'breach', robotId: 'r0', wallKey: '6,2:W' }];
  assert.equal(validateSolution(bw, bs, bt, dbl).reason, 'power-spent');
});

test('blue ram-phase lines validate as plain slides', () => {
  // Blue (5,2) rams '6,2:W', phases through, solves at (15,2) — still one
  // slide entry, no power spent, no par void.
  const bw = new Set(['6,2:W']);
  const bs = [{ id: 'r0', color: 'blue', x: 5, y: 2 }];
  const bt = { x: 15, y: 2, color: 'blue' };
  assert.deepEqual(
    validateSolution(bw, bs, bt, [{ kind: 'slide', robotId: 'r0', dir: 'right' }]),
    { ok: true, moves: 1, flips: 0 },
  );
  // Phasing through a robot validates too.
  const rb = [
    { id: 'r0', color: 'blue', x: 3, y: 5 },
    { id: 'r1', color: 'red', x: 4, y: 5 },
  ];
  const rt = { x: 15, y: 5, color: 'blue' };
  assert.deepEqual(
    validateSolution(new Set(), rb, rt, [{ kind: 'slide', robotId: 'r0', dir: 'right' }]),
    { ok: true, moves: 1, flips: 0 },
  );
});

test('silver slides count 0.5 in validation and beat par', () => {
  const bots = [{ id: 'r0', color: 'silver', x: 0, y: 2 }];
  const target = { x: 5, y: 2, color: 'silver' };
  const v = validateSolution(WALLS, bots, target, [{ kind: 'slide', robotId: 'r0', dir: 'right' }]);
  assert.deepEqual(v, { ok: true, moves: 0.5, flips: 0 });
  assert.equal(isOptimalSolve(0.5, 1), true);
});

test('silver slides cost 0.5 in the sandbox; undo refunds 0.5', () => {
  // START has silver r1 at (10,10): sliding down runs to (10,15).
  let s = craftState(5);
  s = move(s, 'r1', 'down');
  assert.deepEqual([s.sandboxes.p0.robots[1].x, s.sandboxes.p0.robots[1].y], [10, 15]);
  assert.equal(s.sandboxes.p0.movesUsed, 0.5);
  assert.equal(s.roster.p0.movesUsed, 0.5);
  s = gameReducer(s, { type: 'UNDO' });
  assert.equal(s.sandboxes.p0.movesUsed, 0);
  assert.deepEqual([s.sandboxes.p0.robots[1].x, s.sandboxes.p0.robots[1].y], [10, 10]);
});

test('silver immediate reverse cancels 0.5, not 1', () => {
  // Corridor: down stops on (10,11), up returns exactly to (10,10).
  let s = { ...craftState(5), walls: new Set(['6,2:W', '10,11:S', '10,10:N']) };
  s = move(s, 'r1', 'down');
  assert.deepEqual([s.sandboxes.p0.robots[1].x, s.sandboxes.p0.robots[1].y], [10, 11]);
  assert.equal(s.sandboxes.p0.movesUsed, 0.5);
  s = move(s, 'r1', 'up'); // back onto the pre-move cell → pair cancels
  assert.deepEqual([s.sandboxes.p0.robots[1].x, s.sandboxes.p0.robots[1].y], [10, 10]);
  assert.equal(s.sandboxes.p0.movesUsed, 0);
  assert.equal(s.sandboxes.p0.history.length, 0);
});

test('block on a goal cell is rejected', () => {
  const walls = new Set(['10,10:S']);
  const bots = [
    { id: 'r0', color: 'green', x: 10, y: 10 },
    { id: 'r1', color: 'red', x: 0, y: 0 },
  ];
  const target = { x: 10, y: 9, color: 'red' }; // goal sits behind the rammer
  const line = [{ kind: 'block', robotId: 'r0', wallKey: '10,10:S', x: 10, y: 9 }];
  assert.equal(validateSolution(walls, bots, target, line).reason, 'illegal');
});

// ─── power tiles: white/yellow switch flips the wall set ───

function craftTilesSolo() {
  const robots = [{ id: 'r0', color: 'red', x: 0, y: 0, dir: 'up' }];
  const tiles = [{ id: 'w0', kind: 'white', x: 15, y: 0 }];
  const box = () => ({
    robots: robots.map((r) => ({ ...r })), movesUsed: 0, history: [], collected: [],
    tiles: tiles.map((t) => ({ ...t })), flips: 0,
  });
  return {
    ...initialState(),
    players: [{ id: 'p0', name: 'Ada', color: '#e5484d' }],
    walls: new Set(),
    wallsAlt: new Set(['10,0:E']),
    roundTiles: tiles.map((t) => ({ ...t })),
    targets: [{ id: 't0', x: 0, y: 5, color: 'red', shape: 'circle' }],
    deck: [0], deckPos: 0, round: 1,
    startRobots: robots.map((r) => ({ ...r })),
    sandboxes: { p0: box() },
    viewAs: 'p0',
    roster: { p0: { movesUsed: 0, solved: false, best: null, givenUp: false } },
    race: null, scores: { p0: 0 }, par: 4,
    phase: 'thinking',
  };
}

test('landing on white flips it, swaps walls, voids par', () => {
  let s = craftTilesSolo();
  s = move(s, 'r0', 'right'); // → (15,0), lands on white
  const box = s.sandboxes.p0;
  assert.deepEqual([box.robots[0].x, box.robots[0].y], [15, 0]);
  assert.equal(box.tiles[0].kind, 'yellow');
  assert.equal(box.flips, 1);
  assert.equal(s.par, null);
  // Yellow set is live: leftward slide now stops at (11,0), not (0,0).
  s = move(s, 'r0', 'left');
  assert.deepEqual([s.sandboxes.p0.robots[0].x, s.sandboxes.p0.robots[0].y], [11, 0]);
});

test('undo keeps flips; reset restores white', () => {
  let s = craftTilesSolo();
  s = move(s, 'r0', 'right');
  s = gameReducer(s, { type: 'UNDO' });
  assert.equal(s.sandboxes.p0.tiles[0].kind, 'yellow'); // world progress stays
  assert.equal(s.sandboxes.p0.flips, 1);
  s = move(s, 'r0', 'right');
  s = gameReducer(s, { type: 'RESET' });
  assert.equal(s.sandboxes.p0.tiles[0].kind, 'white');
  assert.equal(s.sandboxes.p0.flips, 0);
});

test('validation replays flips and swaps walls mid-line', () => {
  const walls = new Set();
  const alt = ['10,0:E'];
  const tiles = [{ id: 'w0', kind: 'white', x: 15, y: 0 }];
  const bots = [{ id: 'r0', color: 'red', x: 0, y: 0 }];
  const target = { x: 11, y: 0, color: 'red' };
  const line = [
    { kind: 'slide', robotId: 'r0', dir: 'right' },
    { kind: 'slide', robotId: 'r0', dir: 'left' },
  ];
  const opts = { altWalls: alt, tiles: tiles.map((t) => ({ ...t })) };
  const v = validateSolution(walls, bots, target, line, opts);
  assert.deepEqual(v, { ok: true, moves: 2, flips: 1 });
  // Same line on a board without the switch: sails past to (0,0), unsolved.
  assert.equal(validateSolution(walls, bots, target, line).reason, 'unsolved');
});

test('server enforces one breach per player per round across lines', () => {
  const room = createRoom('Ada', {});
  room.walls = new Set(['6,2:W']);
  room.targets = [{ id: 't0', x: 15, y: 2, color: 'red', shape: 'circle' }];
  room.deck = [0];
  room.deckPos = 0;
  room.startRobots = [{ id: 'r0', color: 'red', x: 5, y: 2, dir: 'up' }];
  room.robotTemplate = room.startRobots.map((r) => ({ ...r }));
  room.round = 1;
  room.phase = 'thinking';
  room.par = null;
  room.presence = { p0: { movesUsed: 0, solved: false, best: null, givenUp: false, powers: { breach: false, block: false } } };
  const line = [
    { kind: 'breach', robotId: 'r0', wallKey: '6,2:W' },
    { kind: 'slide', robotId: 'r0', dir: 'right' },
  ];
  const first = applySolution(room, 'p0', line);
  assert.equal(first.type, 'race');
  assert.equal(room.presence.p0.powers.breach, true);
  assert.equal(room.par, null);
  // Second line spending breach again → rejected even though locally legal.
  const again = applySolution(room, 'p0', line);
  assert.equal(again.type, 'rejected');
  assert.equal(again.reason, 'power-spent');
});

test('NET_RACE adopts server-voided par', () => {
  let s = gameReducer(initialState(), {
    type: 'NET_LOBBY', code: 'ABCD', you: 'p1', isHost: false, hostId: 'p0',
    players: [{ id: 'p0', name: 'Ada' }, { id: 'p1', name: 'Bob' }],
    roundsTotal: 10, robotCount: 4, raceSeconds: 30, chaos: false,
  });
  s = { ...s, par: 7 };
  s = gameReducer(s, { type: 'NET_RACE', leaderId: 'p0', bestMoves: 9, timeLeft: 30, total: 30, par: null });
  assert.equal(s.par, null);
  s = gameReducer(s, { type: 'NET_RACE', leaderId: 'p0', bestMoves: 9, timeLeft: 29, total: 30 });
  assert.equal(s.par, null); // missing field keeps current (null here)
});

test('preview draws breach dots and block squares', () => {
  const bw = new Set(['6,2:W']);
  const bs = [{ id: 'r0', color: 'red', x: 5, y: 2 }];
  const pts = previewPath(bw, bs, [
    { kind: 'breach', robotId: 'r0', wallKey: '6,2:W' },
    { kind: 'slide', robotId: 'r0', dir: 'right' },
  ]);
  assert.deepEqual(pts.map((p) => p.kind ?? 'slide'), ['breach', 'slide']);
  assert.deepEqual([pts[0].x, pts[0].y], [5, 2]);
  assert.equal(pts[1].x, 15);
});

// ─── multi-target collection (touch to collect, token disappears) ───

test('collectionComplete needs every id touched', () => {
  const ts = [{ id: 'a' }, { id: 'b' }];
  assert.equal(collectionComplete(['a', 'b'], ts), true);
  assert.equal(collectionComplete(['a'], ts), false);
  assert.equal(collectionComplete([], ts), false);
  assert.equal(collectionComplete(['a', 'b'], []), false);
});

test('covering one target collects it; round ends when all collected', () => {
  let s = craftMulti(); // red t0 at (5,2), silver t1 at (10,15)
  s = move(s, 'r0', 'right'); // red home → t0 collected, still thinking
  assert.equal(s.phase, 'thinking');
  assert.deepEqual(s.sandboxes.p0.collected, ['t0']);
  s = move(s, 'r1', 'down'); // silver home → complete, race starts
  assert.equal(s.phase, 'race');
  assert.deepEqual(s.sandboxes.p0.collected, ['t0', 't1']);
  assert.deepEqual(s.race.bestMoves, 1.5); // red 1 + silver 0.5
});

test('undo keeps collected goals; reset clears them', () => {
  let s = craftMulti();
  s = move(s, 'r0', 'right');
  assert.deepEqual(s.sandboxes.p0.collected, ['t0']);
  s = gameReducer(s, { type: 'UNDO' }); // robot leaves, token stays gone
  assert.deepEqual(s.sandboxes.p0.collected, ['t0']);
  assert.equal(s.sandboxes.p0.movesUsed, 0);
  s = move(s, 'r0', 'right');
  s = gameReducer(s, { type: 'RESET' });
  assert.deepEqual(s.sandboxes.p0.collected, []);
  assert.equal(s.sandboxes.p0.movesUsed, 0);
});

test('passing through counts as a touch in multi, not in solo', () => {
  const walls = new Set(); // open board: r0 sails straight through (5,2)
  const bots = [
    { id: 'r0', color: 'red', x: 0, y: 2 },
    { id: 'r1', color: 'silver', x: 10, y: 10 },
  ];
  const red = { id: 't0', x: 5, y: 2, color: 'red', shape: 'circle' };
  const line = [
    { kind: 'slide', robotId: 'r1', dir: 'down' }, // silver home (10,15)
    { kind: 'slide', robotId: 'r0', dir: 'right' }, // through red, ends (15,2)
  ];
  const silv = { id: 't1', x: 10, y: 15, color: 'silver', shape: 'hex' };
  assert.deepEqual(validateSolution(walls, bots, [red, silv], line), { ok: true, moves: 1.5, flips: 0 });
  assert.equal(validateSolution(walls, bots, red, line).reason, 'unsolved');
});

// ─── power tiles: generation, alt walls, deal terrain ───

test('board builds an alt wall set sharing target pockets', () => {
  const board = buildBoard({ robotCount: 4, seed: 7 });
  assert.ok(board.walls instanceof Set && board.wallsAlt instanceof Set);
  assert.ok(board.wallsAlt.size > 0);
  assert.notDeepEqual([...board.walls].sort(), [...board.wallsAlt].sort());
  // Every target keeps its corner pocket in both sets.
  for (const t of board.targets) {
    const near = (set) => [...set].some((w) => {
      const [cell] = w.split(':');
      const [x, y] = cell.split(',').map(Number);
      return Math.abs(x - t.x) + Math.abs(y - t.y) <= 1;
    });
    assert.equal(near(board.walls), true);
    assert.equal(near(board.wallsAlt), true);
  }
});

test('generateTiles places a full set on free cells', () => {
  const board = buildBoard({ robotCount: 4, seed: 11 });
  placeRobots(board);
  const tiles = generateTiles(board.targets, board.robots);
  assert.deepEqual(tiles.map((t) => t.kind).sort(), ['ice', 'ice', 'ice', 'ice', 'warpA', 'warpB', 'white', 'white']);
  const taken = new Set([...board.targets.map((t) => `${t.x},${t.y}`), ...board.robots.map((r) => `${r.x},${r.y}`)]);
  for (const t of tiles) {
    assert.equal(taken.has(`${t.x},${t.y}`), false);
    taken.add(`${t.x},${t.y}`);
  }
});

test('server ROUND payload carries tiles and both wall sets', () => {
  const room = createRoom('Ada', { robotCount: 4 });
  setupBoard(room);
  // Power tiles currently gated off (POWER_TILES_ENABLED=false): no tiles
  // in live games, but the generator itself still deals a full set.
  assert.deepEqual(room.tiles, []);
  const fresh = generateTiles(room.targets, room.startRobots.length ? room.startRobots : room.robotTemplate);
  assert.equal(fresh.length, 8);
  const payload = roundPayload(room);
  assert.deepEqual(payload.tiles, []);
  assert.ok(Array.isArray(payload.wallsAlt));
  assert.ok(payload.wallsAlt.length > 0);
});

test('findDeal hands solver terrain from tiles', () => {
  let gotOpts = null;
  findDeal(
    { ...dealCfg(), terrain: { ice: new Set(['1,1']), warps: new Map() } },
    { scatter: stubScatter, solver: (w, r, t, d, n, o) => { gotOpts = o; return 7; } },
  );
  assert.ok(gotOpts.ice instanceof Set);
  assert.ok(gotOpts.ice.has('1,1'));
});
