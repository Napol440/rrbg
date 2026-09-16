import { useEffect, useState } from 'react';
import { loadingVideo } from './theme.js';

// Squadron lobby (neon command-deck styling): room code, roster with host
// crown + kick buttons, and host-tunable mission parameters (debounced CONFIG).
export default function Lobby({ state, send, onLeave }) {
  const you = state.players.find((p) => p.id === state.net?.you);
  const isHost = !!state.net?.isHost;
  const hostId = state.net?.hostId ?? state.players[0]?.id;
  const [draft, setDraft] = useState({
    raceSeconds: state.raceSeconds ?? 60,
    roundsTotal: state.roundsTotal ?? 15,
    robotCount: state.robotCount ?? 4,
    targetCount: state.targetCount ?? 1,
    hardMode: !!state.hardMode,
    chaos: !!state.chaos,
  });
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  // Host edits fly to the server (debounced); guests render read-only.
  useEffect(() => {
    if (!isHost) return;
    const t = setTimeout(() => send({ t: 'CONFIG', cfg: draft }), 400);
    return () => clearTimeout(t);
  }, [draft, isHost, send]);

  return (
    <div className="hud-wrap">
      <div className="hud">
        <h1 className="hud-title">Squadron lobby</h1>
        <div className="hud-code">{state.net?.code}</div>
        <p className="muted">
          Share the code. You are <b>{you?.name}</b>{isHost && ' — mission control 👑'}.
        </p>

        <h2 className="hud-sub">Pilots ({state.players.length}/6)</h2>
        <ul className="hud-roster">
          {state.players.map((p) => (
            <li key={p.id} className="hud-row">
              <span className="dot" style={{ background: p.color }} />
              <span className="hud-name">{p.name}</span>
              {p.id === hostId && <span title="Host">👑</span>}
              {p.id === state.net?.you && <span className="muted">(you)</span>}
              <span className="spacer" />
              {isHost && p.id !== state.net?.you && (
                <button
                  className="hud-kick"
                  title={`Remove ${p.name}`}
                  aria-label={`Remove ${p.name}`}
                  onClick={() => send({ t: 'KICK', playerId: p.id })}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>

        <h2 className="hud-sub">Mission parameters</h2>
        {isHost ? (
          <div className="hud-grid">
            <label>Race timer (s)
              <input
                type="number" min="10" max="300" step="5" value={draft.raceSeconds}
                onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) set('raceSeconds', Math.max(10, Math.min(300, v))); }}
              />
            </label>
            <label>Rounds (N)
              <input
                type="number" min="1" max="40" value={draft.roundsTotal}
                onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) set('roundsTotal', Math.max(1, Math.min(40, v))); }}
              />
            </label>
            <label>Robots
              <select value={draft.robotCount} onChange={(e) => set('robotCount', +e.target.value)}>
                <option value={4}>4 + no blocker</option>
                <option value={5}>5 + silver</option>
              </select>
            </label>
            <label>Targets
              <select value={draft.targetCount} onChange={(e) => set('targetCount', Math.max(1, Math.min(3, +e.target.value || 1)))}>
                <option value={1}>1 target</option>
                <option value={2}>2 targets</option>
                <option value={3}>3 targets</option>
              </select>
            </label>
            <label className="check">Random walls
              <input type="checkbox" checked={draft.chaos} onChange={(e) => set('chaos', e.target.checked)} />
            </label>
            <label className="check" title="Wins require 3+ distinct rockets in the line">Hard mode (3+ rockets)
              <input type="checkbox" checked={!!draft.hardMode} onChange={(e) => set('hardMode', e.target.checked)} />
            </label>
          </div>
        ) : (
          <p className="muted">
            ⏱ {state.raceSeconds ?? 60}s race · {state.roundsTotal} rounds · {state.robotCount} robots · {state.targetCount ?? 1} target{(state.targetCount ?? 1) === 1 ? '' : 's'}
            {state.chaos ? ' · random walls on' : ''}{state.hardMode ? ' · HARD (3+ rockets)' : ''}
            <br />Waiting for the host to launch…
          </p>
        )}

        <div className="cbtns">
          {isHost && (
            <button className="hud-btn primary" disabled={state.players.length < 1} onClick={() => send({ t: 'START' })}>
              ▸ Launch mission{state.net?.arenaReady ? '' : '…'}
            </button>
          )}
          <button className="hud-btn ghost" onClick={onLeave}>Leave</button>
        </div>
        <p className="muted">{state.net?.arenaReady ? '◆ Arena pre-built — launch is instant.' : '◇ Building arena…'}</p>
        {!state.net?.arenaReady && (
          <video className="hud-loading" src={loadingVideo} autoPlay loop muted playsInline aria-label="Building arena" />
        )}
      </div>
    </div>
  );
}
