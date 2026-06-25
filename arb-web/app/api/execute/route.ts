import { NextResponse } from 'next/server';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import { placeKalshiOrder } from '@/api/kalshi-trading';
import { placePolymarketOrder } from '@/api/polymarket-trading';

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

export async function POST(request: Request): Promise<Response> {
  let body: ExecuteRequest;
  try {
    body = await request.json() as ExecuteRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { opportunity, amount } = body;
  const { pair, legA, legB } = opportunity;

  // Determine which leg is PM and which is Kalshi
  const pmLeg  = legA.venue === 'polymarket' ? legA : legB;
  const kalLeg = legA.venue === 'kalshi'     ? legA : legB;

  // Kalshi ticker lives on .symbol (set by normalizeKalshiMarkets)
  const kalshiTicker = (pair.kalshi as { symbol?: string }).symbol ?? '';
  if (!kalshiTicker) {
    return NextResponse.json({ error: 'Missing Kalshi ticker' }, { status: 400 });
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
    return NextResponse.json({ error: 'Missing Polymarket token ID for this side' }, { status: 400 });
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
