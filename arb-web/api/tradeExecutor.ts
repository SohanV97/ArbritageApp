/**
 * The order path, callable without an HTTP request.
 *
 * This lived inside the /api/execute POST handler, so the only way to place a trade was to
 * poll for an opportunity, send it back to the server, and have the server re-read books it
 * had just read. Measured end to end, an order landed 450-600ms after the prices that
 * justified it, and most of that was the round trip rather than the venues.
 *
 * Extracting it changes nothing about what runs: the route still calls this, and the same
 * checks happen in the same order against the same live books. It just also lets the refresh
 * loop act the moment it finds an edge, instead of waiting to be told about its own data.
 */
import type { ArbitrageOpportunity } from '@/lib/market-types';
import { MIN_ORDER_CONTRACTS } from '@/lib/market-types';
import { placeKalshiOrder, testKalshiAuth, transferBetweenKalshiShards } from '@/api/kalshi-trading';
import { placePolymarketOrder, polymarketFundingDollars, invalidatePolymarketFunding } from '@/api/polymarket-trading';
import { getKalshiOrderbook } from '@/api/kalshi';
import { getPolymarketBooks } from '@/api/polymarket';
import { fillableContracts, kalshiAskLadder, polymarketAskLadder, priceForSize } from '@/lib/depth';
import { getLiveKalshiBook, getLivePolymarketBook } from '@/lib/liveBooks';
import { estimatePolymarketFeeCents, estimateKalshiFeeCents } from '@/lib/fees';

export interface LegResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  filledCount?: number;
  avgPriceCents?: number;
  error?: string;
}

export interface ExecuteResponse {
  kalshi: LegResult;
  polymarket: LegResult;
  executedAt: string;
  bothOk: boolean;      // both legs accepted by their venue (no API error)
  hedged: boolean;      // both legs actually FILLED with matching size — position is safe
  hedgeNote?: string;   // explanation whenever the position is not a clean hedge (naked-leg warning)
  /** true when the pre-order price re-check refused to trade (nothing was sent). */
  abortedOnPriceMove?: boolean;
  /**
   * true when the request was refused before either order was sent, for any reason.
   * The client uses this to re-arm the pair: nothing is at risk, so blocking it would
   * discard edges that are still there — an underfunded venue, for instance, becomes
   * tradeable the moment it is topped up.
   */
  noOrdersSent?: boolean;
  /** ms spent re-quoting both venues immediately before ordering. */
  revalidateMs?: number;
  /** edge the client was showing vs. the edge at the moment of execution. */
  quotedEdgePercent?: number;
  freshEdgePercent?: number;
}

export interface ExecuteRequest {
  opportunity: ArbitrageOpportunity;
  amount: number; // payout = number of contracts on each leg
  /** Run every pre-order check against live books, report the result, send nothing. */
  dryRun?: boolean;
}

// Polymarket markets at runtime carry yesTokenId/noTokenId even though
// the base UnifiedMarket type doesn't declare them.
interface PmRich {
  yesTokenId?: string;
  noTokenId?: string;
  [key: string]: unknown;
}

/** What the route turns into a Response, and what the refresh loop reads directly. */
export interface ExecuteOutcome { body: ExecuteResponse; status: number }

// Redact anything that looks like a wallet key or PEM before it can reach the client
// or logs — defense in depth against an underlying library echoing key material.
function scrubSecrets(s: string | undefined): string | undefined {
  if (!s) return s;
  return s
    .replace(/0x[a-fA-F0-9]{64}/g, '0x<redacted-key>')
    .replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, '<redacted-pem>');
}

// Every exit path carries the full ExecuteResponse shape, so a validation failure renders
// exactly like a completed trade.
//
// noOrdersSent is set because a validation failure sends nothing by definition. Without it
// the caller reads "not hedged, orders may have gone out" and treats the pair as holding an
// open position — which, for the auto-executor, means never trading it again. A rejected
// payload or a flipped kill switch would have silently blacklisted the pair for the life of
// the process.
function err(message: string, status = 400): ExecuteOutcome {
  return {
    body: {
      kalshi: { ok: false, error: message },
      polymarket: { ok: false, error: message },
      executedAt: new Date().toISOString(),
      bothOk: false,
      hedged: false,
      noOrdersSent: true,
      hedgeNote: message,
    },
    status,
  };
}

// Hard server-side ceiling on order size — a crafted or fat-finger request can't
// exceed this regardless of what the client sends. Override via env.
const MAX_ORDER_CONTRACTS = Number(process.env.ARB_MAX_ORDER_CONTRACTS ?? 500);

// Assess whether the two filled legs form a safe hedge, or flag a naked/partial position.
function assessHedge(kalshi: LegResult, polymarket: LegResult): { hedged: boolean; note?: string } {
  const kOk = kalshi.ok, pOk = polymarket.ok;
  const kF = kalshi.filledCount, pF = polymarket.filledCount;
  if (!kOk || !pOk) {
    if (kOk && (kF ?? 0) > 0) return { hedged: false, note: `⚠ NAKED: Kalshi filled ${kF} but Polymarket was rejected (${polymarket.error ?? 'error'}). Manually close the Kalshi position.` };
    if (pOk && (pF ?? 0) > 0) return { hedged: false, note: `⚠ NAKED: Polymarket filled ${pF} but Kalshi was rejected (${kalshi.error ?? 'error'}). Manually close the Polymarket position.` };
    return { hedged: false, note: 'Neither leg took a position (one or both rejected).' };
  }
  if (kF == null || pF == null) return { hedged: false, note: 'Both orders accepted but fill sizes could not be confirmed — verify positions on both venues.' };
  if (kF === 0 && pF === 0) return { hedged: false, note: 'Both accepted but neither filled (no liquidity at the limit price) — no position taken.' };
  if (kF === 0 || pF === 0) {
    const leg = kF > 0 ? `Kalshi (${kF})` : `Polymarket (${pF})`;
    return { hedged: false, note: `⚠ NAKED: only ${leg} filled; the other leg filled 0. Manually close the filled leg.` };
  }
  const diff = Math.abs(kF - pF);
  const tol = Math.max(1, Math.ceil(0.05 * Math.max(kF, pF)));
  if (diff <= tol) return { hedged: true };
  return { hedged: false, note: `⚠ PARTIAL HEDGE: fills differ (Kalshi ${kF} vs Polymarket ${pF}); net exposure ${diff} contracts — trim the larger leg.` };
}

export async function executeArb(req: ExecuteRequest): Promise<ExecuteOutcome> {
  const { opportunity, amount } = req;
  if (!opportunity?.pair?.polymarket || !opportunity?.pair?.kalshi || !opportunity.legA || !opportunity.legB) {
    return err('Malformed opportunity payload');
  }
  if (!Number.isFinite(amount) || amount < 1) {
    return err('Amount must be a number ≥ 1');
  }
  const { pair, legA, legB } = opportunity;
  if (legA.venue === legB.venue) {
    return err('Opportunity legs must be on different venues');
  }

  // Kill switch — set ARB_TRADING_ENABLED=false to hard-disable all order placement.
  if (process.env.ARB_TRADING_ENABLED === 'false') {
    return err('Trading is disabled (ARB_TRADING_ENABLED=false).', 403);
  }

  // Determine which leg is PM and which is Kalshi
  const pmLeg  = legA.venue === 'polymarket' ? legA : legB;
  const kalLeg = legA.venue === 'kalshi'     ? legA : legB;

  // Validate both limit prices are integer cents in range — never forward a garbage
  // or attacker-chosen price to a venue.
  for (const [name, leg] of [['Polymarket', pmLeg], ['Kalshi', kalLeg]] as const) {
    if (!Number.isInteger(leg.priceCents) || leg.priceCents < 1 || leg.priceCents > 99) {
      return err(`${name} price ${leg.priceCents}¢ is outside the valid 1–99¢ range`);
    }
  }

  // Kalshi ticker lives on .symbol (set by normalizeKalshiMarkets)
  const kalshiTicker = (pair.kalshi as { symbol?: string }).symbol ?? '';
  if (!kalshiTicker) {
    return err('Missing Kalshi ticker');
  }

  // When [FLIPPED] was applied, the displayed YES/NO was inverted for alignment.
  // The actual Kalshi side to buy is the opposite of legSide.
  const kalshiFlipped = pair.kalshi.question.includes('[FLIPPED]');
  const actualKalshiSide = kalshiFlipped
    ? (kalLeg.side === 'yes' ? 'no' : 'yes')
    : kalLeg.side;

  // Polymarket token IDs: yesTokenId is token[0], noTokenId is token[1]
  const pmRich = pair.polymarket as unknown as PmRich;
  const pmTokenId = pmLeg.side === 'yes' ? pmRich.yesTokenId : pmRich.noTokenId;
  if (!pmTokenId) {
    return err('Missing Polymarket token ID for this side');
  }

  const contracts = Math.max(1, Math.round(amount));
  if (contracts > MAX_ORDER_CONTRACTS) {
    return err(`Order size ${contracts} exceeds the server cap (${MAX_ORDER_CONTRACTS}). Set ARB_MAX_ORDER_CONTRACTS to raise it.`);
  }
  // Reject BEFORE placing either leg: Polymarket rejects under 5 shares while Kalshi
  // accepts 1, so a smaller order fills only the Kalshi side and leaves it unhedged.
  if (contracts < MIN_ORDER_CONTRACTS) {
    return err(`Order size ${contracts} is below Polymarket's ${MIN_ORDER_CONTRACTS}-share minimum. A smaller order would fill only the Kalshi leg and leave it unhedged.`);
  }

  // ── pre-order re-check, priced off the books ───────────────────────────────
  // The card the user clicked was priced up to a second ago; an edge can be gone by then.
  // Re-read BOTH books in parallel and refuse to trade if the edge no longer exists.
  // Nothing has been sent at this point, so backing out here costs nothing.
  //
  // Price and depth both come from the ORDER BOOKS, not from the venues' quote endpoints.
  // Kalshi's `/markets` quote is set by whatever rests at the top, including orders of 0.01
  // contracts, while the ladder walk ignores anything under a whole contract. The two
  // therefore disagreed on 13 of 24 live MLB markets by up to 8c, which produced exactly
  // this failure: the quote-based price check passed, then the ladder found zero contracts
  // fillable at a profit and backed out. Worse, the order limit was taken from the quote,
  // so a Kalshi leg priced 8c through the real ask would have rested unfilled beside a
  // filled Polymarket leg — a naked position. One source of truth removes both.
  const quotedEdgePercent = Number.isFinite(opportunity.edgePercent) ? opportunity.edgePercent : undefined;
  const revalStart = Date.now();
  // Both ladders derive from the YES token's book, whichever side is being bought.
  const pmYesToken = pmRich.yesTokenId ?? '';

  // Both books are fetched fresh, deliberately, even though the refresh loop holds recent
  // copies. Serving the Polymarket book from that cache would save its ~162ms round trip,
  // but the limit prices are derived from this ladder: a stale Polymarket ladder prices that
  // leg too low while the Kalshi leg is priced off a fresh book, so Kalshi fills and
  // Polymarket does not. That is a naked position — the exact failure this route exists to
  // prevent — traded for latency. A stale-price abort costs nothing; a naked leg costs money.
  // Prefer the websocket books. Serving a POLLED cache here would be unsafe — it is stale by
  // construction, and pricing one leg off a stale ladder while the other is fresh is how a
  // leg fills alone. A pushed book is different in kind: the venue sends every change as it
  // happens, so this is the live book, and using it removes the ~160ms re-read that was
  // costing more than the edges were lasting. If either feed is down or quiet, that side
  // falls back to a fetch and nothing changes but the latency.
  const liveKal = getLiveKalshiBook(kalshiTicker);
  const livePm = getLivePolymarketBook(pmYesToken);
  const [kOrderbook, fetchedPmBooks] = await Promise.all([
    liveKal ? Promise.resolve(liveKal) : getKalshiOrderbook(kalshiTicker),
    livePm ? Promise.resolve(null) : getPolymarketBooks([pmYesToken]),
  ]);
  const revalidateMs = Date.now() - revalStart;
  const bookSource = `${liveKal ? 'live' : 'fetch'}/${livePm ? 'live' : 'fetch'}`;

  // Derive the fee model server-side rather than trusting the posted market.
  const feeKind = pair.polymarket.category === 'politics' ? 'fee_free' : 'sports';
  const kalLadder = kalshiAskLadder(kOrderbook, actualKalshiSide);
  const pmBook = livePm ?? fetchedPmBooks?.get(pmYesToken);
  const pmLadder = polymarketAskLadder(pmBook, pmLeg.side);

  // An unreadable book is not an empty one. Both produce a zero-length ladder, and
  // reporting a failed request as "not enough depth" sent users hunting for liquidity that
  // was actually there. Say which venue could not be read.
  if (!kalLadder.length || !pmLadder.length) {
    const which = !kalLadder.length && !pmLadder.length ? 'neither venue'
      : !kalLadder.length ? 'Kalshi' : 'Polymarket';
    return err(
      `Could not read the order book from ${which} before ordering (${revalidateMs}ms) — ` +
      `refusing to trade on unverified depth. Nothing was sent; try again.`,
      409);
  }

  const feePerContract = (pmPrice: number, kalPrice: number) =>
    estimatePolymarketFeeCents(feeKind, pmPrice, 1) + estimateKalshiFeeCents(kalPrice, 1);

  // Best case available anywhere in either book: the top of both ladders. This separates
  // "the edge is gone" from "the edge exists but is shallow" — without it, a vanished edge
  // reported as zero fillable contracts, which reads as a liquidity problem and is not.
  const topCost = pmLadder[0].priceCents + kalLadder[0].priceCents
                + feePerContract(pmLadder[0].priceCents, kalLadder[0].priceCents);
  const freshEdgePercent = 100 - topCost;

  if (freshEdgePercent <= 0) {
    const body: ExecuteResponse = {
      kalshi: { ok: false, error: 'Not placed — price moved' },
      polymarket: { ok: false, error: 'Not placed — price moved' },
      executedAt: new Date().toISOString(),
      bothOk: false,
      hedged: false,
      abortedOnPriceMove: true,
      noOrdersSent: true,
      revalidateMs,
      quotedEdgePercent,
      freshEdgePercent,
      hedgeNote: `Backed out in ${revalidateMs}ms: the edge is now ${freshEdgePercent.toFixed(2)}%` +
        (quotedEdgePercent !== undefined ? ` (was ${quotedEdgePercent.toFixed(2)}%)` : '') +
        `. No orders were sent.`,
    };
    console.log('[execute] aborted on price move', JSON.stringify({ ticker: kalshiTicker, revalidateMs, quotedEdgePercent, freshEdgePercent }));
    return { body, status: 409 };
  }

  // ── pre-order depth re-check ───────────────────────────────────────────────
  // A price that still looks good can have almost nothing behind it. Both venues publish
  // the whole ladder, so confirm the requested size can actually be bought on BOTH sides
  // while the pair stays profitable. Without this the Kalshi leg fills and the Polymarket
  // leg does not, which is the naked position this app exists to avoid — one live pair
  // advertised 10,000 contracts of depth when Polymarket had 190.
  const fill = fillableContracts(pmLadder, kalLadder, feePerContract, contracts);

  if (fill.contracts < MIN_ORDER_CONTRACTS) {
    const body: ExecuteResponse = {
      kalshi: { ok: false, error: 'Not placed — not enough depth' },
      polymarket: { ok: false, error: 'Not placed — not enough depth' },
      executedAt: new Date().toISOString(),
      bothOk: false,
      hedged: false,
      abortedOnPriceMove: true,
      noOrdersSent: true,
      revalidateMs,
      quotedEdgePercent,
      freshEdgePercent,
      hedgeNote: `Backed out in ${revalidateMs}ms: the edge is ${freshEdgePercent.toFixed(2)}% at the ` +
        `top of both books, but only ${fill.contracts} contract(s) can be bought there before it ` +
        `disappears — below the ${MIN_ORDER_CONTRACTS}-share minimum. No orders were sent.`,
    };
    console.log('[execute] aborted on depth', JSON.stringify({ ticker: kalshiTicker, requested: contracts, fillable: fill.contracts, freshEdgePercent }));
    return { body, status: 409 };
  }

  // Never buy more than both books can absorb. Trimming keeps the two legs equal, which
  // is what makes the position hedged; sending the full size would fill them unevenly.
  const plannedContracts = Math.min(contracts, fill.contracts);

  // Limit prices come from the ladders, set at the deepest level this size reaches, so a
  // marketable order crosses everything it needs and fills in full. Taking them from a
  // quote endpoint instead priced the Kalshi leg through its real ask on 13 of 24 live
  // markets, which rests unfilled — and an unfilled Kalshi leg beside a filled Polymarket
  // leg is precisely the naked position the rest of this route exists to prevent.
  const freshPmPrice = priceForSize(pmLadder, plannedContracts);
  const freshKalPrice = priceForSize(kalLadder, plannedContracts);
  if (freshPmPrice === null || freshKalPrice === null) {
    return err(
      `Book thinned out between measuring depth and pricing the order (${revalidateMs}ms). Nothing was sent; try again.`,
      409);
  }

  // Both legs must be affordable BEFORE either is sent. The legs fire in parallel, so an
  // underfunded venue does not fail cleanly: its leg is rejected while the other one fills,
  // leaving exactly the naked, unhedged position this app exists to avoid. Checking after
  // the fact is too late — the money is already committed.
  const kalCostCents = freshKalPrice * plannedContracts;
  const pmCostCents = freshPmPrice * plannedContracts;
  // Kalshi's check is free (measured 0ms, it is already cached). Polymarket's full auth test
  // is not: 309ms median, 2.7s worst, because it also reads wallet ownership and trading
  // approvals from the chain. Neither is needed to decide whether a leg is affordable, and
  // both sat on the critical path ahead of every order.
  const [kalAuth, pmDollars] = await Promise.all([testKalshiAuth(), polymarketFundingDollars()]);

  // Check the SHARD this market trades on, not the account total.
  //
  // Kalshi funds an order only from the shard its market belongs to. A live account holding
  // $102.90 entirely on shard 0 was approved for an MLB order — MLB trades on shard 3, which
  // held nothing — so Kalshi answered "insufficient shard balance" while the Polymarket leg
  // had already filled. That is the naked position this guard exists to prevent, and the
  // total balance simply does not answer the question being asked.
  const shard = (pair.kalshi as { exchangeIndex?: number }).exchangeIndex;
  let shards = kalAuth.balanceByShard;

  // Move collateral onto the shard this market trades on, if that is all that is missing.
  //
  // Kalshi's website does this silently — you deposit once and can bet on anything — but the
  // API requires collateral to be preallocated per shard, so a deposit sitting on shard 0
  // cannot pay for an MLB order on shard 3. Measured as instant, and it is a transfer inside
  // one account rather than a trade, so doing it here costs a few hundred milliseconds only
  // on the first trade against a shard and removes a whole class of half-filled position.
  if (shard !== undefined && shards) {
    const onShard = (shards[shard] ?? 0) * 100;
    if (onShard < kalCostCents) {
      const needDollars = (kalCostCents - onShard) / 100;
      const [richestShard, richestDollars] = Object.entries(shards)
        .map(([i, d]) => [Number(i), Number(d)] as [number, number])
        .filter(([i]) => i !== shard)
        .sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
      // A 25% buffer so the next trade on this shard does not pay the same round trip, but
      // never more than the source actually holds.
      const moveDollars = Math.min(needDollars * 1.25, richestDollars);
      if (richestShard !== undefined && moveDollars >= needDollars) {
        const moved = await transferBetweenKalshiShards(richestShard, shard, moveDollars);
        console.log('[execute] shard top-up', JSON.stringify({
          from: richestShard, to: shard, dollars: Number(moveDollars.toFixed(2)), ok: moved.ok, error: moved.error,
        }));
        // Re-read rather than assume, and give the transfer a moment to settle. Reading
        // immediately showed the money gone from the source and not yet on the destination,
        // so the guard refused a trade whose collateral was already on its way. Polling to a
        // short ceiling costs nothing when the balance is already right, which is every
        // trade after the first on a given shard.
        if (moved.ok) {
          const needOnShard = kalCostCents / 100;
          for (let attempt = 0; attempt < 6; attempt++) {
            await new Promise(res => setTimeout(res, 250));
            const fresh = (await testKalshiAuth()).balanceByShard;
            if (fresh) shards = fresh;
            if ((shards?.[shard] ?? 0) >= needOnShard) break;
          }
        }
      }
    }
  }

  // When the shard is unknown, assume the WORST shard rather than the total.
  //
  // Falling back to the account total is precisely the assumption that produced the naked
  // leg, and a market whose shard has not been recorded yet — a discovery cache written
  // before shards were tracked, say — must not quietly inherit it. Taking the smallest shard
  // balance can only refuse a trade that would have been fine; the opposite error sends one
  // leg to a venue that cannot pay for it.
  const worstShardDollars = shards ? Math.min(...Object.values(shards)) : undefined;
  const shardFundsDollars = shard !== undefined ? shards?.[shard] : worstShardDollars;
  const kalFunds = (shardFundsDollars ?? kalAuth.balanceDollars ?? 0) * 100;
  const pmFunds = (pmDollars ?? 0) * 100;
  const shortfalls: string[] = [];
  if (kalFunds < kalCostCents) {
    shortfalls.push(
      shardFundsDollars !== undefined
        ? `Kalshi has $${(kalFunds / 100).toFixed(2)} on exchange shard ${shard ?? '(unknown — using the lowest)'} (where this market trades) ` +
          `but this leg costs $${(kalCostCents / 100).toFixed(2)} — the account total is ` +
          `$${(kalAuth.balanceDollars ?? 0).toFixed(2)}, held on other shards`
        : `Kalshi has $${(kalFunds / 100).toFixed(2)} but this leg costs $${(kalCostCents / 100).toFixed(2)}`,
    );
  }
  if (pmFunds < pmCostCents) {
    shortfalls.push(`Polymarket has $${(pmFunds / 100).toFixed(2)} but this leg costs $${(pmCostCents / 100).toFixed(2)}`);
  }
  if (shortfalls.length > 0) {
    const body: ExecuteResponse = {
      kalshi: { ok: false, error: 'Not placed — insufficient funds' },
      polymarket: { ok: false, error: 'Not placed — insufficient funds' },
      executedAt: new Date().toISOString(),
      bothOk: false,
      hedged: false,
      noOrdersSent: true,
      revalidateMs,
      quotedEdgePercent,
      freshEdgePercent,
      hedgeNote: `No orders were sent. ${shortfalls.join('; ')}. Both venues must cover their own ` +
        `leg — funding only one would fill that side alone and leave it unhedged.`,
    };
    console.log('[execute] aborted on funding', JSON.stringify({ ticker: kalshiTicker, shortfalls }));
    return { body, status: 409 };
  }

  // dryRun stops here: every check above has run against live books, so this reports what
  // WOULD be sent, and how long confirming it took, without sending it. That makes the
  // pre-order path measurable and testable at any time — otherwise the only way to time it
  // is to spend money, and the only way to prove it works is to place a real trade.
  if (req.dryRun === true) {
    const dry: ExecuteResponse = {
      kalshi: { ok: false, error: `Dry run — would buy ${plannedContracts} @ ${freshKalPrice}¢` },
      polymarket: { ok: false, error: `Dry run — would buy ${plannedContracts} @ ${freshPmPrice}¢` },
      executedAt: new Date().toISOString(),
      bothOk: false,
      hedged: false,
      noOrdersSent: true,
      revalidateMs,
      quotedEdgePercent,
      freshEdgePercent,
      hedgeNote: `Dry run: ${plannedContracts} contracts at ${freshKalPrice}¢ (Kalshi) + ` +
        `${freshPmPrice}¢ (Polymarket), edge ${freshEdgePercent.toFixed(2)}%, confirmed in ` +
        `${revalidateMs}ms via ${bookSource}. No orders were sent.`,
    };
    return { body: dry, status: 200 };
  }

  // Place both legs simultaneously — this minimizes price-movement risk between legs.
  // Limits are the FRESH prices, so a market that moved is quoted at what it is now
  // rather than at a stale price that would simply fail to fill.
  const [kalshiRaw, pmRaw] = await Promise.all([
    placeKalshiOrder({
      ticker: kalshiTicker,
      side: actualKalshiSide,
      count: plannedContracts,
      priceCents: freshKalPrice,
    }),
    placePolymarketOrder({
      tokenId: pmTokenId,
      count: plannedContracts,
      priceCents: freshPmPrice,
    }),
  ]);

  // A fill changes the balance, so drop the cached reading rather than let the next order
  // size itself against money that has already been spent.
  invalidatePolymarketFunding();

  // Scrub any secret material from error strings before they reach the client/logs.
  const kalshiResult: LegResult = { ...kalshiRaw, error: scrubSecrets(kalshiRaw.error) };
  const pmResult: LegResult = { ...pmRaw, error: scrubSecrets(pmRaw.error) };

  const bothOk = kalshiResult.ok && pmResult.ok;
  const { hedged, note } = assessHedge(kalshiResult, pmResult);

  const response: ExecuteResponse = {
    kalshi: kalshiResult,
    polymarket: pmResult,
    executedAt: new Date().toISOString(),
    bothOk,
    hedged,
    hedgeNote: note,
    abortedOnPriceMove: false,
    revalidateMs,
    quotedEdgePercent,
    freshEdgePercent,
  };

  // Audit log (server-side only). Order IDs + fill counts, no error bodies with secrets.
  console.log('[execute]', JSON.stringify({
    ticker: kalshiTicker, contracts, bothOk, hedged, hedgeNote: note,
    revalidateMs, bookSource, quotedEdgePercent, freshEdgePercent,
    kalshi: { ok: kalshiResult.ok, filled: kalshiResult.filledCount, orderId: kalshiResult.orderId },
    polymarket: { ok: pmResult.ok, filled: pmResult.filledCount, orderId: pmResult.orderId },
  }));
  return { body: response, status: 200 };
}
