import { useEffect, useMemo, useState } from 'react';
import { ROBOT_FILL, ROBOT_DARK } from './colors.js';
import { ROCKET_IMG, dirAngle } from './rockets.js';
import { laserWall, asteroidImg, spaceBg, LASER_W, LASER_H } from './theme.js';

// SVG board: 16×16 cells over the space backdrop, laser edge walls,
// asteroid vault, target tokens, rocket sprites (CSS-transform slide).
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

// Convert the "x,y:DIR" wall set into laser-sprite placements.
function wallSprites(walls) {
  const segs = [];
  for (const w of walls) {
    const [cell, dir] = w.split(':');
    const [x, y] = cell.split(',').map(Number);
    if (dir === 'N') segs.push({ mx: (x + 0.5) * CELL, my: y * CELL, vertical: false });
    else if (dir === 'S') segs.push({ mx: (x + 0.5) * CELL, my: (y + 1) * CELL, vertical: false });
    else if (dir === 'W') segs.push({ mx: x * CELL, my: (y + 0.5) * CELL, vertical: true });
    else if (dir === 'E') segs.push({ mx: (x + 1) * CELL, my: (y + 0.5) * CELL, vertical: true });
  }
  return segs;
}

const VAULT = 7 * CELL; // center 2×2 block origin (80×80 units)

export default function Board({ walls, robots, targets, activeTargets, selectedId, onSelect, onMove, onCellAim, disabled, illegal }) {
  const [shake, setShake] = useState(0);
  const segs = useMemo(() => wallSprites(walls), [walls]);

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
      aria-label="Rocket Rebound board"
      style={{ backgroundImage: `url(${spaceBg})` }}
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
      {/* center-vault asteroid over the 2×2 block (1.3× for presence) */}
      <image href={asteroidImg} x={VAULT - 14.6} y={VAULT - 14.6} width={109.2} height={109.2} preserveAspectRatio="xMidYMid meet" />
      {/* active targets only — the round's objectives, glowing */}
      {targets.filter((t) => !activeTargets || activeTargets.some((a) => a.id === t.id)).map((t) => (
        <g key={t.id} className="target-active" transform={`translate(${t.x * CELL},${t.y * CELL})`}>
          <TargetGlyph shape={t.shape} color={t.color} />
          <rect x={2} y={2} width={CELL - 4} height={CELL - 4} className="active-ring" />
        </g>
      ))}
      {/* walls as laser segments on the cell edges */}
      {segs.map((sg, i) => (
        sg.vertical ? (
          <g key={i} transform={`translate(${sg.mx},${sg.my}) rotate(90)`}>
            <image className="laser" href={laserWall} x={-LASER_W / 2} y={-LASER_H / 2} width={LASER_W} height={LASER_H} preserveAspectRatio="xMidYMid meet" />
          </g>
        ) : (
          <image key={i} className="laser" href={laserWall} x={sg.mx - LASER_W / 2} y={sg.my - LASER_H / 2} width={LASER_W} height={LASER_H} preserveAspectRatio="xMidYMid meet" />
        )
      ))}
      <rect x={1} y={1} width={W - 2} height={W - 2} className="border" />
      {/* robots as rocket sprites (dot fallback for colours without art) */}
      {robots.map((r) => {
        const img = ROCKET_IMG[r.color];
        const isSel = r.id === selected?.id;
        return (
          <g
            key={r.id}
            className={`robot ${isSel ? 'sel' : ''}`}
            style={{ transform: `translate(${r.x * CELL + CELL / 2}px, ${r.y * CELL + CELL / 2}px) rotate(${dirAngle(r.dir)}deg)` }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(r.id);
            }}
          >
            <title>{r.color} rocket</title>
            {img ? (
              <>
                {isSel && <circle r={16} className="sel-ring" />}
                <image href={img} x={-11} y={-17} width={22} height={34} preserveAspectRatio="xMidYMid meet" />
              </>
            ) : (
              <>
                <circle r={14} fill={ROBOT_FILL[r.color]} stroke={ROBOT_DARK[r.color]} strokeWidth={3} />
                <text y={5} textAnchor="middle" className="robot-label">
                  {r.color[0].toUpperCase()}
                </text>
              </>
            )}
          </g>
        );
      })}
      {disabled && <rect x={0} y={0} width={W} height={W} fill="transparent" />}
    </svg>
  );
}
