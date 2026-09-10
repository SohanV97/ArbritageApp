import { NextResponse } from 'next/server';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import { MIN_ORDER_CONTRACTS } from '@/lib/market-types';
import { placeKalshiOrder, testKalshiAuth } from '@/api/kalshi-trading';
import { placePolymarketOrder, testPolymarketAuth } from '@/api/polymarket-trading';
import type { KalshiAuthTest } from '@/api/kalshi-trading';
import type { PolymarketAuthTest } from '@/api/polymarket-trading';
import { getKalshiQuote, getKalshiOrderbook } from '@/api/kalshi';
import { getPolymarketQuote, getPolymarketBooks } from '@/api/polymarket';
import { fillableContracts, kalshiAskLadder, polymarketAskLadder } from '@/lib/depth';
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
  /** ms spent re-quoting both venues immediately before ordering. */
  revalidateMs?: number;
  /** edge the client was showing vs. the edge at the moment of execution. */
  quotedEdgePercent?: number;
  freshEdgePercent?: number;
}

interface ExecuteRequest {
  opportunity: ArbitrageOpportunity;
  amount: number; // payout = number of contracts on each leg
}

// Polymarket markets at runtime carry yesTokenId/noTokenId even though
// the base UnifiedMarket type doesn't declare them.
interface PmRich {
  yesTokenId?: string;
  noTokenId?: string;
  [key: string]: unknown;
}

export interface ConnectionTestResponse {
  kalshi: KalshiAuthTest;
  polymarket: PolymarketAuthTest;
  testedAt: string;
}

// GET = connection test. Verifies both venues' full auth path (key, signing, L2
// credential derivation, balance/allowance read) without placing any order.
export async function GET(): Promise<Response> {
  const [kalshi, polymarket] = await Promise.all([testKalshiAuth(), testPolymarketAuth()]);
  const body: ConnectionTestResponse = { kalshi, polymarket, testedAt: new Date().toISOString() };
  return NextResponse.json(body);
}

// Redact anything that looks like a wallet key or PEM before it can reach the client
// or logs — defense in depth against an underlying library echoing key material.
function scrubSecrets(s: string | undefined): string | undefined {
  if (!s) return s;
  return s
    .replace(/0x[a-fA-F0-9]{64}/g, '0x<redacted-key>')
    .replace(/-----BEGIN[\s\S]*?END[^-]*-----/g, '<redacted-pem>');
}

// The client renders whatever this route returns as an ExecuteResponse, so every
// exit path — including validation failures — must carry that exact shape.
function executeError(message: string, status = 400): Response {
  const body: ExecuteResponse = {
    kalshi: { ok: false, error: message },
    polymarket: { ok: false, error: message },
    executedAt: new Date().toISOString(),
    bothOk: false,
    hedged: false,
    hedgeNote: message,
  };
  return NextResponse.json(body, { status });
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

export async function POST(request: Request): Promise<Response> {
  let body: ExecuteRequest;
  try {
    body = await request.json() as ExecuteRequest;
  } catch {
    return executeError('Invalid JSON body');
  }
  // `JSON.parse` accepts "null", "[]" and bare scalars — destructuring those threw a
  // TypeError that escaped as an unshaped 500 the client could not render.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return executeError('Request body must be a JSON object');
  }

  const { opportunity, amount } = body;
  if (!opportunity?.pair?.polymarket || !opportunity?.pair?.kalshi || !opportunity.legA || !opportunity.legB) {
    return executeError('Malformed opportunity payload');
  }
  if (!Number.isFinite(amount) || amount < 1) {
    return executeError('Amount must be a number ≥ 1');
  }
  const { pair, legA, legB } = opportunity;
  if (legA.venue === legB.venue) {
    return executeError('Opportunity legs must be on different venues');
  }

  // Kill switch — set ARB_TRADING_ENABLED=false to hard-disable all order placement.
  if (process.env.ARB_TRADING_ENABLED === 'false') {
    return executeError('Trading is disabled (ARB_TRADING_ENABLED=false).', 403);
  }

  // Determine which leg is PM and which is Kalshi
  const pmLeg  = legA.venue === 'polymarket' ? legA : legB;
  const kalLeg = legA.venue === 'kalshi'     ? legA : legB;

  // Validate both limit prices are integer cents in range — never forward a garbage
  // or attacker-chosen price to a venue.
  for (const [name, leg] of [['Polymarket', pmLeg], ['Kalshi', kalLeg]] as const) {
    if (!Number.isInteger(leg.priceCents) || leg.priceCents < 1 || leg.priceCents > 99) {
      return executeError(`${name} price ${leg.priceCents}¢ is outside the valid 1–99¢ range`);
    }
  }

  // Kalshi ticker lives on .symbol (set by normalizeKalshiMarkets)
  const kalshiTicker = (pair.kalshi as { symbol?: string }).symbol ?? '';
  if (!kalshiTicker) {
    return executeError('Missing Kalshi ticker');
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
    return executeError('Missing Polymarket token ID for this side');
  }

  const contracts = Math.max(1, Math.round(amount));
  if (contracts > MAX_ORDER_CONTRACTS) {
    return executeError(`Order size ${contracts} exceeds the server cap (${MAX_ORDER_CONTRACTS}). Set ARB_MAX_ORDER_CONTRACTS to raise it.`);
  }
  // Reject BEFORE placing either leg: Polymarket rejects under 5 shares while Kalshi
  // accepts 1, so a smaller order fills only the Kalshi side and leaves it unhedged.
  if (contracts < MIN_ORDER_CONTRACTS) {
    return executeError(`Order size ${contracts} is below Polymarket's ${MIN_ORDER_CONTRACTS}-share minimum. A smaller order would fill only the Kalshi leg and leave it unhedged.`);
  }

  // ── pre-order price re-check ────────────────────────────────────────────────
  // The card the user clicked was priced up to a second ago; an edge can be gone by
  // then. Re-quote BOTH venues in parallel (two targeted requests, ~100 ms total) and
  // refuse to trade if the edge no longer exists. Nothing has been sent at this point,
  // so backing out here costs nothing.
  const quotedEdgePercent = Number.isFinite(opportunity.edgePercent) ? opportunity.edgePercent : undefined;
  const revalStart = Date.now();
  const [kQuote, pmQuote, kOrderbook, pmBooks] = await Promise.all([
    getKalshiQuote(kalshiTicker),
    getPolymarketQuote(pmRich.yesTokenId ?? ''),
    // Depth is checked in the SAME parallel round trip as the prices, so verifying it
    // costs no extra wall-clock time before the order goes out.
    getKalshiOrderbook(kalshiTicker),
    getPolymarketBooks([pmRich.yesTokenId ?? '']),
  ]);
  const revalidateMs = Date.now() - revalStart;

  if (!kQuote || !pmQuote) {
    return executeError(
      `Could not re-quote ${!kQuote ? 'Kalshi' : 'Polymarket'} before ordering (${revalidateMs}ms) — refusing to trade on unverified prices.`,
      409);
  }

  // Prices live right now, for the exact sides this order would buy.
  const freshPmPrice = pmLeg.side === 'yes' ? pmQuote.yes : pmQuote.no;
  const freshKalPrice = actualKalshiSide === 'yes' ? kQuote.yes : kQuote.no;
  // Derive the fee model server-side rather than trusting the posted market.
  const feeKind = pair.polymarket.category === 'politics' ? 'fee_free' : 'sports';
  const freshCost = freshPmPrice + estimatePolymarketFeeCents(feeKind, freshPmPrice, 1)
                  + freshKalPrice + estimateKalshiFeeCents(freshKalPrice, 1);
  const freshEdgePercent = 100 - freshCost;

  if (freshEdgePercent <= 0) {
    const body: ExecuteResponse = {
      kalshi: { ok: false, error: 'Not placed — price moved' },
      polymarket: { ok: false, error: 'Not placed — price moved' },
      executedAt: new Date().toISOString(),
      bothOk: false,
      hedged: false,
      abortedOnPriceMove: true,
      revalidateMs,
      quotedEdgePercent,
      freshEdgePercent,
      hedgeNote: `Backed out in ${revalidateMs}ms: the edge is now ${freshEdgePercent.toFixed(2)}%` +
        (quotedEdgePercent !== undefined ? ` (was ${quotedEdgePercent.toFixed(2)}%)` : '') +
        `. No orders were sent.`,
    };
    console.log('[execute] aborted on price move', JSON.stringify({ ticker: kalshiTicker, revalidateMs, quotedEdgePercent, freshEdgePercent }));
    return NextResponse.json(body, { status: 409 });
  }

  // ── pre-order depth re-check ───────────────────────────────────────────────
  // A price that still looks good can have almost nothing behind it. Both venues publish
  // the whole ladder, so confirm the requested size can actually be bought on BOTH sides
  // while the pair stays profitable. Without this the Kalshi leg fills and the Polymarket
  // leg does not, which is the naked position this app exists to avoid — one live pair
  // advertised 10,000 contracts of depth when Polymarket had 190.
  const kalLadder = kalshiAskLadder(kOrderbook, actualKalshiSide);
  const pmLadder = polymarketAskLadder(pmBooks.get(pmRich.yesTokenId ?? ''), pmLeg.side);
  const feePerContract = (pmPrice: number, kalPrice: number) =>
    estimatePolymarketFeeCents(feeKind, pmPrice, 1) + estimateKalshiFeeCents(kalPrice, 1);
  const fill = fillableContracts(pmLadder, kalLadder, feePerContract, contracts);

  if (fill.contracts < MIN_ORDER_CONTRACTS) {
    const body: ExecuteResponse = {
      kalshi: { ok: false, error: 'Not placed — not enough depth' },
      polymarket: { ok: false, error: 'Not placed — not enough depth' },
      executedAt: new Date().toISOString(),
      bothOk: false,
      hedged: false,
      abortedOnPriceMove: true,
      revalidateMs,
      quotedEdgePercent,
      freshEdgePercent,
      hedgeNote: `Backed out in ${revalidateMs}ms: only ${fill.contracts} contract(s) can be filled ` +
        `profitably across both books, below the ${MIN_ORDER_CONTRACTS}-share minimum. No orders were sent.`,
    };
    console.log('[execute] aborted on depth', JSON.stringify({ ticker: kalshiTicker, requested: contracts, fillable: fill.contracts }));
    return NextResponse.json(body, { status: 409 });
  }

  // Never buy more than both books can absorb. Trimming keeps the two legs equal, which
  // is what makes the position hedged; sending the full size would fill them unevenly.
  const plannedContracts = Math.min(contracts, fill.contracts);

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
    revalidateMs, quotedEdgePercent, freshEdgePercent,
    kalshi: { ok: kalshiResult.ok, filled: kalshiResult.filledCount, orderId: kalshiResult.orderId },
    polymarket: { ok: pmResult.ok, filled: pmResult.filledCount, orderId: pmResult.orderId },
  }));
  return NextResponse.json(response);
}
