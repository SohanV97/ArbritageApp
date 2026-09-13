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
export function pairLimits(args: PairLimitArgs): PairLimits | null {
  const { kalAtBook, pmAtBook, kalBuffer, pmBuffer, feePerContract } = args;
  if (![kalAtBook, pmAtBook, kalBuffer, pmBuffer].every(n => Number.isFinite(n))) return null;

  let kalLimit = Math.min(99, kalAtBook + Math.max(0, kalBuffer));
  let pmLimit = Math.min(99, pmAtBook + Math.max(0, pmBuffer));

  // Fees depend on the prices, so they are estimated at the most expensive prices under
  // consideration. Trimming below that only makes the real fee smaller, never larger.
  const maxTotal = 100 - feePerContract(pmLimit, kalLimit);

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
