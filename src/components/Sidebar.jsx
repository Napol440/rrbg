import { useState } from 'react';
import { orderBids } from '../game/bidding.js';
import { activeTarget } from '../state/useGame.js';
import { ROBOT_FILL } from './colors.js';

// Right-hand panel: target card, clocks, bids, attempt meter, scoreboard.
export default function Sidebar({ state, dispatch }) {
  const target = activeTarget(state);
  const [bidInputs, setBidInputs] = useState({});
  const ordered = orderBids(state.bids);
  const name = (id) => state.players.find((p) => p.id === id)?.name ?? id;
  const attemptName = state.attempt ? name(state.attempt.playerId) : '';

  const declare = (pid) => {
    const v = parseInt(bidInputs[pid], 10);
    if (!v || v < 1) return;
    dispatch({ type: 'BID', playerId: pid, moves: v });
    setBidInputs((b) => ({ ...b, [pid]: '' }));
  };

  return (
    <aside className="side">
      <section className="card target-card">
        <h2>Round {state.round}/{state.roundsTotal} · Target</h2>
        {target ? (
          <div className="targetline">
            <span className="swatch" style={{ background: ROBOT_FILL[target.color] }} />
            <b style={{ textTransform: 'capitalize' }}>{target.color} {target.shape}</b>
            {state.par != null && state.players.length === 1 && (
              <span className="muted"> · solver par: {state.par} (≤9 search)</span>
            )}
          </div>
        ) : <p className="muted">No target.</p>}
        <p className="phase">Phase: <b>{state.phase}</b></p>
      </section>

      {(state.phase === 'thinking' || state.phase === 'bidding') && state.players.length > 1 && (
        <section className="card">
          <h2>Bidding</h2>
          {state.phase === 'thinking' && (
            <p className="muted">Thinking time is unlimited. Declare the first bid to start the 60s clock.</p>
          )}
          {state.phase === 'bidding' && state.bidClock > 0 && (
            <div className="clockbar"><div className="fill" style={{ width: `${(state.bidClock / 60) * 100}%` }} /><span>{state.bidClock}s — a lower bid restarts the clock</span></div>
          )}
          <ul className="bids">
            {ordered.map((b) => (
              <li key={b.playerId}><b>{name(b.playerId)}</b>: {b.moves} moves</li>
            ))}
            {ordered.length === 0 && <li className="muted">No bids yet.</li>}
          </ul>
          {state.phase === 'thinking' ? (
            <button className="primary" onClick={() => dispatch({ type: 'TO_BIDDING' })}>Open bidding</button>
          ) : (
            <>
              {state.players.map((p) => {
                const hasBid = state.bids.some((b) => b.playerId === p.id);
                const hasPassed = state.passed.includes(p.id);
                if (hasBid || hasPassed) return <div key={p.id} className="bidrow done">{p.name} — {hasPassed ? 'passed' : 'bid in'}</div>;
                return (
                  <div key={p.id} className="bidrow">
                    <span><span className="dot" style={{ background: p.color }} />{p.name}</span>
                    <input
                      type="number" min="1" max="200" placeholder="moves"
                      value={bidInputs[p.id] ?? ''}
                      onChange={(e) => setBidInputs((b) => ({ ...b, [p.id]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') declare(p.id); }}
                    />
                    <button onClick={() => declare(p.id)}>Bid</button>
                    <button className="ghost" onClick={() => dispatch({ type: 'PASS', playerId: p.id })}>Pass</button>
                  </div>
                );
              })}
              <button className="primary" disabled={state.bids.length === 0} onClick={() => dispatch({ type: 'CLOSE_BIDDING' })}>
                Close bidding → lowest attempts
              </button>
            </>
          )}
        </section>
      )}

      {state.phase === 'attempt' && state.attempt && (
        <section className="card">
          <h2>Attempt: {attemptName}</h2>
          <p className="bigmeter">
            {state.attempt.movesUsed} / {state.attempt.declared === Infinity ? '∞' : state.attempt.declared} moves
          </p>
          {state.attempt.declared !== Infinity && (
            <div className="clockbar low"><div className="fill" style={{ width: `${(state.attempt.timeLeft / 60) * 100}%` }} /><span>{state.attempt.timeLeft}s left</span></div>
          )}
          {state.attemptQueue.length > 0 && (
            <p className="muted">On deck: {state.attemptQueue.map(name).join(', ')}</p>
          )}
        </section>
      )}

      {state.phase === 'reveal' && state.lastResult && (
        <section className="card">
          <h2>Round result</h2>
          {state.lastResult.winnerId
            ? <p><b>{name(state.lastResult.winnerId)}</b> solved it in {state.lastResult.movesUsed}!</p>
            : <p className="muted">Unsolved ({state.lastResult.reason}). No points.</p>}
          <button className="primary" onClick={() => dispatch({ type: 'NEXT_ROUND' })}>Next target →</button>
        </section>
      )}

      <section className="card">
        <h2>Scores</h2>
        <table className="scores">
          <tbody>
            {[...state.players].sort((a, b) => (state.scores[b.id] ?? 0) - (state.scores[a.id] ?? 0)).map((p) => (
              <tr key={p.id}><td><span className="dot" style={{ background: p.color }} />{p.name}</td><td><b>{state.scores[p.id] ?? 0}</b></td></tr>
            ))}
          </tbody>
        </table>
        {state.players.length === 1 && (
          <p className="muted">Solo: solved {state.soloMoves.filter((m) => m != null).length}/{state.soloMoves.length} · moves: [{state.soloMoves.map((m) => (m == null ? '–' : m)).join(', ')}]</p>
        )}
      </section>
    </aside>
  );
}
