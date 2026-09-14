# Rocket Rebound — race mode + online rooms (React + Vite)

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

1. **Target revealed** — the matching-colour robot must reach the pulsing token. Rounds are re-dealt until the puzzle genuinely needs 6+ moves (or is beyond solver search).
2. **Thinking (unlimited, sandbox)** — everyone experiments on a **private board copy**: moves count live, **Reset** restores the round start, all free. Sidebar shows every player's live count.
3. **Race** — the first *validated* solve starts the **60s clock**; all players see `"<name> solved in N"`. A strictly **smaller** solve restarts the clock and steals the lead. A provably **optimal** solve (≤ solver par) wins **instantly** ⚡.
4. **Solved → point**, next target. Winner: most targets after N rounds, or first to X points.
5. **Solo (1 player)** — no race; solve against the solver's par, tracked over N rounds.

## Online rooms

- **Create** a room (uses your rounds/robots settings), share the code; others **Join** with name + code. Host starts, host advances rounds.
- The server is authoritative: board seed, round scatter, race clock, and solution validation (your move list is replayed with the real slide physics — fake solves are rejected). Clients only send move counts + claimed solutions.
- Mid-game joiners catch up immediately. Rooms are in-memory (a server restart drops them). Solo/hot-seat works with no server.
- Playing on the same Wi-Fi: run `npm run server` plus `npm run dev -- --host`, then others open `http://<your-lan-ip>:5173/rrbg/`.
- GitHub Pages is static-only: it cannot host rooms. Point it at a public server with `VITE_ROOM_WS=wss://<server-host>/ws` at build time, or just open the app from wherever `npm start` runs.

## Playing on the public site (2+ devices, any network)

Pages can't run the rooms server, so host it free on Render (~5 min, one time):

1. Push this repo to GitHub (already done for Pages).
2. [Render](https://render.com/) → New → Web Service → select this repo. Render auto-detects `render.yaml` (build `npm ci && npm run build`, start `npm start`, free plan). Deploy and copy your URL, e.g. `https://rrbg-rooms.onrender.com`.
3. GitHub repo → Settings → Secrets and variables → Actions → **Variables** → New: name `VITE_ROOM_WS`, value `wss://rrbg-rooms.onrender.com/ws` (note `wss`, same host as step 2).
4. Push any commit (or re-run the Deploy workflow) — Pages rebuilds with rooms wired up. Open `https://<you>.github.io/rrbg/` on both devices, create/join with the room code.

Notes: free Render sleeps after inactivity — the first Create/Join can take ~30s while it wakes; rooms are in-memory, so a sleep/restart drops active games. Warm it first by opening `https://rrbg-rooms.onrender.com/` once.

## Code map

- `src/game/engine.js` — slide physics, legal-move validator, BFS solver/par
- `src/game/board.js` — 4 authored 8×8 quadrant tiles, mirrored/rotated/shuffled per game; target deck; robot scatter
- `src/game/race.js` — 60s race clock, better/optimal-solve predicates, shared solution validator
- `src/state/useGame.js` — phase machine (setup→thinking→race→reveal→gameOver) + per-player sandboxes + net actions
- `server/rooms.js` + `server/index.js` — authoritative rooms (pure logic + ws/static host)
- `src/net/socket.js` — rooms WS endpoint helper
- `src/components/` — `Board.jsx` (SVG), `Sidebar.jsx` (sandbox meter, race clock, roster), `Controls.jsx`, `SetupScreen.jsx` (hot-seat + create/join), `Lobby.jsx`
- `asset/` — rocket sprites, laser walls, vault asteroid, space backdrop
