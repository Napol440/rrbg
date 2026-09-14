# Ricochet Robots — race mode + online rooms (React + Vite)

1–6 players, hot-seat or online. No account; rooms are 4-letter codes on a tiny Node server.

## Run it

```sh
npm install
npm run dev      # → http://localhost:5173 (hot-seat/solo only)

# Online rooms (two processes in dev):
npm run server   # → rooms server on :8787
npm run dev      # app talks to ws://localhost:8787/ws

npm test         # engine + race + rooms tests (node --test)
npm run build    # static dist/ for hosting
npm start        # serve dist/ + rooms on one port (PORT env, default 8787)
```

## How a round works

1. **Target revealed** — the matching-colour robot must reach the pulsing token.
2. **Thinking (unlimited, sandbox)** — everyone experiments on a **private board copy**: moves count live, **Reset** restores the round start, all free. Sidebar shows every player's live count.
3. **Race** — the first *validated* solve starts the **60s clock**; all players see `"<name> solved in N"`. A strictly **smaller** solve restarts the clock and steals the lead. A provably **optimal** solve (≤ solver par) wins **instantly** ⚡.
4. **Solved → point**, next target. Winner: most targets after N rounds, or first to X points.
5. **Solo (1 player)** — no race; solve against the solver's par, tracked over N rounds.

## Online rooms

- **Create** a room (uses your rounds/robots settings), share the code; others **Join** with name + code. Host starts, host advances rounds.
- The server is authoritative: board seed, round scatter, race clock, and solution validation (your move list is replayed with the real slide physics — fake solves are rejected). Clients only send move counts + claimed solutions.
- Mid-game joiners catch up immediately. Rooms are in-memory (a server restart drops them). Solo/hot-seat works with no server.

## Code map

- `src/game/engine.js` — slide physics, legal-move validator, BFS solver/par
- `src/game/board.js` — 4 authored 8×8 quadrant tiles, mirrored/rotated/shuffled per game; target deck; robot scatter
- `src/game/race.js` — 60s race clock, better/optimal-solve predicates, shared solution validator
- `src/state/useGame.js` — phase machine (setup→thinking→race→reveal→gameOver) + per-player sandboxes + net actions
- `server/rooms.js` + `server/index.js` — authoritative rooms (pure logic + ws/static host)
- `src/net/socket.js` — rooms WS endpoint helper
- `src/components/` — `Board.jsx` (SVG), `Sidebar.jsx` (sandbox meter, race clock, roster), `Controls.jsx`, `SetupScreen.jsx` (hot-seat + create/join), `Lobby.jsx`
