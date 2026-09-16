// ─── Rocket Rebound: movement engine (pure logic, no React) ─────────────────
// Board model: 16x16 cells, coords 0..15. Walls live on CELL EDGES, stored as
// strings "x,y:DIR" where DIR is the edge of cell (x,y) — N/S/E/W.
//   - Board outer border is implicit (no stored walls needed).
//   - The center 2x2 block [(7,7),(8,7),(7,8),(8,8)] is walled and
//     impassable: slides stop before it like any wall.
// Robots slide until a wall, the board edge, or another robot. They can
// never stop mid-slide (except on a detected loop, which ends the slide).
// Blue alone may phase through a single adjacent ram blocker per slide.

export const SIZE = 16;

// Center 2x2 vault (classic rules: robots can't enter or pass through).
export function isCenterCell(x, y) {
  return x >= 7 && x <= 8 && y >= 7 && y <= 8;
}

export function inBounds(x, y) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

export function isBlockedCell(x, y) {
  return !inBounds(x, y) || isCenterCell(x, y);
}

// ─── Ram powers (red breach, green block) ───────────────────────────────────
// Trigger: a slide that would be ILLEGAL purely because of an immediately
// adjacent real wall segment (no arming UI — ramming is detected, not aimed).

/**
 * Wall segment key blocking (x,y) heading dir, or null (edge/center/robot).
 * Covers both key representations (own edge or neighbor opposite edge).
 */
export function adjacentWallKey(walls, x, y, dir) {
  const d = DIRS[dir];
  if (!d) return null;
  const own = `${x},${y}:${d.edge}`;
  if (walls.has(own)) return own;
  const nx = x + d.dx;
  const ny = y + d.dy;
  if (!inBounds(nx, ny) || isCenterCell(nx, ny)) return null;
  const far = `${nx},${ny}:${d.opposite}`;
  if (walls.has(far)) return far;
  return null;
}

/** Cell directly behind (x, y) relative to heading dir (opposite the ram). */
export function behindCell(x, y, dir) {
  const d = DIRS[dir];
  return { x: x - d.dx, y: y - d.dy };
}

const BACK_EDGE = { N: 'S', S: 'N', E: 'W', W: 'E' };
const EDGE_STEP = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

/** Copy of a wall set minus the given segment keys (both representations). */
export function withoutWalls(walls, keys) {
  const out = new Set(walls);
  for (const key of keys) {
    const [cell, edge] = key.split(':');
    const [x, y] = cell.split(',').map(Number);
    const step = EDGE_STEP[edge];
    if (!step) continue;
    out.delete(key);
    out.delete(`${x + step[0]},${y + step[1]}:${BACK_EDGE[edge]}`);
  }
  return out;
}

/**
 * Derive live board terrain from a sandbox history.
 * @returns {{walls:Set, blocks:Set}} effective walls (breaches removed) and
 *   green-block "x,y" cells (impassable terrain for everyone, even blue).
 */
export function deriveBoard(baseWalls, history) {
  const broken = [];
  const blocks = [];
  for (const h of history ?? []) {
    if (h.kind === 'breach') broken.push(h.wallKey);
    else if (h.kind === 'block') blocks.push(`${h.x},${h.y}`);
  }
  return { walls: withoutWalls(baseWalls, broken), blocks: new Set(blocks) };
}

/** Power charges spent in a history ({breach, block}, each capped at 1). */
export function chargesUsed(history) {
  let breach = 0;
  let block = 0;
  for (const h of history ?? []) {
    if (h.kind === 'breach') breach += 1;
    else if (h.kind === 'block') block += 1;
  }
  return { breach, block };
}

export const DIRS = {
  up: { dx: 0, dy: -1, edge: 'N', opposite: 'S' },
  down: { dx: 0, dy: 1, edge: 'S', opposite: 'N' },
  left: { dx: -1, dy: 0, edge: 'W', opposite: 'E' },
  right: { dx: 1, dy: 0, edge: 'E', opposite: 'W' },
};

/** True if cell (x,y) has a wall on its `edge` ('N'|'S'|'E'|'W'). */
export function hasWall(walls, x, y, edge) {
  return walls.has(`${x},${y}:${edge}`);
}

/**
 * Slide one robot until it must stop.
 * @param {Set<string>} walls  edge-wall set from board.js
 * @param {Array<{id:string,x:number,y:number}>} robots  all robot positions
 * @param {string} robotId
 * @param {'up'|'down'|'left'|'right'} dir commanded direction
 * @param {object} opts {blocked, ice, warps} (all optional terrain)
 *   `blocked` holds "x,y" green-block cells (stop everyone, even blue);
 *   `ice` holds brake-pad cells (slides end ON entry); `warps` maps "x,y"
 *   to its pair destination (teleport + keep sliding, same move).
 * @returns {{x:number,y:number,moved:boolean,cells:number,trail:Array,endDir:string}}
 *   stop cell. `moved:false` means the slide is ILLEGAL (zero displacement)
 *   and the caller must reject it without counting a move. `trail` lists
 *   every traversed cell (for pass-through collection). `endDir` is the
 *   final heading, for sprite facing.
 *   Rocket powers, intrinsic to color: blue may phase through ONE adjacent
 *   blocker per slide — a real wall segment or a robot — when ramming it,
 *   then keeps sliding (mid-slide robots block blue like everyone else);
 *   yellow slides normally, except that ramming an adjacent wall steps one
 *   tile back instead of being illegal. Silver has no power at all; its
 *   slides just cost 0.5 moves (see moveCost).
 */
export function slide(walls, robots, robotId, dir, opts = {}) {
  if (!DIRS[dir]) throw new Error(`bad direction: ${dir}`);
  const blocked = opts.blocked;
  const ice = opts.ice;
  const warps = opts.warps;
  const me = robots.find((r) => r.id === robotId);
  if (!me) throw new Error(`unknown robot: ${robotId}`);
  let occupied = new Set(
    robots.filter((r) => r.id !== robotId).map((r) => `${r.x},${r.y}`),
  );
  const startOccupied = new Set(occupied);
  let liveWalls = walls;
  // Blue ram-phase: a single adjacent blocker per slide is phased through,
  // then the slide continues with normal stopping rules.
  let phase = me.color === 'blue' ? 1 : 0;
  const d0 = DIRS[dir];
  let heading = dir;
  let { x, y } = me;
  let cells = 0;
  let stoppedBy = null; // 'wall' | 'edge' | 'robot' | 'loop'
  const trail = [];
  const visited = new Set();
  for (;;) {
    const d = DIRS[heading];
    const here = `${x},${y}:${heading}`;
    if (visited.has(here)) { stoppedBy = 'loop'; break; }
    visited.add(here);
    // A wall on our current edge stops us before leaving this cell.
    if (hasWall(liveWalls, x, y, d.edge)) {
      const key = phase > 0 && cells === 0 ? adjacentWallKey(liveWalls, x, y, heading) : null;
      if (key) {
        liveWalls = withoutWalls(liveWalls, [key]);
        phase = 0;
        visited.delete(here); // re-evaluate this heading with the wall gone
        continue;
      }
      stoppedBy = 'wall'; break;
    }
    const nx = x + d.dx;
    const ny = y + d.dy;
    // Board edge stops us; the walled 2×2 core stops us like a wall.
    if (!inBounds(nx, ny)) { stoppedBy = 'edge'; break; }
    if (isCenterCell(nx, ny)) { stoppedBy = 'wall'; break; }
    if (hasWall(liveWalls, nx, ny, d.opposite)) {
      const key = phase > 0 && cells === 0 ? adjacentWallKey(liveWalls, x, y, heading) : null;
      if (key) {
        liveWalls = withoutWalls(liveWalls, [key]);
        phase = 0;
        visited.delete(here); // re-evaluate this heading with the wall gone
        continue;
      }
      stoppedBy = 'wall'; break;
    }
    if (blocked?.has(`${nx},${ny}`)) { stoppedBy = 'wall'; break; }
    if (occupied.has(`${nx},${ny}`)) {
      // Blue rams the adjacent robot like a wall: phase through it once,
      // then keep sliding. Mid-slide robots block blue normally.
      if (phase > 0 && cells === 0) {
        occupied = new Set(occupied);
        occupied.delete(`${nx},${ny}`);
        phase = 0;
        visited.delete(here); // re-evaluate this heading with the robot ghosted
        continue;
      }
      stoppedBy = 'robot'; break;
    }
    const warpTo = warps?.get(`${nx},${ny}`);
    if (warpTo && occupied.has(`${warpTo.x},${warpTo.y}`)) { stoppedBy = 'robot'; break; }
    x = nx;
    y = ny;
    cells += 1;
    trail.push({ x, y });
    if (warpTo) {
      if (!inBounds(warpTo.x, warpTo.y) || isCenterCell(warpTo.x, warpTo.y)) { stoppedBy = 'wall'; break; }
      x = warpTo.x;
      y = warpTo.y;
      trail.push({ x, y });
      continue;
    }
    if (ice?.has(`${x},${y}`)) { stoppedBy = 'wall'; break; }
  }
  if (cells === 0) {
    // Yellow's only power: ramming an adjacent wall moves one tile back
    // (away from the wall) instead of being illegal, whenever that
    // retreat cell is free. Wall stops after a real slide end normally.
    if (me.color === 'yellow' && stoppedBy === 'wall') {
      const bx = x - d0.dx;
      const by = y - d0.dy;
      const back = DIRS[{ up: 'down', down: 'up', left: 'right', right: 'left' }[dir]];
      const clear =
        inBounds(bx, by) && !isCenterCell(bx, by) &&
        !hasWall(liveWalls, x, y, back.edge) && !hasWall(liveWalls, bx, by, back.opposite) &&
        !occupied.has(`${bx},${by}`) && !blocked?.has(`${bx},${by}`);
      if (clear) {
        const opp = { up: 'down', down: 'up', left: 'right', right: 'left' }[dir];
        return { x: bx, y: by, moved: true, cells: 0, trail: [{ x: bx, y: by }], endDir: opp };
      }
    }
    return { x, y, moved: false, cells, trail, endDir: heading };
  }
  // A blue phase may not finish stacked on the robot it passed through
  // (e.g. walled in right behind it) — that ram fizzles as illegal.
  if (startOccupied.has(`${x},${y}`)) {
    return { x: me.x, y: me.y, moved: false, cells, trail, endDir: heading };
  }
  return { x, y, moved: true, cells, trail, endDir: heading };
}

/** Move-meter cost of one slide: silver is cheap (0.5), everyone else 1. */
export function moveCost(color) {
  return color === 'silver' ? 0.5 : 1;
}

/** All legal slides from a position: every (robot, dir) with moved===true. */
export function legalMoves(walls, robots, opts = {}) {
  const out = [];
  for (const r of robots) {
    for (const dir of Object.keys(DIRS)) {
      const s = slide(walls, robots, r.id, dir, opts);
      if (s.moved) out.push({ robotId: r.id, dir, x: s.x, y: s.y });
    }
  }
  return out;
}

/** Goal test: matching-colour robot sits on the active target cell. */
export function isSolved(robots, target) {
  if (!target) return false;
  const bot = robots.find((r) => r.color === target.color);
  return !!bot && bot.x === target.x && bot.y === target.y;
}

/**
 * Slide terrain from a tile list: brake-pad cells + paired warp gates.
 * White/yellow switch tiles are flip triggers (reducer level), not physics.
 */
export function terrainOpts(tiles) {
  const ice = new Set();
  const warps = new Map();
  const ends = {};
  for (const t of tiles ?? []) {
    if (t.kind === 'ice') ice.add(`${t.x},${t.y}`);
    else if (t.kind === 'warpA') ends.A = t;
    else if (t.kind === 'warpB') ends.B = t;
  }
  if (ends.A && ends.B) {
    warps.set(`${ends.A.x},${ends.A.y}`, { x: ends.B.x, y: ends.B.y });
    warps.set(`${ends.B.x},${ends.B.y}`, { x: ends.A.x, y: ends.A.y });
  }
  return { ice, warps };
}

/** Multi-target goal: EVERY active target covered simultaneously. */
export function isMultiSolved(robots, targets) {
  if (!targets || targets.length === 0) return false;
  return targets.every((t) => {
    const bot = robots.find((r) => r.color === t.color);
    return !!bot && bot.x === t.x && bot.y === t.y;
  });
}

/** Single target covered right now (multi-target collection check). */
export function covers(robots, target) {
  if (!target) return false;
  const bot = robots.find((r) => r.color === target.color);
  return !!bot && bot.x === target.x && bot.y === target.y;
}

/** Collection complete: every active target id was touched at least once. */
export function collectionComplete(collected, targets) {
  if (!targets || targets.length === 0) return false;
  const have = new Set(collected ?? []);
  return targets.every((t) => have.has(t.id));
}

// ─── Solver (BFS over joint robot positions) ────────────────────────────────
// Used for: (a) par hints, (b) optimal instant-win threshold, (c) showing the
// answer when everyone gives up. Branching is ≤ 4×robots; depth/node caps
// keep it fast. Level-by-level BFS returns the true minimum when found.
// Returns null if not found within caps (NOT a proof of unsolvability).

export function solveMinMoves(walls, robots, target, maxDepth = 9, maxNodes = 120000, opts = {}) {
  const path = solvePath(walls, robots, target, maxDepth, maxNodes, opts);
  return path ? path.length : null;
}

/** Hard mode: a solve must use this many distinct rockets to count. */
export const MIN_HARD_ROBOTS = 3;

/** Distinct robot ids used in a move list (ram entries count — they moved). */
export function distinctRobots(moves) {
  return [...new Set((moves ?? []).map((m) => m.robotId).filter(Boolean))];
}

/**
 * Fewest moves solving with at least minRobots distinct rockets (hard mode
 * deal check). Unlike the main solver this one carries colors, so intrinsic
 * powers (blue/silver phase, yellow retreat) are modeled; ram powers are not
 * (they void par instead). Null within caps, like the main solver.
 */
export function solveConstrainedMinMoves(walls, robots, target, minRobots = 3, maxDepth = 9, maxNodes = 120000, opts = {}) {
  if (!target) return null;
  const ids = robots.map((r) => r.id);
  const colors = robots.map((r) => r.color);
  const goalIdx = robots.findIndex((r) => r.color === target.color);
  if (goalIdx === -1) return null;
  const start = robots.map((r) => ({ x: r.x, y: r.y }));
  const posKey = (p) => p.map((q) => `${q.x},${q.y}`).join('|');
  const seen = new Set([`${posKey(start)}|`]);
  let frontier = [{ pos: start, used: [] }];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next = [];
    for (const node of frontier) {
      const { pos, used } = node;
      const asRobots = ids.map((id, i) => ({ id, color: colors[i], x: pos[i].x, y: pos[i].y }));
      if (pos[goalIdx].x === target.x && pos[goalIdx].y === target.y && used.length >= minRobots) return depth;
      if (depth === maxDepth) continue;
      for (let i = 0; i < ids.length; i++) {
        for (const dir of Object.keys(DIRS)) {
          const s = slide(walls, asRobots, ids[i], dir, opts);
          if (!s.moved) continue;
          const np = pos.map((p, j) => (j === i ? { x: s.x, y: s.y } : p));
          const nused = used.includes(ids[i]) ? used : [...used, ids[i]];
          const key = `${posKey(np)}|${[...nused].sort().join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > maxNodes) return null;
          next.push({ pos: np, used: nused });
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) return null;
  }
  return null;
}

/**
 * Shortest legal move list solving the target, or null within caps.
 * @returns {Array<{robotId:string,dir:string}>|null}
 */
export function solvePath(walls, robots, target, maxDepth = 9, maxNodes = 120000, opts = {}) {
  if (!target) return null;
  const ids = robots.map((r) => r.id);
  const startKey = ids.map((id) => {
    const r = robots.find((q) => q.id === id);
    return `${r.x},${r.y}`;
  }).join('|');
  // Goal: target-coloured robot on target cell. Find that robot's index.
  const goalIdx = robots.findIndex((r) => r.color === target.color);
  if (goalIdx === -1) return null;

  const start = robots.map((r) => ({ x: r.x, y: r.y }));
  const seen = new Set([startKey]);
  let frontier = [{ pos: start, path: [] }];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next = [];
    for (const node of frontier) {
      const { pos, path } = node;
      const asRobots = ids.map((id, i) => ({ id, x: pos[i].x, y: pos[i].y }));
      if (pos[goalIdx].x === target.x && pos[goalIdx].y === target.y) return path;
      if (depth === maxDepth) continue;
      for (let i = 0; i < ids.length; i++) {
        for (const dir of Object.keys(DIRS)) {
          const s = slide(walls, asRobots, ids[i], dir, opts);
          if (!s.moved) continue;
          const np = pos.map((p, j) => (j === i ? { x: s.x, y: s.y } : p));
          const key = np.map((p) => `${p.x},${p.y}`).join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > maxNodes) return null;
          next.push({ pos: np, path: [...path, { robotId: ids[i], dir }] });
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) return null;
  }
  return null;
}
