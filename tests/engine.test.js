// Legal-move validator tests: slide stops at edge/wall/robot/center, rejects
// zero-displacement slides. Run with: npm test  (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slide, legalMoves, solveMinMoves } from '../src/game/engine.js';

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

test('center vault blocks entry', () => {
  const r = slide(noWalls, bots([['a', 3, 7]]), 'a', 'right');
  assert.deepEqual([r.x, r.y], [6, 7]);
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
