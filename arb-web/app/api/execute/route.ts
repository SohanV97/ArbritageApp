import { NextResponse } from 'next/server';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import { placeKalshiOrder, testKalshiAuth } from '@/api/kalshi-trading';
import { placePolymarketOrder, testPolymarketAuth } from '@/api/polymarket-trading';
import type { KalshiAuthTest } from '@/api/kalshi-trading';
import type { PolymarketAuthTest } from '@/api/polymarket-trading';

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

  // Place both legs simultaneously — this minimizes price-movement risk between legs
  const [kalshiRaw, pmRaw] = await Promise.all([
    placeKalshiOrder({
      ticker: kalshiTicker,
      side: actualKalshiSide,
      count: contracts,
      priceCents: kalLeg.priceCents,
    }),
    placePolymarketOrder({
      tokenId: pmTokenId,
      count: contracts,
      priceCents: pmLeg.priceCents,
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
  };

  // Audit log (server-side only). Order IDs + fill counts, no error bodies with secrets.
  console.log('[execute]', JSON.stringify({
    ticker: kalshiTicker, contracts, bothOk, hedged, hedgeNote: note,
    kalshi: { ok: kalshiResult.ok, filled: kalshiResult.filledCount, orderId: kalshiResult.orderId },
    polymarket: { ok: pmResult.ok, filled: pmResult.filledCount, orderId: pmResult.orderId },
  }));
  return NextResponse.json(response);
}
