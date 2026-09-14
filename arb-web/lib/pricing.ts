/**
 * The limit price for each leg of a pair.
 *
 * Kept here, with no path-alias imports, so it can be tested under bare Node: this decides
 * what is actually paid, and it is the calculation that turned a real hedge into a
 * guaranteed loss. A 1.05c edge took a 1c Kalshi buffer and a 3c Polymarket buffer and
 * filled at 9c + 91c against a 100c payout. Both legs filled and the hedge was perfect; it
 * simply could not make money, and every status in the app said success.
 */

export interface PairLimitArgs {
  /** Cost per contract at the size being traded, not the top of book. */
  kalAtBook: number;
  pmAtBook: number;
  /** Cents each leg may pay through its book to secure the fill. */
  kalBuffer: number;
  pmBuffer: number;
  /** Fees in cents for one contract of each leg at the given prices. */
  feePerContract: (pmPrice: number, kalPrice: number) => number;
}

export interface PairLimits {
  kalLimit: number;
  pmLimit: number;
  /** What is left over per contract after both legs and fees. Always > 0. */
  netEdgeCents: number;
}

/**
 * Returns the two limits, or null when no pair of prices both fills and profits.
 *
 * The invariant is the whole point: kalLimit + pmLimit + fees < 100, because 100c is what
 * the winning side pays. A buffer may never push the pair past what it is worth.
 */
/**
 * Most of an edge may not be spent on certainty.
 *
 * The buffers grow with the edge, so a bigger edge authorised a bigger giveaway, and the
 * cap only stopped the pair costing more than it paid. The result was that every edge came
 * out worth about the same: priced through the book, a 6c edge and a 0.5c edge both landed
 * near 1c of guaranteed profit. Capturing a sixth of a good edge is not a safety property,
 * it is the good edges paying for the marginal ones.
 *
 * At least half of the gross edge is now kept, whatever the buffers ask for — so a thin
 * edge still trades on a thin buffer, and a fat one is actually worth finding.
 */
const MAX_GIVEAWAY_FRACTION = 0.5;
/** Below this there is nothing to divide; the pair simply has to clear costs. */
const MIN_RETAINED_CENTS = 0.5;

export function pairLimits(args: PairLimitArgs): PairLimits | null {
  const { kalAtBook, pmAtBook, kalBuffer, pmBuffer, feePerContract } = args;
  if (![kalAtBook, pmAtBook, kalBuffer, pmBuffer].every(n => Number.isFinite(n))) return null;

  let kalLimit = Math.min(99, kalAtBook + Math.max(0, kalBuffer));
  let pmLimit = Math.min(99, pmAtBook + Math.max(0, pmBuffer));

  // Fees depend on the prices, so they are estimated at the most expensive prices under
  // consideration. Trimming below that only makes the real fee smaller, never larger.
  const feeAtLimits = feePerContract(pmLimit, kalLimit);

  // What the pair is worth before any buffer is spent.
  const grossEdge = 100 - kalAtBook - pmAtBook - feePerContract(pmAtBook, kalAtBook);
  if (grossEdge <= 0) return null;   // nothing to trade at any price

  // Keep at least half of it. This is the whole difference between a buffer that protects
  // a fill and one that quietly consumes the reason for the trade.
  const retained = Math.max(MIN_RETAINED_CENTS, grossEdge * MAX_GIVEAWAY_FRACTION);
  const maxTotal = 100 - feeAtLimits - retained;

  if (kalLimit + pmLimit > maxTotal) {
    // Trim Polymarket first. It is the leg that goes out FIRST, so missing it costs nothing:
    // no Kalshi order follows and there is no position to unwind. Kalshi's buffer is the one
    // buying certainty on a leg that would otherwise leave a naked Polymarket position, so it
    // is given up last. Neither may be trimmed below its own book price — that would be a
    // limit that cannot fill.
    pmLimit = Math.floor(maxTotal - kalLimit);
    if (pmLimit < pmAtBook) {
      pmLimit = pmAtBook;
      kalLimit = Math.floor(maxTotal - pmLimit);
    }
  }

  if (kalLimit < kalAtBook || pmLimit < pmAtBook) return null;

  const netEdgeCents = 100 - kalLimit - pmLimit - feePerContract(pmLimit, kalLimit);
  // A pair that exactly breaks even is not worth the execution risk of two legs.
  if (netEdgeCents <= 0) return null;

  return { kalLimit, pmLimit, netEdgeCents };
}
