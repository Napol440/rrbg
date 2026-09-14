import { useState } from 'react';
import { playerColor } from '../state/useGame.js';

// Entry screen: solo practice on this device, or online rooms for multiplayer.
// (Hot-seat multiplayer was removed — every pilot gets their own screen.)
export default function SetupScreen({ onStart, onCreate, onJoin }) {
  const [soloName, setSoloName] = useState('Ada');
  const [roundsTotal, setRoundsTotal] = useState(15);
  const [pointsToWin, setPointsToWin] = useState(0);
  const [robotCount, setRobotCount] = useState(4);
  const [targetCount, setTargetCount] = useState(1);
  const [chaos, setChaos] = useState(false);
  const [netName, setNetName] = useState('');
  const [joinCode, setJoinCode] = useState('');

  const startSolo = () => {
    onStart({
      players: [{ name: soloName.trim() || 'Solo', color: playerColor(0) }],
      roundsTotal,
      pointsToWin,
      robotCount,
      targetCount,
      chaos,
    });
  };

  return (
    <div className="setup">
      <h1>Rocket Rebound</h1>
      <p className="muted">Solo practice offline · multiplayer in online rooms</p>

      <div className="hud-wrap">
        <section className="hud">
          <h2 className="hud-title">Solo flight</h2>
          <label className="namerow">
            <span>Your name</span>
            <input value={soloName} onChange={(e) => setSoloName(e.target.value)} maxLength={12} placeholder="Ada" />
          </label>
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
            <label>Targets per round
              <select value={targetCount} onChange={(e) => setTargetCount(+e.target.value)}>
                <option value={1}>1 target</option>
                <option value={2}>2 targets</option>
                <option value={3}>3 targets</option>
              </select>
            </label>
            <label className="check">Chaos walls
              <input type="checkbox" checked={chaos} onChange={(e) => setChaos(e.target.checked)} />
            </label>
          </div>
          <button className="hud-btn primary" onClick={startSolo}>Launch solo</button>
        </section>
      </div>

      <details>
        <summary>How a round works</summary>
        <ol>
          <li>A coloured target is revealed. Experiment freely — moves count live, reset anytime.</li>
          <li>First solve starts the race clock — everyone sees the move count.</li>
          <li>A <b>smaller</b> solve restarts the clock and steals the lead. A provably <b>optimal</b> solve (≤ par) wins instantly.</li>
          <li>Lowest-move solver scores the target. Most targets (or first to X) wins.</li>
        </ol>
      </details>

      <div className="hud-wrap">
        <section className="hud">
          <h2 className="hud-title">Squadron rooms</h2>
          <p className="muted">Create a room and share the 4-letter code, or join with one. The host tunes timer, rounds, robots and walls in the lobby.</p>
          <label className="namerow">
            <span>Your name</span>
            <input value={netName} onChange={(e) => setNetName(e.target.value)} maxLength={12} placeholder="Ada" />
          </label>
          <div className="cbtns">
            <button className="hud-btn primary" onClick={() => onCreate?.({ name: netName.trim() || 'Host', cfg: { roundsTotal, pointsToWin, robotCount, targetCount, chaos, raceSeconds: 60 } })}>
              Create room
            </button>
          </div>
          <label className="namerow">
            <span>Room code</span>
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} maxLength={4} placeholder="ABCD" />
          </label>
          <div className="cbtns">
            <button className="hud-btn" onClick={() => joinCode.trim() && onJoin?.({ name: netName.trim() || 'Guest', code: joinCode.trim() })}>
              Join room
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
