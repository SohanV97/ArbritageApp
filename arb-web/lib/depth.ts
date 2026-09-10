// How many contracts of a hedged pair can actually be bought while it stays profitable.
//
// This used to be `kalshi.yesDepth` / `kalshi.noDepth`, which is the size resting at
// Kalshi's BEST ask and nothing else. That is wrong in both directions, and both were
// observed live:
//
//   Virginia Senate  reported 10,000 — Polymarket had 190 contracts at a price that kept
//                    the trade profitable. Sizing to the reported number would have filled
//                    the Kalshi leg and left most of the Polymarket leg unfilled: a naked
//                    position, which is the one outcome an arbitrage app must never cause.
//   Maine Senate     reported 10,961 — 26,709 were genuinely fillable, because Kalshi had
//                    more size one cent deeper and Polymarket had plenty. The UI warned
//                    "exceeds visible book depth" on an order that would have filled fine.
//
// Both venues publish the whole ladder, so walk them together: take contracts level by
// level, on both sides at once, for as long as the combined cost (including fees) is under
// the $1 payout. The answer is the largest size that is genuinely arbitrage, not a guess.

// Dollar → cent conversion for order-book prices.
//
// Both venues quote dollars as decimal strings, and the obvious arithmetic is off by a
// whole cent surprisingly often, because these values are not exactly representable in
// binary floating point:
//
//   Math.ceil((1 - 0.41) * 100)  ->  60   (should be 59)
//   Math.ceil(0.07 * 100)        ->   8   (should be 7)
//
// Measured across every cent price from 1c to 99c, the previous formulas were wrong for
// 22 of 99 NO prices and 5 of 99 YES prices. A cent is not a rounding detail here: the
// edges this app trades on are 1-2%, so a one-cent error either invents profit that does
// not exist or hides a real arbitrage. It always erred the same way — overstating cost —
// so the effect was silently suppressing genuine opportunities.
//
// Round deliberately, and always against ourselves: what we PAY rounds up, what we
// RECEIVE rounds down. The tolerance has to exceed the representation error (~1e-14 at
// these magnitudes) while staying well under half a cent, so it can never shift a price
// that is legitimately on a half-cent boundary.
const CENT_EPSILON = 1e-6;

/** Cents needed to BUY at this ask price, rounded up. */
export function askCents(price: number): number {
  return Math.ceil(price * 100 - CENT_EPSILON);
}

/** This bid in cents, rounded down. */
export function bidCents(price: number): number {
  return Math.floor(price * 100 + CENT_EPSILON);
}

/** Cents to buy the NO side, i.e. 1 − bid, with the cost rounded up. */
export function noAskCents(bid: number): number {
  return 100 - bidCents(bid);
}

/** Clamp to a quotable contract price. */
export function clampCents(cents: number): number {
  return Math.max(1, Math.min(99, cents));
}

export interface AskLevel {
  /** Price to BUY one contract at this level, in cents. */
  priceCents: number;
  /** Contracts available at this level. */
  size: number;
}

export interface FillResult {
  /** Contracts fillable while the pair remains profitable after fees. */
  contracts: number;
  /** Volume-weighted cost per contract across those fills, in cents (both legs). */
  avgCostCents: number;
  /** Edge at that average cost — lower than the top-of-book edge once you size up. */
  edgePercent: number;
  /** True when the ladder ran out rather than the trade becoming unprofitable, i.e. more
   *  size would be available if the venues had it. */
  limitedByBook: boolean;
}

const EMPTY: FillResult = { contracts: 0, avgCostCents: 0, edgePercent: 0, limitedByBook: true };

/**
 * Walk two ask ladders in lockstep. A hedged pair needs the SAME number of contracts on
 * each side, so each step is limited by whichever side has less size remaining.
 *
 * `feeCentsPerContract` is called with the price of each leg and must return the per
 * contract fee for that leg — fees are price-dependent on both venues, so they have to be
 * evaluated per level rather than once at the top of the book.
 */
export function fillableContracts(
  ladderA: AskLevel[],
  ladderB: AskLevel[],
  feeCentsPerContract: (aPriceCents: number, bPriceCents: number) => number,
  maxContracts = Number.POSITIVE_INFINITY,
): FillResult {
  if (!ladderA.length || !ladderB.length) return EMPTY;

  const a = [...ladderA].sort((x, y) => x.priceCents - y.priceCents);
  const b = [...ladderB].sort((x, y) => x.priceCents - y.priceCents);

  let i = 0, j = 0;
  let remA = a[0].size, remB = b[0].size;
  let contracts = 0, spendCents = 0;
  let limitedByBook = true;

  while (i < a.length && j < b.length && contracts < maxContracts) {
    const costPer = a[i].priceCents + b[j].priceCents + feeCentsPerContract(a[i].priceCents, b[j].priceCents);
    // Once a level pair costs a dollar or more, every deeper level costs at least as much
    // (both ladders ascend), so nothing further can be profitable.
    if (costPer >= 100) { limitedByBook = false; break; }

    const take = Math.min(remA, remB, maxContracts - contracts);
    if (take <= 0) break;

    contracts += take;
    spendCents += take * costPer;
    remA -= take;
    remB -= take;

    if (remA === 0) { i++; remA = i < a.length ? a[i].size : 0; }
    if (remB === 0) { j++; remB = j < b.length ? b[j].size : 0; }
  }

  if (contracts === 0) return EMPTY;
  const avgCostCents = spendCents / contracts;
  return {
    contracts,
    avgCostCents,
    edgePercent: 100 - avgCostCents,
    limitedByBook,
  };
}

/**
 * Kalshi publishes RESTING BIDS on each side, not asks. Buying YES means matching someone
 * who bid NO, at 1 − their price — so the YES ask ladder is the NO bid ladder mirrored,
 * and vice versa. Verified against the top-of-book fields: a NO bid of $0.46 for 998
 * contracts is exactly the reported `yes_ask` of $0.54, size 998.
 */
export function kalshiAskLadder(
  orderbook: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] } | null | undefined,
  side: 'yes' | 'no',
): AskLevel[] {
  const opposite = side === 'yes' ? orderbook?.no_dollars : orderbook?.yes_dollars;
  if (!Array.isArray(opposite)) return [];
  const out: AskLevel[] = [];
  for (const level of opposite) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const restingPrice = parseFloat(level[0]);
    const size = parseFloat(level[1]);
    if (!Number.isFinite(restingPrice) || !Number.isFinite(size)) continue;
    // Same conservative conversion as everywhere else: what we pay rounds up.
    const priceCents = 100 - bidCents(restingPrice);
    const contracts = Math.floor(size);
    if (priceCents < 1 || priceCents > 99 || contracts < 1) continue;
    out.push({ priceCents, size: contracts });
  }
  return out.sort((x, y) => x.priceCents - y.priceCents);
}

/**
 * Both sides of a Polymarket pair come from the YES token's book: its asks are the price to
 * buy YES, and its bids mirrored (1 − price) are the price to buy NO. Rounded the same way
 * the quote path rounds, so sizing never assumes a better price than the app quoted.
 */
export function polymarketAskLadder(
  book: { bids?: { price?: string; size?: string }[]; asks?: { price?: string; size?: string }[] } | null | undefined,
  side: 'yes' | 'no',
): AskLevel[] {
  const levels = side === 'yes' ? book?.asks : book?.bids;
  if (!Array.isArray(levels)) return [];
  const out: AskLevel[] = [];
  for (const level of levels) {
    const price = parseFloat(level?.price ?? '');
    const size = parseFloat(level?.size ?? '');
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    const priceCents = side === 'yes' ? askCents(price) : 100 - bidCents(price);
    const contracts = Math.floor(size);
    if (priceCents < 1 || priceCents > 99 || contracts < 1) continue;
    out.push({ priceCents, size: contracts });
  }
  return out.sort((x, y) => x.priceCents - y.priceCents);
}

/**
 * Is a quoted price backed by enough size to actually trade?
 *
 * Kalshi's top-of-book ask can be set by a resting order of 0.01 contracts, and its
 * `/markets` quote reports that dust price as the ask. Observed live on NYM/NYY: the YES
 * bid was $0.40 for 0.01 contracts, so NO was quoted at 60c, while the best bid carrying
 * real size was $0.32 — eight cents worse. Costing a trade off the dust price manufactures
 * an edge that vanishes the moment anyone tries to take it, which is exactly what produced
 * repeated "backed out — 0 contracts fillable" aborts on markets that looked profitable.
 *
 * Undefined depth means the venue did not report a size, which is not the same as reporting
 * a small one — treat it as usable rather than silently dropping every such market.
 */
export function quoteIsTradeable(depthContracts: number | undefined, minContracts: number): boolean {
  if (depthContracts === undefined || !Number.isFinite(depthContracts)) return true;
  return depthContracts >= minContracts;
}

/**
 * The limit price that fills `contracts` by walking a ladder — the price of the deepest
 * level the order reaches, so a marketable limit set here crosses every level it needs.
 *
 * Returns null when the ladder cannot supply that many contracts, which must abort the
 * trade rather than quietly send a smaller or unfillable order.
 */
export function priceForSize(ladder: AskLevel[], contracts: number): number | null {
  if (!Array.isArray(ladder) || ladder.length === 0) return null;
  if (!Number.isFinite(contracts) || contracts <= 0) return null;
  const sorted = [...ladder].sort((a, b) => a.priceCents - b.priceCents);
  let remaining = contracts;
  for (const level of sorted) {
    remaining -= level.size;
    if (remaining <= 0) return level.priceCents;
  }
  return null;
}
