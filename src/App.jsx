import { useCallback, useEffect, useRef, useState } from 'react';
import { useGame, activeTargets, playerColor, visibleRobots } from './state/useGame.js';
import { isMultiSolved } from './game/engine.js';
import SetupScreen from './components/SetupScreen.jsx';
import Lobby from './components/Lobby.jsx';
import Board from './components/Board.jsx';
import Sidebar from './components/Sidebar.jsx';
import Controls from './components/Controls.jsx';
import { roomWsUrl } from './net/socket.js';

// Top-level phase machine + race timer + selection + net wiring + game-over.
export default function App() {
  const { state, dispatch } = useGame();
  const [selectedId, setSelectedId] = useState('r0');
  const [netError, setNetError] = useState('');
  const wsRef = useRef(null);
  const robots = visibleRobots(state);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // Keep selection valid when robots re-scatter each round.
  useEffect(() => {
    if (!robots.some((r) => r.id === selectedId)) setSelectedId(robots[0]?.id);
  }, [robots, selectedId]);

  // 1s race countdown (local authority only; the server ticks for net games).
  useEffect(() => {
    if (state.phase !== 'race' || state.mode !== 'local') return;
    const t = setInterval(() => dispatch({ type: 'RACE_TICK' }), 1000);
    return () => clearInterval(t);
  }, [state.phase, state.mode, dispatch]);

  // Answer auto-play on unsolved reveals (replays the solver's line).
  useEffect(() => {
    if (state.phase !== 'reveal' || !state.lastResult?.answer?.length) return;
    if ((state.answerIdx ?? 0) >= state.lastResult.answer.length) return;
    const t = setInterval(() => dispatch({ type: 'ANSWER_STEP' }), 450);
    return () => clearInterval(t);
  }, [state.phase, state.lastResult, state.answerIdx, dispatch]);

  // Net: report our live move count so others see it as we play.
  const myMoves = state.mode === 'net' && state.net?.you
    ? state.sandboxes[state.net.you]?.movesUsed ?? 0
    : null;
  useEffect(() => {
    if (state.mode === 'net' && state.phase !== 'setup' && myMoves != null) send({ t: 'COUNT', moves: myMoves });
  }, [state.mode, state.phase, myMoves, send]);

  // Net: submit our solution once our sandbox is solved. Re-sends if a later
  // solve uses a different move count (e.g. a better line after a reject).
  useEffect(() => {
    if (state.mode !== 'net' || state.net?.status !== 'playing') return;
    const you = state.net.you;
    const box = state.sandboxes[you];
    if (!box || state.phase === 'setup' || state.phase === 'reveal' || state.phase === 'gameOver') return;
    if (state.solutionSent === box.movesUsed) return;
    const targets = activeTargets(state);
    if (!targets.length) return;
    if (isMultiSolved(box.robots, targets)) {
      send({ t: 'SOLUTION', moves: box.history.map((h) => ({ robotId: h.robotId, dir: h.dir })) });
      dispatch({ type: 'NET_SENT', moves: box.movesUsed });
    }
  });

  // Net: host advances rounds / generic sender for lobby actions.
  const netAction = useCallback((msg) => send(msg), [send]);

  useEffect(() => () => wsRef.current?.close(), []);

  const connect = useCallback((firstMsg, onErr) => {
    try {
      const ws = new WebSocket(roomWsUrl());
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        routeServerMessage(m, dispatch, setNetError, () => wsRef.current?.close());
      };
      ws.onerror = () => { onErr?.(); setNetError(`Could not reach ${roomWsUrl()}. Is the rooms server running? (npm run server, keep it open)`); };
      ws.onclose = () => dispatch({ type: 'NET_CLOSE' });
      ws.onopen = () => ws.send(JSON.stringify(firstMsg));
    } catch {
      onErr?.();
    }
  }, [dispatch]);

  const play = useCallback(
    (dir) => {
      const id = selectedId ?? robots[0]?.id;
      if (!id) return;
      dispatch({ type: 'MOVE', robotId: id, dir });
    },
    [dispatch, selectedId, robots],
  );

  // Clicking a board cell in line with the selected robot steers it that way.
  const onCellAim = useCallback(
    (x, y) => {
      const sel = robots.find((r) => r.id === selectedId) ?? robots[0];
      if (!sel || !canPlay(state)) return;
      if (x === sel.x && y === sel.y) return;
      if (x === sel.x) play(y < sel.y ? 'up' : 'down');
      else if (y === sel.y) play(x < sel.x ? 'left' : 'right');
    },
    [play, selectedId, robots, state],
  );

  const giveUp = useCallback(() => {
    if (state.mode === 'net') send({ t: 'GIVE_UP' });
    dispatch({ type: 'GIVE_UP' });
  }, [state.mode, send, dispatch]);

  // Global hotkeys (single listener — the source of truth for keys):
  // arrows/WASD move · 1-5 select rocket · U undo · R reset · G give up.
  useEffect(() => {
    const onKey = (e) => {
      if (state.phase !== 'thinking' && state.phase !== 'race') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const map = {
        ArrowUp: 'up', w: 'up', W: 'up',
        ArrowDown: 'down', s: 'down', S: 'down',
        ArrowLeft: 'left', a: 'left', A: 'left',
        ArrowRight: 'right', d: 'right', D: 'right',
      };
      const dir = map[e.key];
      if (dir) {
        e.preventDefault();
        play(dir);
        return;
      }
      if (e.key >= '1' && e.key <= '5') {
        const bot = robots[+e.key - 1];
        if (bot) setSelectedId(bot.id);
        return;
      }
      if (e.key === 'u' || e.key === 'U') dispatch({ type: 'UNDO' });
      else if (e.key === 'r' || e.key === 'R') dispatch({ type: 'RESET' });
      else if (e.key === 'g' || e.key === 'G') giveUp();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.phase, play, robots, giveUp, dispatch]);

  if (state.phase === 'setup' && state.mode === 'local') {
    return (
      <div className="wrap narrow">
        {netError && <p className="neterr">{netError}</p>}
        <SetupScreen
          onStart={(cfg) => dispatch({ type: 'START', ...cfg })}
          onCreate={({ name, cfg }) => connect({ t: 'CREATE', name, cfg })}
          onJoin={({ name, code }) => connect({ t: 'JOIN', name, code })}
        />
      </div>
    );
  }

  if (state.mode === 'net' && state.net?.status === 'lobby') {
    return (
      <div className="wrap narrow">
        {netError && <p className="neterr">{netError}</p>}
        <Lobby key={state.net?.code} state={state} send={netAction} onLeave={() => { wsRef.current?.close(); dispatch({ type: 'QUIT' }); }} />
      </div>
    );
  }

  if (state.phase === 'gameOver') {
    const rows = [...state.players].sort((a, b) => (state.scores[b.id] ?? 0) - (state.scores[a.id] ?? 0));
    const best = state.scores[rows[0]?.id] ?? 0;
    const winners = rows.filter((p) => (state.scores[p.id] ?? 0) === best);
    return (
      <div className="wrap narrow">
        <div className="setup">
          <h1>Game over</h1>
          <p>{winners.length === 1 ? <><b>{winners[0].name}</b> wins with {best} target{winners[0] && best === 1 ? '' : 's'}!</> : <>Tie at {best} — {winners.map((w) => w.name).join(', ')}!</>}</p>
          <table className="scores">
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}><td><span className="dot" style={{ background: p.color ?? playerColor(0) }} />{p.name}</td><td><b>{state.scores[p.id] ?? 0}</b></td></tr>
              ))}
            </tbody>
          </table>
          <button className="primary" onClick={() => { wsRef.current?.close(); dispatch({ type: 'QUIT' }); }}>Back to setup</button>
        </div>
      </div>
    );
  }

  const targets = activeTargets(state);
  const sel = robots.find((r) => r.id === selectedId) ?? robots[0];
  const playable = canPlay(state);

  return (
    <div className="wrap">
      <header className="topbar">
        <b>Rocket Rebound</b>
        <span className="muted">
          {state.mode === 'net' ? `room ${state.net?.code} · you are ${state.players.find((p) => p.id === state.net?.you)?.name ?? ''} · ` : 'hot-seat · '}
          round {state.round}/{state.roundsTotal}
        </span>
        {!state.net?.connected && state.mode === 'net' && <span className="neterr">disconnected</span>}
        <span className="spacer" />
        <button className="ghost" onClick={() => { wsRef.current?.close(); dispatch({ type: 'QUIT' }); }}>Quit</button>
      </header>
      <main className="layout">
        <div className="boardcol">
          <Board
            walls={state.walls}
            robots={robots}
            targets={state.targets}
            activeTargets={targets}
            selectedId={sel?.id}
            onSelect={setSelectedId}
            onCellAim={onCellAim}
            illegal={state.illegal}
          />
          <Controls
            onMove={play}
            onUndo={() => dispatch({ type: 'UNDO' })}
            onReset={() => dispatch({ type: 'RESET' })}
            onGiveUp={giveUp}
            canPlay={playable}
            selectedColor={sel?.color}
            robotCount={robots.length}
          />
        </div>
        <Sidebar state={state} dispatch={dispatch} send={netAction} />
      </main>
    </div>
  );
}

function routeServerMessage(m, dispatch, setNetError, onKicked) {
  switch (m.t) {
    case 'WELCOME':
      dispatch({ type: 'NET_LOBBY', code: m.code, you: m.you, isHost: m.isHost, hostId: m.hostId, players: m.players, roundsTotal: m.roundsTotal, robotCount: m.robotCount, raceSeconds: m.raceSeconds, chaos: m.chaos, targetCount: m.targetCount });
      break;
    case 'LOBBY':
      dispatch({ type: 'NET_LOBBY', code: m.code, you: m.you, isHost: m.isHost, hostId: m.hostId, players: m.players, roundsTotal: m.roundsTotal, robotCount: m.robotCount, raceSeconds: m.raceSeconds, chaos: m.chaos, targetCount: m.targetCount });
      break;
    case 'ROUND':
      dispatch({ type: 'NET_ROUND', ...m });
      break;
    case 'RACE':
      dispatch({ type: 'NET_RACE', leaderId: m.leaderId, bestMoves: m.bestMoves, timeLeft: m.timeLeft, total: m.total });
      break;
    case 'TICK':
      dispatch({ type: 'NET_TICK', timeLeft: m.timeLeft });
      break;
    case 'PRESENCE':
      dispatch({ type: 'NET_PRESENCE', counts: m.counts });
      break;
    case 'END':
      dispatch({ type: 'NET_END', ...m });
      break;
    case 'GAMEOVER':
      dispatch({ type: 'NET_GAMEOVER', scores: m.scores });
      break;
    case 'ERROR':
      setNetError(m.message);
      break;
    case 'KICKED':
      onKicked?.();
      dispatch({ type: 'QUIT' });
      setNetError('Removed from the room by the host.');
      break;
    default:
      break;
  }
}

// Sandbox moves are free in thinking AND race (solo too). Locked otherwise.
function canPlay(state) {
  return state.phase === 'thinking' || state.phase === 'race';
}
