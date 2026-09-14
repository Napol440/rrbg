// ─── Ricochet Robots: movement engine (pure logic, no React) ────────────────
// Board model: 16x16 cells, coords 0..15. Walls live on CELL EDGES, stored as
// strings "x,y:DIR" where DIR is the edge of cell (x,y) — N/S/E/W.
//   - Board outer border is implicit (no stored walls needed).
//   - The center 2x2 block [(7,7),(8,7),(7,8),(8,8)] is impassable.
// Robots slide in a straight line until the cell BEFORE a wall, board edge,
// the center block, or another robot. They can never stop mid-slide.

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
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {{x:number,y:number,moved:boolean,cells:number}} stop cell.
 *   `moved:false` means the slide is ILLEGAL (zero displacement) and the
 *   caller must reject it without counting a move.
 */
export function slide(walls, robots, robotId, dir) {
  const d = DIRS[dir];
  if (!d) throw new Error(`bad direction: ${dir}`);
  const me = robots.find((r) => r.id === robotId);
  if (!me) throw new Error(`unknown robot: ${robotId}`);
  const occupied = new Set(
    robots.filter((r) => r.id !== robotId).map((r) => `${r.x},${r.y}`),
  );
  let { x, y } = me;
  let cells = 0;
  for (;;) {
    // A wall on our current edge stops us before leaving this cell.
    if (hasWall(walls, x, y, d.edge)) break;
    const nx = x + d.dx;
    const ny = y + d.dy;
    // Board edge, center vault, or another robot in the next cell stops us.
    if (isBlockedCell(nx, ny)) break;
    if (hasWall(walls, nx, ny, d.opposite)) break;
    if (occupied.has(`${nx},${ny}`)) break;
    x = nx;
    y = ny;
    cells += 1;
  }
  return { x, y, moved: cells > 0, cells };
}

/** All legal slides from a position: every (robot, dir) with moved===true. */
export function legalMoves(walls, robots) {
  const out = [];
  for (const r of robots) {
    for (const dir of Object.keys(DIRS)) {
      const s = slide(walls, robots, r.id, dir);
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

// ─── Solver (BFS over joint robot positions) ────────────────────────────────
// Used for: (a) rejecting unsolvable deals at setup, (b) showing a "par"
// hint in solo mode. Branching is ≤ 4×robots; depth/node caps keep it fast.
// Returns min move count or null if not found within caps (NOT a proof of
// unsolvability — caller should re-deal rather than loop forever).

export function solveMinMoves(walls, robots, target, maxDepth = 9, maxNodes = 120000) {
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
  let frontier = [start];
  for (let depth = 0; depth <= maxDepth; depth++) {
    const next = [];
    for (const pos of frontier) {
      const asRobots = ids.map((id, i) => ({ id, x: pos[i].x, y: pos[i].y }));
      if (pos[goalIdx].x === target.x && pos[goalIdx].y === target.y) return depth;
      if (depth === maxDepth) continue;
      for (let i = 0; i < ids.length; i++) {
        for (const dir of Object.keys(DIRS)) {
          const s = slide(walls, asRobots, ids[i], dir);
          if (!s.moved) continue;
          const np = pos.map((p, j) => (j === i ? { x: s.x, y: s.y } : p));
          const key = np.map((p) => `${p.x},${p.y}`).join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > maxNodes) return null;
          next.push(np);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) return null;
  }
  return null;
}
