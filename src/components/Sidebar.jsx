import { RACE_SECONDS } from '../game/race.js';
import { activeTarget, activeMovesUsed } from '../state/useGame.js';
import { ROBOT_FILL } from './colors.js';

// Right-hand panel: target card, sandbox meter, race clock, roster, scoreboard.
export default function Sidebar({ state, dispatch, send }) {
  const target = activeTarget(state);
  const name = (id) => state.players.find((p) => p.id === id)?.name ?? id;
  const solo = state.players.length === 1 && state.mode === 'local';
  const myMoves = activeMovesUsed(state);
  const rows = [...state.players].sort((a, b) => (state.roster[b.id]?.movesUsed ?? 0) - (state.roster[a.id]?.movesUsed ?? 0));

  return (
    <aside className="side">
      <section className="card target-card">
        <h2>Round {state.round}/{state.roundsTotal} · Target</h2>
        {target ? (
          <div className="targetline">
            <span className="swatch" style={{ background: ROBOT_FILL[target.color] }} />
            <b style={{ textTransform: 'capitalize' }}>{target.color} {target.shape}</b>
            {state.par != null && (
              <span className="muted"> · optimal: {state.par}</span>
            )}
            {state.par == null && !solo && (
              <span className="muted"> · optimal unknown</span>
            )}
          </div>
        ) : <p className="muted">No target.</p>}
        <p className="phase">Phase: <b>{state.phase}</b></p>
      </section>

      {(state.phase === 'thinking' || state.phase === 'race') && (
        <section className="card">
          <h2>{solo ? 'Your sandbox' : 'Sandbox — experiment freely'}</h2>
          <p className="bigmeter">{myMoves} moves</p>
          <p className="muted">
            {state.phase === 'thinking'
              ? 'Moves count live. Reset anytime. First solve starts the race clock.'
              : 'Race is on — keep optimizing, a smaller solve steals the lead.'}
          </p>
          {state.phase === 'race' && state.race && (
            <div className="clockbar low">
              <div className="fill" style={{ width: `${(state.race.timeLeft / RACE_SECONDS) * 100}%` }} />
              <span>{name(state.race.leaderId)} leads with {state.race.bestMoves} · {state.race.timeLeft}s left</span>
            </div>
          )}
          {!solo && (
            <>
              <ul className="bids">
                {rows.map((p) => {
                  const r = state.roster[p.id] ?? {};
                  return (
                    <li key={p.id}>
                      <span className="dot" style={{ background: p.color }} />{p.name}: <b>{r.movesUsed ?? 0}</b>
                      {r.solved && r.best != null && <span className="muted"> · solved {r.best}</span>}
                      {r.givenUp && <span className="muted"> · gave up</span>}
                      {state.race?.leaderId === p.id && <span> 👑</span>}
                    </li>
                  );
                })}
              </ul>
              {state.mode === 'local' && state.players.length > 1 && (
                <div className="switchrow">
                  <span className="muted">Experimenting as:</span>
                  {state.players.map((p) => (
                    <button
                      key={p.id}
                      className={state.viewAs === p.id ? 'primary' : 'ghost'}
                      onClick={() => dispatch({ type: 'VIEW_AS', playerId: p.id })}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {state.phase === 'reveal' && state.lastResult && (
        <section className="card">
          <h2>Round result</h2>
          {state.lastResult.winnerId
            ? <p><b>{name(state.lastResult.winnerId)}</b> solved it in {state.lastResult.movesUsed}!{state.lastResult.optimal && <> ⚡ <b>Optimal!</b></>}</p>
            : <p className="muted">Unsolved ({state.lastResult.reason}). No points.</p>}
          {!state.lastResult.winnerId && (state.lastResult.answer?.length ?? 0) > 0 && (
            <>
              <p className="muted">Answer in {state.lastResult.answer.length}{(state.answerIdx ?? 0) < state.lastResult.answer.length ? ' — playing…' : ' — done.'}</p>
              <div className="cbtns">
                <button onClick={() => dispatch({ type: 'ANSWER_REPLAY' })}>↻ Replay answer</button>
              </div>
            </>
          )}
          {!state.lastResult.winnerId && !state.lastResult.answer && (
            <p className="muted">No answer within solver search.</p>
          )}
          {(state.mode === 'local' || state.net?.isHost) && (
            <button className="primary" onClick={() => { if (state.mode === 'net') send?.({ t: 'NEXT' }); dispatch({ type: 'NEXT_ROUND' }); }}>Next target →</button>
          )}
          {state.mode === 'net' && !state.net?.isHost && (
            <p className="muted">Waiting for host to start the next target…</p>
          )}
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
        {solo && (
          <p className="muted">Solo: solved {state.soloMoves.filter((m) => m != null).length}/{state.soloMoves.length} · moves: [{state.soloMoves.map((m) => (m == null ? '–' : m)).join(', ')}]</p>
        )}
      </section>
    </aside>
  );
}
