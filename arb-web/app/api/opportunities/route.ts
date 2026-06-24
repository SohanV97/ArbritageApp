import { NextResponse } from 'next/server';
import { getPolymarketMarketsForAllCategories } from '@/api/polymarket';
import { getKalshiMarketsForAllCategories } from '@/api/kalshi';
import { matchMarkets } from '@/lib/matchMarkets';
import { findArbitrageOpportunities, type PairWithKind } from '@/lib/arbitrage';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import type { ArbitrageOpportunity, Category } from '@/lib/market-types';
import { SPORT_ALIASES } from '@/lib/categories';

export interface OpportunitiesResponse {
  opportunities: ArbitrageOpportunity[];
  stats: {
    pmMarkets: number;
    kalshiMarkets: number;
    matchedPairs: number;
    byCategory: Partial<Record<Category, { pm: number; kalshi: number; pairs: number }>>;
    fetchedAt: string;
  };
  error?: string;
}

export const revalidate = 60;

const SPORT_CATEGORIES: Category[] = ['mlb', 'soccer'];

export async function GET() {
  try {
    const [pmByCategory, kalshiByCategory] = await Promise.all([
      getPolymarketMarketsForAllCategories(),
      getKalshiMarketsForAllCategories(),
    ]);

    const allOpportunities: ArbitrageOpportunity[] = [];
    const byCategory: OpportunitiesResponse['stats']['byCategory'] = {};

    const allCategories: Category[] = [...SPORT_CATEGORIES, 'politics' as Category];

    for (const cat of allCategories) {
      const pmMarkets = pmByCategory.get(cat) ?? [];
      const kalshiMarkets = kalshiByCategory.get(cat) ?? [];

      if (pmMarkets.length === 0 || kalshiMarkets.length === 0) {
        byCategory[cat] = { pm: pmMarkets.length, kalshi: kalshiMarkets.length, pairs: 0 };
        continue;
      }

      const isSport = SPORT_CATEGORIES.includes(cat);
      const pairs = matchMarkets(pmMarkets, kalshiMarkets, {
        minTitleSimilarity: isSport ? (cat === 'soccer' ? 0.3 : 0.35) : 0.35,
        minOverlapTokens: isSport ? 2 : 1,
        requireSameDay: isSport,
        aliases: SPORT_ALIASES[cat],
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

      const opps = findArbitrageOpportunities(typedPairs, 0);
      allOpportunities.push(...opps);
      byCategory[cat] = { pm: pmMarkets.length, kalshi: kalshiMarkets.length, pairs: pairs.length };
    }

    allOpportunities.sort((a, b) => b.edgePercent - a.edgePercent);

    const totalPm = [...pmByCategory.values()].reduce((s, v) => s + v.length, 0);
    const totalKalshi = [...kalshiByCategory.values()].reduce((s, v) => s + v.length, 0);
    const totalPairs = Object.values(byCategory).reduce((s, v) => s + (v?.pairs ?? 0), 0);

    const body: OpportunitiesResponse = {
      opportunities: allOpportunities,
      stats: {
        pmMarkets: totalPm,
        kalshiMarkets: totalKalshi,
        matchedPairs: totalPairs,
        byCategory,
        fetchedAt: new Date().toISOString(),
      },
    };

    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/opportunities]', message);
    const body: OpportunitiesResponse = {
      opportunities: [],
      stats: {
        pmMarkets: 0,
        kalshiMarkets: 0,
        matchedPairs: 0,
        byCategory: {},
        fetchedAt: new Date().toISOString(),
      },
      error: message,
    };
    return NextResponse.json(body, { status: 500 });
  }
}
