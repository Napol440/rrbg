import { useEffect, useMemo, useState } from 'react';
import { ROBOT_FILL, ROBOT_DARK } from './colors.js';

// SVG board: 16×16 cells, walls as thick edge lines, targets as shape tokens,
// robots as sliding tokens (CSS-transform transition = slide animation).
const N = 16;
const CELL = 40;
const W = N * CELL;

function TargetGlyph({ shape, color, active, dim }) {
  const fill = ROBOT_FILL[color] ?? '#888';
  const stroke = ROBOT_DARK[color] ?? '#333';
  const c = CELL / 2;
  const common = { opacity: dim ? 0.35 : 1 };
  if (shape === 'circle') return <circle cx={c} cy={c} r={11} fill={fill} stroke={stroke} strokeWidth={3} {...common} />;
  if (shape === 'square') return <rect x={c - 10} y={c - 10} width={20} height={20} fill={fill} stroke={stroke} strokeWidth={3} {...common} />;
  if (shape === 'triangle') return <polygon points={`${c},${c - 12} ${c - 11},${c + 9} ${c + 11},${c + 9}`} fill={fill} stroke={stroke} strokeWidth={3} strokeLinejoin="round" {...common} />;
  // hex
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 6;
    return `${c + 12 * Math.cos(a)},${c + 12 * Math.sin(a)}`;
  }).join(' ');
  return <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={3} strokeLinejoin="round" {...common} />;
}

// Convert the "x,y:DIR" wall set into SVG line segments.
function wallLines(walls) {
  const lines = [];
  for (const w of walls) {
    const [cell, dir] = w.split(':');
    const [x, y] = cell.split(',').map(Number);
    const x0 = x * CELL;
    const y0 = y * CELL;
    if (dir === 'N') lines.push([x0, y0, x0 + CELL, y0]);
    else if (dir === 'S') lines.push([x0, y0 + CELL, x0 + CELL, y0 + CELL]);
    else if (dir === 'W') lines.push([x0, y0, x0, y0 + CELL]);
    else if (dir === 'E') lines.push([x0 + CELL, y0, x0 + CELL, y0 + CELL]);
  }
  return lines;
}

export default function Board({ walls, robots, targets, activeTarget, selectedId, onSelect, onMove, onCellAim, disabled, illegal }) {
  const [shake, setShake] = useState(0);
  const lines = useMemo(() => wallLines(walls), [walls]);

  // Replay a shake animation whenever an illegal slide is rejected.
  useEffect(() => {
    if (illegal) setShake((s) => s + 1);
  }, [illegal]);

  const selected = robots.find((r) => r.id === selectedId) ?? robots[0];

  return (
    <svg
      className="board"
      viewBox={`0 0 ${W} ${W}`}
      role="grid"
      aria-label="Ricochet Robots board"
      key={shake /* remount to retrigger shake via CSS */}
    >
      {/* cells */}
      {Array.from({ length: N * N }, (_, i) => {
        const x = i % N;
        const y = Math.floor(i / N);
        const center = x >= 7 && x <= 8 && y >= 7 && y <= 8;
        return (
          <rect
            key={i}
            x={x * CELL}
            y={y * CELL}
            width={CELL}
            height={CELL}
            className={center ? 'cell vault' : 'cell'}
            onClick={() => onCellAim?.(x, y)}
          />
        );
      })}
      {/* faint grid */}
      {Array.from({ length: N + 1 }, (_, i) => (
        <g key={i} className="gridline">
          <line x1={i * CELL} y1={0} x2={i * CELL} y2={W} />
          <line x1={0} y1={i * CELL} x2={W} y2={i * CELL} />
        </g>
      ))}
      {/* target tokens printed on the board */}
      {targets.map((t) => (
        <g key={t.id} transform={`translate(${t.x * CELL},${t.y * CELL})`} opacity={activeTarget && t.id !== activeTarget.id ? 0.45 : 1}>
          <TargetGlyph shape={t.shape} color={t.color} />
          {activeTarget && t.id === activeTarget.id && (
            <rect x={2} y={2} width={CELL - 4} height={CELL - 4} className="active-ring" />
          )}
        </g>
      ))}
      {/* walls as thick edge lines */}
      {lines.map(([x1, y1, x2, y2], i) => (
        <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="wall" />
      ))}
      <rect x={1} y={1} width={W - 2} height={W - 2} className="border" />
      {/* robots */}
      {robots.map((r) => (
        <g
          key={r.id}
          className={`robot ${r.id === selected?.id ? 'sel' : ''}`}
          style={{ transform: `translate(${r.x * CELL + CELL / 2}px, ${r.y * CELL + CELL / 2}px)` }}
          onClick={(e) => {
            e.stopPropagation();
            onSelect?.(r.id);
          }}
        >
          <circle r={14} fill={ROBOT_FILL[r.color]} stroke={ROBOT_DARK[r.color]} strokeWidth={3} />
          <text y={5} textAnchor="middle" className="robot-label">
            {r.color[0].toUpperCase()}
          </text>
        </g>
      ))}
      {disabled && <rect x={0} y={0} width={W} height={W} fill="transparent" />}
    </svg>
  );
}
