// D-pad + undo/reset/give-up buttons. Keyboard lives in App (single global
// listener): arrows/WASD move, 1-5 select rocket, U undo, R reset, G give up.
export default function Controls({ onMove, onUndo, onReset, onGiveUp, canPlay, selectedColor, robotCount }) {
  return (
    <div className="controls">
      <div className="dpad" aria-label="Move selected robot">
        <span />
        <button onClick={() => onMove('up')} disabled={!canPlay} aria-label="Move up">▲</button>
        <span />
        <button onClick={() => onMove('left')} disabled={!canPlay} aria-label="Move left">◀</button>
        <button onClick={() => onMove('down')} disabled={!canPlay} aria-label="Move down">▼</button>
        <button onClick={() => onMove('right')} disabled={!canPlay} aria-label="Move right">▶</button>
      </div>
      <div className="cbtns">
        <button onClick={onUndo} disabled={!canPlay}>↩ Undo <kbd>U</kbd></button>
        <button onClick={onReset} disabled={!canPlay}>⟲ Reset <kbd>R</kbd></button>
        <button className="ghost" onClick={onGiveUp} disabled={!canPlay}>Give up <kbd>G</kbd></button>
      </div>
      {selectedColor && <p className="muted">Selected: <b style={{ textTransform: 'capitalize' }}>{selectedColor}</b> robot — keys <b>1–{robotCount ?? 4}</b> switch rockets, click one, or use WASD/arrows to fly.</p>}
    </div>
  );
}
