import { useState } from 'react';
import { playerColor } from '../state/useGame.js';

// Player setup: 1–6 hot-seat players, round/point config, robot count.
// Plus online rooms: create a room (share the code) or join one.
export default function SetupScreen({ onStart, onCreate, onJoin }) {
  const [count, setCount] = useState(2);
  const [names, setNames] = useState(['Ada', 'Bob', 'Cid', 'Dee', 'Eli', 'Fay']);
  const [roundsTotal, setRoundsTotal] = useState(15);
  const [pointsToWin, setPointsToWin] = useState(0);
  const [robotCount, setRobotCount] = useState(4);
  const [chaos, setChaos] = useState(false);
  const [netName, setNetName] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const setName = (i, v) => setNames((n) => n.map((x, j) => (j === i ? v : x)));

  const start = () => {
    const players = Array.from({ length: count }, (_, i) => ({
      name: names[i]?.trim() || `Player ${i + 1}`,
      color: playerColor(i),
    }));
    onStart({ players, roundsTotal, pointsToWin, robotCount, chaos });
  };

  return (
    <div className="setup">
      <h1>Ricochet Robots</h1>
      <p className="muted">Hot-seat multiplayer · 1–6 players · all state in your browser</p>

      <label className="row">
        <span>Players: <b>{count}</b> {count === 1 && '(solo — bidding skipped)'}</span>
        <input type="range" min="1" max="6" value={count} onChange={(e) => setCount(+e.target.value)} />
      </label>
      <div className="names">
        {Array.from({ length: count }, (_, i) => (
          <label key={i} className="namerow">
            <span className="dot" style={{ background: playerColor(i) }} />
            <input value={names[i]} onChange={(e) => setName(i, e.target.value)} maxLength={12} aria-label={`Player ${i + 1} name`} />
          </label>
        ))}
      </div>

      <div className="grid2">
        <label>Rounds (N)
          <input type="number" min="1" max="40" value={roundsTotal} onChange={(e) => setRoundsTotal(Math.max(1, +e.target.value || 1))} />
        </label>
        <label>First to X points (0 = off)
          <input type="number" min="0" max="30" value={pointsToWin} onChange={(e) => setPointsToWin(Math.max(0, +e.target.value || 0))} />
        </label>
        <label>Robots on board
          <select value={robotCount} onChange={(e) => setRobotCount(+e.target.value)}>
            <option value={4}>4 (red/blue/green/yellow)</option>
            <option value={5}>5 (+ silver blocker)</option>
          </select>
        </label>
        <label className="check">Chaos walls
          <input type="checkbox" checked={chaos} onChange={(e) => setChaos(e.target.checked)} />
        </label>
      </div>

      <button className="primary" onClick={start}>Start game</button>
      <details>
        <summary>How a round works</summary>
        <ol>
          <li>A coloured target is revealed. Experiment freely — moves count live, reset anytime.</li>
          <li>First solve starts the race clock — everyone sees the move count.</li>
          <li>A <b>smaller</b> solve restarts the clock and steals the lead. A provably <b>optimal</b> solve (≤ par) wins instantly.</li>
          <li>Lowest-move solver scores the target. Most targets (or first to X) wins.</li>
        </ol>
      </details>

      <div className="netbox">
        <h2>Play online</h2>
        <p className="muted">Create a room and share the 4-letter code, or join with one. Needs the rooms server (<code>npm run server</code>).</p>
        <label className="namerow">
          <span>Your name</span>
          <input value={netName} onChange={(e) => setNetName(e.target.value)} maxLength={12} placeholder="Ada" />
        </label>
        <div className="cbtns">
          <button className="primary" onClick={() => onCreate?.({ name: netName.trim() || 'Host', cfg: { roundsTotal, pointsToWin, robotCount, chaos } })}>
            Create room
          </button>
        </div>
        <label className="namerow">
          <span>Room code</span>
          <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} maxLength={4} placeholder="ABCD" />
        </label>
        <div className="cbtns">
          <button onClick={() => joinCode.trim() && onJoin?.({ name: netName.trim() || 'Guest', code: joinCode.trim() })}>
            Join room
          </button>
        </div>
      </div>
    </div>
  );
}
