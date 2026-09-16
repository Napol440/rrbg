// Legal-move validator tests: slide stops at edge/wall/robot/center, rejects
// zero-displacement slides. Run with: npm test  (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slide, legalMoves, solveMinMoves, adjacentWallKey, deriveBoard, chargesUsed, terrainOpts, moveCost, distinctRobots, solveConstrainedMinMoves, MIN_HARD_ROBOTS } from '../src/game/engine.js';

const noWalls = new Set();
const bots = (list) => list.map(([id, x, y], i) => ({ id, x, y, color: ['red', 'blue'][i] ?? 'red' }));

test('slides to board edge with no walls', () => {
  const r = slide(noWalls, bots([['a', 3, 5]]), 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved], [15, 5, true]);
});

test('zero-displacement slide is illegal', () => {
  const r = slide(noWalls, bots([['a', 0, 0]]), 'a', 'left');
  assert.equal(r.moved, false);
});

test('wall on current edge stops the robot', () => {
  const walls = new Set(['3,5:E']);
  const r = slide(walls, bots([['a', 3, 5]]), 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved], [3, 5, false]);
});

test('wall on neighbour opposite edge stops the robot', () => {
  const walls = new Set(['4,5:W']);
  const r = slide(walls, bots([['a', 3, 5]]), 'a', 'right');
  assert.deepEqual([r.x, r.y], [3, 5]);
});

test('another robot blocks the slide', () => {
  const r = slide(noWalls, bots([['a', 3, 5], ['b', 6, 5]]), 'a', 'right');
  assert.deepEqual([r.x, r.y], [5, 5]);
});

test('walled core stops all four approaches like a wall', () => {
  const r = slide(noWalls, bots([['a', 3, 7]]), 'a', 'right'); // west side
  assert.deepEqual([r.x, r.y, r.moved, r.endDir], [6, 7, true, 'right']);
  const d = slide(noWalls, bots([['a', 7, 3]]), 'a', 'down'); // north side
  assert.deepEqual([d.x, d.y, d.endDir], [7, 6, 'down']);
  const l = slide(noWalls, bots([['a', 12, 8]]), 'a', 'left'); // east side
  assert.deepEqual([l.x, l.y, l.endDir], [9, 8, 'left']);
  const u = slide(noWalls, bots([['a', 8, 12]]), 'a', 'up'); // south side
  assert.deepEqual([u.x, u.y, u.endDir], [8, 9, 'up']);
});

test('a wall before the center still stops the slide', () => {
  const walls = new Set(['6,7:E']);
  const r = slide(walls, bots([['a', 3, 7]]), 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved, r.endDir], [6, 7, true, 'right']);
});

test('plain slides keep their commanded facing', () => {
  const r = slide(noWalls, bots([['a', 0, 0]]), 'a', 'right');
  assert.equal(r.endDir, 'right');
});

test('robots block blue and silver mid-slide like everyone else', () => {
  const blue = [{ id: 'a', color: 'blue', x: 0, y: 5 }, { id: 'b', color: 'red', x: 6, y: 5 }];
  assert.deepEqual([slide(noWalls, blue, 'a', 'right').x, slide(noWalls, blue, 'a', 'right').y], [5, 5]);
  const silver = [{ id: 'a', color: 'silver', x: 3, y: 5 }, { id: 'b', color: 'red', x: 6, y: 5 }];
  assert.deepEqual([slide(noWalls, silver, 'a', 'right').x, slide(noWalls, silver, 'a', 'right').y], [5, 5]);
});

test('silver still blocks everyone else', () => {
  const red = [{ id: 'a', color: 'red', x: 3, y: 5 }, { id: 'b', color: 'silver', x: 6, y: 5 }];
  assert.deepEqual([slide(noWalls, red, 'a', 'right').x, slide(noWalls, red, 'a', 'right').y], [5, 5]);
});

test('blue ramming an adjacent wall phases through and keeps sliding', () => {
  // Both wall-key spellings phase; the slide continues to the edge.
  assert.deepEqual(
    [slide(new Set(['6,2:W']), [{ id: 'a', color: 'blue', x: 5, y: 2 }], 'a', 'right').x],
    [15],
  );
  const own = slide(new Set(['5,2:E']), [{ id: 'a', color: 'blue', x: 5, y: 2 }], 'a', 'right');
  assert.deepEqual([own.x, own.y, own.moved], [15, 2, true]);
  // Red ramming the same wall is just illegal.
  assert.equal(slide(new Set(['6,2:W']), [{ id: 'a', color: 'red', x: 5, y: 2 }], 'a', 'right').moved, false);
});

test('blue ramming an adjacent robot phases through and keeps sliding', () => {
  const r = slide(noWalls, [{ id: 'a', color: 'blue', x: 3, y: 5 }, { id: 'q', color: 'red', x: 4, y: 5 }], 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved], [15, 5, true]);
  assert.ok(r.trail.some((c) => c.x === 4 && c.y === 5)); // passed through red
});

test('blue phases exactly once per slide', () => {
  // Two walls ahead: phases the first, stops normally at the second.
  const walls = new Set(['6,2:W', '10,2:W']);
  const r = slide(walls, [{ id: 'a', color: 'blue', x: 5, y: 2 }], 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved], [9, 2, true]);
});

test('blue phase fizzles instead of stacking or leaving the board', () => {
  // Walled in directly behind the phased robot → ends stacked → illegal.
  const trap = slide(new Set(['5,5:W']), [{ id: 'a', color: 'blue', x: 3, y: 5 }, { id: 'q', color: 'red', x: 4, y: 5 }], 'a', 'right');
  assert.equal(trap.moved, false);
  // Board edge and center vault have nothing to phase through → illegal.
  assert.equal(slide(noWalls, [{ id: 'a', color: 'blue', x: 0, y: 0 }], 'a', 'left').moved, false);
  assert.equal(slide(noWalls, [{ id: 'a', color: 'blue', x: 6, y: 7 }], 'a', 'right').moved, false);
});

test('moveCost: silver slides cost 0.5, everyone else 1', () => {
  assert.equal(moveCost('silver'), 0.5);
  assert.equal(moveCost('blue'), 1);
  assert.equal(moveCost('red'), 1);
  assert.equal(moveCost('green'), 1);
  assert.equal(moveCost('yellow'), 1);
});

test('yellow slides normally (no wall-stop penalty)', () => {
  const botsY = [{ id: 'a', color: 'yellow', x: 0, y: 0 }];
  const r = slide(noWalls, botsY, 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved, r.endDir], [15, 0, true, 'right']);
});

test('yellow wall stops end on the wall like everyone else', () => {
  // Wall '6,2:W' ends the run on (5,2) — no rebound.
  const walls = new Set(['6,2:W']);
  const r = slide(walls, [{ id: 'a', color: 'yellow', x: 0, y: 2 }], 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved, r.endDir], [5, 2, true, 'right']);
  // Edge and robot stops are unchanged.
  const e = slide(noWalls, [{ id: 'a', color: 'yellow', x: 0, y: 0 }], 'a', 'right');
  assert.deepEqual([e.x, e.y], [15, 0]);
  const b = slide(noWalls, [{ id: 'a', color: 'yellow', x: 3, y: 5 }, { id: 'q', color: 'red', x: 6, y: 5 }], 'a', 'right');
  assert.deepEqual([b.x, b.y], [5, 5]);
});

test('yellow ramming an adjacent wall steps back instead of illegal', () => {
  const walls = new Set(['5,2:E']);
  const r = slide(walls, [{ id: 'a', color: 'yellow', x: 5, y: 2 }], 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved, r.endDir], [4, 2, true, 'left']);
  // Nowhere to retreat (board edge behind) → still illegal.
  const w2 = new Set(['0,0:E']);
  const stuck = slide(w2, [{ id: 'a', color: 'yellow', x: 0, y: 0 }], 'a', 'right');
  assert.equal(stuck.moved, false);
  // Red ramming the same wall is just illegal (no retreat, no breach here).
  const red = slide(walls, [{ id: 'a', color: 'red', x: 5, y: 2 }], 'a', 'right');
  assert.equal(red.moved, false);
});

test('green-block terrain stops everyone including blue', () => {
  const opts = { blocked: new Set(['5,5']) };
  const red = [{ id: 'a', color: 'red', x: 3, y: 5 }];
  const blue = [{ id: 'a', color: 'blue', x: 3, y: 5 }];
  assert.deepEqual([slide(noWalls, red, 'a', 'right', opts).x], [4]);
  assert.deepEqual([slide(noWalls, blue, 'a', 'right', opts).x], [4]);
});

test('adjacentWallKey finds both key spellings, rejects non-walls', () => {
  assert.equal(adjacentWallKey(new Set(['3,5:E']), 3, 5, 'right'), '3,5:E');
  assert.equal(adjacentWallKey(new Set(['4,5:W']), 3, 5, 'right'), '4,5:W');
  assert.equal(adjacentWallKey(new Set(), 3, 5, 'right'), null);
  assert.equal(adjacentWallKey(new Set(['3,5:E']), 3, 5, 'left'), null);
  assert.equal(adjacentWallKey(new Set(['0,0:W']), 0, 0, 'left'), '0,0:W'); // board edge wall still a key
});

test('deriveBoard and chargesUsed track power history', () => {
  const base = new Set(['3,5:E', '9,9:N']);
  const hist = [
    { kind: 'slide', robotId: 'r0', dir: 'right' },
    { kind: 'breach', robotId: 'r0', wallKey: '3,5:E' },
    { kind: 'block', robotId: 'r1', wallKey: '9,9:N', x: 9, y: 8 },
  ];
  const { walls, blocks } = deriveBoard(base, hist);
  assert.equal(walls.has('3,5:E'), false);
  assert.equal(walls.has('9,9:N'), true);
  assert.deepEqual([...blocks], ['9,8']);
  assert.deepEqual(chargesUsed(hist), { breach: 1, block: 1 });
  assert.deepEqual(chargesUsed([]), { breach: 0, block: 0 });
});

test('walled core blocks like classic walls', () => {
  const r = slide(noWalls, bots([['a', 3, 7]]), 'a', 'right');
  assert.deepEqual([r.x, r.y, r.moved, r.endDir], [6, 7, true, 'right']);
  // Solver routes around the core.
  const bots1 = [{ id: 'r0', color: 'red', x: 3, y: 7 }];
  const target = { x: 6, y: 0, color: 'red' };
  assert.equal(solveMinMoves(noWalls, bots1, target), 2);
});

test('legalMoves excludes stuck robots', () => {
  // Single robot in open board: all 4 directions move (to an edge).
  const moves = legalMoves(noWalls, bots([['a', 5, 5]]));
  assert.equal(moves.length, 4);
});

test('solver finds a 1-move solution', () => {
  // Red robot shares row 2 with its target; a wall stops it ON the target.
  // (Without the wall it would slide straight past — no mid-slide stops.)
  const walls = new Set(['6,2:W']);
  const robots = [{ id: 'r0', color: 'red', x: 0, y: 2 }];
  const target = { x: 5, y: 2, color: 'red' };
  assert.equal(solveMinMoves(walls, robots, target), 1);
});

test('solver returns null when target colour has no robot', () => {
  const robots = [{ id: 'r0', color: 'blue', x: 0, y: 0 }];
  assert.equal(solveMinMoves(noWalls, robots, { x: 5, y: 5, color: 'red' }), null);
});

// ─── power tiles: ice brakes, warp gates ───

test('ice brake ends the slide on entry', () => {
  const ice = terrainOpts([{ id: 'i0', kind: 'ice', x: 5, y: 0 }]);
  const r = slide(noWalls, bots([['a', 0, 0]]), 'a', 'right', ice);
  assert.deepEqual([r.x, r.y, r.moved], [5, 0, true]);
});

test('warp gate teleports and keeps sliding', () => {
  const t = terrainOpts([
    { id: 'wA', kind: 'warpA', x: 3, y: 0 },
    { id: 'wB', kind: 'warpB', x: 10, y: 7 },
  ]);
  const r = slide(noWalls, bots([['a', 0, 0]]), 'a', 'right', t);
  assert.deepEqual([r.x, r.y, r.moved], [15, 7, true]);
});

test('warp with blocked exit stops before entry', () => {
  const t = terrainOpts([
    { id: 'wA', kind: 'warpA', x: 3, y: 0 },
    { id: 'wB', kind: 'warpB', x: 10, y: 7 },
  ]);
  const r = slide(noWalls, bots([['a', 0, 0], ['b', 10, 7]]), 'a', 'right', t);
  assert.deepEqual([r.x, r.y, r.moved], [2, 0, true]);
});

test('solver rides warps and brakes on ice', () => {
  const t = terrainOpts([
    { id: 'wA', kind: 'warpA', x: 3, y: 0 },
    { id: 'wB', kind: 'warpB', x: 10, y: 7 },
  ]);
  const robots = [{ id: 'r0', color: 'red', x: 0, y: 0 }];
  assert.equal(solveMinMoves(noWalls, robots, { x: 15, y: 7, color: 'red' }, 9, 120000, t), 1);
  const ice = terrainOpts([{ id: 'i0', kind: 'ice', x: 5, y: 0 }]);
  assert.equal(solveMinMoves(noWalls, robots, { x: 5, y: 0, color: 'red' }, 9, 120000, ice), 1);
});

// ─── hard mode: distinct rockets ───

test('distinctRobots counts movers once each (rams count)', () => {
  assert.equal(MIN_HARD_ROBOTS, 3);
  assert.deepEqual(distinctRobots([
    { kind: 'slide', robotId: 'r0', dir: 'right' },
    { kind: 'slide', robotId: 'r0', dir: 'up' },
    { kind: 'breach', robotId: 'r1', wallKey: '1,1:N' },
  ]), ['r0', 'r1']);
  assert.deepEqual(distinctRobots([]), []);
  assert.deepEqual(distinctRobots([{ dir: 'right' }]), []);
});

test('constrained solver demands 3+ rockets in the line', () => {
  // 1-move wall setup, single robot present: impossible under the constraint.
  const walls = new Set(['6,2:W']);
  const solo = [{ id: 'r0', color: 'red', x: 0, y: 2 }];
  const target = { x: 5, y: 2, color: 'red' };
  assert.equal(solveMinMoves(walls, solo, target), 1);
  assert.equal(solveConstrainedMinMoves(walls, solo, target, 3), null);
  // Open board: 2-move solve exists, but the 3-rocket minimum costs a move.
  const crew = [
    { id: 'r0', color: 'red', x: 0, y: 0 },
    { id: 'r1', color: 'blue', x: 5, y: 5 },
  ];
  assert.equal(solveMinMoves(noWalls, crew, { x: 15, y: 15, color: 'red' }), 2);
  assert.equal(solveConstrainedMinMoves(noWalls, crew, { x: 15, y: 15, color: 'red' }, 3), null);
  // 2-robot minimum still costs a move: r1 wiggle + the 2-move solve.
  assert.equal(solveConstrainedMinMoves(noWalls, crew, { x: 15, y: 15, color: 'red' }, 2), 3);
});

test('constrained solver finds the cheapest 3-rocket line', () => {
  const crew = [
    { id: 'r0', color: 'red', x: 0, y: 0 },
    { id: 'r1', color: 'blue', x: 5, y: 5 },
    { id: 'r2', color: 'green', x: 9, y: 9 },
  ];
  // Wasteful r1/r2 wiggles + the 2-move solve = 4 with all three involved.
  assert.equal(solveConstrainedMinMoves(noWalls, crew, { x: 15, y: 15, color: 'red' }, 3), 4);
});
