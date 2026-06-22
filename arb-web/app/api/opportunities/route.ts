import { NextResponse } from 'next/server';
import { getPolymarketBaseballMarkets } from '@/api/polymarket';
import { getKalshiBaseballMarkets } from '@/api/kalshi';
import { matchMarkets } from '@/lib/matchMarkets';
import { findArbitrageOpportunities, type PairWithKind } from '@/lib/arbitrage';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import type { ArbitrageOpportunity } from '@/lib/market-types';

export interface OpportunitiesResponse {
  opportunities: ArbitrageOpportunity[];
  stats: {
    pmMarkets: number;
    kalshiMarkets: number;
    matchedPairs: number;
    fetchedAt: string;
  };
  error?: string;
}

// Cache: re-use data for 60s to avoid hammering both APIs on every page load
export const revalidate = 60;

export async function GET() {
  try {
    const [pmMarkets, kalshiMarkets] = await Promise.all([
      getPolymarketBaseballMarkets(),
      getKalshiBaseballMarkets(),
    ]);

    const pairs = matchMarkets(pmMarkets, kalshiMarkets, {
      minTitleSimilarity: 0.35,
      minOverlapTokens: 2,
      requireSameDay: true,
    });

    const typedPairs: PairWithKind[] = pairs.map(p => {
      const pmYes = p.polymarket.yesPriceCents;
      const kalYes = p.kalshi.yesPriceCents;
      const kalNo = p.kalshi.noPriceCents;
      const isAligned = Math.abs(pmYes - kalYes) < Math.abs(pmYes - kalNo);
      const alignedKalshi = isAligned ? p.kalshi : {
        ...p.kalshi,
        yesPriceCents: kalNo,
        noPriceCents: kalYes,
        question: `${p.kalshi.question} [FLIPPED]`,
      };
      return {
        polymarket: p.polymarket as PolymarketMarketWithKind,
        kalshi: alignedKalshi,
      };
    });

    const opportunities = findArbitrageOpportunities(typedPairs, 0);

    const body: OpportunitiesResponse = {
      opportunities,
      stats: {
        pmMarkets: pmMarkets.length,
        kalshiMarkets: kalshiMarkets.length,
        matchedPairs: pairs.length,
        fetchedAt: new Date().toISOString(),
      },
    };

    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/opportunities]', message);
    const body: OpportunitiesResponse = {
      opportunities: [],
      stats: { pmMarkets: 0, kalshiMarkets: 0, matchedPairs: 0, fetchedAt: new Date().toISOString() },
      error: message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
