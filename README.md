# Ricochet Robots — hot-seat web build (React + Vite)

Fully playable 1–6 player implementation. No backend; all state is client-side.

## Run it

```sh
npm install
npm run dev      # → http://localhost:5173
npm test         # engine validator tests (node --test)
npm run build    # static dist/ for hosting
```

## How a round works

1. **Target revealed** — the matching-colour robot must reach the pulsing token.
2. **Thinking (unlimited)** — simultaneous; solo players can freely explore the board (moves don't count).
3. **Bidding** — anyone declares a move count. The first bid starts a **60s clock**; any strictly **lower** bid restarts it. Lowest bidder attempts first.
4. **Attempt (60s)** — solve within the declared move count. **Undo** pops one move, **Reset** restores the round-start position — both allowed inside the budget. Fail (timeout / out-of-moves / give up) → next-lowest bidder tries the same target from a fresh board.
5. **Solved → point**, next target. Winner: most targets after N rounds, or first to X points.
6. **Solo (1 player)** — bidding is skipped; solve against the solver's par, tracked over N rounds.

## Controls

- Click/tap a robot to select, then: arrow keys / WASD, on-screen D-pad, or click a cell in the same row/column to slide toward it.
- Robots slide until a wall, the board edge, the center vault, or another robot. Zero-displacement slides are rejected.

## Code map

- `src/game/engine.js` — slide physics, legal-move validator, BFS solver/par
- `src/game/board.js` — 4 authored 8×8 quadrant tiles, mirrored/rotated/shuffled per game; target deck; robot scatter
- `src/game/bidding.js` — 60s clocks, lowest-first ordering
- `src/state/useGame.js` — phase machine (setup→thinking→bidding→attempt→reveal→gameOver)
- `src/components/` — `Board.jsx` (SVG), `Sidebar.jsx`, `Controls.jsx`, `SetupScreen.jsx`
