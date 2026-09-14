// ─── Bidding helpers (pure) ─────────────────────────────────────────────────
// Bidding rule used by the app:
//   - Thinking phase is UNLIMITED until the first bid is declared.
//   - The first bid starts a 60s countdown; any strictly LOWER bid restarts
//     it to 60s. Equal bids keep the earlier declarer ahead.
//   - When the clock hits 0 (or everyone has bid/passed), the lowest bidder
//     attempts first; on failure the next-lowest gets the board, etc.

export const BID_SECONDS = 60;
export const ATTEMPT_SECONDS = 60;

/** Lowest-first, earliest-first ordering of bids. */
export function orderBids(bids) {
  return [...bids].sort((a, b) => a.moves - b.moves || a.at - b.at);
}
