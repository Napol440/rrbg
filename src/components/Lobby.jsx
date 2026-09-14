// Online lobby: room code, player list, host starts the game.
export default function Lobby({ state, send, onLeave }) {
  const you = state.players.find((p) => p.id === state.net?.you);
  return (
    <div className="setup">
      <h1>Room <span className="lobby-code">{state.net?.code}</span></h1>
      <p className="muted">Share the code so others can join. You are <b>{you?.name}</b>{state.net?.isHost && ' (host)'}.</p>
      <ul className="bids">
        {state.players.map((p) => (
          <li key={p.id}><span className="dot" style={{ background: p.color }} />{p.name}{p.id === state.net?.you && ' (you)'}</li>
        ))}
      </ul>
      <p className="muted">{state.roundsTotal} rounds · {state.robotCount} robots</p>
      <div className="cbtns">
        {state.net?.isHost
          ? <button className="primary" disabled={state.players.length < 1} onClick={() => send({ t: 'START' })}>Start game</button>
          : <p className="muted">Waiting for the host to start…</p>}
        <button className="ghost" onClick={onLeave}>Leave</button>
      </div>
    </div>
  );
}
