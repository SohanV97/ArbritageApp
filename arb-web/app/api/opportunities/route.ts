import { NextResponse } from 'next/server';
import { getPolymarketMarketsForAllCategories } from '@/api/polymarket';
import { getKalshiMarketsForAllCategories } from '@/api/kalshi';
import { matchMarkets } from '@/lib/matchMarkets';
import { findArbitrageOpportunities, type PairWithKind } from '@/lib/arbitrage';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import type { ArbitrageOpportunity, Category } from '@/lib/market-types';
import { SPORT_ALIASES } from '@/lib/categories';

export interface PairInfo {
  category: Category;
  pmId: string;   // unique market id — URLs are shared across a multi-outcome event
  kalId: string;
  pmQuestion: string;
  pmPrice: number;
  pmDate?: string;
  pmUrl: string;
  kalQuestion: string;
  kalPrice: number;
  kalDate?: string;
  kalUrl: string;
  priceDiff: number;
  datesMatch: boolean;
  filteredOut: boolean; // true if excluded by date/sanity checks (shown greyed in UI)
}

export interface OpportunitiesResponse {
  opportunities: ArbitrageOpportunity[];
  pairsDetail: PairInfo[];
  stats: {
    pmMarkets: number;
    kalshiMarkets: number;
    matchedPairs: number;
    byCategory: Partial<Record<Category, { pm: number; kalshi: number; pairs: number }>>;
    fetchedAt: string;
  };
  error?: string;
}

// No `revalidate` export: that would opt this GET handler into static/ISR caching
// and bake responses at build time. Left dynamic (the Next 16 default), freshness
// is governed by the in-process stale-while-revalidate cache below.
const SPORT_CATEGORIES: Category[] = ['mlb', 'soccer'];

// ─── stale-while-revalidate in-process cache ─────────────────────────────────
// After the first cold-start fetch (~3 s with batch optimizations), every poll
// returns from this cache in <5 ms. When the TTL expires the cache is served
// stale immediately and refreshed in the background, so the user never waits.
interface CacheEntry { body: OpportunitiesResponse; builtAt: number; }
let _cache: CacheEntry | null = null;
let _rebuilding = false;
const CACHE_TTL_MS = 55_000; // refresh in background at 55 s (under the 60 s revalidate)

// ─── YES-side alignment helpers ──────────────────────────────────────────────
// A matched pair's two YES contracts may pay on opposite outcomes (PM YES = Braves,
// Kalshi YES = Pirates). Alignment must be decided by identity — team for sports,
// party for politics. Price proximity inverts exactly when the venues disagree on
// price, which is the arb signal itself, so it's only a last-resort fallback.

function teamTokens(s: string, aliases: Record<string, string[]>): Set<string> {
  const base = s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
  const out = new Set(base);
  for (const t of base) {
    for (const alias of aliases[t] ?? []) {
      for (const w of alias.toLowerCase().split(/\s+/)) if (w.length > 1) out.add(w);
    }
  }
  return out;
}

function teamOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}

function partyOf(q: string): 'r' | 'd' | 'i' | null {
  const s = q.toLowerCase();
  if (/\brepublican(s)?\b|\bgop\b/.test(s)) return 'r';
  if (/\bdemocrat(s|ic|ics)?\b/.test(s)) return 'd';
  if (/\bindependent(s)?\b/.test(s)) return 'i';
  return null;
}

async function buildOpportunities(): Promise<OpportunitiesResponse> {
  const [pmByCategory, kalshiByCategory] = await Promise.all([
    getPolymarketMarketsForAllCategories(),
    getKalshiMarketsForAllCategories(),
  ]);

  const allOpportunities: ArbitrageOpportunity[] = [];
  const allPairsDetail: PairInfo[] = [];
  const byCategory: OpportunitiesResponse['stats']['byCategory'] = {};

  const allCategories: Category[] = [...SPORT_CATEGORIES, 'politics' as Category];

  for (const cat of allCategories) {
    const pmMarkets = pmByCategory.get(cat) ?? [];
    const kalshiMarkets = kalshiByCategory.get(cat) ?? [];

    if (pmMarkets.length === 0 || kalshiMarkets.length === 0) {
      byCategory[cat] = { pm: pmMarkets.length, kalshi: kalshiMarkets.length, pairs: 0 };
      continue;
    }

    const pairs = matchMarkets(pmMarkets, kalshiMarkets, {
      // Sports (MLB + soccer): team-split matching requires BOTH teams to align, so
      //   ambiguous city aliases (york→yankees/mets) can't cross-match different games;
      //   also enforces same game date (the same two teams play a multi-day series).
      // Politics: structured (state, chamber, year) matching — token similarity
      //   can't separate states because every senate market shares "senate race 2026".
      minTitleSimilarity: 0.35,
      minOverlapTokens: 1,
      requireSameDay: cat === 'soccer' || cat === 'mlb',
      politics: cat === 'politics',
      aliases: SPORT_ALIASES[cat],
    });

    const typedPairs: PairWithKind[] = pairs.flatMap(p => {
      const pmYes = p.polymarket.yesPriceCents;
      const kalYes = p.kalshi.yesPriceCents;
      const kalNo = p.kalshi.noPriceCents;
      const pmDay = p.polymarket.resolutionTime?.slice(0, 10);
      const kDay = p.kalshi.resolutionTime?.slice(0, 10);
      // Politics markets are matched by structured identity (state/chamber/year), not
      // by date — PM settles on election day, Kalshi on swearing-in — so their raw
      // resolution dates legitimately differ and must not count as a mismatch.
      const datesMatch = cat === 'politics' ? true : pmDay === kDay;

      // Identity-based YES alignment; price proximity only when identity is unknown.
      const priceAligned = Math.abs(pmYes - kalYes) < Math.abs(pmYes - kalNo);
      let isAligned = priceAligned;
      if (cat !== 'politics' && p.polymarket.yesTeam && p.kalshi.yesTeam) {
        const aliases = SPORT_ALIASES[cat] ?? {};
        const kalYesTokens = teamTokens(p.kalshi.yesTeam, aliases);
        const yesScore = teamOverlap(teamTokens(p.polymarket.yesTeam, aliases), kalYesTokens);
        const noScore = p.polymarket.noTeam
          ? teamOverlap(teamTokens(p.polymarket.noTeam, aliases), kalYesTokens)
          : 0;
        // Overlap comparison (not boolean match) disambiguates same-city teams
        // (NYY/NYM, LAD/LAA); a tie means identity is inconclusive → price fallback.
        if (yesScore !== noScore) isAligned = yesScore > noScore;
      } else if (cat === 'politics') {
        const pmParty = partyOf(p.polymarket.question);
        const kalParty = partyOf(p.kalshi.question);
        if (pmParty !== null && kalParty !== null) isAligned = pmParty === kalParty;
      }
      const alignedKalYes = isAligned ? kalYes : kalNo;
      const priceDiff = Math.abs(pmYes - alignedKalYes);

      // Require same game date (±1 day) for all sports.
      // PM dates come from the market slug (extractDateFromSlug), not end_date_iso,
      // so they reflect the actual game date rather than the series settlement date.
      let dateTooFar = false;
      if (cat !== 'politics' && pmDay && kDay) {
        dateTooFar = pmDay !== kDay;
      }

      // >25¢ gap between aligned YES prices means these are different events (wrong match)
      const priceTooFar = priceDiff > 25;
      const filteredOut = dateTooFar || priceTooFar;

      allPairsDetail.push({
        category: cat,
        pmId: p.polymarket.id,
        kalId: p.kalshi.id,
        pmQuestion: p.polymarket.question,
        pmPrice: pmYes,
        pmDate: pmDay,
        pmUrl: p.polymarket.url ?? '',
        kalQuestion: p.kalshi.question,
        kalPrice: alignedKalYes,
        kalDate: kDay,
        kalUrl: p.kalshi.url ?? '',
        priceDiff,
        datesMatch,
        filteredOut,
      });

      if (filteredOut) return [];

      // Flipping swaps everything YES/NO-directional: prices AND book depths.
      const alignedKalshi = isAligned ? p.kalshi : {
        ...p.kalshi,
        yesPriceCents: kalNo,
        noPriceCents: kalYes,
        yesDepth: p.kalshi.noDepth,
        noDepth: p.kalshi.yesDepth,
        question: `${p.kalshi.question} [FLIPPED]`,
      };
      return [{
        polymarket: p.polymarket as PolymarketMarketWithKind,
        kalshi: alignedKalshi,
      }];
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
    pairsDetail: allPairsDetail,
    stats: {
      pmMarkets: totalPm,
      kalshiMarkets: totalKalshi,
      matchedPairs: totalPairs,
      byCategory,
      fetchedAt: new Date().toISOString(),
    },
  };
}

// Kick off a build the moment this module loads. In local dev the module is loaded
// once and stays warm — the build completes before you open the browser. On Vercel
// with pre-warmed instances it completes before real traffic arrives. If a real GET
// request arrives while the warm is still running, it awaits the same Promise
// instead of starting a second parallel build.
let _warmupPromise: Promise<void> | null = (() => {
  _rebuilding = true;
  return buildOpportunities()
    .then(body => { _cache = { body, builtAt: Date.now() }; })
    .catch(err => console.error('[opportunities] startup warm failed:', err))
    .finally(() => { _rebuilding = false; _warmupPromise = null; });
})();

const cacheHeaders = { 'Cache-Control': 'public, max-age=7, stale-while-revalidate=55' };

export async function GET() {
  // If the startup warm is still in flight, wait for it rather than firing a second build.
  if (_warmupPromise) await _warmupPromise;

  const now = Date.now();
  const age = _cache ? now - _cache.builtAt : Infinity;

  // Stale: return old data immediately and kick off a background refresh
  if (_cache && age > CACHE_TTL_MS && !_rebuilding) {
    _rebuilding = true;
    buildOpportunities()
      .then(body => { _cache = { body, builtAt: Date.now() }; })
      .catch(err => console.error('[opportunities] background rebuild failed:', err))
      .finally(() => { _rebuilding = false; });
    return NextResponse.json(_cache.body, { headers: cacheHeaders });
  }

  // Fresh cache: instant return
  if (_cache) return NextResponse.json(_cache.body, { headers: cacheHeaders });

  // Warm failed — try once more
  try {
    const body = await buildOpportunities();
    _cache = { body, builtAt: Date.now() };
    return NextResponse.json(body, { headers: cacheHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/opportunities]', message);
    return NextResponse.json({
      opportunities: [],
      pairsDetail: [],
      stats: { pmMarkets: 0, kalshiMarkets: 0, matchedPairs: 0, byCategory: {}, fetchedAt: new Date().toISOString() },
      error: message,
    } satisfies OpportunitiesResponse, { status: 500 });
  }
}
