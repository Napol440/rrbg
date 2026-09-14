// ─── Ricochet Robots: central game state (React useReducer) ─────────────────
// Phases: setup → thinking → race → reveal(roundEnd) → … → gameOver
// Bidding replacement ("proof-of-solution race"):
//   - thinking = free-play sandbox. Every player has a PRIVATE board copy
//     (sandboxes[pid]) with a live move counter; undo/reset anytime, free.
//   - The first legit solve starts a RACE_SECONDS countdown. Everyone sees
//     "<name> solved in N moves". A strictly SMALLER solve restarts the clock
//     and steals the lead. A provably OPTIMAL solve (≤ solver par) wins now.
// Solo (1 player): thinking → solve → next round (no race), tracked vs par.
// Hot-seat: pass-and-play sandboxes via VIEW_AS. Online (mode 'net'): your
// sandbox is local; race/rounds are driven by server broadcasts (NET_*).

import { useMemo, useReducer } from 'react';
import { buildBoard, placeRobots, makeDeck } from '../game/board.js';
import { slide, isSolved, solveMinMoves, solvePath } from '../game/engine.js';
import { RACE_SECONDS, isOptimalSolve } from '../game/race.js';

const PLAYER_PALETTE = ['#e5484d', '#3e8ef7', '#46a758', '#f5a524', '#8e4ec6', '#12a594'];

export function playerColor(i) {
  return PLAYER_PALETTE[i % PLAYER_PALETTE.length];
}

function snapshot(robots) {
  return robots.map((r) => ({ ...r }));
}

function sandboxOf(robots) {
  return { robots: snapshot(robots), movesUsed: 0, history: [] };
}

export function initialState() {
  return {
    phase: 'setup',
    mode: 'local', // 'local' | 'net'
    net: null, // {code, you, isHost, status:'lobby'|'playing', connected}
    players: [],
    roundsTotal: 15,
    pointsToWin: 0, // 0 = play all rounds; else first to X
    robotCount: 4,
    walls: new Set(),
    targets: [],
    deck: [],
    deckPos: 0,
    round: 0,
    startRobots: [],
    sandboxes: {}, // playerId -> {robots, movesUsed, history:[{robotId,dir,prev}]}
    viewAs: null, // hot-seat: which sandbox is on the board
    roster: {}, // playerId -> {movesUsed, solved, best, givenUp}
    race: null, // {leaderId, bestMoves, timeLeft}
    scores: {}, // playerId -> targets won
    soloMoves: [], // per-round move counts (solo)
    par: null, // solver optimum for active target (null = unknown)
    lastResult: null, // {winnerId|null, movesUsed, reason, optimal, answer}
    answerIdx: 0, // answer playback cursor during reveal
    solutionSent: false, // net: move count already submitted (false = none)
    illegal: null,
  };
}

function dealTarget(state) {
  const target = state.targets[state.deck[state.deckPos % state.deck.length]];
  // Fresh robot scatter each round; each player experiments from this origin.
  const robots = snapshot(state.robots?.length ? state.robots : state.startRobots);
  const taken = new Set(state.targets.map((t) => `${t.x},${t.y}`));
  taken.delete(`${target.x},${target.y}`);
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
      r.dir = 'up'; // fresh round: rockets face up until moved
      break;
    }
  }
  const par = solveMinMoves(state.walls, robots, target);
  return { target, robots, par };
}

/** Which sandbox does a move/undo/reset apply to? */
function activePid(s) {
  return s.mode === 'net' ? s.net?.you : s.viewAs;
}

export function gameReducer(s, a) {
  switch (a.type) {
    case 'START': {
      const board = buildBoard({ robotCount: a.robotCount, randomExtraWalls: a.chaos });
      placeRobots(board);
      const deck = makeDeck(board.targets);
      const players = a.players.map((p, i) => ({ ...p, id: `p${i}` }));
      const scores = Object.fromEntries(players.map((p) => [p.id, 0]));
      const st = {
        ...initialState(),
        players,
        roundsTotal: a.roundsTotal,
        pointsToWin: a.pointsToWin,
        robotCount: a.robotCount,
        walls: board.walls,
        targets: board.targets,
        startRobots: snapshot(board.robots),
        robots: snapshot(board.robots),
        deck,
        scores,
        viewAs: players[0]?.id ?? null,
      };
      return startRound(st);
    }
    case 'VIEW_AS': {
      if (s.mode !== 'local' || !s.sandboxes[a.playerId]) return s;
      return { ...s, viewAs: a.playerId };
    }
    case 'MOVE': {
      if (s.phase !== 'thinking' && s.phase !== 'race') return s;
      const pid = activePid(s);
      const box = s.sandboxes[pid];
      if (!box || s.roster[pid]?.givenUp) return s;
      const r = slide(s.walls, box.robots, a.robotId, a.dir);
      if (!r.moved) return { ...s, illegal: { robotId: a.robotId, n: (s.illegal?.n ?? 0) + 1 } };
      const prev = snapshot(box.robots);
      const robots = box.robots.map((q) => (q.id === a.robotId ? { ...q, x: r.x, y: r.y, dir: a.dir } : q));
      // Immediate reverse: the same robot sliding back onto its pre-last-move
      // cell cancels the pair (no net move) instead of counting a new one.
      const lastEntry = box.history[box.history.length - 1];
      if (lastEntry && lastEntry.robotId === a.robotId) {
        const before = lastEntry.prev.find((q) => q.id === a.robotId);
        if (before && before.x === r.x && before.y === r.y) {
          const history = box.history.slice(0, -1);
          const movesUsed = Math.max(0, box.movesUsed - 1);
          const sandboxes = { ...s.sandboxes, [pid]: { robots: lastEntry.prev, movesUsed, history } };
          const roster = {
            ...s.roster,
            [pid]: { ...s.roster[pid], movesUsed, solved: false },
          };
          return { ...s, sandboxes, roster };
        }
      }
      const movesUsed = box.movesUsed + 1;
      // Store compact replay (robotId+dir) alongside undo snapshots.
      const history = [...box.history, { robotId: a.robotId, dir: a.dir, prev }];
      const sandboxes = { ...s.sandboxes, [pid]: { robots, movesUsed, history } };
      const roster = {
        ...s.roster,
        [pid]: { ...s.roster[pid], movesUsed, solved: s.roster[pid]?.solved ?? false },
      };
      const st = { ...s, sandboxes, roster };
      const target = activeTarget(st);
      if (!isSolved(robots, target)) return st;
      return onSandboxSolved(st, pid, movesUsed);
    }
    case 'UNDO': {
      if (s.phase !== 'thinking' && s.phase !== 'race') return s;
      const pid = activePid(s);
      const box = s.sandboxes[pid];
      if (!box || box.history.length === 0 || s.roster[pid]?.givenUp) return s;
      const history = [...box.history];
      const last = history.pop();
      const sandboxes = {
        ...s.sandboxes,
        [pid]: { robots: last.prev, movesUsed: Math.max(0, box.movesUsed - 1), history },
      };
      const roster = {
        ...s.roster,
        [pid]: { ...s.roster[pid], movesUsed: Math.max(0, box.movesUsed - 1), solved: false },
      };
      return { ...s, sandboxes, roster };
    }
    case 'RESET': {
      if (s.phase !== 'thinking' && s.phase !== 'race') return s;
      const pid = activePid(s);
      if (!s.sandboxes[pid] || s.roster[pid]?.givenUp) return s;
      const sandboxes = { ...s.sandboxes, [pid]: sandboxOf(s.startRobots) };
      const roster = { ...s.roster, [pid]: { ...s.roster[pid], movesUsed: 0, solved: false } };
      return { ...s, sandboxes, roster };
    }
    case 'RACE_TICK': {
      // Local authority only; online the server broadcasts NET_TICK.
      if (s.phase !== 'race' || !s.race || s.mode !== 'local') return s;
      const timeLeft = s.race.timeLeft - 1;
      if (timeLeft <= 0) return onSolved({ ...s, race: { ...s.race, timeLeft: 0 } }, s.race.leaderId, s.race.bestMoves, false);
      return { ...s, race: { ...s.race, timeLeft } };
    }
    case 'GIVE_UP': {
      if (s.players.length === 1 && s.mode === 'local') {
        // Solo: record failure, reveal the answer, then move on.
        const soloMoves = [...s.soloMoves, null];
        return unsolvedReveal({ ...s, soloMoves }, 'gave-up');
      }
      const pid = s.mode === 'net' ? s.net?.you : (a.playerId ?? s.viewAs);
      if (!pid || !s.roster[pid]) return s;
      const roster = { ...s.roster, [pid]: { ...s.roster[pid], givenUp: true } };
      const st = { ...s, roster };
      if (Object.keys(roster).length > 0 && Object.values(roster).every((r) => r.givenUp)) {
        if (st.phase === 'race' && st.race) return onSolved(st, st.race.leaderId, st.race.bestMoves, false);
        return unsolvedReveal(st, 'gave-up');
      }
      return st;
    }
    case 'ANSWER_STEP': {
      // Answer playback during reveal: slide without counting or solving.
      if (s.phase !== 'reveal' || !s.lastResult?.answer) return s;
      const idx = s.answerIdx ?? 0;
      if (idx >= s.lastResult.answer.length) return s;
      const pid = activePid(s);
      const box = s.sandboxes[pid];
      if (!box) return s;
      const step = s.lastResult.answer[idx];
      const r = slide(s.walls, box.robots, step.robotId, step.dir);
      if (!r.moved) return { ...s, answerIdx: idx + 1 }; // skip stale step
      const robots = box.robots.map((q) => (q.id === step.robotId ? { ...q, x: r.x, y: r.y, dir: step.dir } : q));
      return { ...s, sandboxes: { ...s.sandboxes, [pid]: { ...box, robots } }, answerIdx: idx + 1 };
    }
    case 'ANSWER_REPLAY': {
      if (s.phase !== 'reveal' || !s.lastResult?.answer) return s;
      const pid = activePid(s);
      if (!s.sandboxes[pid]) return s;
      return { ...s, sandboxes: { ...s.sandboxes, [pid]: sandboxOf(s.startRobots) }, answerIdx: 0 };
    }
    case 'NEXT_ROUND':
      if (s.mode === 'net' && !s.net?.isHost) return s; // server drives for guests
      return afterRound(s);
    case 'QUIT':
      return initialState();
    // ── online (server-driven) ──
    case 'NET_LOBBY':
      return {
        ...initialState(),
        mode: 'net',
        net: { code: a.code, you: a.you, isHost: a.isHost, status: 'lobby', connected: true },
        players: a.players,
        roundsTotal: a.roundsTotal,
        robotCount: a.robotCount,
      };
    case 'NET_ROUND': {
      // Authoritative round snapshot from the server.
      const players = a.players;
      const sandboxes = Object.fromEntries(players.map((p) => [p.id, sandboxOf(a.startRobots)]));
      const roster = Object.fromEntries(
        players.map((p) => [p.id, { movesUsed: 0, solved: false, best: null, givenUp: false }]),
      );
      const scores = a.scores ?? Object.fromEntries(players.map((p) => [p.id, 0]));
      return {
        ...s,
        phase: 'thinking',
        players,
        roundsTotal: a.roundsTotal ?? s.roundsTotal,
        walls: new Set(a.walls),
        targets: a.targets,
        deck: a.deck,
        deckPos: a.deckPos ?? 0,
        round: a.round,
        startRobots: snapshot(a.startRobots),
        sandboxes,
        roster,
        race: null,
        par: a.par ?? null,
        scores,
        lastResult: null,
        solutionSent: false,
        answerIdx: 0,
        illegal: null,
        net: s.net ? { ...s.net, status: 'playing', connected: true } : s.net,
      };
    }
    case 'NET_RACE':
      return { ...s, phase: 'race', race: { leaderId: a.leaderId, bestMoves: a.bestMoves, timeLeft: a.timeLeft } };
    case 'NET_TICK':
      if (s.phase !== 'race' || !s.race) return s;
      return { ...s, race: { ...s.race, timeLeft: a.timeLeft } };
    case 'NET_PRESENCE': {
      // Own sandbox is the source of truth — never let a server echo clear
      // our local solved flag before the RACE broadcast arrives.
      const me = s.net?.you;
      const roster = { ...s.roster };
      for (const [pid, info] of Object.entries(a.counts ?? {})) {
        if (pid !== me && roster[pid]) roster[pid] = { ...roster[pid], ...info };
      }
      return { ...s, roster };
    }
    case 'NET_END': {
      // Server answer (if any) plays back on our own sandbox from the origin.
      const you = s.net?.you;
      const sandboxes = you && s.sandboxes[you]
        ? { ...s.sandboxes, [you]: sandboxOf(s.startRobots) }
        : s.sandboxes;
      return {
        ...s,
        sandboxes,
        phase: 'reveal',
        race: null,
        answerIdx: 0,
        scores: a.scores ?? s.scores,
        lastResult: { winnerId: a.winnerId, movesUsed: a.movesUsed, reason: a.reason, optimal: !!a.optimal, answer: a.answer ?? null },
      };
    }
    case 'NET_GAMEOVER':
      return { ...s, phase: 'gameOver', scores: a.scores ?? s.scores, race: null };
    case 'NET_SENT':
      // Stamp the submitted move count so a later *better* solve resends.
      return { ...s, solutionSent: a.moves };
    case 'NET_CLOSE':
      return s.net ? { ...s, net: { ...s.net, connected: false } } : s;
    default:
      return s;
  }
}

// ─── solve handling ───

function onSandboxSolved(s, pid, movesUsed) {
  const roster = {
    ...s.roster,
    [pid]: { ...s.roster[pid], solved: true, best: Math.min(movesUsed, s.roster[pid]?.best ?? Infinity) },
  };
  // Solo: no race, record and move on.
  if (s.players.length === 1 && s.mode === 'local') {
    return onSolved({ ...s, roster }, pid, movesUsed, false);
  }
  // Online: mark solved locally; the App effect submits to the server, which
  // validates + broadcasts (prevents fakes). Never flag solutionSent here —
  // the effect owns sending, otherwise the server never hears about it.
  if (s.mode === 'net') {
    return { ...s, roster };
  }
  // Optimal (≤ solver par) is unbeatable → instant win.
  if (isOptimalSolve(movesUsed, s.par)) {
    return onSolved({ ...s, roster }, pid, movesUsed, true);
  }
  if (s.phase === 'thinking') {
    return { ...s, roster, phase: 'race', race: { leaderId: pid, bestMoves: movesUsed, timeLeft: RACE_SECONDS } };
  }
  // In-race: strictly smaller steals the lead and restarts the clock.
  if (movesUsed < s.race.bestMoves) {
    return { ...s, roster, race: { leaderId: pid, bestMoves: movesUsed, timeLeft: RACE_SECONDS } };
  }
  return { ...s, roster };
}

function startRound(s) {
  const round = s.round + 1;
  const st = { ...s, round, robots: s.startRobots?.length ? s.startRobots : s.robots };
  const dealt = dealTarget({ ...st, robots: st.startRobots?.length ? st.startRobots : [] });
  const sandboxes = Object.fromEntries(s.players.map((p) => [p.id, sandboxOf(dealt.robots)]));
  const roster = Object.fromEntries(
    s.players.map((p) => [p.id, { movesUsed: 0, solved: false, best: null, givenUp: false }]),
  );
  return {
    ...st,
    startRobots: snapshot(dealt.robots),
    robots: snapshot(dealt.robots),
    par: dealt.par,
    sandboxes,
    roster,
    race: null,
    lastResult: null,
    solutionSent: false,
    answerIdx: 0,
    illegal: null,
    phase: 'thinking',
    deckPos: s.deckPos,
  };
}

// Unsolved round end: reveal + compute the solver's answer for auto-playback
// (null when beyond search caps). Playback starts from the round origin.
function unsolvedReveal(s, reason) {
  const target = activeTarget(s);
  const answer = solvePath(s.walls, s.startRobots, target);
  const pid = activePid(s);
  const sandboxes = pid && s.sandboxes[pid]
    ? { ...s.sandboxes, [pid]: sandboxOf(s.startRobots) }
    : s.sandboxes;
  return {
    ...s,
    sandboxes,
    phase: 'reveal',
    race: null,
    answerIdx: 0,
    lastResult: { winnerId: null, reason, answer },
  };
}

function onSolved(s, winnerId, movesUsed, optimal) {  const scores = { ...s.scores, [winnerId]: (s.scores[winnerId] ?? 0) + 1 };
  const soloMoves = s.players.length === 1 && s.mode === 'local' ? [...s.soloMoves, movesUsed] : s.soloMoves;
  const st = {
    ...s,
    scores,
    soloMoves,
    lastResult: { winnerId, movesUsed, reason: 'solved', optimal },
    race: null,
  };
  if (s.players.length === 1 && s.mode === 'local') return afterRound(st);
  return { ...st, phase: 'reveal' };
}

function afterRound(s) {
  // Win checks: first to X points, else most targets after N rounds.
  if (s.pointsToWin > 0) {
    const champ = s.players.find((p) => (s.scores[p.id] ?? 0) >= s.pointsToWin);
    if (champ) return { ...s, phase: 'gameOver' };
  }
  if (s.round >= s.roundsTotal) return { ...s, phase: 'gameOver' };
  if (s.mode === 'net') return s; // server sends the next NET_ROUND
  return startRound({ ...s, deckPos: s.deckPos + 1 });
}

export function activeTarget(s) {
  return s.targets[s.deck[s.deckPos % s.deck.length]];
}

/** Robots to render: active sandbox (hot-seat viewAs / net self / solo). */
export function visibleRobots(s) {
  const pid = s.mode === 'net' ? s.net?.you : (s.viewAs ?? s.players[0]?.id);
  return s.sandboxes[pid]?.robots ?? s.startRobots;
}

export function activeMovesUsed(s) {
  const pid = s.mode === 'net' ? s.net?.you : (s.viewAs ?? s.players[0]?.id);
  return s.sandboxes[pid]?.movesUsed ?? 0;
}

export function useGame() {
  const [state, dispatch] = useReducer(gameReducer, undefined, initialState);
  return useMemo(() => ({ state, dispatch }), [state]);
}
