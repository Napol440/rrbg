// ─── Race helpers + shared solution validation ──────────────────────────────
// New bidding replacement ("proof-of-solution race"):
//   - Thinking is a free-play sandbox: moves count per-player, reset anytime.
//   - The first LEGIT solve starts a RACE_SECONDS countdown.
//   - A strictly SMALLER validated solve restarts the clock and takes the lead.
//   - A solve within solver par is provably OPTIMAL → instant win, no wait.
// Used by both the local reducer and the rooms server (single source of truth).

import { slide, isMultiSolved } from './engine.js';

export const RACE_SECONDS = 60;
export const MAX_SOLUTION_MOVES = 200;
// Rounds are re-dealt until the puzzle genuinely needs this many moves.
// (A null par means beyond solver search — certainly hard enough — so it
// is accepted rather than re-rolled forever.)
export const MIN_ROUND_PAR = 6;
export const MAX_DEAL_ATTEMPTS = 25;

/** True when a dealt round is meaty enough to keep. */
export function meetsMinPar(par, min = MIN_ROUND_PAR) {
  return par == null || par >= min;
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
 * @param {Set<string>|Array<string>} walls
 * @param {Array} startRobots canonical round-start positions
 * @param {object|Array<object>} target active target (or array in multi mode)
 * @param {Array<{robotId:string,dir:string}>} moves claimed move list
 * @returns {{ok:boolean, moves?:number, reason?:string}}
 */
export function validateSolution(walls, startRobots, target, moves) {
  if (!Array.isArray(moves) || moves.length === 0) return { ok: false, reason: 'empty' };
  if (moves.length > MAX_SOLUTION_MOVES) return { ok: false, reason: 'too-long' };
  const wallSet = walls instanceof Set ? walls : new Set(walls);
  let robots = startRobots.map((r) => ({ ...r }));
  for (const m of moves) {
    let r;
    try {
      r = slide(wallSet, robots, m.robotId, m.dir);
    } catch {
      return { ok: false, reason: 'illegal' };
    }
    if (!r.moved) return { ok: false, reason: 'illegal' };
    robots = robots.map((q) => (q.id === m.robotId ? { ...q, x: r.x, y: r.y } : q));
  }
  if (!isMultiSolved(robots, Array.isArray(target) ? target : [target])) return { ok: false, reason: 'unsolved' };
  return { ok: true, moves: moves.length };
}
