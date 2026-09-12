import { NextResponse } from 'next/server';
import { gzipSync } from 'node:zlib';
import { getPolymarketMarketsForAllCategories, refreshPolymarketPrices, getPolymarketBooks } from '@/api/polymarket';
import { getKalshiMarketsForAllCategories, refreshKalshiPrices, getKalshiOrderbook } from '@/api/kalshi';
import { warmPolymarketTrading } from '@/api/polymarket-trading';
import { fillableContracts, kalshiAskLadder, polymarketAskLadder } from '@/lib/depth';
import { estimateKalshiFeeCents, estimatePolymarketFeeCents } from '@/lib/fees';
import { sizeByRisk } from '@/lib/sizing';
import { executeArb } from '@/api/tradeExecutor';
import {
  getAutoExecConfig, addAutoExecRecord, tryClaimExecution, releaseExecution,
  pairIsAvailable, releasePairAfter, holdPair,
} from '@/lib/autoExec';
import { loadDiscovery, saveDiscovery } from '@/lib/discoveryCache';
import { matchMarkets, teamsAreDifferent } from '@/lib/matchMarkets';
import { findArbitrageOpportunities, type PairWithKind } from '@/lib/arbitrage';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import type { ArbitrageOpportunity, Category, MatchedPair, UnifiedMarket } from '@/lib/market-types';
import { MIN_ORDER_CONTRACTS } from '@/lib/market-types';
import { SPORT_ALIASES, SPORT_CATEGORY_LIST, isSportCategory, isThreeWayCategory } from '@/lib/categories';

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
  /** Cold start: discovery is still running, so this is an empty placeholder.
   *  The client keeps polling and fills in as soon as the first build lands. */
  warming?: boolean;
}

// No `revalidate` export: that would opt this GET handler into static/ISR caching
// and bake responses at build time. Left dynamic (the Next 16 default), freshness
// is governed by the in-process stale-while-revalidate cache below.
const SPORT_CATEGORIES: Category[] = SPORT_CATEGORY_LIST;

// Only genuinely profitable trades are surfaced. A non-positive edge is a guaranteed
// loss after fees, so it is never an "opportunity" — the Matched Pairs tab still shows
// every pairing (including unprofitable ones) when you want to see the market is being
// tracked at all.
const MIN_PROFIT_EDGE_PERCENT = 0;

// ─── stale-while-revalidate in-process cache ─────────────────────────────────
// After the first cold-start fetch (~3 s with batch optimizations), every poll
// returns from this cache in <5 ms. When the TTL expires the cache is served
// stale immediately and refreshed in the background, so the user never waits.
// The body only changes when prices refresh, so serialize AND compress it once per
// build instead of on every request. Measured: the raw payload is ~200 KB and was being
// sent uncompressed; gzip takes it to ~37 KB (5.4x less over the wire) and a request
// becomes a buffer write with no JSON work at all.
interface CacheEntry {
  body: OpportunitiesResponse;
  builtAt: number;
  json: string;
  gzip: Buffer;
  /** Same payload without pairsDetail. That array is 93% of the bytes (269KB -> 19KB raw,
   *  49KB -> 4KB gzipped) and only the Matched Pairs tab renders it, yet every client polls
   *  three times a second. Serving it only when asked cuts the steady-state transfer from
   *  ~141KB/s to ~12KB/s and, more importantly, the JSON.parse the browser does on each
   *  poll from 269KB to 19KB. Both variants are built once per build, not per request. */
  slimJson: string;
  slimGzip: Buffer;
}
let _cache: CacheEntry | null = null;

function makeEntry(body: OpportunitiesResponse, builtAt: number): CacheEntry {
  // builtAt travels IN the payload so the response is byte-identical for the whole
  // build window; the client derives quote age from it. (A per-request "ageMs" field
  // would force re-serialization on every hit and defeat the caching.)
  const stamped: OpportunitiesResponse = {
    ...body,
    stats: { ...body.stats, builtAt: new Date(builtAt).toISOString() },
  };
  const json = JSON.stringify(stamped);
  // pairsDetail omitted, but stats.matchedPairs still carries the count the tab label needs.
  const slimJson = JSON.stringify({ ...stamped, pairsDetail: [] });
  return {
    body: stamped, builtAt, json, gzip: gzipSync(json, { level: 6 }),
    slimJson, slimGzip: gzipSync(slimJson, { level: 6 }),
  };
}
let _rebuilding = false;
// Last discovery result, reused by the cheap reprice path.
let _discovery: Discovery | null = null;
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
    .then(body => { _cache = makeEntry(body, Date.now()); return body; })
    .finally(() => { _inFlight = null; _rebuilding = false; });
  return _inFlight;
}

// Fast path: re-quote the matched markets only. Single-flighted like rebuild().
let _repriceInFlight: Promise<OpportunitiesResponse> | null = null;

function reprice(): Promise<OpportunitiesResponse> {
  if (_repriceInFlight) return _repriceInFlight;
  const disc = _discovery;
  if (!disc) return rebuild();               // nothing discovered yet
  _repriceInFlight = repriceAndAssemble(disc)
    .then(body => { _cache = makeEntry(body, Date.now()); return body; })
    .finally(() => { _repriceInFlight = null; });
  return _repriceInFlight;
}

// A game that is being played right now. Its synthetic resolutionTime is
// "<gameDate>T23:59:00Z", so "today or yesterday (UTC)" covers a game in progress and one
// that started late and ran past midnight, without dragging in tomorrow's fixtures.
function isInPlay(m: { resolutionTime?: string }): boolean {
  if (!m.resolutionTime) return false;
  const day = m.resolutionTime.slice(0, 10);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return day === today || day === yesterday;
}

// Re-quote ONLY the games in progress. Live prices move within seconds, and the edge a
// user clicks has to still exist when the order lands — the whole reason an execution
// aborts is that the displayed price was already stale. In-play is a handful of markets,
// so this costs one small batch per venue and can run far more often than the full set.
let _fastInFlight: Promise<void> | null = null;

function repriceInPlay(): Promise<void> {
  if (_fastInFlight) return _fastInFlight;
  const disc = _discovery;
  if (!disc) return Promise.resolve();
  const pm = disc.matchedPm.filter(isInPlay);
  const kal = disc.matchedKalshi.filter(isInPlay);
  if (pm.length === 0 && kal.length === 0) return Promise.resolve();
  _fastInFlight = Promise.all([
    refreshKalshiPrices(kal),
    refreshPolymarketPrices(pm),
  ])
    .then(() => {
      // Rebuild from the mutated market objects so the cache reflects the new prices.
      _cache = makeEntry(assemble(disc), Date.now());
    })
    .catch(err => console.error('[opportunities] in-play reprice failed:', err))
    .finally(() => { _fastInFlight = null; });
  return _fastInFlight;
}

// ─── true fillable depth ─────────────────────────────────────────────────────
// maxContracts used to be Kalshi's top-of-book size and nothing else, which is wrong both
// ways. Live examples: a pair reported 10,000 contracts when Polymarket only had 190 at a
// profitable price (sizing to that number fills one leg and leaves the other naked), and
// another reported 10,961 when 26,709 were fillable one cent deeper, so the UI warned
// "exceeds visible book depth" on an order that would have filled comfortably.
//
// Real depth needs the whole ladder from BOTH venues, walked together. Kalshi charges one
// request per market for its book, so this runs only for markets that are currently
// profitable (a handful) and on its own slow cadence — depth is for sizing, not for the
// abort decision, which re-quotes prices independently at order time.
const DEPTH_REFRESH_MS = 3_000;
const _depthByKey = new Map<string, number>();
let _depthAt = 0;
let _depthInFlight: Promise<void> | null = null;

const depthKey = (kalshiTicker: string, kalshiSide: string) => `${kalshiTicker}|${kalshiSide}`;

async function refreshDepth(opps: ArbitrageOpportunity[]): Promise<void> {
  if (_depthInFlight) return _depthInFlight;
  if (Date.now() - _depthAt < DEPTH_REFRESH_MS) return;
  const targets = opps.slice(0, 40);            // bounded: only what a user could act on
  if (targets.length === 0) { _depthAt = Date.now(); return; }

  _depthInFlight = (async () => {
    // One batched Polymarket request covers every token; Kalshi is one request per market.
    // pair.polymarket is typed as the base market; at runtime it is the Polymarket one,
    // which carries the CLOB token id and the fee model.
    const pmOf = (o: ArbitrageOpportunity) => o.pair.polymarket as PolymarketMarketWithKind;
    const tokenIds = targets
      .map(o => pmOf(o).yesTokenId)
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
    const [books, orderbooks] = await Promise.all([
      getPolymarketBooks([...new Set(tokenIds)]),
      Promise.all(targets.map(o => getKalshiOrderbook(o.pair.kalshi.symbol ?? ''))),
    ]);

    targets.forEach((o, idx) => {
      const pmLeg = o.legA.venue === 'polymarket' ? o.legA : o.legB;
      const kalLeg = o.legA.venue === 'kalshi' ? o.legA : o.legB;
      const ticker = o.pair.kalshi.symbol ?? '';
      if (!ticker) return;

      const kalLadder = kalshiAskLadder(orderbooks[idx], kalLeg.side);
      const pmTokenId = pmOf(o).yesTokenId;
      const book = pmTokenId ? books.get(pmTokenId) : undefined;
      const pmLadder = polymarketAskLadder(book, pmLeg.side);
      if (!kalLadder.length || !pmLadder.length) return;

      const kind = pmOf(o).polymarketFeeKind ?? 'fee_free';
      const fee = (pmPrice: number, kalPrice: number) =>
        estimatePolymarketFeeCents(kind, pmPrice, 1) + estimateKalshiFeeCents(kalPrice, 1);

      // fillableContracts walks (a, b); pass Polymarket first so the fee closure lines up.
      const result = fillableContracts(pmLadder, kalLadder, fee);
      _depthByKey.set(depthKey(ticker, kalLeg.side), result.contracts);
    });
    _depthAt = Date.now();
  })()
    .catch(err => console.error('[opportunities] depth refresh failed:', err))
    .finally(() => { _depthInFlight = null; });

  return _depthInFlight;
}

// Overwrite the top-of-book guess with the measured value once we have one. Until the
// first depth pass completes, maxContracts is left undefined rather than showing a number
// that is known to be wrong — an absent limit is honest, a wrong one causes naked legs.
function applyDepth(opps: ArbitrageOpportunity[]): void {
  for (const o of opps) {
    const kalLeg = o.legA.venue === 'kalshi' ? o.legA : o.legB;
    const measured = _depthByKey.get(depthKey(o.pair.kalshi.symbol ?? '', kalLeg.side));
    // Only overwrite once a real measurement exists. Assigning `measured` unconditionally
    // replaced Kalshi's own reported size with undefined for every not-yet-measured pair,
    // and undefined passes the tradeable filter below — so a quote resting on 0.01
    // contracts was published as an opportunity with no depth limit at all, right up until
    // the execute path measured the books and refused it.
    if (measured !== undefined) o.maxContracts = measured;
  }
}

/**
 * Trade an edge the moment the loop finds one, rather than waiting for a browser to notice.
 *
 * This is where the latency went. The browser had to poll (~150ms), post the opportunity
 * back, and the server then re-read books it had just read (~160ms) — so an order landed
 * 450-600ms after the prices that justified it, on edges measured to live under a second.
 * Deciding here removes the poll and the round trip.
 *
 * Deliberately fire-and-forget: the caller is the refresh tick, and blocking it on an order
 * would stall repricing for every other market while one trade completes.
 */
// Edges seen on the previous tick, so one that only exists for an instant can be told from
// one both venues agree on.
let _lastTickEdges = new Set<string>();

function maybeAutoExecute(opps: ArbitrageOpportunity[]): void {
  const cfg = getAutoExecConfig();

  const qualifyingNow = new Set<string>();
  for (const o of opps) {
    if (o.edgePercent > 0 && o.edgePercent >= cfg.thresholdPercent) {
      qualifyingNow.add(`${o.pair.polymarket.id}|${o.pair.kalshi.id}`);
    }
  }
  const seenLastTick = _lastTickEdges;
  _lastTickEdges = qualifyingNow;

  if (!cfg.enabled || opps.length === 0) return;

  for (const opp of opps) {
    if (opp.edgePercent <= 0 || opp.edgePercent < cfg.thresholdPercent) break;   // sorted desc
    if (cfg.scope === 'sports' && opp.pair.polymarket.category === 'politics') continue;
    const key = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
    if (!pairIsAvailable(key)) continue;

    // The edge must have been there on the previous tick too.
    //
    // Measured on live books: an edge that survives a tick is one both venues agree on, and
    // it goes on to pass every pre-order check — 36 of 41 such attempts were cleared to
    // send. An edge present for a single tick is the gap between two feeds rather than a
    // price: in-play baseball cards reading +0.56/+3.59/+2.55/+0.54% re-checked at
    // -4.37/-3.31/-2.40/-8.49% about 160ms later, always negative, which is selection bias
    // and not movement. Those cannot be captured at any latency reachable over HTTP, so
    // firing at them produces the run of executions that never becomes a trade.
    //
    // This costs one tick (~150ms) and still lands far inside the old 450-600ms budget.
    if (!seenLastTick.has(key)) continue;

    const amount = sizeByRisk({
      riskDollars: cfg.riskDollars,
      legAPriceCents: opp.legA.priceCents,
      legBPriceCents: opp.legB.priceCents,
      maxContracts: opp.maxContracts,
      minContracts: MIN_ORDER_CONTRACTS,
    }).contracts;
    if (amount <= 0) continue;

    // Claim before any await: two ticks can overlap, and both must not trade at once.
    if (!tryClaimExecution()) return;
    holdPair(key, 30_000);   // provisional; replaced by the outcome-based hold below

    const startedAt = Date.now();
    void executeArb({ opportunity: opp, amount, dryRun: cfg.dryRun === true })
      .then(({ body }) => {
        releasePairAfter(key, body);
        addAutoExecRecord({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ts: new Date().toISOString(),
          question: opp.pair.polymarket.question,
          edgePercent: opp.edgePercent,
          amount,
          result: body,
        });
        console.log('[autoexec] fired', JSON.stringify({
          ticker: opp.pair.kalshi.symbol, amount, quoted: opp.edgePercent,
          fresh: body.freshEdgePercent, hedged: body.hedged, sent: !body.noOrdersSent,
          totalMs: Date.now() - startedAt,
        }));
      })
      .catch(err => console.error('[autoexec] execution threw:', err))
      .finally(() => releaseExecution());
    return;   // one at a time
  }
}

// ─── background refresh loop ─────────────────────────────────────────────────
// Requests never wait on the network: a timer keeps the cache continuously hot, so
// every GET is a memory read (<5 ms) of quotes that are at most REPRICE_MS old.
// Rediscovery (new fixtures) runs far less often because it is ~6× more expensive.
// Repricing is a couple of batch calls (~200 ms), so it can run sub-second without
// approaching either venue's rate limit — verified at this cadence with zero 429s.
// Fast tick. Only in-play markets are re-quoted this often, so the added load is one
// small batch per venue (Kalshi's full 319-ticker batch already measures 24ms, and
// Polymarket's book call is ~120ms of pure network RTT regardless of size).
const FAST_REPRICE_MS = 150;
// Full set. Pre-game prices drift slowly, so they do not need the fast lane.
const REPRICE_MS = 700;
const REDISCOVER_MS = 90_000;

// Dev HMR re-evaluates this module, so a module-local flag would let each reload start
// another timer and multiply the upstream load. Pin the guard to the process instead.
//
// Store the TIMER, not a boolean. A boolean guard outlives the interval it guards: HMR
// tears down the old module instance (and its setInterval) while the flag stays true on
// globalThis, so every later reload returned early and no replacement timer was ever
// created. The loop died silently on the first edit and the cache then only refreshed
// when a request happened to hit the on-demand rebuild path — exactly the multi-second
// staleness this loop exists to prevent. Keeping the handle lets a reload cancel the old
// timer and install a new one, so the guard still prevents doubling up.
const LOOP_FLAG = Symbol.for('arb.opportunities.refreshLoop');
type LoopTimer = ReturnType<typeof setInterval>;
type LoopHost = { [LOOP_FLAG]?: LoopTimer };

function startRefreshLoop() {
  const host = globalThis as unknown as LoopHost;
  const existing = host[LOOP_FLAG];
  if (existing) clearInterval(existing);
  let lastFull = 0;
  const tick = async () => {
    try {
      const needsDiscovery = !_discovery || Date.now() - _discovery.at > REDISCOVER_MS;
      if (needsDiscovery) {
        // The very first discovery has nothing to serve, so it must complete.
        if (!_discovery) { await rebuild(); lastFull = Date.now(); return; }
        // Every later rediscovery runs in the BACKGROUND. Awaiting it here froze every
        // price for the whole ~15s scan, once every 90s: measured lag p90 2.1s, p99 14.9s,
        // max 15.2s, with 13% of samples over 700ms. A click on a live game inside that
        // window is quoting 15-second-old prices, so the pre-order revalidation correctly
        // refuses it — which is exactly the abort this work is meant to prevent.
        // rebuild() is single-flighted, so this cannot stack up, and repricing below keeps
        // using the existing discovery until the new one swaps in.
        void rebuild().catch(err => console.error('[opportunities] rediscovery failed:', err));
      }
      // Every tick refreshes the games in progress; the full set on the slower cadence.
      if (Date.now() - lastFull >= REPRICE_MS) {
        await reprice();
        lastFull = Date.now();
      } else {
        await repriceInPlay();
      }
    } catch (err) {
      console.error('[opportunities] refresh tick failed:', err);
    }
  };
  const timer = setInterval(() => { void tick(); }, FAST_REPRICE_MS);
  host[LOOP_FLAG] = timer;
  // Don't hold the process open on shutdown.
  (timer as unknown as { unref?: () => void }).unref?.();
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

// ─── discovery vs pricing ────────────────────────────────────────────────────
// Discovery — finding which markets exist and pairing them up — is the expensive part
// (~1.2 s of paging both APIs) but changes slowly: new fixtures appear hourly. Prices
// change by the second. Keeping them separate lets prices refresh in ~200 ms via the
// venues' batch endpoints, so quotes stay current without re-walking every series.
interface Discovery {
  pairsByCategory: Map<Category, MatchedPair[]>;
  counts: Partial<Record<Category, { pm: number; kalshi: number }>>;
  totalPm: number;
  totalKalshi: number;
  /** Just the markets that actually got matched — the only ones worth re-quoting. */
  matchedPm: PolymarketMarketWithKind[];
  matchedKalshi: UnifiedMarket[];
  at: number;
}

async function discover(): Promise<Discovery> {
  const [pmByCategory, kalshiByCategory] = await Promise.all([
    getPolymarketMarketsForAllCategories(),
    getKalshiMarketsForAllCategories(),
  ]);

  const pairsByCategory = new Map<Category, MatchedPair[]>();
  const counts: Discovery['counts'] = {};
  const matchedPm: PolymarketMarketWithKind[] = [];
  const matchedKalshi: UnifiedMarket[] = [];
  const seenPm = new Set<string>();
  const seenKal = new Set<string>();

  const allCategories: Category[] = [...SPORT_CATEGORIES, 'politics' as Category];

  for (const cat of allCategories) {
    const pmMarkets = pmByCategory.get(cat) ?? [];
    const kalshiMarkets = kalshiByCategory.get(cat) ?? [];
    counts[cat] = { pm: pmMarkets.length, kalshi: kalshiMarkets.length };

    if (pmMarkets.length === 0 || kalshiMarkets.length === 0) {
      pairsByCategory.set(cat, []);
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
      requireSameDay: isSportCategory(cat),
      politics: cat === 'politics',
      aliases: SPORT_ALIASES[cat],
    });

    pairsByCategory.set(cat, pairs);
    // Collect the matched markets once so repricing touches only what's on screen.
    for (const p of pairs) {
      if (!seenPm.has(p.polymarket.id)) { seenPm.add(p.polymarket.id); matchedPm.push(p.polymarket as PolymarketMarketWithKind); }
      if (!seenKal.has(p.kalshi.id)) { seenKal.add(p.kalshi.id); matchedKalshi.push(p.kalshi); }
    }
  }

  return {
    pairsByCategory, counts, matchedPm, matchedKalshi, at: Date.now(),
    totalPm: [...pmByCategory.values()].reduce((s, v) => s + v.length, 0),
    totalKalshi: [...kalshiByCategory.values()].reduce((s, v) => s + v.length, 0),
  };
}

// Pure CPU: rebuild the response from whatever prices the matched markets currently
// hold. Called after discovery and after every reprice, so both paths run identical
// alignment, fee and edge logic.
function assemble(disc: Discovery): OpportunitiesResponse {
  const allOpportunities: ArbitrageOpportunity[] = [];
  const allPairsDetail: PairInfo[] = [];
  const byCategory: OpportunitiesResponse['stats']['byCategory'] = {};

  for (const [cat, pairs] of disc.pairsByCategory) {
    const c = disc.counts[cat] ?? { pm: 0, kalshi: 0 };
    byCategory[cat] = { pm: c.pm, kalshi: c.kalshi, pairs: pairs.length };

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
        // Qualifiers first: "Eastern Washington" and "Washington" overlap on the shared
        // token, so the two scores TIE and the decision falls through to price proximity —
        // which is inverted exactly when the venues disagree. Settle those by identity
        // instead: whichever of PM's two teams is not qualifier-incompatible with Kalshi's
        // YES team is the aligned one.
        const pmYesDiffers = teamsAreDifferent(p.polymarket.yesTeam, p.kalshi.yesTeam);
        const pmNoDiffers = p.polymarket.noTeam
          ? teamsAreDifferent(p.polymarket.noTeam, p.kalshi.yesTeam)
          : true;
        if (pmYesDiffers !== pmNoDiffers) isAligned = !pmYesDiffers;
        else if (yesScore !== noScore) isAligned = yesScore > noScore;
        // Overlap comparison (not boolean match) disambiguates same-city teams
        // (NYY/NYM, LAD/LAA); a tie means identity is inconclusive → price fallback.
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

      // In a three-way sport the draw is its own outcome, so the two teams' contracts are
      // NOT complements. Pairing across teams there ("Galaxy wins" + "New England wins")
      // leaves a draw uncovered: it prices as a large edge — really just the draw
      // probability — but loses outright if the game is drawn. Only a same-team pairing
      // hedges, because the Kalshi NO side then covers the draw exactly as PM's NO does.
      const unhedgeableDraw = isThreeWayCategory(cat) && !isAligned;

      // A binary market's two executable sides must sum to about 100c — a little over,
      // because each side is an ASK and the spread is paid twice. A sum far above that
      // means the book is effectively empty or one-sided and the "price" is not something
      // anyone can trade at: an untraded college game quoted YES 81 / NO 98 (sum 179,
      // spread 49c) is not a market, it is two lonely resting orders. Those bogus prices
      // are what manufacture huge phantom edges. Kalshi already enforces this on its own
      // asks (95-105); Polymarket had no equivalent, so nothing caught it.
      const quoteSum = (yes: number, no: number) => yes + no;
      const pmSum = quoteSum(p.polymarket.yesPriceCents, p.polymarket.noPriceCents);
      const kalSum = quoteSum(p.kalshi.yesPriceCents, p.kalshi.noPriceCents);
      // 115 was too tight for the same reason Kalshi's 105 was: books widen the further out
      // a game is, and Polymarket college-football quotes run p50 121 / p90 145 / max 196.
      // Capping at 115 removed those fixtures from arbitrage entirely. A wide book is
      // expensive, not fake — the danger was never the width but the misalignment that made
      // both legs pay on the same outcome, which the identity gate above now prevents.
      const untradeableBook = pmSum > 200 || kalSum > 200 || pmSum < 90 || kalSum < 90;

      const filteredOut = dateTooFar || priceTooFar || unhedgeableDraw || untradeableBook;

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

    // Profitable trades only. findArbitrageOpportunities filters with >=, so filter
    // again strictly: a 0% edge is break-even, not profit, and isn't worth the
    // execution risk of two live orders.
    const opps = findArbitrageOpportunities(typedPairs, MIN_PROFIT_EDGE_PERCENT)
      .filter(o => o.edgePercent > 0);
    allOpportunities.push(...opps);
  }

  allOpportunities.sort((a, b) => b.edgePercent - a.edgePercent);

  // Replace the top-of-book guess with measured depth, and kick off a refresh for the
  // current set. The refresh is throttled and runs in the background, so assembling stays
  // pure CPU — it never waits on the venues.
  applyDepth(allOpportunities);
  void refreshDepth(allOpportunities);

  // Act here, on the books this tick just read, instead of waiting for a browser to poll.
  maybeAutoExecute(allOpportunities);

  // An edge you cannot legally place is not an opportunity. Polymarket rejects anything
  // under MIN_ORDER_CONTRACTS shares, so when the two books together can only fill fewer
  // than that, the trade is unreachable: the execute route would refuse it, and sizing to
  // it anyway would fill the Kalshi leg and leave the Polymarket leg naked. Depth of 3
  // contracts was showing as a live 0.25% opportunity.
  //
  // Only drop what has been MEASURED. Before the first depth pass maxContracts is
  // undefined, and hiding those would blank the list for the first few seconds after a
  // restart on markets that are perfectly tradeable.
  const tradeable = allOpportunities.filter(
    o => o.maxContracts === undefined || o.maxContracts >= MIN_ORDER_CONTRACTS,
  );

  const totalPairs = Object.values(byCategory).reduce((s, v) => s + (v?.pairs ?? 0), 0);

  return {
    opportunities: tradeable,
    pairsDetail: allPairsDetail,
    stats: {
      pmMarkets: disc.totalPm,
      kalshiMarkets: disc.totalKalshi,
      matchedPairs: totalPairs,
      byCategory,
      fetchedAt: new Date().toISOString(),
    },
  };
}

// Re-quote only the matched markets, then recompute. ~200 ms versus ~1.2 s for a full
// rediscovery, which is what makes second-by-second freshness affordable.
async function repriceAndAssemble(disc: Discovery): Promise<OpportunitiesResponse> {
  await Promise.all([
    refreshKalshiPrices(disc.matchedKalshi),
    refreshPolymarketPrices(disc.matchedPm),
  ]);
  return assemble(disc);
}

async function buildOpportunities(): Promise<OpportunitiesResponse> {
  const disc = await discover();

  // A rediscovery that found NOTHING on either venue is a network failure, not an empty
  // market. Both venues going silent at once has been observed — every Kalshi series logging
  // "fetch failed" while Polymarket returned 0 events — and publishing that result replaced a
  // working set of hundreds of markets with nothing, then wrote the nothing to disk, so the
  // next restart began blank as well. One bad minute of connectivity therefore blanked the
  // app until a later scan happened to succeed.
  //
  // Keep what we already have instead. Prices for those markets are re-fetched every tick
  // regardless, so holding the fixture list across a blip costs nothing and the next
  // rediscovery replaces it normally.
  const foundNothing = disc.matchedPm.length === 0 && disc.matchedKalshi.length === 0;
  const haveWorkingSet = !!_discovery
    && (_discovery.matchedPm.length > 0 || _discovery.matchedKalshi.length > 0);
  if (foundNothing && haveWorkingSet) {
    console.warn('[opportunities] rediscovery found no markets on either venue — keeping the previous set');
    return repriceAndAssemble(_discovery!);
  }

  _discovery = disc;
  // Persist the fixture list so the next process start does not have to redo the ~15s scan.
  saveDiscovery(disc);
  // Reprice before publishing, never assemble straight off the discovery prices.
  // Discovery reads Polymarket through Gamma, whose bestBid/bestAsk is a CACHED snapshot;
  // repricing reads the live CLOB order book. On a game IN PROGRESS the two diverge
  // wildly — Gamma quoted a live Cubs/Brewers market at 0.55/0.56 while the book was
  // 0.68/0.69, a 13c error that manifested as a phantom 14% "arb" against Kalshi (which
  // agreed with the book exactly). That window was invisible while in-play games were
  // filtered out; now that they are included it would surface a fake edge on every
  // rediscovery, which is precisely what auto-execute reaches for first.
  // Costs one extra batch round-trip (~200ms) per rediscovery, i.e. once every 90s.
  return repriceAndAssemble(disc);
}

// Kick off a build the moment this module loads. In local dev the module is loaded
// once and stays warm — the build completes before you open the browser. On Vercel
// with pre-warmed instances it completes before real traffic arrives. If a real GET
// request arrives while the warm is still running, it awaits the same Promise
// instead of starting a second parallel build.
// Seed discovery from the previous run before anything else. Discovery is ~15s of paging
// that produces only fixture metadata; prices are re-fetched within 250ms either way. So a
// restart can serve real pairs almost immediately and let a fresh scan replace them in the
// background, instead of showing an empty screen for the whole scan.
function seedFromCache(): boolean {
  const cached = loadDiscovery();
  if (!cached) return false;
  _discovery = {
    pairsByCategory: cached.pairsByCategory,
    counts: cached.counts,
    totalPm: cached.totalPm,
    totalKalshi: cached.totalKalshi,
    matchedPm: cached.matchedPm as PolymarketMarketWithKind[],
    matchedKalshi: cached.matchedKalshi,
    // Mark it old so the refresh loop treats a rediscovery as immediately due.
    at: 0,
  };
  const ageMin = Math.round((Date.now() - cached.savedAt) / 60000);
  console.log(`[opportunities] seeded ${cached.matchedPm.length} pm / ${cached.matchedKalshi.length} kalshi markets from cache (${ageMin}m old) — repricing now, rediscovering in background`);
  return true;
}

let _warmupPromise: Promise<void> | null = (() => {
  const seeded = seedFromCache();
  startRefreshLoop();
  // Prime the Polymarket trading client too. Its first use derives L2 credentials over the
  // network (~560ms) and that cost would otherwise land on the first order placed — which
  // on a live in-play edge is long enough for the price to move and the trade to abort.
  // Fire-and-forget: this must never delay or break the market warm.
  void warmPolymarketTrading();
  // Seeded: a reprice publishes usable data in a few hundred ms. The loop's first tick
  // sees at: 0 and kicks off the background rediscovery.
  return (seeded ? reprice() : rebuild())
    .then(() => { /* cache populated by rebuild() */ })
    .catch(err => console.error('[opportunities] startup warm failed:', err))
    .finally(() => { _warmupPromise = null; });
})();

// Never let a browser or proxy serve a cached copy: quotes go stale in seconds, and an
// HTTP-cached response made pressing Refresh look like nothing had changed because the
// request never reached the server.
const cacheHeaders = { 'Cache-Control': 'no-store, max-age=0' };

// Send the pre-built payload: gzip when the client accepts it (~37 KB vs ~200 KB),
// otherwise the cached string. Either way there is no per-request JSON or compression
// work — the response is a buffer that was produced once when prices last refreshed.
function send(entry: CacheEntry, acceptsGzip: boolean, withPairs = true): Response {
  const gzip = withPairs ? entry.gzip : entry.slimGzip;
  const json = withPairs ? entry.json : entry.slimJson;
  if (acceptsGzip) {
    return new Response(new Uint8Array(gzip), {
      headers: { ...cacheHeaders, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' },
    });
  }
  return new Response(json, {
    headers: { ...cacheHeaders, 'Content-Type': 'application/json', 'Vary': 'Accept-Encoding' },
  });
}

export async function GET(request: Request) {
  // ?fresh=1 — used by the Refresh button. Waits for a genuinely new build so the prices
  // shown match the venues right now, and an opportunity that has evaporated disappears.
  let forceFresh = false;
  try { forceFresh = new URL(request.url).searchParams.get('fresh') === '1'; } catch { /* ignore */ }
  const acceptsGzip = /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '');
  // pairsDetail is opt-in: only the Matched Pairs tab (and the check scripts) need it.
  let withPairs = false;
  try { withPairs = new URL(request.url).searchParams.get('pairs') === '1'; } catch { /* ignore */ }

  // Only an explicit ?fresh=1 may wait on the startup warm. A cold discovery pages
  // through ~11k Gamma events and takes ~17s; blocking the first page load on it meant
  // the browser sat on a dead screen for that whole time (and often gave up with
  // a "TypeError: Failed to fetch"). A normal GET returns an empty "warming" payload
  // instantly instead — the client already polls every 800ms, so data appears the moment
  // the build lands, and the page is interactive throughout.
  if (_warmupPromise && forceFresh) await _warmupPromise;

  // Cold start, no data yet: answer immediately instead of holding the connection open
  // for the full discovery. 200 (not 503) so the client's normal render path handles it.
  // ?fresh=1 still falls through to a real build below: the Refresh button and the
  // check scripts must never be answered with an empty placeholder.
  if (!_cache && !forceFresh) {
    return NextResponse.json({
      opportunities: [],
      pairsDetail: [],
      stats: {
        pmMarkets: 0, kalshiMarkets: 0, matchedPairs: 0, byCategory: {},
        fetchedAt: new Date().toISOString(),
      },
      warming: true,
    } satisfies OpportunitiesResponse, { headers: cacheHeaders });
  }

  if (forceFresh) {
    // Already current (the loop just ticked) — answer from memory instead of paying
    // a network round-trip the user would feel.
    if (_cache && Date.now() - _cache.builtAt < REPRICE_MS) return send(_cache, acceptsGzip, withPairs);
    try {
      await reprice();
      if (_cache) return send(_cache, acceptsGzip, withPairs);
    } catch (err) {
      console.error('[opportunities] forced refresh failed:', err);
      // Serve the last good data rather than an empty screen; the age makes it obvious.
      if (_cache) return send(_cache, acceptsGzip, withPairs);
    }
  }

  // Serve from memory. The background loop keeps this within REPRICE_MS, so a request
  // never blocks on the venues; only nudge a refresh if the loop has fallen behind.
  if (_cache) {
    if (Date.now() - _cache.builtAt > CACHE_TTL_MS) {
      reprice().catch(err => console.error('[opportunities] background reprice failed:', err));
    }
    return send(_cache, acceptsGzip, withPairs);
  }

  // No cache at all (warm failed) — build now.
  try {
    await rebuild();
    if (_cache) return send(_cache, acceptsGzip, withPairs);
    throw new Error('build produced no cache entry');
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
