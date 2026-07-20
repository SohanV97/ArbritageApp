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
  bothOk: boolean;
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

// The client renders whatever this route returns as an ExecuteResponse, so every
// exit path — including validation failures — must carry that exact shape.
function executeError(message: string, status = 400): Response {
  const body: ExecuteResponse = {
    kalshi: { ok: false, error: message },
    polymarket: { ok: false, error: message },
    executedAt: new Date().toISOString(),
    bothOk: false,
  };
  return NextResponse.json(body, { status });
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

  // Determine which leg is PM and which is Kalshi
  const pmLeg  = legA.venue === 'polymarket' ? legA : legB;
  const kalLeg = legA.venue === 'kalshi'     ? legA : legB;

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

  // Place both legs simultaneously — this minimizes price-movement risk between legs
  const [kalshiResult, pmResult] = await Promise.all([
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

  const response: ExecuteResponse = {
    kalshi: kalshiResult,
    polymarket: pmResult,
    executedAt: new Date().toISOString(),
    bothOk: kalshiResult.ok && pmResult.ok,
  };

  console.log('[execute]', JSON.stringify(response));
  return NextResponse.json(response);
}
