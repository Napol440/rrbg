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
 * @returns {{ walls:Set<string>, wallsAlt:Set<string>, targets:Array, robots:Array, seed:number }}
 * robots get placeholder (0,0) positions — call placeRobots() to scatter.
 * wallsAlt is the toggle-switch alternate set: same target pockets (targets
 * never move), different extra walls (one extra quarter-turn each).
 */
export function buildBoard({ seed, robotCount = 4, randomExtraWalls = false } = {}) {
  const useSeed = seed ?? Math.floor(Math.random() * 2 ** 31);
  const rand = mulberry32(useSeed);
  const targets = [];
  const pockets = [];
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
  const placements = QUADRANTS.map((q, qi) => {
    const [cx, cy] = corners[qi];
    return { q, qi, cx, cy, mirror: rand() < 0.5, rot: Math.floor(rand() * 4) };
  });
  const put = (p, lx, ly, ld, rotOffset = 0) => {
    const [tx, ty, td] = transformLocal(lx, ly, ld, p.mirror, (p.rot + rotOffset) % 4);
    return [p.cx * 8 + tx, p.cy * 8 + ty, td];
  };
  for (const p of placements) {
    for (const t of p.q.targets) {
      const [gx, gy] = put(p, t.x, t.y, 'N').slice(0, 2);
      // Skip anything that landed inside the center vault after rotation.
      if (isCenterCell(gx, gy)) continue;
      pockets.push({ qi: p.qi, lx: t.x, ly: t.y, corner: t.corner });
      targets.push({ id: `t${tid++}`, x: gx, y: gy, color: t.color, shape: t.shape });
    }
  }
  const emitSet = (rotOffset) => {
    const walls = new Set();
    // Target pockets are identical in both sets (targets never move); only
    // the extra walls rearrange.
    for (const pk of pockets) {
      const p = placements[pk.qi];
      for (const edge of pk.corner) {
        const [wx, wy, wd] = put(p, pk.lx, pk.ly, edge, 0);
        walls.add(`${wx},${wy}:${wd}`);
      }
    }
    for (const p of placements) {
      for (const [lx, ly, ld] of p.q.extraWalls) {
        const [gx, gy, gd] = put(p, lx, ly, ld, rotOffset);
        walls.add(`${gx},${gy}:${gd}`);
      }
    }
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
    return walls;
  };
  const walls = emitSet(0);
  const wallsAlt = emitSet(1);

  const colors = robotCount === 5 ? ROBOT_COLORS_5 : ROBOT_COLORS;
  const robots = colors.map((color, i) => ({ id: `r${i}`, color, x: 0, y: 0, dir: 'up' }));
  return { walls, wallsAlt, targets, robots, seed: useSeed };
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

/**
 * Pick `count` deck targets with DISTINCT colours, scanning forward from
 * deckPos (wrapping). Same-colour pairs would be uncompletable — one robot
 * per colour can only cover one cell — so duplicates are skipped.
 * Falls back to fewer targets if the deck lacks distinct colours.
 */
export function pickActiveTargets(targets, deck, deckPos, count) {
  const out = [];
  const seenColors = new Set();
  if (!deck.length) return out;
  for (let k = 0; k < deck.length && out.length < count; k++) {
    const t = targets[deck[(deckPos + k) % deck.length]];
    if (!t || seenColors.has(t.color)) continue;
    seenColors.add(t.color);
    out.push(t);
  }
  return out;
}

/**
 * Power tiles kill-switch: false shelves ice/warp/switch tiles (game plays
 * classic + powers). All tile logic stays wired so flipping this back on
 * restores everything — no other changes needed.
 */
export const POWER_TILES_ENABLED = false;

/**
 * Power tiles, fixed per game: 4 ice brakes, 1 warp pair, 2 white switches.
 * Scattered onto free cells (never targets/center/robots/each other).
 * White tiles flip to yellow (and back) as rockets land on them.
 */
export function generateTiles(targets, robots, rand = Math.random) {
  const taken = new Set([
    ...targets.map((t) => `${t.x},${t.y}`),
    ...robots.map((r) => `${r.x},${r.y}`),
  ]);
  const tiles = [];
  const put = (id, kind) => {
    for (let tries = 0; tries < 500; tries++) {
      const x = Math.floor(rand() * SIZE);
      const y = Math.floor(rand() * SIZE);
      const k = `${x},${y}`;
      if (isCenterCell(x, y) || taken.has(k)) continue;
      taken.add(k);
      tiles.push({ id, kind, x, y });
      return;
    }
  };
  for (let i = 0; i < 4; i++) put(`ice${i}`, 'ice');
  put('warpA', 'warpA');
  put('warpB', 'warpB');
  put('white0', 'white');
  put('white1', 'white');
  return tiles;
}

/**
 * Fresh scatter: every robot onto a free cell — never a target cell, never
 * the center vault, optionally never power-tile cells either. Rockets face
 * up until moved. Pure (mutates the passed array); shared by the reducer,
 * the rooms server, and the deal workers.
 */
export function scatterRobots(robots, targets, extraTaken = []) {
  const taken = new Set([...targets.map((t) => `${t.x},${t.y}`), ...extraTaken]);
  for (const r of robots) {
    for (let tries = 0; tries < 500; tries++) {
      const x = Math.floor(Math.random() * 16);
      const y = Math.floor(Math.random() * 16);
      const lockedCenter = x >= 7 && x <= 8 && y >= 7 && y <= 8;
      const k = `${x},${y}`;
      if (lockedCenter || taken.has(k)) continue;
      taken.add(k);
      r.x = x;
      r.y = y;
      r.dir = 'up';
      break;
    }
  }
  return robots;
}
