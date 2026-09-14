import { useEffect } from 'react';

// D-pad + undo/reset + keyboard (arrows/WASD). All moves go through onMove(dir)
// which App resolves against the currently selected robot.
export default function Controls({ onMove, onUndo, onReset, onGiveUp, canPlay, selectedColor }) {
  useEffect(() => {
    const onKey = (e) => {
      if (!canPlay) return;
      const map = {
        ArrowUp: 'up', w: 'up', W: 'up',
        ArrowDown: 'down', s: 'down', S: 'down',
        ArrowLeft: 'left', a: 'left', A: 'left',
        ArrowRight: 'right', d: 'right', D: 'right',
      };
      const dir = map[e.key];
      if (!dir) return;
      e.preventDefault();
      onMove(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPlay, onMove]);

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
        <button onClick={onUndo} disabled={!canPlay}>↩ Undo</button>
        <button onClick={onReset} disabled={!canPlay}>⟲ Reset</button>
        <button className="ghost" onClick={onGiveUp} disabled={!canPlay}>Give up</button>
      </div>
      {selectedColor && <p className="muted">Selected: <b style={{ textTransform: 'capitalize' }}>{selectedColor}</b> robot — click another robot to switch.</p>}
    </div>
  );
}
