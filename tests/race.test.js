// Race-mode tests: helpers, solution validation, reducer race flow,
// rooms-server round/race logic. Run with: npm test (node --test tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RACE_SECONDS, isBetterSolve, isOptimalSolve, validateSolution, meetsMinPar, MIN_ROUND_PAR } from '../src/game/race.js';
import { isSolved, isMultiSolved, solvePath } from '../src/game/engine.js';
import { gameReducer, initialState, activeTargets } from '../src/state/useGame.js';
import { createRoom, joinRoom, tickRoom, applySolution, applyGiveUp, updateConfig, removePlayer } from '../server/rooms.js';

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
  assert.deepEqual(v, { ok: true, moves: 1 });
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
  assert.equal(s.roster.p0.movesUsed, 2);
  s = move(s, 'r0', 'right'); // solves in 3
  assert.equal(s.phase, 'race');
  assert.deepEqual([s.race.leaderId, s.race.bestMoves, s.race.timeLeft], ['p0', 3, RACE_SECONDS]);
  assert.equal(s.roster.p0.solved, true);
  assert.equal(s.roster.p0.best, 3);
});

test('smaller solve steals the lead and restarts the clock; worse is ignored', () => {
  let s = craftState(null);
  s = move(s, 'r1', 'down');
  s = move(s, 'r1', 'up');
  s = move(s, 'r0', 'right'); // p0 leads with 3
  s = tick(s, 2);
  assert.equal(s.race.timeLeft, RACE_SECONDS - 2);
  s = gameReducer(s, { type: 'VIEW_AS', playerId: 'p1' });
  s = move(s, 'r0', 'right'); // p1 solves in 1
  assert.deepEqual([s.race.leaderId, s.race.bestMoves, s.race.timeLeft], ['p1', 1, RACE_SECONDS]);
  // p0 resets and re-solves in 3 — worse than 1, race untouched.
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
  // par is 1 here but p0 wastes two blocker moves first → 3 moves, not optimal.
  let s = craftState(1);
  s = move(s, 'r1', 'down');
  s = move(s, 'r1', 'up');
  s = move(s, 'r0', 'right');
  assert.equal(s.phase, 'race');
  assert.deepEqual([s.race.leaderId, s.race.bestMoves], ['p0', 3]);
  assert.equal(s.lastResult, null);
});

test('reset restores the round start with zero moves', () => {
  let s = craftState(null);
  s = move(s, 'r1', 'down');
  assert.equal(s.roster.p0.movesUsed, 1);
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
  assert.deepEqual([s.sandboxes.p0.movesUsed, s.sandboxes.p0.history.length], [1, 1]);
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
  assert.equal(st.sandboxes.p0.movesUsed, 2);
  assert.equal(st.sandboxes.p0.history.length, 2);
});

test('interleaved robots do not cancel', () => {
  let s = craftCorridor();
  s = move(s, 'r1', 'down'); // [1] last: r1
  s = move(s, 'r0', 'up'); // [2] last: r0 (0,2)→(0,0)
  s = move(s, 'r1', 'up'); // r1 returns, but last entry is r0 → counts
  assert.equal(s.sandboxes.p0.movesUsed, 3);
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
  assert.deepEqual(validateSolution(new Set(), [{ id: 'r0', color: 'red', x: 0, y: 0 }], { x: 15, y: 15, color: 'red' }, open), { ok: true, moves: 2 });
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
    { ok: true, moves: 1 },
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
  assert.deepEqual([s.lastResult.winnerId, s.lastResult.movesUsed], ['p0', 3]);
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
  s = move(s, 'r1', 'down'); // silver home too → solved in 2
  assert.equal(s.phase, 'race');
  assert.deepEqual([s.race.leaderId, s.race.bestMoves], ['p0', 2]);
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

test('deck advances by target count each round', () => {
  const dummies = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, x: i, y: 0, color: 'red', shape: 'circle' }));
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
  assert.equal(full.race.bestMoves, 2);
});
