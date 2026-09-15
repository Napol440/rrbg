// ─── Race helpers + shared solution validation ──────────────────────────────
// New bidding replacement ("proof-of-solution race"):
//   - Thinking is a free-play sandbox: moves count per-player, reset anytime.
//   - The first LEGIT solve starts a RACE_SECONDS countdown.
//   - A strictly SMALLER validated solve restarts the clock and takes the lead.
//   - A solve within solver par is provably OPTIMAL → instant win, no wait.
// Used by both the local reducer and the rooms server (single source of truth).

import { slide, isMultiSolved, solveMinMoves, withoutWalls, inBounds, isCenterCell, terrainOpts, moveCost } from './engine.js';
import { pickActiveTargets } from './board.js';

export const RACE_SECONDS = 60;
export const MAX_SOLUTION_MOVES = 200;
// Rounds are re-dealt until the puzzle genuinely needs this many moves.
// (A null par means beyond solver search — accepted only as a last resort,
// since null ALSO covers truly sealed targets. findDeal prefers proven lines.)
export const MIN_ROUND_PAR = 6;
export const MAX_DEAL_ATTEMPTS = 25;

/**
 * Sanitize one history entry for the wire / stored paths. Drops undefined
 * fields so shape comparisons stay exact; rejects nothing (validation does).
 */
export function cleanMove(m) {
  const kind = m.kind ?? 'slide';
  if (kind === 'breach') return { kind, robotId: m.robotId, wallKey: m.wallKey };
  if (kind === 'block') return { kind, robotId: m.robotId, wallKey: m.wallKey, x: m.x, y: m.y };
  return { kind: 'slide', robotId: m.robotId, dir: m.dir };
}

/** True when a dealt round is meaty enough to keep. */
export function meetsMinPar(par, min = MIN_ROUND_PAR) {
  return par == null || par >= min;
}

/**
 * Find a provably-doable round within a time budget. Preference order:
 *   1. proven par ≥ MIN_ROUND_PAR (meaty AND solvable) → returned immediately
 *   2. best proven par found (easy but definitely solvable)
 *   3. last scatter, par unknown (likely deep; sealed only in pathology)
 * A streak of nulls suggests the target itself is sealed → advance the deck.
 * Multi-target rounds skip solving (par always null): single scatter.
 *
 * @param {object} cfg {walls, targets, deck, deckPos, targetCount, robotKinds}
 * @param {object} deps {scatter(kinds)->robots, solver, now, budgetMs,
 *   maxScatters, nullsToSwitch, maxTargets} — injectable for tests.
 * @returns {{robots, par, deckPos}}
 */
export function findDeal(cfg, deps = {}) {
  const {
    walls,
    targets,
    deck,
    deckPos = 0,
    targetCount = 1,
    robotKinds = [],
    terrain = null,
  } = cfg;
  const solverOpts = { ...(terrain ?? {}) };
  const {
    scatter,
    solver = solveMinMoves,
    now = Date.now,
    budgetMs = 2500,
    maxScatters = MAX_DEAL_ATTEMPTS,
    nullsToSwitch = 8,
    maxTargets = 3,
  } = deps;
  if (targetCount !== 1 || typeof scatter !== 'function') {
    return { robots: typeof scatter === 'function' ? scatter(robotKinds) : [], par: null, deckPos };
  }
  const t0 = now();
  let pos = deckPos;
  let fallback = null;
  let last = null;
  let outOfTime = false;
  for (let t = 0; t < maxTargets && !outOfTime; t++) {
    const actives = pickActiveTargets(targets, deck, pos, 1);
    if (!actives.length) break;
    let nulls = 0;
    for (let a = 0; a < maxScatters; a++) {
      const robots = scatter(robotKinds);
      const par = solver(walls, robots, actives[0], 9, 120000, solverOpts);
      last = { robots, par };
      if (par != null && par >= MIN_ROUND_PAR) return { robots, par, deckPos: pos };
      if (par != null) {
        // Proven solvable — remember WITH its deck position (a later target
        // switch must not re-pair these robots with a different target).
        if (!fallback || par > fallback.par) fallback = { robots, par, deckPos: pos };
      } else {
        nulls++;
      }
      if (now() - t0 > budgetMs) {
        outOfTime = true;
        break;
      }
      if (nulls >= nullsToSwitch) break;
    }
    if (!outOfTime && nulls >= nullsToSwitch) {
      pos += 1; // target looks sealed — try the next deck entry
      last = null; // stale: belonged to the abandoned position
      continue;
    }
    break;
  }
  if (fallback) return fallback;
  if (last) return { ...last, deckPos: pos };
  return { robots: scatter(robotKinds), par: null, deckPos: pos };
}

/** Strictly better than the current best? */
export function isBetterSolve(moves, bestMoves) {
  return moves < bestMoves;
}

/**
 * Provably optimal? The solver is BFS, so any depth it returns is minimal —
 * solving in `par` moves cannot be beaten. `par == null` means optimality is
 * unknown (beyond search caps) → never an instant win.
 */
export function isOptimalSolve(moves, par) {
  return par != null && moves <= par;
}

/**
 * Replay a claimed solution against the round's start position.
 * Understands slides plus ram powers (breach/block); blue ram-phase and
 * yellow retreat are intrinsic to slide() via robot colors, and silver
 * slides count 0.5 via moveCost.
  * opts: {spent:{breach,block} (pre-spent charges), targets, altWalls, tiles}
 * @returns {{ok:boolean, moves?:number, reason?:string}}
 */
export function validateSolution(walls, startRobots, target, moves, opts = {}) {
  if (!Array.isArray(moves) || moves.length === 0) return { ok: false, reason: 'empty' };
  if (moves.length > MAX_SOLUTION_MOVES) return { ok: false, reason: 'too-long' };
  const targets = Array.isArray(target) ? target : [target];
  const replayed = replayEntries(walls, startRobots, moves, targets, opts);
  if (!replayed.ok) return { ok: false, reason: replayed.reason };
  // Multi-target rounds collect on touch (cumulative); single-target rounds
  // still require the final position (passing through doesn't count).
  const solved = targets.length > 1
    ? targets.every((t) => replayed.touched.includes(t.id))
    : isMultiSolved(replayed.robots, targets);
  if (!solved) return { ok: false, reason: 'unsolved' };
  return { ok: true, moves: replayed.moves, flips: replayed.flips };
}

/**
 * Replay a validated path into per-step board positions for visualization.
 * @returns {Array<{x:number,y:number,n:number,kind?:string}>} one per step.
 * Truncates at the first illegal step (shouldn't happen for validated lines).
 */
export function previewPath(walls, startRobots, path, max = 200, opts = {}) {
  if (!Array.isArray(path) || !path.length) return [];
  const replayed = replayEntries(walls, startRobots, path.slice(0, max), opts.targets ?? [], opts);
  return replayed.points;
}

// Shared step-by-step replay for validation + preview. Tracks wall breaches,
// green-block terrain, power charges, and white/yellow switch flips (which
// swap the active wall set mid-line); enforces one charge each.
function replayEntries(walls, startRobots, moves, targets, opts) {
  const baseWhite = walls instanceof Set ? walls : new Set(walls);
  const baseYellow = opts.altWalls instanceof Set ? opts.altWalls : new Set(opts.altWalls ?? []);
  const tiles = new Map((opts.tiles ?? []).map((t) => [t.id, { ...t }]));
  const tileCells = new Set([...tiles.values()].map((t) => `${t.x},${t.y}`));
  const ground = terrainOpts([...tiles.values()]);
  const brokenKeys = [];
  const blocks = new Set();
  const goalCells = new Set((targets ?? []).map((t) => `${t.x},${t.y}`));
  let robots = startRobots.map((r) => ({ ...r }));
  const spent = { breach: opts.spent?.breach | 0, block: opts.spent?.block | 0 };
  const points = [];
  const touched = new Set();
  let flips = 0;
  const activeWalls = () => {
    const yellow = [...tiles.values()].some((t) => t.kind === 'yellow');
    const base = yellow && baseYellow.size ? baseYellow : baseWhite;
    return withoutWalls(base, brokenKeys);
  };
  // Touch collection: any traversed cell counts (pass-through collects).
  const touchTrail = (trail, color) => {
    const cells = new Set((trail ?? []).map((c) => `${c.x},${c.y}`));
    for (const t of targets ?? []) {
      if (t.color === color && cells.has(`${t.x},${t.y}`)) touched.add(t.id);
    }
  };
  // Landing on a switch tile flips it and swaps the wall set (cumulative).
  const landFlip = (x, y) => {
    for (const t of tiles.values()) {
      if (t.x === x && t.y === y && (t.kind === 'white' || t.kind === 'yellow')) {
        t.kind = t.kind === 'white' ? 'yellow' : 'white';
        flips += 1;
      }
    }
  };
  let n = 0;
  for (const m of moves) {
    const kind = m.kind ?? 'slide';
    if (kind === 'slide') {
      const slideOpts = { blocked: blocks, ice: ground.ice, warps: ground.warps };
      let r;
      try {
        r = slide(activeWalls(), robots, m.robotId, m.dir, slideOpts);
      } catch {
        return { ok: false, points, reason: 'illegal' };
      }
      if (!r.moved) return { ok: false, points, reason: 'illegal' };
      const mover = robots.find((q) => q.id === m.robotId);
      robots = robots.map((q) => (q.id === m.robotId ? { ...q, x: r.x, y: r.y } : q));
      n += moveCost(mover?.color);
      points.push({ x: r.x, y: r.y, n });
      touchTrail(r.trail, mover?.color);
      landFlip(r.x, r.y);
    } else if (kind === 'breach' || kind === 'block') {
      const bot = robots.find((q) => q.id === m.robotId);
      const want = kind === 'breach' ? 'red' : 'green';
      if (!bot || bot.color !== want) return { ok: false, points, reason: 'illegal' };
      if ((spent[kind] | 0) >= 1) return { ok: false, points, reason: 'power-spent' };
      if (!touchesCell(m.wallKey, bot.x, bot.y) || !activeWalls().has(m.wallKey)) return { ok: false, points, reason: 'illegal' };
      spent[kind] += 1;
      brokenKeys.push(m.wallKey);
      n += 1;
      if (kind === 'breach') {
        points.push({ x: bot.x, y: bot.y, n, kind: 'breach' });
      } else {
        // Block must land on the cell behind the rammer (opposite the
        // rammed segment), on a free cell (bounds, center, robots, goals,
        // tiles, existing blocks).
        const at = stepBehind(bot.x, bot.y, m.wallKey);
        if (!at || m.x !== at.x || m.y !== at.y) return { ok: false, points, reason: 'illegal' };
        if (!inBounds(m.x, m.y) || isCenterCell(m.x, m.y)) return { ok: false, points, reason: 'illegal' };
        if (robots.some((q) => q.x === m.x && q.y === m.y)) return { ok: false, points, reason: 'illegal' };
        if (blocks.has(`${m.x},${m.y}`) || goalCells.has(`${m.x},${m.y}`) || tileCells.has(`${m.x},${m.y}`)) return { ok: false, points, reason: 'illegal' };
        blocks.add(`${m.x},${m.y}`);
        points.push({ x: m.x, y: m.y, n, kind: 'block' });
      }
    } else {
      return { ok: false, points, reason: 'illegal' };
    }
  }
  return { ok: true, robots, points, moves: n, touched: [...touched], flips };
}

/** True when a wall segment key touches cell (x, y) on either side. */
function touchesCell(wallKey, x, y) {
  return stepBehind(x, y, wallKey) !== null;
}

/**
 * Cell behind (x, y) relative to a touched wall segment, or null if the
 * segment isn't adjacent. The ram runs from (x, y) toward the wall, so the
 * block lands one step the other way — e.g. bot (10,10) ramming '10,10:S'
 * drops the block on (10,9); bot (5,2) ramming '6,2:W' drops it on (4,2).
 */
function stepBehind(x, y, wallKey) {
  if (typeof wallKey !== 'string') return null;
  const [cell, edge] = wallKey.split(':');
  const [cx, cy] = cell.split(',').map(Number);
  const step = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[edge];
  if (!step) return null;
  const nx = cx + step[0];
  const ny = cy + step[1];
  // Wall spelled on our own cell: ram heads along the edge, block behind.
  if (cx === x && cy === y) return { x: x - step[0], y: y - step[1] };
  // Wall spelled on the neighbor: ram heads toward it, block the other way.
  if (nx === x && ny === y) return { x: 2 * x - cx, y: 2 * y - cy };
  return null;
}
