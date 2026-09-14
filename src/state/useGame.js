// ─── Ricochet Robots: central game state (React useReducer) ─────────────────
// Phases: setup → thinking → bidding → attempt → reveal(roundEnd) → … → gameOver
// Solo (1 player): setup → thinking → attempt (bidding skipped), tracked vs par.

import { useMemo, useReducer } from 'react';
import { buildBoard, placeRobots, makeDeck } from '../game/board.js';
import { slide, isSolved, solveMinMoves } from '../game/engine.js';
import { ATTEMPT_SECONDS, BID_SECONDS, orderBids } from '../game/bidding.js';

const PLAYER_PALETTE = ['#e5484d', '#3e8ef7', '#46a758', '#f5a524', '#8e4ec6', '#12a594'];

export function playerColor(i) {
  return PLAYER_PALETTE[i % PLAYER_PALETTE.length];
}

function snapshot(robots) {
  return robots.map((r) => ({ ...r }));
}

function initialState() {
  return {
    phase: 'setup',
    players: [],
    roundsTotal: 15,
    pointsToWin: 0, // 0 = play all rounds; else first to X
    robotCount: 4,
    walls: new Set(),
    targets: [],
    deck: [],
    deckPos: 0,
    round: 0,
    robots: [],
    startRobots: [],
    bids: [], // {playerId, moves, at}
    passed: [], // playerIds
    bidClock: 0,
    bidTick: 0, // increments to order bids
    attempt: null, // {playerId, declared, movesUsed, timeLeft, history:[], done}
    attemptQueue: [], // playerIds still to try (after current fails)
    scores: {}, // playerId -> targets won
    soloMoves: [], // per-round move counts (solo)
    par: null, // solver hint for active target
    lastResult: null, // {winnerId|null, movesUsed, reason}
    roundBids: [], // all bids this round for display
  };
}

function dealTarget(state) {
  const target = state.targets[state.deck[state.deckPos % state.deck.length]];
  // Fresh robot scatter each round (classic: robots stay, but re-scatter
  // keeps hot-seat rounds independent and avoids carry-over deadlocks).
  const robots = snapshot(state.robots);
  const taken = new Set(state.targets.map((t) => `${t.x},${t.y}`));
  taken.delete(`${target.x},${target.y}`); // goal cell may start occupied? no—keep others off it
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
      break;
    }
  }
  const par = solveMinMoves(state.walls, robots, target);
  return { target, robots, par };
}

function reducer(s, a) {
  switch (a.type) {
    case 'START': {
      const board = buildBoard({ robotCount: a.robotCount, randomExtraWalls: a.chaos });
      placeRobots(board);
      const deck = makeDeck(board.targets);
      const players = a.players.map((p, i) => ({ ...p, id: `p${i}` }));
      const scores = Object.fromEntries(players.map((p) => [p.id, 0]));
      let st = {
        ...initialState(),
        players,
        roundsTotal: a.roundsTotal,
        pointsToWin: a.pointsToWin,
        robotCount: a.robotCount,
        walls: board.walls,
        targets: board.targets,
        robots: snapshot(board.robots),
        deck,
        scores,
      };
      return startRound(st);
    }
    case 'TO_BIDDING': {
      if (s.phase !== 'thinking') return s;
      if (s.players.length <= 1) return s;
      return { ...s, phase: 'bidding', bids: [], passed: [], bidClock: 0 };
    }
    case 'BID': {
      if (s.phase !== 'bidding') return s;
      if (s.passed.includes(a.playerId)) return s;
      const moves = Math.max(1, Math.min(200, Math.floor(a.moves) || 0));
      if (!moves) return s;
      if (s.bids.some((b) => b.playerId === a.playerId)) return s; // one bid each
      const at = s.bidTick + 1;
      const bids = [...s.bids, { playerId: a.playerId, moves, at }];
      // First bid starts the clock; a strictly lower bid restarts it.
      const best = Math.min(...bids.map((b) => b.moves));
      const prevBest = s.bids.length ? Math.min(...s.bids.map((b) => b.moves)) : Infinity;
      const bidClock = s.bids.length === 0 || moves < prevBest ? BID_SECONDS : s.bidClock;
      let st = { ...s, bids, bidTick: at, bidClock, roundBids: bids };
      // Auto-close when everyone bid or passed.
      if (bids.length + st.passed.length >= s.players.length) {
        return beginAttempts(st);
      }
      return st;
    }
    case 'PASS': {
      if (s.phase !== 'bidding' || s.passed.includes(a.playerId)) return s;
      const passed = [...s.passed, a.playerId];
      let st = { ...s, passed };
      if (st.bids.length + passed.length >= s.players.length) {
        return beginAttempts(st);
      }
      return st;
    }
    case 'BID_TICK': {
      if (s.phase !== 'bidding' || s.bidClock <= 0) return s;
      const bidClock = s.bidClock - 1;
      if (bidClock <= 0) return beginAttempts({ ...s, bidClock: 0 });
      return { ...s, bidClock };
    }
    case 'CLOSE_BIDDING': {
      if (s.phase !== 'bidding' || s.bids.length === 0) return s;
      return beginAttempts(s);
    }
    case 'START_SOLO': {
      // Solo: skip bidding entirely. Restart from the round's initial
      // scatter so any free-explore moves made while thinking don't count.
      if (s.players.length !== 1 || s.phase !== 'thinking') return s;
      const att = { playerId: s.players[0].id, declared: Infinity, movesUsed: 0, timeLeft: 0, history: [], done: false };
      return { ...s, phase: 'attempt', robots: snapshot(s.startRobots), attempt: att, attemptQueue: [] };
    }
    case 'MOVE': {
      // Solo free-explore while thinking: slide with no counting/validation.
      if (s.phase === 'thinking' && s.players.length === 1) {
        const r = slide(s.walls, s.robots, a.robotId, a.dir);
        if (!r.moved) return s;
        return { ...s, robots: s.robots.map((q) => (q.id === a.robotId ? { ...q, x: r.x, y: r.y } : q)) };
      }
      if (s.phase !== 'attempt' || !s.attempt || s.attempt.done) return s;
      const r = slide(s.walls, s.robots, a.robotId, a.dir);
      if (!r.moved) return { ...s, illegal: { robotId: a.robotId, n: (s.illegal?.n ?? 0) + 1 } };
      const history = [...s.attempt.history, snapshot(s.robots)];
      const robots = s.robots.map((q) => (q.id === a.robotId ? { ...q, x: r.x, y: r.y } : q));
      const movesUsed = s.attempt.movesUsed + 1;
      const target = activeTarget(s);
      if (isSolved(robots, target)) {
        return onSolved({ ...s, robots, attempt: { ...s.attempt, movesUsed, history } }, movesUsed);
      }
      if (movesUsed >= s.attempt.declared) {
        // Out of declared moves without solving → this bidder fails.
        return failAttempt({ ...s, robots, attempt: { ...s.attempt, movesUsed, history } }, 'out-of-moves');
      }
      return { ...s, robots, attempt: { ...s.attempt, movesUsed, history } };
    }
    case 'UNDO': {
      if (s.phase !== 'attempt' || !s.attempt || s.attempt.history.length === 0) return s;
      const history = [...s.attempt.history];
      const robots = history.pop();
      return { ...s, robots, attempt: { ...s.attempt, history, movesUsed: Math.max(0, s.attempt.movesUsed - 1) } };
    }
    case 'RESET': {
      if (s.phase !== 'attempt' || !s.attempt) return s;
      return { ...s, robots: snapshot(s.startRobots), attempt: { ...s.attempt, history: [], movesUsed: 0 } };
    }
    case 'ATTEMPT_TICK': {
      if (s.phase !== 'attempt' || !s.attempt || s.attempt.declared === Infinity) return s;
      const timeLeft = s.attempt.timeLeft - 1;
      if (timeLeft <= 0) return failAttempt(s, 'timeout');
      return { ...s, attempt: { ...s.attempt, timeLeft } };
    }
    case 'GIVE_UP': {
      if (s.players.length === 1) {
        // Solo: record failure, move on.
        const soloMoves = [...s.soloMoves, null];
        return afterRound({ ...s, soloMoves, lastResult: { winnerId: null, reason: 'gave-up' } });
      }
      return failAttempt(s, 'gave-up');
    }
    case 'NEXT_ROUND':
      return afterRound(s);
    case 'QUIT':
      return initialState();
    default:
      return s;
  }
}

// ─── helpers ───

function startRound(s) {
  const round = s.round + 1;
  const target = s.targets[s.deck[s.deckPos % s.deck.length]];
  // scatter robots for the new round
  const robots = snapshot(s.robots.length ? s.robots : s.targets.length ? [] : []);
  const st = { ...s, round };
  const dealt = dealTarget({ ...st, robots: st.robots });
  return {
    ...st,
    robots: dealt.robots,
    startRobots: snapshot(dealt.robots),
    par: dealt.par,
    bids: [],
    passed: [],
    bidClock: 0,
    attempt: null,
    attemptQueue: [],
    lastResult: null,
    phase: 'thinking',
    deckPos: s.deckPos,
  };
}

function beginAttempts(s) {
  if (s.bids.length === 0) {
    // Nobody bid → no points, straight to reveal/next.
    return { ...s, phase: 'reveal', lastResult: { winnerId: null, reason: 'no-bids' }, attempt: null };
  }
  const ordered = orderBids(s.bids).map((b) => b.playerId);
  const first = ordered[0];
  const declared = s.bids.find((b) => b.playerId === first).moves;
  return {
    ...s,
    phase: 'attempt',
    robots: snapshot(s.startRobots),
    attempt: { playerId: first, declared, movesUsed: 0, timeLeft: ATTEMPT_SECONDS, history: [], done: false },
    attemptQueue: ordered.slice(1),
  };
}

function onSolved(s, movesUsed) {
  const winnerId = s.attempt.playerId;
  const scores = { ...s.scores, [winnerId]: (s.scores[winnerId] ?? 0) + 1 };
  const soloMoves = s.players.length === 1 ? [...s.soloMoves, movesUsed] : s.soloMoves;
  const st = { ...s, scores, soloMoves, lastResult: { winnerId, movesUsed, reason: 'solved' }, attempt: { ...s.attempt, done: true } };
  if (s.players.length === 1) return afterRound(st);
  return { ...st, phase: 'reveal' };
}

function failAttempt(s, reason) {
  if (s.players.length === 1) return s; // solo has no clock/fail path except give-up
  const [next, ...rest] = s.attemptQueue;
  if (!next) {
    return { ...s, phase: 'reveal', lastResult: { winnerId: null, reason }, attempt: null, attemptQueue: [] };
  }
  const declared = s.bids.find((b) => b.playerId === next).moves;
  return {
    ...s,
    robots: snapshot(s.startRobots),
    lastResult: { winnerId: null, reason, failedId: s.attempt.playerId },
    attempt: { playerId: next, declared, movesUsed: 0, timeLeft: ATTEMPT_SECONDS, history: [], done: false },
    attemptQueue: rest,
  };
}

function afterRound(s) {
  // Win checks: first to X points, else most targets after N rounds.
  if (s.pointsToWin > 0) {
    const champ = s.players.find((p) => (s.scores[p.id] ?? 0) >= s.pointsToWin);
    if (champ) return { ...s, phase: 'gameOver' };
  }
  if (s.round >= s.roundsTotal) return { ...s, phase: 'gameOver' };
  return startRound({ ...s, deckPos: s.deckPos + 1 });
}

export function activeTarget(s) {
  return s.targets[s.deck[s.deckPos % s.deck.length]];
}

export function useGame() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  return useMemo(() => ({ state, dispatch }), [state]);
}
