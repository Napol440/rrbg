import { RACE_SECONDS } from '../game/race.js';
import { activeTargets, activeMovesUsed } from '../state/useGame.js';
import { chargesUsed } from '../game/engine.js';
import { ROBOT_FILL } from './colors.js';

// Right-hand panel: target card, sandbox meter, race clock, roster, scoreboard.
export default function Sidebar({ state, dispatch, send, onNextRound, showPath, onTogglePath }) {
  const next = onNextRound ?? (() => dispatch({ type: 'NEXT_ROUND' }));
  const hasLeadLine = (state.phase === 'race' && (state.race?.path?.length ?? 0) > 0)
    || (state.phase === 'reveal' && (state.lastResult?.path?.length ?? 0) > 0);
  const targets = activeTargets(state);
  const multi = targets.length > 1;
  const selfPid = state.mode === 'net' ? state.net?.you : state.viewAs;
  const collected = new Set((selfPid && state.sandboxes[selfPid]?.collected) ?? []);
  const name = (id) => state.players.find((p) => p.id === id)?.name ?? id;
  const solo = state.players.length === 1 && state.mode === 'local';
  const myMoves = activeMovesUsed(state);
  const rows = [...state.players].sort((a, b) => (state.roster[b.id]?.movesUsed ?? 0) - (state.roster[a.id]?.movesUsed ?? 0));

  return (
    <aside className="side">
      <section className="card target-card">
        <h2>Round {state.round}/{state.roundsTotal} · Target{multi ? `s — ${collected.size}/${targets.length} collected` : ''}{state.hardMode ? ' · HARD 3+' : ''}</h2>
        {targets.length ? targets.map((t) => (
          <div key={t.id} className="targetline">
            <span className="swatch" style={{ background: ROBOT_FILL[t.color] }} />
            <b style={{ textTransform: 'capitalize' }}>{t.color} {t.shape}</b>
            {multi && collected.has(t.id) && <span> ✓</span>}
          </div>
        )) : <p className="muted">No target.</p>}
        {!multi && state.par != null && (
          <span className="muted"> · optimal: {state.par}</span>
        )}
        {!multi && state.par == null && !solo && (
          <span className="muted"> · optimal unknown</span>
        )}
        {multi && (
          <span className="muted"> · multi-target: no optimal, fewest total wins</span>
        )}
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
            <>
              <div className="clockbar low">
                <div className="fill" style={{ width: `${(state.race.timeLeft / (state.race.total ?? RACE_SECONDS)) * 100}%` }} />
                <span>{name(state.race.leaderId)} leads with {state.race.bestMoves}{!multi && state.par != null && <> · optimal {state.par}</>} · {state.race.timeLeft}s left</span>
              </div>
              {hasLeadLine && (
                <div className="cbtns">
                  <button className="ghost" onClick={onTogglePath}>👁 {showPath ? 'Hide' : 'Show'} lead line</button>
                </div>
              )}
            </>
          )}
          {!solo && (
            <>
              <ul className="bids">
                {rows.map((p) => {
                  const r = state.roster[p.id] ?? {};
                  const isSelf = (state.mode === 'net' ? state.net?.you : state.viewAs) === p.id;
                  const spent = isSelf
                    ? chargesUsed(state.sandboxes[p.id]?.history)
                    : { breach: r.powers?.breach ? 1 : 0, block: r.powers?.block ? 1 : 0 };
                  return (
                    <li key={p.id}>
                      <span className="dot" style={{ background: p.color }} />{p.name}: <b>{r.movesUsed ?? 0}</b>
                      {r.solved && r.best != null && <span className="muted"> · solved {r.best}</span>}
                      {r.givenUp && <span className="muted"> · gave up</span>}
                      {state.race?.leaderId === p.id && <span> 👑</span>}
                      <span className="pips" title="Red breach / Green block">
                        <span className={spent.breach ? 'pip spent' : 'pip'} style={{ background: '#e5484d' }} />
                        <span className={spent.block ? 'pip spent' : 'pip'} style={{ background: '#46a758' }} />
                      </span>
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
            ? <p><b>{name(state.lastResult.winnerId)}</b> solved it in {state.lastResult.movesUsed}{!multi && state.par != null && !state.lastResult.optimal && <> (optimal {state.par})</>}!{state.lastResult.optimal && <> ⚡ <b>Optimal!</b></>}</p>
            : <p className="muted">Unsolved ({state.lastResult.reason}). No points.</p>}
          {state.lastResult.winnerId && hasLeadLine && (
            <div className="cbtns">
              <button className="ghost" onClick={onTogglePath}>👁 {showPath ? 'Hide' : 'Show'} winning line</button>
            </div>
          )}
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
            <button className="primary" onClick={next}>Next target →</button>
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
