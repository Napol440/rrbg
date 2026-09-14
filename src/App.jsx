import { useCallback, useEffect, useState } from 'react';
import { useGame, activeTarget, playerColor } from './state/useGame.js';
import SetupScreen from './components/SetupScreen.jsx';
import Board from './components/Board.jsx';
import Sidebar from './components/Sidebar.jsx';
import Controls from './components/Controls.jsx';

// Top-level phase machine + per-second timers + selection + game-over screen.
export default function App() {
  const { state, dispatch } = useGame();
  const [selectedId, setSelectedId] = useState('r0');

  // Keep selection valid when robots re-scatter each round.
  useEffect(() => {
    if (!state.robots.some((r) => r.id === selectedId)) setSelectedId(state.robots[0]?.id);
  }, [state.robots, selectedId]);

  // 1s bidding countdown (only runs once the first bid started the clock).
  useEffect(() => {
    if (state.phase !== 'bidding' || state.bidClock <= 0) return;
    const t = setInterval(() => dispatch({ type: 'BID_TICK' }), 1000);
    return () => clearInterval(t);
  }, [state.phase, state.bidClock, dispatch]);

  // 1s attempt countdown (skipped in solo mode: declared === Infinity).
  useEffect(() => {
    if (state.phase !== 'attempt' || !state.attempt || state.attempt.declared === Infinity) return;
    const t = setInterval(() => dispatch({ type: 'ATTEMPT_TICK' }), 1000);
    return () => clearInterval(t);
  }, [state.phase, state.attempt, dispatch]);

  const play = useCallback(
    (dir) => {
      const id = selectedId ?? state.robots[0]?.id;
      if (!id) return;
      dispatch({ type: 'MOVE', robotId: id, dir });
    },
    [dispatch, selectedId, state.robots],
  );

  // Clicking a board cell in line with the selected robot steers it that way.
  const onCellAim = useCallback(
    (x, y) => {
      const sel = state.robots.find((r) => r.id === selectedId) ?? state.robots[0];
      if (!sel || !canPlay(state)) return;
      if (x === sel.x && y === sel.y) return;
      if (x === sel.x) play(y < sel.y ? 'up' : 'down');
      else if (y === sel.y) play(x < sel.x ? 'left' : 'right');
    },
    [play, selectedId, state],
  );

  if (state.phase === 'setup') {
    return (
      <div className="wrap narrow">
        <SetupScreen onStart={(cfg) => dispatch({ type: 'START', ...cfg })} />
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
          <button className="primary" onClick={() => dispatch({ type: 'QUIT' })}>Back to setup</button>
        </div>
      </div>
    );
  }

  const target = activeTarget(state);
  const sel = state.robots.find((r) => r.id === selectedId) ?? state.robots[0];
  const playable = canPlay(state);

  return (
    <div className="wrap">
      <header className="topbar">
        <b>Ricochet Robots</b>
        <span className="muted">seeded board · hot-seat · round {state.round}/{state.roundsTotal}</span>
        <span className="spacer" />
        {state.phase === 'thinking' && state.players.length > 1 && (
          <button className="primary" onClick={() => dispatch({ type: 'TO_BIDDING' })}>Open bidding</button>
        )}
        {state.phase === 'thinking' && state.players.length === 1 && (
          <button className="primary" onClick={() => dispatch({ type: 'START_SOLO' })}>Start solving</button>
        )}
        <button className="ghost" onClick={() => dispatch({ type: 'QUIT' })}>Quit</button>
      </header>
      <main className="layout">
        <div className="boardcol">
          <Board
            walls={state.walls}
            robots={state.robots}
            targets={state.targets}
            activeTarget={target}
            selectedId={sel?.id}
            onSelect={setSelectedId}
            onCellAim={onCellAim}
            illegal={state.illegal}
          />
          <Controls
            onMove={play}
            onUndo={() => dispatch({ type: 'UNDO' })}
            onReset={() => dispatch({ type: 'RESET' })}
            onGiveUp={() => dispatch({ type: 'GIVE_UP' })}
            canPlay={playable}
            selectedColor={sel?.color}
          />
        </div>
        <Sidebar state={state} dispatch={dispatch} />
      </main>
    </div>
  );
}

// Moves are explorable freely while thinking (solo) but only count during an
// attempt. In multiplayer thinking/bidding the board is view-only so nobody
// accidentally scrambles the shared position before the attempt starts.
function canPlay(state) {
  if (state.phase === 'attempt') return true;
  if (state.phase === 'thinking' && state.players.length === 1) return true;
  return false;
}
