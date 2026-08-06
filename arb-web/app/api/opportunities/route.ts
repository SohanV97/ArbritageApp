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
    /** When these quotes were actually built (not when the response was sent). */
    builtAt?: string;
    /** Age of the quotes in ms at send time — what the UI should show as freshness. */
    ageMs?: number;
  };
  error?: string;
}

// No `revalidate` export: that would opt this GET handler into static/ISR caching
// and bake responses at build time. Left dynamic (the Next 16 default), freshness
// is governed by the in-process stale-while-revalidate cache below.
const SPORT_CATEGORIES: Category[] = ['mlb', 'soccer'];

// Opportunities down to this edge are returned so near-misses stay visible.
// Anything ≤ 0 is unprofitable and the UI refuses to execute it.
const NEAR_MISS_FLOOR_PERCENT = -5;

// ─── stale-while-revalidate in-process cache ─────────────────────────────────
// After the first cold-start fetch (~3 s with batch optimizations), every poll
// returns from this cache in <5 ms. When the TTL expires the cache is served
// stale immediately and refreshed in the background, so the user never waits.
interface CacheEntry { body: OpportunitiesResponse; builtAt: number; }
let _cache: CacheEntry | null = null;
let _rebuilding = false;
// A full rebuild measured ~1.2 s, so holding quotes for 55 s was ~50× more stale than
// necessary: an opportunity could be gone from the venues long before the app stopped
// showing it. Keep it just under the client's 7 s poll so nearly every poll gets a
// freshly built set, while still collapsing bursts onto one build.
const CACHE_TTL_MS = 6_000;

// Single-flight: every caller that needs a rebuild awaits the SAME build, so a burst of
// polls or force-refreshes can never stampede the upstream APIs into rate limits.
let _inFlight: Promise<OpportunitiesResponse> | null = null;

function rebuild(): Promise<OpportunitiesResponse> {
  if (_inFlight) return _inFlight;
  _rebuilding = true;
  _inFlight = buildOpportunities()
    .then(body => { _cache = { body, builtAt: Date.now() }; return body; })
    .finally(() => { _inFlight = null; _rebuilding = false; });
  return _inFlight;
}

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

    // Surface near-misses, not just profitable arbs. Cross-venue prediction markets
    // are efficient most of the day: a threshold of 0 hides every matched game and
    // leaves the user staring at an empty screen with no idea whether the app is
    // broken or the market is simply tight. Showing down to -5% makes "how close are
    // we" visible; the UI marks anything ≤0 as unprofitable and blocks executing it,
    // and auto-exec has its own (positive) threshold, so nothing loss-making trades.
    const opps = findArbitrageOpportunities(typedPairs, NEAR_MISS_FLOOR_PERCENT);
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
  return rebuild()
    .then(() => { /* cache populated by rebuild() */ })
    .catch(err => console.error('[opportunities] startup warm failed:', err))
    .finally(() => { _warmupPromise = null; });
})();

// Never let a browser or proxy serve a cached copy: quotes go stale in seconds, and an
// HTTP-cached response made pressing Refresh look like nothing had changed because the
// request never reached the server.
const cacheHeaders = { 'Cache-Control': 'no-store, max-age=0' };

// Stamp how old the quotes actually are, so the UI can report real data age instead of
// "just now" (which only ever meant "the response arrived just now").
function withAge(body: OpportunitiesResponse, builtAt: number): OpportunitiesResponse {
  return { ...body, stats: { ...body.stats, builtAt: new Date(builtAt).toISOString(), ageMs: Math.max(0, Date.now() - builtAt) } };
}

export async function GET(request: Request) {
  // ?fresh=1 — used by the Refresh button. Waits for a genuinely new build so the prices
  // shown match the venues right now, and an opportunity that has evaporated disappears.
  let forceFresh = false;
  try { forceFresh = new URL(request.url).searchParams.get('fresh') === '1'; } catch { /* ignore */ }

  // If the startup warm is still in flight, wait for it rather than firing a second build.
  if (_warmupPromise) await _warmupPromise;

  if (forceFresh) {
    try {
      const body = await rebuild();
      return NextResponse.json(withAge(body, _cache?.builtAt ?? Date.now()), { headers: cacheHeaders });
    } catch (err) {
      console.error('[opportunities] forced refresh failed:', err);
      // Serve the last good data rather than an empty screen; the age makes it obvious.
      if (_cache) return NextResponse.json(withAge(_cache.body, _cache.builtAt), { headers: cacheHeaders });
    }
  }

  const age = _cache ? Date.now() - _cache.builtAt : Infinity;

  // Stale: return current data immediately and refresh in the background
  if (_cache && age > CACHE_TTL_MS) {
    rebuild().catch(err => console.error('[opportunities] background rebuild failed:', err));
    return NextResponse.json(withAge(_cache.body, _cache.builtAt), { headers: cacheHeaders });
  }

  // Fresh cache: instant return
  if (_cache) return NextResponse.json(withAge(_cache.body, _cache.builtAt), { headers: cacheHeaders });

  // No cache at all (warm failed) — build now. Just-built, so age is effectively zero.
  try {
    const body = await rebuild();
    return NextResponse.json(withAge(body, Date.now()), { headers: cacheHeaders });
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
