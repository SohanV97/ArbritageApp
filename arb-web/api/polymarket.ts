import type { UnifiedMarket, Category } from '@/lib/market-types';
import type { PolymarketMarketKind } from '@/lib/fees';
import {
  POLYMARKET_SPORT_KEYWORDS,
  POLYMARKET_POLITICS_TAG_SLUGS,
} from '@/lib/categories';

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

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
    const res = await fetch(`${POLYMARKET_GAMMA_API}/sports`, { headers: polymarketHeaders() });
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
    const res = await fetch(`${POLYMARKET_GAMMA_API}/tags`, { headers: polymarketHeaders() });
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
    yes: Math.max(1, Math.min(99, Math.ceil(ask * 100))),
    no: Math.max(1, Math.min(99, Math.ceil((1 - bid) * 100))),
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

interface ClobBook {
  asset_id?: string;
  bids?: { price?: string }[];
  asks?: { price?: string }[];
}

const bestPrice = (side: 'ask' | 'bid', levels: { price?: string }[] | undefined): number | null => {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const prices = levels.map(l => parseFloat(l.price ?? '')).filter(Number.isFinite);
  if (prices.length === 0) return null;
  return side === 'ask' ? Math.min(...prices) : Math.max(...prices);
};

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
        const yes = Math.max(1, Math.min(99, Math.ceil(ask * 100)));
        const no = Math.max(1, Math.min(99, Math.ceil((1 - bid) * 100)));
        for (const t of targets) { t.yesPriceCents = yes; t.noPriceCents = no; }
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
  const isSport = category === 'mlb' || category === 'soccer';
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

      // For sports: extract game date from slug (more reliable than end_date_iso,
      // which PM sets to the series/event settlement date, not the game date).
      const slugDate = isSport ? extractDateFromSlug(m.slug ?? m.market_slug ?? '') : null;
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
      });
    }
  }
  return out;
}

// ─── sport moneyline filter ──────────────────────────────────────────────────

const SPORT_JUNK: Record<string, string[]> = {
  mlb: ['nhl', 'hockey', 'nba', 'basketball', 'nfl', 'soccer', 'football'],
  soccer: ['mlb', 'baseball', 'nhl', 'hockey', 'nba', 'basketball', 'nfl'],
};

const COMMON_SPORT_JUNK = [
  'championship', 'award', 'mvp', 'rookie', 'draft', 'most valuable',
  'division winner', 'pennant', 'wild card', 'make the playoffs', 'series winner',
  'margin', 'stats', 'will be traded', 'trade destination',
  // Esports / gaming — these appear in PM's "sports" feed but Kalshi doesn't cover them
  'valorant', 'vct', 'vcl', 'esports', 'e-sports', 'gaming',
  'map 1', 'map 2', 'map 3', 'map 4', 'map 5', 'bo1', 'bo3', 'bo5',
  'league of legends', 'counter-strike', 'cs:go', 'dota', 'overwatch',
  'mobile legends', 'bang bang', 'mlbb', 'mid season cup',
  // Prop-bet markets about commentary / broadcasting — not the same as match winner
  'announcer', 'commentator', 'broadcast',
];

// Sport-specific additional junk on top of COMMON_SPORT_JUNK
const SPORT_EXTRA_JUNK: Record<string, string[]> = {
  mlb: ['strikeout', 'home run', 'batting', 'earned run', 'hits allowed', 'run line', 'inning', 'draw', 'tie', ' fc', 'fc '],
  soccer: [
    // Prop bets and non-moneyline markets — Kalshi only has game-level moneylines
    'score', 'goal', 'assist', 'save', 'shot',
    'qualify', 'advance', 'group stage', 'knockout',
    'player', 'player prop',
    'clean sheet', 'penalty kick', 'penalty shootout', 'corner', 'free kick', 'foul', 'offside',
    'both teams', 'first half', 'second half', 'halftime', 'half time',
    'golden boot', 'top scorer', 'red card', 'yellow card', 'offsides',
    // Time/outcome prop markets — NOT the same as a match winner market
    'extra time', 'overtime', 'over time',
    'draw', 'tie',
    // Polymarket "More Markets" sub-events contain props like extra time, draw, etc.
    // The event title is prefixed with "- More Markets:" so blocking this catches them all.
    'more markets',
  ],
};

function isSportMoneyline(market: PolymarketMarketWithKind, cat: Category): boolean {
  const q = market.question.toLowerCase();
  // ' at ' excluded — too ambiguous ("score at least", "win at home"); ' @ ' covers venue format
  if (![' vs ', ' vs. ', ' versus ', ' @ '].some(t => q.includes(t))) return false;
  const junk = [...COMMON_SPORT_JUNK, ...(SPORT_JUNK[cat] ?? []), ...(SPORT_EXTRA_JUNK[cat] ?? [])];
  if (junk.some(word => q.includes(word))) return false;
  if (['spread', 'over/under', 'o/u', 'cover', 'total', 'nrfi', 'run line'].some(word => q.includes(word))) return false;
  if (/(?:\s|^)[+-]\d+(\.\d+)?(?:\s|$)/.test(q)) return false;
  // Exact score patterns like "Switzerland 0 - 3 Canada" or "2-1"
  // Strip ISO dates first so "2026-06-23" (which contains "06-23") isn't a false hit
  if (/\b\d+\s*-\s*\d+\b/.test(q.replace(/\d{4}-\d{2}-\d{2}/g, ''))) return false;
  if (market.resolutionTime && Date.parse(market.resolutionTime) < Date.now()) return false;
  return true;
}

// States with 2026 Senate races that Kalshi lists (mirrors CATEGORY_SERIES in kalshi.ts).
const KALSHI_SENATE_STATES = [
  'texas', 'iowa', 'alaska', 'georgia', 'michigan', 'wisconsin',
  'montana', 'maine', 'new jersey', 'new hampshire', 'colorado',
  'new mexico', 'north carolina', 'oregon', 'illinois', 'maryland',
  'virginia', 'nevada', 'delaware', 'louisiana', 'alabama',
  'arkansas', 'idaho', 'kansas', 'minnesota', 'south carolina',
  'massachusetts', 'rhode island', 'west virginia', 'oklahoma',
  'tennessee', 'mississippi', 'nebraska',
];

// Kalshi politics coverage is narrow: individual 2026 Senate races + Senate/House control.
// Filtering PM down to the same slice prevents false matches with approval ratings,
// Supreme Court picks, policy bills, foreign elections, and other things Kalshi ignores.
function isPoliticsMarket(market: PolymarketMarketWithKind): boolean {
  if (market.resolutionTime && Date.parse(market.resolutionTime) < Date.now()) return false;
  const q = market.question.toLowerCase();

  // Kalshi has no primaries, runoffs, caucuses, or governor races
  if (/\bprimary\b|\bprimaries\b|\brunoff\b|\bcaucus\b|\bgovernor\b|\bgov\b/.test(q)) return false;

  // Drop Polymarket's placeholder candidate/party slots ("Person A", "Party B",
  // "a candidate not listed above", "another party") — they have no real prices.
  if (/\b(person|party|candidate)\s+[a-l]\b/.test(q)) return false;
  if (/not listed|another party|other party/.test(q)) return false;

  // Compound / derivative markets that LOOK like control markets but resolve on a
  // different event: trifecta, supermajority, "all core four races", seat counts,
  // "lose a seat", "before the midterms" timing markets, House+Senate combos.
  if (/\btrifecta\b|\bsupermajority\b|\bcore four\b|\bhow many\b|\bincumbent|\bsweep\b|\bswept\b|\blose\b|\bflip\b|\bbefore the midterm/.test(q)) return false;
  if (/\bhouse\b/.test(q) && /\bsenate\b/.test(q)) return false;

  // Must name a real party so the structured matcher can align it.
  const hasParty = /\b(republican|republicans|democrat|democrats|democratic)\b/.test(q);
  if (!hasParty) return false;

  const hasSenate = /\bsenate\b|\bsenator\b/.test(q);
  const hasControl = /\bcontrol\b|\bmajority\b/.test(q);

  // Senate race in a state Kalshi covers
  if (hasSenate && KALSHI_SENATE_STATES.some(s => q.includes(s))) return true;

  // "Which party controls / wins the Senate / House / Congress?"
  if ((hasControl || hasSenate) && /\b(senate|house|congress)\b/.test(q)) return true;

  return false;
}

// ─── event fetching helpers ──────────────────────────────────────────────────

async function fetchEventsByIds(
  idParam: string,
  ids: Set<string>,
  maxPages = 3
): Promise<GammaEvent[]> {
  const limit = 200;
  // Fetch all IDs in parallel (was sequential — with 10+ tag IDs this saved several seconds).
  const perIdResults = await Promise.all([...ids].map(async (id) => {
    const events: GammaEvent[] = [];
    let offset = 0;
    let pagesFetched = 0;
    while (pagesFetched < maxPages) {
      try {
        const url = `${POLYMARKET_GAMMA_API}/events?${idParam}=${encodeURIComponent(id)}&active=true&closed=false&limit=${limit}&offset=${offset}`;
        const res = await fetch(url, { headers: polymarketHeaders() });
        if (!res.ok) break;
        const page = await res.json() as GammaEvent[];
        if (!Array.isArray(page) || page.length === 0) break;
        events.push(...page);
        pagesFetched++;
        if (page.length < limit) break;
        offset += limit;
      } catch { break; }
    }
    return events;
  }));
  return perIdResults.flat();
}

// Fetch events by tag slug with pagination. Politics senate/control events live
// deep in the politics tag (well past the first 100), so the old
// `category=politics&limit=100` call never reached them — it only saw the noisy
// top of the feed (Kraken IPO, celebrity markets, foreign elections).
async function fetchEventsByTagSlug(slug: string, maxPages = 12): Promise<GammaEvent[]> {
  const limit = 200;
  const events: GammaEvent[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    try {
      const url = `${POLYMARKET_GAMMA_API}/events?tag_slug=${encodeURIComponent(slug)}&active=true&closed=false&limit=${limit}&offset=${offset}`;
      const res = await fetch(url, { headers: polymarketHeaders() });
      if (!res.ok) break;
      const pageEvents = await res.json() as GammaEvent[];
      if (!Array.isArray(pageEvents) || pageEvents.length === 0) break;
      events.push(...pageEvents);
      if (pageEvents.length < limit) break;
      offset += limit;
    } catch { break; }
  }
  return events;
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
  const sportCategories: Category[] = ['mlb', 'soccer'];

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

    // 3 pages × 200/page = 600 events; covers 15+ days of upcoming games.
    const allEvents: GammaEvent[] = [];
    const [bySeriesEvents, byTagEvents] = await Promise.all([
      seriesIds.size > 0 ? fetchEventsByIds('series_id', seriesIds, 3) : Promise.resolve([]),
      tagIds.size > 0 ? fetchEventsByIds('tag_id', tagIds, 3) : Promise.resolve([]),
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
