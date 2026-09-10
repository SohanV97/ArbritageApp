import type { UnifiedMarket, Category } from '@/lib/market-types';
import type { PolymarketMarketKind } from '@/lib/fees';
import { isPoliticsMarket } from '@/lib/politicsFilter';
import { isSportMoneyline } from '@/lib/moneylineFilter';
import { easternDateOf } from '@/lib/gameDate';
import { askCents, noAskCents, clampCents, polymarketAskLadder, priceForSize } from '@/lib/depth';
import { MIN_ORDER_CONTRACTS } from '@/lib/market-types';
import {
  POLYMARKET_SPORT_KEYWORDS,
  POLYMARKET_POLITICS_TAG_SLUGS,
  SPORT_CATEGORY_LIST,
  isSportCategory,
} from '@/lib/categories';

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

// ─── Gamma request gate ──────────────────────────────────────────────────────
// Gamma's throughput saturates at roughly 8 concurrent requests; past that it queues and
// per-request latency grows linearly rather than the work going faster. Measured against
// one endpoint: 1 concurrent = 231ms/req, 8 = 197ms, 16 = 291ms, 32 = 611ms, 64 = 1008ms.
//
// Discovery fans out over every series AND tag id of all five categories at once — soccer
// alone has 39 ids — so ~60 requests were permanently in flight and each one paid the
// ~1s queued latency. That is why the cold start spent 31.5s inside Polymarket while
// fetching only ~11k events, most of them duplicates across overlapping ids.
//
// Holding the fan-out at the saturation point makes the same work finish far sooner.
const GAMMA_MAX_INFLIGHT = 8;
let _gammaInflight = 0;
const _gammaWaiters: Array<() => void> = [];

async function gammaFetch(url: string, init?: RequestInit): Promise<Response> {
  // Queue if full OR anyone is already waiting — otherwise a request arriving while a slot
  // is free jumps ahead of queued ones, starving whichever category fanned out last.
  if (_gammaInflight >= GAMMA_MAX_INFLIGHT || _gammaWaiters.length > 0) {
    await new Promise<void>(resolve => _gammaWaiters.push(resolve));
  }
  _gammaInflight++;
  try {
    return await fetch(url, init);
  } finally {
    _gammaInflight--;
    _gammaWaiters.shift()?.();
  }
}

function getPolymarketApiKey(): string | null {
  // EXPO_PUBLIC_ fallback: the key may still live in the OS env under the old
  // Expo app's naming convention.
  const key = process.env.POLYMARKET_API_KEY ?? process.env.EXPO_PUBLIC_POLYMARKET_API_KEY;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

function polymarketHeaders(): Record<string, string> {
  const key = getPolymarketApiKey();
  const headers: Record<string, string> = {};
  if (key) headers['POLY_API_KEY'] = key;
  return headers;
}

interface GammaMarket {
  id?: string;
  condition_id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  outcomes?: string;
  outcomePrices?: string;
  bestBid?: number | string;
  bestAsk?: number | string;
  spread?: number | string;
  liquidity?: number | string;
  liquidityClob?: number | string;
  end_date_iso?: string;
  endDateIso?: string;
  clobTokenIds?: string;
  market_slug?: string;
  groupItemTitle?: string;
  // Liveness, straight from the venue. A game in progress is still `acceptingOrders`;
  // it flips only once the market settles, which is the signal a date cannot provide.
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  gameStartTime?: string;
  [key: string]: unknown;
}

interface GammaTag {
  id?: string;
  label?: string;
  slug?: string;
  [key: string]: unknown;
}

interface GammaEvent {
  id?: string;
  title?: string;
  slug?: string;
  markets?: GammaMarket[];
  end_date_iso?: string;
  [key: string]: unknown;
}

interface GammaSportMetadata {
  sport?: string;
  tags?: string;
  series?: string;
  [key: string]: unknown;
}

// /sports and /tags are stable metadata — cache for 5 minutes to avoid re-fetching on every 55s rebuild.
const PM_META_TTL_MS = 5 * 60_000;
let _cachedSportsData: { data: GammaSportMetadata[]; ts: number } | null = null;
let _cachedTags: { data: GammaTag[]; ts: number } | null = null;

async function fetchSportsMetadata(): Promise<GammaSportMetadata[]> {
  if (_cachedSportsData && Date.now() - _cachedSportsData.ts < PM_META_TTL_MS) return _cachedSportsData.data;
  try {
    const res = await gammaFetch(`${POLYMARKET_GAMMA_API}/sports`, { headers: polymarketHeaders() });
    if (res.ok) {
      const data = await res.json() as GammaSportMetadata[];
      _cachedSportsData = { data: Array.isArray(data) ? data : [], ts: Date.now() };
      return _cachedSportsData.data;
    }
  } catch { /* ok */ }
  return _cachedSportsData?.data ?? [];
}

async function fetchAllTags(): Promise<GammaTag[]> {
  if (_cachedTags && Date.now() - _cachedTags.ts < PM_META_TTL_MS) return _cachedTags.data;
  try {
    const res = await gammaFetch(`${POLYMARKET_GAMMA_API}/tags`, { headers: polymarketHeaders() });
    if (res.ok) {
      const data = await res.json() as GammaTag[];
      _cachedTags = { data: Array.isArray(data) ? data : [], ts: Date.now() };
      return _cachedTags.data;
    }
  } catch { /* ok */ }
  return _cachedTags?.data ?? [];
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

// Executable prices from the CLOB book: buying YES (outcome[0]) fills at bestAsk;
// buying NO (outcome[1]) fills at 1 − bestBid. outcomePrices is last-trade/mid —
// quoting it makes arbs appear that can't actually be filled at those prices.
// Round UP: a BUY limit rounded down could sit below the true ask and never fill,
// and a lower price would understate cost and OVERSTATE edge. Ceil is conservative
// on both counts.
function parseBookPrices(m: GammaMarket): { yes: number; no: number } | null {
  const bid = toNum(m.bestBid);
  const ask = toNum(m.bestAsk);
  if (bid === null || ask === null) return null;
  if (bid <= 0 || ask <= 0 || bid >= 1 || ask >= 1 || ask < bid) return null;
  return {
    yes: clampCents(askCents(ask)),
    no: clampCents(noAskCents(bid)),
  };
}

// ─── fast price refresh ──────────────────────────────────────────────────────
// The CLOB serves whole order books in bulk: POST /books with N token ids returns N
// books in ~150 ms, versus ~1 s to re-walk every event page. Prices are derived
// exactly as parseBookPrices does (buy YES at the best ask, buy NO at 1 − best bid,
// rounded up so cost is never understated). Mutates markets in place; a market whose
// book can't be read keeps its previous price rather than being zeroed.
const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';
const PM_BOOK_BATCH = 100;

export interface ClobBook {
  asset_id?: string;
  // `size` is contracts resting at that price. The price path ignores it, but sizing needs
  // it: how much of a hedged pair is fillable depends on the whole ladder, not the top.
  bids?: { price?: string; size?: string }[];
  asks?: { price?: string; size?: string }[];
}

const bestPrice = (side: 'ask' | 'bid', levels: { price?: string }[] | undefined): number | null => {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const prices = levels.map(l => parseFloat(l.price ?? '')).filter(Number.isFinite);
  if (prices.length === 0) return null;
  return side === 'ask' ? Math.min(...prices) : Math.max(...prices);
};

/**
 * Price a book at the level where a tradeable order can actually be filled.
 *
 * Taking the raw best price ignores how much is resting there. A top-of-book level holding
 * fewer contracts than the venue minimum is not a price anyone can trade at, and quoting it
 * manufactures an edge that vanishes at execution — the same failure Kalshi's 0.01-contract
 * dust caused, and present on about 1% of Polymarket sports books. Walking to where
 * MIN_ORDER_CONTRACTS is cumulatively available gives a price that can be filled, and
 * matches how the execute path sizes and prices the order.
 */
function tradeableBookPrices(b: ClobBook): { yes: number; no: number } | null {
  const yes = priceForSize(polymarketAskLadder(b, 'yes'), MIN_ORDER_CONTRACTS);
  const no = priceForSize(polymarketAskLadder(b, 'no'), MIN_ORDER_CONTRACTS);
  if (yes === null || no === null) return null;
  return { yes: clampCents(yes), no: clampCents(no) };
}

// Single-market live quote for the pre-order price re-check. Always pass the YES token
// (outcome[0]) — both sides are derived from that one book, exactly as the pipeline does.
export async function getPolymarketQuote(yesTokenId: string): Promise<{ yes: number; no: number } | null> {
  if (!yesTokenId) return null;
  try {
    const res = await fetch(`${POLYMARKET_CLOB_API}/books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ token_id: yesTokenId }]),
    });
    if (!res.ok) return null;
    const books = (await res.json()) as ClobBook[];
    const b = (Array.isArray(books) ? books : [])[0];
    if (!b) return null;
    const ask = bestPrice('ask', b.asks);
    const bid = bestPrice('bid', b.bids);
    if (ask === null || bid === null) return null;
    if (bid <= 0 || ask <= 0 || bid >= 1 || ask >= 1 || ask < bid) return null;
    return tradeableBookPrices(b);
  } catch {
    return null;
  }
}

// Whole books for sizing. The price path already fetches these and keeps only the best
// level; depth needs every level, because the fillable size of a hedged pair is set by
// whichever venue runs out first, not by Kalshi's top of book. One request covers many
// tokens, and both sides of a pair come from the YES token's book (asks = buy YES,
// bids mirrored = buy NO), so no second fetch is needed.
export async function getPolymarketBooks(tokenIds: string[]): Promise<Map<string, ClobBook>> {
  const out = new Map<string, ClobBook>();
  const ids = tokenIds.filter(Boolean);
  if (ids.length === 0) return out;
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += PM_BOOK_BATCH) batches.push(ids.slice(i, i + PM_BOOK_BATCH));
  await Promise.all(batches.map(async (chunk) => {
    try {
      const res = await fetch(`${POLYMARKET_CLOB_API}/books`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(token_id => ({ token_id }))),
      });
      if (!res.ok) return;
      const books = (await res.json()) as ClobBook[];
      for (const b of Array.isArray(books) ? books : []) {
        if (b?.asset_id) out.set(b.asset_id, b);
      }
    } catch { /* a book we cannot read simply has no depth data */ }
  }));
  return out;
}

export async function refreshPolymarketPrices(markets: PolymarketMarketWithKind[]): Promise<number> {
  const byToken = new Map<string, PolymarketMarketWithKind[]>();
  for (const m of markets) {
    if (!m.yesTokenId) continue;
    const list = byToken.get(m.yesTokenId) ?? [];
    list.push(m);
    byToken.set(m.yesTokenId, list);
  }
  const tokens = [...byToken.keys()];
  if (tokens.length === 0) return 0;

  const batches: string[][] = [];
  for (let i = 0; i < tokens.length; i += PM_BOOK_BATCH) batches.push(tokens.slice(i, i + PM_BOOK_BATCH));

  let updated = 0;
  await Promise.all(batches.map(async (chunk) => {
    try {
      const res = await fetch(`${POLYMARKET_CLOB_API}/books`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(token_id => ({ token_id }))),
      });
      if (!res.ok) return;
      const books = (await res.json()) as ClobBook[];
      for (const b of Array.isArray(books) ? books : []) {
        const targets = b.asset_id ? byToken.get(b.asset_id) : undefined;
        if (!targets) continue;
        const ask = bestPrice('ask', b.asks);
        const bid = bestPrice('bid', b.bids);
        if (ask === null || bid === null) continue;
        if (bid <= 0 || ask <= 0 || bid >= 1 || ask >= 1 || ask < bid) continue;
        const priced = tradeableBookPrices(b);
        if (!priced) continue;   // nothing fillable at the minimum size — keep last good prices
        for (const t of targets) { t.yesPriceCents = priced.yes; t.noPriceCents = priced.no; }
        updated++;
      }
    } catch { /* keep last good prices */ }
  }));
  return updated;
}

export interface PolymarketMarketWithKind extends UnifiedMarket {
  polymarketFeeKind: PolymarketMarketKind;
  yesTokenId?: string;
  noTokenId?: string;
}

// For sports markets, PM's end_date_iso is the event/series settlement date (often
// 7 days later), not the actual game date. Extract the real game date from the
// market slug, which encodes the date in the URL.
// Handles: "...jul-2-2026", "...july-02", "...2026-07-02", "...0702" (mmdd), etc.
const SLUG_MONTH: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

// When a slug carries a month/day but no year, infer it from today rather than
// hardcoding one: a fixed year silently mis-dates every such market once the calendar
// rolls over, and since sports matching requires the same game date, those games would
// quietly stop matching. Pick the current year, rolling forward when that would place
// the date far in the past (a "jan-03" slug seen in December means next January).
function inferYearFor(month: string, day: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const candidate = Date.parse(`${y}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(candidate)) return String(y);
  const daysAgo = (now.getTime() - candidate) / 86_400_000;
  if (daysAgo > 180) return String(y + 1);   // e.g. "jan-03" seen in December
  if (daysAgo < -180) return String(y - 1);  // e.g. "dec-28" seen in January
  return String(y);
}

function extractDateFromSlug(slug: string): string | null {
  if (!slug) return null;
  // ISO date anywhere in slug: 2026-07-02
  const iso = slug.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // "jul-2-2026" or "jul-02-2026" or "july-2" (no year → inferred from today)
  const m = slug.match(/-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*-(\d{1,2})(?:-(\d{4}))?/i);
  if (m) {
    const month = SLUG_MONTH[m[1].toLowerCase().slice(0, 3)];
    if (month) {
      const day = m[2].padStart(2, '0');
      const year = m[3] ?? inferYearFor(month, day);
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}

// Soccer (and some MLB) markets are phrased "Will <Team> win on <date>?" with plain
// Yes/No outcomes, so the winning team never appears in `outcomes` — leaving yesTeam
// unset and forcing YES/NO alignment to fall back to price proximity, which inverts
// precisely when the venues disagree (i.e. when there's an arb). Recover the team
// from the question text and the "A vs. B" event title so alignment stays identity-based.
function extractYesNoTeams(eventTitle: string, question: string): { yes?: string; no?: string } {
  const m = question.match(/\bwill\s+(.+?)\s+win\b/i);
  if (!m) return {};
  const team = m[1].trim();
  const parts = eventTitle.split(/\s+vs\.?\s+/i).map(s => s.trim()).filter(Boolean);
  if (parts.length === 2) {
    const [a, b] = parts;
    const la = a.toLowerCase(), lb = b.toLowerCase(), lt = team.toLowerCase();
    if (la.includes(lt) || lt.includes(la)) return { yes: a, no: b };
    if (lb.includes(lt) || lt.includes(lb)) return { yes: b, no: a };
  }
  return { yes: team };
}

function normalizeEvents(
  events: GammaEvent[],
  category: Category,
  feeKind: PolymarketMarketKind
): PolymarketMarketWithKind[] {
  const isSport = isSportCategory(category);
  const out: PolymarketMarketWithKind[] = [];
  for (const event of events) {
    const markets = event.markets ?? [];
    const eventTitle = (event.title ?? '').trim(); // PM titles can carry trailing spaces
    // Only a real slug addresses a page — event.id is a numeric id and would 404, so it
    // must never outrank the market slug when choosing the link below.
    const eventSlug = typeof event.slug === 'string' ? event.slug : '';
    const eventIdFallback = typeof event.id === 'string' ? event.id : '';
    const endDate = event.end_date_iso;

    for (const m of markets) {
      let outcomesArr: string[] = [];
      try { outcomesArr = JSON.parse(m.outcomes ?? '["Yes","No"]'); } catch { outcomesArr = ['Yes', 'No']; }
      if (outcomesArr.length !== 2) continue;

      // Executable book prices only. A market with no live two-sided book cannot be
      // bought at a known price, so skip it rather than fall back to a non-executable
      // mid/last-trade price that would surface phantom arbs.
      const prices = parseBookPrices(m);
      if (!prices) continue;
      const { yes, no } = prices;
      const rawQuestion = m.question ?? m.groupItemTitle ?? '';
      let question = rawQuestion.toLowerCase().includes(eventTitle.toLowerCase()) ? rawQuestion : `${eventTitle}: ${rawQuestion}`;
      const isYesNo = outcomesArr[0].toLowerCase() === 'yes' || outcomesArr[1].toLowerCase() === 'no';
      if (!isYesNo) question = `${question} [${outcomesArr[0]} vs ${outcomesArr[1]}]`;
      // "Will <Team> win?" markets carry the team only in the text — recover it so
      // YES/NO alignment is identity-based rather than price-based.
      const ynTeams = (isSport && isYesNo) ? extractYesNoTeams(eventTitle, rawQuestion) : {};

      const slug = m.slug ?? m.market_slug ?? m.condition_id ?? m.conditionId ?? m.id ?? '';
      const conditionId = m.condition_id ?? m.conditionId ?? m.id ?? '';

      // For sports: the game date, which is the key both venues must agree on to pair a
      // fixture. Prefer gameStartTime over the slug — Polymarket is not self-consistent
      // about which timezone the slug encodes, and Kalshi always uses the US Eastern date:
      //   NFL  "nfl-ne-sea-2026-09-10"  kicks off 00:20 UTC -> Eastern date 09-09,
      //                                 which is what Kalshi's ticker says (26SEP09).
      //   MLB  "mlb-cin-lad-2026-09-08" starts 02:10 UTC the 9th -> Eastern 09-08,
      //                                 and the slug already says 09-08.
      // So NFL slugs are UTC while MLB slugs are Eastern. Every NFL prime-time game
      // (Thursday/Sunday/Monday night) therefore looked like a different day on each venue
      // and could not be paired: 7 of 32 games this week, all of them night games.
      // Converting the real kick-off timestamp to Eastern makes both venues agree without
      // loosening the same-day rule — which must stay strict, because MLB plays the same
      // opponent on consecutive days and a +/-1 day tolerance would cross-match a series.
      const startDate = isSport ? easternDateOf(m.gameStartTime) : null;
      const slugDate = startDate ?? (isSport ? extractDateFromSlug(m.slug ?? m.market_slug ?? '') : null);
      const resolutionTime = slugDate
        ? `${slugDate}T23:59:00Z`
        : (m.end_date_iso ?? m.endDateIso ?? endDate);

      let yesTokenId: string | undefined;
      let noTokenId: string | undefined;
      try {
        if (typeof m.clobTokenIds === 'string') {
          const ids = JSON.parse(m.clobTokenIds) as string[];
          yesTokenId = ids[0];
          noTokenId = ids[1];
        }
      } catch { /* ok */ }

      // Build the /event/ deep-link. Polymarket pages are addressed ONLY by event slug,
      // so always use it. A market slug is a different namespace and generally 404s:
      //   soccer   market "mls-atl-clt-2026-08-29-clt" (one market per team)  -> no page
      //   politics market "will-the-republicans-win-…"                        -> no page
      //   MLB      market slug happens to EQUAL the event slug, which is the only
      //            reason using it ever appeared to work.
      // Verified against Gamma: event slugs resolved 12/12, market slugs 0/12.
      // Fall back to the market slug only if an event slug is genuinely absent.
      const marketSlug = m.slug ?? m.market_slug ?? '';
      const urlSlug = eventSlug || marketSlug || eventIdFallback;
      out.push({
        id: `pm-${conditionId || slug}`,
        venue: 'polymarket',
        question,
        yesPriceCents: yes,
        noPriceCents: no,
        resolutionTime,
        // Without any slug there is no addressable page — send the user to the market
        // list rather than a URL that is guaranteed to 404.
        url: urlSlug ? `https://polymarket.com/event/${urlSlug}` : 'https://polymarket.com/markets',
        polymarketFeeKind: feeKind,
        yesTokenId,
        noTokenId,
        category,
        // Team-outcome moneylines: YES pays on outcomes[0], NO on outcomes[1].
        // Yes/No-phrased markets ("Will <Team> win?"): recover the team from the text.
        yesTeam: !isSport ? undefined : (!isYesNo ? outcomesArr[0] : ynTeams.yes),
        noTeam: !isSport ? undefined : (!isYesNo ? outcomesArr[1] : ynTeams.no),
        spreadCents: (() => { const s = toNum(m.spread); return s !== null ? Math.round(s * 100) : undefined; })(),
        liquidityUsd: toNum(m.liquidityClob ?? m.liquidity) ?? undefined,
        // Gamma's own liveness flags. These are what distinguishes a game that is
        // mid-innings from one that has finished — the game date cannot, because a game
        // runs for hours past the date in its slug.
        tradeable: !(m.closed === true) && m.active !== false && m.acceptingOrders !== false,
      });
    }
  }
  return out;
}

// ─── sport moneyline filter ──────────────────────────────────────────────────



// ─── event fetching helpers ──────────────────────────────────────────────────

// Gamma silently caps page size at 100 however large a `limit` you ask for. Asking for
// 200 therefore returned 100, the "short page means last page" check fired immediately,
// and pagination stopped after ONE page. Because Gamma also returns events oldest-first,
// that single page was mostly games already played: of 223 college-football events only
// 11 upcoming ones were ever seen (134 exist), and of 269 MLB events only 61 of 229.
// The limit must match the real cap for the short-page check to mean anything.
const GAMMA_PAGE_LIMIT = 100;

// Gamma returns events OLDEST-first by default. Combined with a page cap that means the
// cap truncates exactly the wrong end: for a tag holding 2000+ events we kept the oldest
// 1200 and threw away the upcoming games — the only ones tradeable. Ordering newest-first
// puts the games we want on page 0 and turns the cap into a harmless floor.
//
// It also lets paging stop as soon as a page holds nothing inside the window we trade,
// instead of walking an entire season every rediscovery.
const GAMMA_ORDER = '&order=startDate&ascending=false';

// Games worth keeping: anything from yesterday onward. Yesterday (not today) because a
// late game started on one UTC date runs into the next, and it is still live.
function gammaEventInWindow(e: GammaEvent): boolean {
  const m = (e.slug ?? '').match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return true;   // no date in the slug (politics, futures) — never page past it
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return m[1] >= yesterday;
}

// Stop after this many consecutive pages with nothing in the window. One page of slack
// absorbs the fact that startDate (when the market opened) only loosely tracks game date.
const GAMMA_DRY_PAGES = 2;

async function pageGamma(
  buildUrl: (offset: number) => string,
  maxPages: number,
  earlyStop = true,
): Promise<GammaEvent[]> {
  const limit = GAMMA_PAGE_LIMIT;
  const events: GammaEvent[] = [];
  let offset = 0;
  let dry = 0;
  for (let page = 0; page < maxPages; page++) {
    try {
      const res = await gammaFetch(buildUrl(offset), { headers: polymarketHeaders() });
      if (!res.ok) break;
      const pageEvents = await res.json() as GammaEvent[];
      if (!Array.isArray(pageEvents) || pageEvents.length === 0) break;
      events.push(...pageEvents);
      if (earlyStop) {
        dry = pageEvents.some(gammaEventInWindow) ? 0 : dry + 1;
        if (dry >= GAMMA_DRY_PAGES) break;
      }
      if (pageEvents.length < limit) break;
      offset += limit;
    } catch { break; }
  }
  return events;
}

async function fetchEventsByIds(
  idParam: string,
  ids: Set<string>,
  maxPages = 12
): Promise<GammaEvent[]> {
  // Fetch all IDs in parallel; the Gamma gate holds the real fan-out at the saturation point.
  const perIdResults = await Promise.all([...ids].map(id =>
    pageGamma(
      offset => `${POLYMARKET_GAMMA_API}/events?${idParam}=${encodeURIComponent(id)}&active=true&closed=false&limit=${GAMMA_PAGE_LIMIT}&offset=${offset}${GAMMA_ORDER}`,
      maxPages,
    )
  ));
  return perIdResults.flat();
}

// Fetch events by tag slug with pagination. Politics senate/control events live
// deep in the politics tag (well past the first 100), so the old
// `category=politics&limit=100` call never reached them — it only saw the noisy
// top of the feed (Kraken IPO, celebrity markets, foreign elections).
async function fetchEventsByTagSlug(slug: string, maxPages = 12): Promise<GammaEvent[]> {
  // NO newest-first ordering here. Politics markets carry no game date and are long-lived:
  // the 2026 Senate races opened months ago, so ordering by startDate descending pushed them
  // past the page cap and cut the usable politics set from 72 markets to 25. Sports need the
  // recency ordering; politics needs the opposite, so it keeps the original walk.
  return pageGamma(
    offset => `${POLYMARKET_GAMMA_API}/events?tag_slug=${encodeURIComponent(slug)}&active=true&closed=false&limit=${GAMMA_PAGE_LIMIT}&offset=${offset}`,
    maxPages,
    false,
  );
}

function dedupeEvents(events: GammaEvent[]): GammaEvent[] {
  const seen = new Set<string>();
  return events.filter(e => {
    const key = e.id ?? e.slug;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── main export ─────────────────────────────────────────────────────────────

export async function getPolymarketMarketsForAllCategories(): Promise<Map<Category, PolymarketMarketWithKind[]>> {
  const result = new Map<Category, PolymarketMarketWithKind[]>();

  // Use cached metadata (5-min TTL) — avoids re-fetching on every 55s rebuild.
  const [sportsData, allTags] = await Promise.all([fetchSportsMetadata(), fetchAllTags()]);

  // ── Sports + Politics in parallel ────────────────────────────────────────
  // Sports and politics both need allTags (already fetched), so run them concurrently.
  const sportCategories: Category[] = SPORT_CATEGORY_LIST;

  await Promise.all([
    // Sports: MLB + soccer in parallel, capped at 5 pages each
    Promise.all(sportCategories.map(async (cat) => {
    const keywords = POLYMARKET_SPORT_KEYWORDS[cat] ?? [];
    const seriesIds = new Set<string>();
    const tagIds = new Set<string>();

    // Match sport metadata — compare both the raw keyword and its space-normalized form
    for (const s of sportsData) {
      const name = (s.sport ?? '').toLowerCase();
      if (keywords.some(kw => name.includes(kw) || name.includes(kw.replace(/-/g, ' ')))) {
        if (s.series) s.series.split(',').forEach(id => { const t = id.trim(); if (t) seriesIds.add(t); });
        if (s.tags) s.tags.split(',').forEach(t => { const tr = t.trim(); if (tr) tagIds.add(tr); });
      }
    }

    // Match tags by slug — normalize spaces to hyphens to match Polymarket's slug format
    for (const tag of allTags) {
      const slug = (tag.slug ?? '').toLowerCase();
      if (keywords.some(kw => {
        const kwSlug = kw.replace(/\s+/g, '-');
        return slug === kwSlug || slug.startsWith(kwSlug + '-') || slug.includes('-' + kwSlug);
      })) {
        if (tag.id) tagIds.add(tag.id);
      }
    }

    // Page all the way through. Gamma orders events oldest-first, so stopping early
    // discards precisely the upcoming games we need — a season's series runs to a few
    // hundred events (MLB ~269, CFB ~223), and paging stops on its own at a short page.
    const allEvents: GammaEvent[] = [];
    const [bySeriesEvents, byTagEvents] = await Promise.all([
      seriesIds.size > 0 ? fetchEventsByIds('series_id', seriesIds) : Promise.resolve([]),
      tagIds.size > 0 ? fetchEventsByIds('tag_id', tagIds) : Promise.resolve([]),
    ]);
    allEvents.push(...bySeriesEvents, ...byTagEvents);

    const deduped = dedupeEvents(allEvents);
    console.log(`[Polymarket] ${cat}: ${deduped.length} events`);

    const normalized = normalizeEvents(deduped, cat, 'sports');
    const filtered = normalized.filter(m => isSportMoneyline(m, cat));
    console.log(`[Polymarket] ${cat}: ${filtered.length} moneyline markets`);
    result.set(cat, filtered);
  })),

    // Politics: runs in parallel with sports
    (async () => {
      // Paginate the politics/elections tag slugs — this is the only method that
      // reaches the individual Senate-race events (e.g. "Georgia Senate Election
      // Winner"), which sit far past the first page of the politics feed.
      const slugResults = await Promise.all(
        POLYMARKET_POLITICS_TAG_SLUGS.map(slug => fetchEventsByTagSlug(slug))
      );
      const dedupedPol = dedupeEvents(slugResults.flat());
      console.log(`[Polymarket] politics: ${dedupedPol.length} events`);

      const normalizedPol = normalizeEvents(dedupedPol, 'politics', 'fee_free');
      const filteredPol = normalizedPol.filter(isPoliticsMarket);
      console.log(`[Polymarket] politics: ${filteredPol.length} markets`);
      result.set('politics', filteredPol);
    })(),
  ]);

  return result;
}
