// Background map builder (Node worker thread): solves the NEXT round's deal
// while the current one is played, so NEXT is instant and the event loop
// never stalls mid-race. Thin wrapper over findDeal — all logic and tests
// live in src/game/race.js. One shared worker for all rooms; jobs carry
// {jobId, gen} so stale results are discarded. Sync deal is the fallback.
import { parentPort } from 'node:worker_threads';
import { findDeal } from '../src/game/race.js';
import { scatterRobots } from '../src/game/board.js';
import { terrainOpts } from '../src/game/engine.js';

parentPort.on('message', (job) => {
  try {
    const targets = job.targets ?? [];
    const tiles = job.tiles ?? [];
    const tileCells = tiles.map((t) => `${t.x},${t.y}`);
    const found = findDeal(
      {
        walls: new Set(job.walls ?? []),
        targets: job.targets ?? [],
        deck: job.deck ?? [],
        deckPos: job.deckPos ?? 0,
        targetCount: job.targetCount ?? 1,
        robotKinds: job.robotKinds ?? [],
        terrain: terrainOpts(tiles),
        hardMode: !!job.hardMode,
      },
      { scatter: (ks) => scatterRobots(ks.map((k) => ({ ...k })), targets, tileCells) },
    );
    parentPort.postMessage({ ok: true, jobId: job.jobId, gen: job.gen, ...found });
  } catch (err) {
    parentPort.postMessage({ ok: false, jobId: job.jobId, gen: job.gen, error: String(err?.message ?? err) });
  }
});
