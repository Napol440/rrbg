// Race-mode tests: helpers, solution validation, reducer race flow,
// rooms-server round/race logic. Run with: npm test (node --test tests/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RACE_SECONDS, isBetterSolve, isOptimalSolve, validateSolution } from '../src/game/race.js';
import { gameReducer, initialState } from '../src/state/useGame.js';
import { createRoom, joinRoom, tickRoom, applySolution } from '../server/rooms.js';

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

// ─── validateSolution ───
// Board: red r0 at (0,2), target red at (5,2), wall '6,2:W' stops the slide ON it.

const WALLS = new Set(['6,2:W']);
const START = [
  { id: 'r0', color: 'red', x: 0, y: 2 },
  { id: 'r1', color: 'silver', x: 10, y: 10 },
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

test('server accepts first solve, steals on better, instant-wins optimal', () => {
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
