// ─── Ricochet Robots: board generation ──────────────────────────────────────
// 16×16 board built from 4 hand-authored 8×8 quadrant tiles (classic style).
// Each new game: every quadrant is randomly mirrored + rotated, then placed
// into a random corner. Target tokens are dealt from a shuffled deck.
// Walls are stored as edge-flags "x,y:DIR" (see engine.js).
//
// Quadrant authoring convention: each quadrant lists
//   - extraWalls: [x, y, DIR] in LOCAL 0..7 coords (straight wall stubs), and
//   - targets: { x, y, color, shape, corner: [DIR, DIR] } — the two walls
//     forming the corner the target sits in are auto-generated from `corner`.

import { SIZE, isCenterCell } from './engine.js';

export const ROBOT_COLORS = ['red', 'blue', 'green', 'yellow'];
export const ROBOT_COLORS_5 = ['red', 'blue', 'green', 'yellow', 'silver'];
export const SHAPES = ['circle', 'triangle', 'square', 'hex'];

// Four tiles. Coords local 0..7. Kept deliberately asymmetric so rotation
// produces visibly different boards.
const QUADRANTS = [
  {
    targets: [
      { x: 1, y: 5, color: 'red', shape: 'circle', corner: ['N', 'W'] },
      { x: 5, y: 1, color: 'blue', shape: 'triangle', corner: ['S', 'E'] },
      { x: 6, y: 5, color: 'green', shape: 'square', corner: ['N', 'E'] },
      { x: 3, y: 2, color: 'yellow', shape: 'hex', corner: ['S', 'W'] },
    ],
    extraWalls: [
      [0, 3, 'S'], [2, 0, 'E'], [4, 4, 'N'], [4, 4, 'W'],
      [7, 2, 'W'], [1, 7, 'N'], [5, 6, 'E'], [6, 3, 'W'],
    ],
  },
  {
    targets: [
      { x: 2, y: 1, color: 'green', shape: 'triangle', corner: ['N', 'E'] },
      { x: 1, y: 4, color: 'yellow', shape: 'circle', corner: ['S', 'W'] },
      { x: 5, y: 6, color: 'red', shape: 'hex', corner: ['N', 'W'] },
      { x: 6, y: 3, color: 'blue', shape: 'square', corner: ['S', 'E'] },
    ],
    extraWalls: [
      [3, 0, 'W'], [7, 5, 'N'], [0, 2, 'E'], [4, 3, 'S'],
      [2, 6, 'E'], [5, 1, 'W'], [6, 7, 'N'], [3, 5, 'N'],
    ],
  },
  {
    targets: [
      { x: 4, y: 2, color: 'yellow', shape: 'square', corner: ['N', 'E'] },
      { x: 1, y: 6, color: 'blue', shape: 'hex', corner: ['S', 'W'] },
      { x: 6, y: 4, color: 'red', shape: 'triangle', corner: ['S', 'E'] },
      { x: 2, y: 3, color: 'green', shape: 'circle', corner: ['N', 'W'] },
    ],
    extraWalls: [
      [0, 4, 'S'], [5, 0, 'E'], [3, 6, 'N'], [7, 1, 'W'],
      [4, 5, 'W'], [1, 1, 'S'], [6, 6, 'W'], [2, 7, 'E'],
    ],
  },
  {
    targets: [
      { x: 3, y: 5, color: 'blue', shape: 'circle', corner: ['S', 'E'] },
      { x: 5, y: 2, color: 'red', shape: 'square', corner: ['N', 'W'] },
      { x: 1, y: 2, color: 'green', shape: 'hex', corner: ['N', 'E'] },
      { x: 6, y: 6, color: 'yellow', shape: 'triangle', corner: ['S', 'W'] },
    ],
    extraWalls: [
      [2, 0, 'W'], [0, 6, 'E'], [4, 4, 'S'], [7, 3, 'N'],
      [3, 1, 'E'], [5, 5, 'N'], [1, 4, 'W'], [6, 0, 'S'],
    ],
  },
];

const ROTATE_DIR = { N: 'E', E: 'S', S: 'W', W: 'N' };

// Mirror left-right, then rotate k×90° clockwise, inside an 8×8 tile.
function transformLocal(x, y, dir, mirror, rot) {
  let px = x;
  let py = y;
  let pd = dir;
  if (mirror) {
    px = 7 - px;
    if (pd === 'E') pd = 'W';
    else if (pd === 'W') pd = 'E';
  }
  for (let i = 0; i < rot; i++) {
    const nx = 7 - py;
    const ny = px;
    px = nx;
    py = ny;
    pd = ROTATE_DIR[pd];
  }
  return [px, py, pd];
}

function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let z = Math.imul(t ^ (t >>> 15), t | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a fresh board.
 * @param {object} opts { seed?, robotCount?: 4|5, randomExtraWalls?: boolean }
 * @returns {{ walls:Set<string>, targets:Array, robots:Array, seed:number }}
 * robots get placeholder (0,0) positions — call placeRobots() to scatter.
 */
export function buildBoard({ seed, robotCount = 4, randomExtraWalls = false } = {}) {
  const useSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
  const rand = mulberry32(useSeed);
  const walls = new Set();
  const targets = [];
  let tid = 0;

  // Randomly assign each authored quadrant to a board corner with its own
  // mirror + rotation, so every game looks different.
  const corners = shuffled(
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
    rand,
  );
  QUADRANTS.forEach((q, qi) => {
    const [cx, cy] = corners[qi];
    const mirror = rand() < 0.5;
    const rot = Math.floor(rand() * 4);
    const put = (lx, ly, ld) => {
      const [tx, ty, td] = transformLocal(lx, ly, ld, mirror, rot);
      return [cx * 8 + tx, cy * 8 + ty, td];
    };
    for (const t of q.targets) {
      const [gx, gy] = put(t.x, t.y, 'N').slice(0, 2);
      // Skip anything that landed inside the center vault after rotation.
      if (isCenterCell(gx, gy)) continue;
      for (const edge of t.corner) {
        const [wx, wy, wd] = put(t.x, t.y, edge);
        walls.add(`${wx},${wy}:${wd}`);
      }
      targets.push({ id: `t${tid++}`, x: gx, y: gy, color: t.color, shape: t.shape });
    }
    for (const [lx, ly, ld] of q.extraWalls) {
      const [gx, gy, gd] = put(lx, ly, ld);
      walls.add(`${gx},${gy}:${gd}`);
    }
  });

  // Optional chaos mode: sprinkle a few extra random L-corners.
  if (randomExtraWalls) {
    for (let i = 0; i < 10; i++) {
      const x = 1 + Math.floor(rand() * (SIZE - 2));
      const y = 1 + Math.floor(rand() * (SIZE - 2));
      if (isCenterCell(x, y)) continue;
      const e = ['N', 'S', 'E', 'W'][Math.floor(rand() * 4)];
      walls.add(`${x},${y}:${e}`);
    }
  }

  const colors = robotCount === 5 ? ROBOT_COLORS_5 : ROBOT_COLORS;
  const robots = colors.map((color, i) => ({ id: `r${i}`, color, x: 0, y: 0 }));
  return { walls, targets, robots, seed: useSeed };
}

/** Scatter robots on free cells (not center, not on a target, not stacked). */
export function placeRobots(board, rand = Math.random) {
  const taken = new Set(board.targets.map((t) => `${t.x},${t.y}`));
  for (const r of board.robots) {
    for (let tries = 0; tries < 500; tries++) {
      const x = Math.floor(rand() * SIZE);
      const y = Math.floor(rand() * SIZE);
      const k = `${x},${y}`;
      if (isCenterCell(x, y) || taken.has(k)) continue;
      taken.add(k);
      r.x = x;
      r.y = y;
      break;
    }
  }
  return board.robots;
}

/** Shuffled target deck (ids in deal order). */
export function makeDeck(targets, rand = Math.random) {
  const idx = targets.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}
