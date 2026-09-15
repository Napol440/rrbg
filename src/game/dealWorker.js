// Background map builder: runs the budgeted deal search off the main thread
// so round transitions stay instant. Thin wrapper over findDeal — all deal
// logic and its tests live in race.js. Bundled by Vite; App posts one job
// per round ({jobId, walls[], targets, deck, deckPos, targetCount,
// robotKinds}) and consumes {ok, jobId, robots, par, deckPos}.
import { findDeal } from './race.js';
import { scatterRobots } from './board.js';
import { terrainOpts } from './engine.js';

self.onmessage = (e) => {
  const job = e.data ?? {};
  try {
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
      },
      { scatter: (ks) => scatterRobots(ks.map((k) => ({ ...k })), job.targets ?? [], tileCells) },
    );
    self.postMessage({ ok: true, jobId: job.jobId, ...found });
  } catch (err) {
    self.postMessage({ ok: false, jobId: job.jobId, error: String(err?.message ?? err) });
  }
};
