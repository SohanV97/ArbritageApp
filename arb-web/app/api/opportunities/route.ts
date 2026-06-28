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

// ─── stale-while-revalidate in-process cache ─────────────────────────────────
// After the first cold-start fetch (~3 s with batch optimizations), every poll
// returns from this cache in <5 ms. When the TTL expires the cache is served
// stale immediately and refreshed in the background, so the user never waits.
interface CacheEntry { body: OpportunitiesResponse; builtAt: number; }
let _cache: CacheEntry | null = null;
let _rebuilding = false;
const CACHE_TTL_MS = 55_000; // refresh in background at 55 s (under the 60 s revalidate)

async function buildOpportunities(): Promise<OpportunitiesResponse> {
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

  return {
    opportunities: allOpportunities,
    stats: {
      pmMarkets: totalPm,
      kalshiMarkets: totalKalshi,
      matchedPairs: totalPairs,
      byCategory,
      fetchedAt: new Date().toISOString(),
    },
  };
}

export async function GET() {
  const now = Date.now();
  const age = _cache ? now - _cache.builtAt : Infinity;

  // Stale: return old data immediately and kick off a background refresh
  if (_cache && age > CACHE_TTL_MS && !_rebuilding) {
    _rebuilding = true;
    buildOpportunities()
      .then(body => { _cache = { body, builtAt: Date.now() }; })
      .catch(err => console.error('[opportunities] background rebuild failed:', err))
      .finally(() => { _rebuilding = false; });
    return NextResponse.json(_cache.body);
  }

  // Fresh cache: instant return
  if (_cache) return NextResponse.json(_cache.body);

  // Cold start: must wait for first build
  try {
    const body = await buildOpportunities();
    _cache = { body, builtAt: Date.now() };
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/opportunities]', message);
    return NextResponse.json({
      opportunities: [],
      stats: { pmMarkets: 0, kalshiMarkets: 0, matchedPairs: 0, byCategory: {}, fetchedAt: new Date().toISOString() },
      error: message,
    } satisfies OpportunitiesResponse, { status: 500 });
  }
}
