/**
 * Kalshi API client.
 * - API key: set EXPO_PUBLIC_KALSHI_API_KEY in Arbritage_App/.env → app.config.js extra.kalshiApiKey → sent as header KALSHI-ACCESS-KEY.
 * - Endpoint: GET {KALSHI_API_BASE}/markets?status=open&limit=100&cursor=...
 * - Response: { markets: [...], cursor? }. Each market: yes_ask_dollars (string "0.55"), no_ask_dollars (string), yes_ask/no_ask (deprecated cents).
 */
import Constants from 'expo-constants';
import type { UnifiedMarket } from '@/lib/market-types';
import { KALSHI_API_BASE } from '@/constants/config';

function getKalshiApiKey(): string | null {
  const key = Constants.expoConfig?.extra?.kalshiApiKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** Kalshi API market (subset we use) - list can use snake_case or camelCase */
interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  eventTicker?: string;
  series_ticker?: string;
  seriesTicker?: string;
  market_type?: string;
  marketType?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  yesSubTitle?: string;
  noSubTitle?: string;
  status?: string;
  yes_bid?: number;
  yes_bid_dollars?: number | string;
  yesBid?: number;
  yesBidDollars?: number | string;
  yes_ask?: number;
  yes_ask_dollars?: number | string;
  yesAsk?: number;
  yesAskDollars?: number | string;
  no_bid?: number;
  no_bid_dollars?: number | string;
  noBid?: number;
  noBidDollars?: number | string;
  no_ask?: number;
  no_ask_dollars?: number | string;
  noAsk?: number;
  noAskDollars?: number | string;
  close_time?: string;
  closeTime?: string;
  expiration_time?: string;
  latest_expiration_time?: string;
  market?: KalshiMarket;
  last_price?: number;
  last_price_dollars?: number | string;
  [key: string]: unknown;
}

interface KalshiMarketsResponse {
  markets?: KalshiMarket[];
  cursor?: string;
}

interface KalshiSeries {
  ticker?: string;
  title?: string;
  category?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface KalshiSeriesListResponse {
  series?: KalshiSeries[];
}

/** Pick first defined value from market for a set of possible keys (snake and camel). Also checks m.market if present. */
function getPrice(m: KalshiMarket, ...keys: string[]): number | string | undefined {
  const src = (m.market as Record<string, unknown> | undefined) ?? m;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== '') return v as number | string;
  }
  return undefined;
}

/**
 * Convert Kalshi price to cents. API returns:
 * - yes_ask_dollars: string "0.5500" (dollars) or "1.0000" ($1 = 100¢, no liquidity)
 * - yes_ask (deprecated): number, cents (e.g. 55)
 * Rule: string with decimal point = dollars. Number or string without decimal = cents.
 */
function kalshiPriceToCents(v: number | string | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const isDollarString = typeof v === 'string' && v.includes('.');
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  if (Number.isNaN(n)) return null;
  let cents: number;
  if (isDollarString) {
    // Dollar format: convert to cents (e.g., "0.55" -> 55)
    cents = Math.round(n * 100);
  } else if (n >= 1 && n <= 99) {
    // Legacy cents format: already in cents (e.g., 55 -> 55)
    cents = Math.round(n);
  } else {
    return null;
  }
  if (cents < 1 || cents > 99) return null;
  return cents;
}

/** In binary markets yes+no≈100. When one side is 0 or 100 (no liquidity), derive from the other. */
function deriveMissingPrice(validCents: number): number {
  const other = 100 - validCents;
  return Math.max(1, Math.min(99, other));
}

const KALSHI_PAGE_LIMIT = 100;
/** Delay between pagination requests to avoid 429 rate limit */
const KALSHI_PAGE_DELAY_MS = 300;
/** Stop after this many pages so refresh finishes in ~15–20s max */
const KALSHI_MAX_PAGES = 25;

const KALSHI_DEBUG_LOGS = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch one page of open markets from Kalshi (cursor-based pagination).
 * Retries once on 429 after a longer delay.
 */
async function fetchKalshiMarketsPage(cursor?: string | null): Promise<{
  markets: KalshiMarket[];
  nextCursor: string | null;
}> {
  return fetchKalshiMarketsPageWithParams({ cursor });
}

async function fetchKalshiMarketsPageWithParams(opts: {
  cursor?: string | null;
  seriesTicker?: string;
}): Promise<{
  markets: KalshiMarket[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  params.set('status', 'open');
  params.set('mve_filter', 'exclude');
  params.set('limit', String(KALSHI_PAGE_LIMIT));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.seriesTicker) params.set('series_ticker', opts.seriesTicker);
  const url = `${KALSHI_API_BASE}/markets?${params.toString()}`;
  const headers: Record<string, string> = {};
  const apiKey = getKalshiApiKey();
  void apiKey;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      lastError = new Error(`Kalshi API: 429 too many requests`);
      await delay(2500);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Kalshi API: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as KalshiMarketsResponse;
    const list = data.markets ?? [];
    // #region agent log
    if (KALSHI_DEBUG_LOGS && list.length > 0) {
      const raw = list[0] as Record<string, unknown>;
      const priceKeys = ['yes_ask_dollars', 'yesAskDollars', 'yes_ask', 'yesAsk', 'no_ask_dollars', 'noAskDollars', 'no_ask', 'noAsk', 'last_price_dollars', 'last_price', 'yes_bid_dollars', 'no_bid_dollars', 'yes_bid', 'no_bid'];
      const sample: Record<string, unknown> = { ticker: raw?.ticker, title: typeof raw?.title === 'string' ? raw.title.slice(0, 60) : raw?.title, topLevelKeys: Object.keys(raw || {}) };
      priceKeys.forEach((k) => { if (raw?.[k] !== undefined) sample[k] = raw[k]; });
      const payload = { sessionId: '6ebff7', location: 'kalshi.ts:fetchPage', message: 'Kalshi first market raw', data: sample, timestamp: Date.now(), hypothesisId: 'H1-H4-H5' };
      fetch('http://127.0.0.1:7864/ingest/1db4401f-b144-4aed-9aa6-5a1876b1005e', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6ebff7' }, body: JSON.stringify(payload) }).catch(() => {});
      console.log('[DEBUG Kalshi] first market raw:', JSON.stringify(sample));
    }
    // #endregion
    const binary = list.filter((m) => {
      const mt = (m as KalshiMarket).market_type ?? (m as KalshiMarket).marketType;
      // Some list responses omit market_type; treat unknown as binary.
      if (!mt) return true;
      if (mt === 'scalar' || mt === 'multivariate') return false;
      return true;
    }) as KalshiMarket[];
    const nextCursor =
      data.cursor != null && String(data.cursor).length > 0 ? String(data.cursor) : null;
    return { markets: binary, nextCursor };
  }
  throw lastError ?? new Error('Kalshi API: failed after retry');
}

/**
 * Fetch open binary markets from Kalshi (paginates with delay, capped at KALSHI_MAX_PAGES).
 */
export async function fetchKalshiMarkets(): Promise<KalshiMarket[]> {
  const all: KalshiMarket[] = [];
  let cursor: string | null = null;
  let isFirstPage = true;
  let pageCount = 0;
  do {
    if (!isFirstPage) await delay(KALSHI_PAGE_DELAY_MS);
    isFirstPage = false;
    if (pageCount >= KALSHI_MAX_PAGES) break;
    const { markets, nextCursor } = await fetchKalshiMarketsPageWithParams({ cursor });
    all.push(...markets);
    cursor = nextCursor;
    pageCount++;
  } while (cursor != null);
  return all;
}

async function fetchKalshiSeriesList(): Promise<KalshiSeries[]> {
  const url = `${KALSHI_API_BASE}/series`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kalshi API (series): ${res.status} ${await res.text()}`);
  const data = (await res.json()) as KalshiSeriesListResponse | KalshiSeries[];
  if (Array.isArray(data)) return data;
  return data.series ?? [];
}

async function fetchKalshiMarketsBySeries(seriesTicker: string): Promise<KalshiMarket[]> {
  const all: KalshiMarket[] = [];
  let cursor: string | null = null;
  let isFirstPage = true;
  let pageCount = 0;
  do {
    if (!isFirstPage) await delay(KALSHI_PAGE_DELAY_MS);
    isFirstPage = false;
    if (pageCount >= KALSHI_MAX_PAGES) break;
    const { markets, nextCursor } = await fetchKalshiMarketsPageWithParams({ cursor, seriesTicker });
    all.push(...markets);
    cursor = nextCursor;
    pageCount++;
  } while (cursor != null);
  return all;
}

export function normalizeKalshiMarketsToUnified(markets: KalshiMarket[]): UnifiedMarket[] {
  return normalizeKalshiMarkets(markets);
}

/**
 * Normalize Kalshi markets to UnifiedMarket. Reads all known price keys (snake + camel).
 * Skips markets with missing or invalid yes/no prices.
 */
export function normalizeKalshiMarkets(markets: KalshiMarket[]): UnifiedMarket[] {
  return markets
    .map((m) => {
      // Drop multivariate markets that may sneak through when market_type is missing.
      if (typeof m.ticker === 'string' && (m.ticker.includes('KXMV') || m.ticker.toLowerCase().includes('mve'))) return null;
      // API now only returns dollar fields (_dollars). Deprecated cent fields are no longer available.
      // Kalshi market data often only exposes bids due to the reciprocal relationship between YES/NO.
      // If asks are missing or are 0/1 sentinel values, derive the ask from the opposing bid.
      const yesAskDollars = getPrice(m, 'yes_ask_dollars', 'yesAskDollars');
      const noAskDollars = getPrice(m, 'no_ask_dollars', 'noAskDollars');
      const yesBidDollars = getPrice(m, 'yes_bid_dollars', 'yesBidDollars', 'yes_bid', 'yesBid');
      const noBidDollars = getPrice(m, 'no_bid_dollars', 'noBidDollars', 'no_bid', 'noBid');
      const lastPrice = getPrice(m, 'last_price_dollars', 'last_price');
      // Use dollar fields; when both asks empty (0/100), use last trade price.
      let yesCents = kalshiPriceToCents(yesAskDollars);
      let noCents = kalshiPriceToCents(noAskDollars);

      const yesBidCents = kalshiPriceToCents(yesBidDollars);
      const noBidCents = kalshiPriceToCents(noBidDollars);
      // Derive asks from opposing bids if needed
      if (yesCents == null && noBidCents != null) yesCents = deriveMissingPrice(noBidCents);
      if (noCents == null && yesBidCents != null) noCents = deriveMissingPrice(yesBidCents);
      // Fall back to last trade only if we still can't price a side.
      if (yesCents == null) yesCents = kalshiPriceToCents(lastPrice);
      // Binary markets: yes+no≈100. When one side is 0 or 100 (API returns "0.0000"/"1.0000" = no liquidity), derive from the other.
      if (yesCents != null && noCents == null) noCents = deriveMissingPrice(yesCents);
      if (noCents != null && yesCents == null) yesCents = deriveMissingPrice(noCents);
      // #region agent log
      if (KALSHI_DEBUG_LOGS && markets[0] && m.ticker === markets[0].ticker) {
        const normPayload = { sessionId: '6ebff7', location: 'kalshi.ts:normalize', message: 'Kalshi first market parsed', data: { ticker: m.ticker, yesAskDollars, noAskDollars, yesBidDollars, noBidDollars, lastPrice, finalYes: yesCents, finalNo: noCents }, timestamp: Date.now(), hypothesisId: 'H2-H4' };
        fetch('http://127.0.0.1:7864/ingest/1db4401f-b144-4aed-9aa6-5a1876b1005e', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6ebff7' }, body: JSON.stringify(normPayload) }).catch(() => {});
        console.log('[DEBUG Kalshi] first market parsed:', JSON.stringify(normPayload.data));
      }
      // #endregion
      if (yesCents == null || noCents == null || yesCents + noCents > 101) return null;
      const question = m.title ?? m.subtitle ?? m.ticker ?? '';
      const closeTime =
        m.close_time ?? m.closeTime ?? m.latest_expiration_time ?? m.expiration_time;
      const marketUrl = `https://kalshi.com/markets/${m.ticker}`;
      const out: UnifiedMarket = {
        id: `kalshi-${m.ticker}`,
        venue: 'kalshi',
        question,
        symbol: m.ticker,
        yesPriceCents: yesCents,
        noPriceCents: noCents,
        resolutionTime: closeTime,
        url: marketUrl,
        rulesDescription: undefined,
      };
      return out;
    })
    .filter((m): m is UnifiedMarket => m != null);
}

/**
 * Get all Kalshi open binary markets as unified shape (paginates automatically).
 */
export async function getKalshiMarkets(): Promise<UnifiedMarket[]> {
  const raw = await fetchKalshiMarkets();
  return normalizeKalshiMarkets(raw);
}

export async function getKalshiBasketballMarkets(): Promise<UnifiedMarket[]> {
  const series = await fetchKalshiSeriesList();
  const wantedTitleIncludes = [
    'pro basketball',
    'college basketball',
    'ncaab',
    'ncaa basketball',
  ];
  const wanted = series
    .filter((s) => {
      const title = (s.title ?? '').toLowerCase();
      return wantedTitleIncludes.some((t) => title.includes(t));
    })
    .map((s) => s.ticker)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);

  const unique = Array.from(new Set(wanted));
  if (KALSHI_DEBUG_LOGS) {
    console.log('[DEBUG Kalshi] series total:', series.length, 'basketball series matched:', unique.length);
  }
  if (unique.length === 0) return [];

  const rawLists = await Promise.all(unique.map((t) => fetchKalshiMarketsBySeries(t)));
  const raw = rawLists.flat();
  return normalizeKalshiMarkets(raw);
}

export function filterKalshiBasketballMarkets(markets: UnifiedMarket[]): UnifiedMarket[] {
  return markets.filter(isSportsMarket);
}

/**
 * Filter markets to only include sports games (NBA, NFL, MLB, etc.)
 * Excludes long-term futures and focuses on specific game matchups.
 */
function isSportsMarket(market: UnifiedMarket): boolean {
  const question = market.question.toLowerCase();
  const symbol = market.symbol?.toLowerCase() || '';

  // Restrict to NBA + College Basketball only.
  const basketballKeywords = [
    'nba',
    'pro basketball',
    'pro basketball (m)',
    'ncaab',
    'ncaa basketball',
    'college basketball',
    'college basketball (m)',
    'march madness',
  ];
  const isBasketball = basketballKeywords.some((k) => question.includes(k) || symbol.includes(k));
  if (!isBasketball) return false;

  // Exclude obvious non-game props/novelty markets.
  const propKeywords = [
    'announcer',
    'announcers',
    'commentator',
    'broadcast',
    'during the game',
    'what will',
    'what phrase',
    'say during',
    'first word',
    'mention',
    'halftime',
    'commercial',
    'postgame',
  ];
  if (propKeywords.some((k) => question.includes(k))) return false;

  // First exclude long-term futures (championships, seasons, awards)
  const futuresKeywords = [
    'championship', 'title', 'season', 'award', 'mvp', 'rookie',
    'conference', 'division', 'playoffs', 'super bowl', 'world series',
    'stanley cup', 'nba finals', 'world cup', 'premier league',
    'la liga', 'serie a', 'bundesliga', 'ligue 1', 'europa league',
    'champions league', '2025-2026', '2026-2027', '2025-26', '2026-27',
    'finals', 'final', 'the finals', 'the final', 'championships',
    'defensive player', 'sixth man', 'coach of the year', 'rookie of the year',
    'most valuable', 'player of the year', 'cy young', 'heisman', 'hart trophy',
    'art ross', 'conn smythe', 'golden boot', 'ballon d\'or', 'fifa best'
  ];

  // Exclude if it contains futures keywords
  const hasFuturesKeyword = futuresKeywords.some(keyword => question.includes(keyword) || symbol.includes(keyword));
  if (hasFuturesKeyword) {
    return false;
  }
 
  // Also reject year/season ranges even if they use en/em dashes (e.g. 2025–2026)
  const yearRangeRe = /\b20\d{2}\s*[-–—]\s*20\d{2}\b/;
  if (yearRangeRe.test(question) || yearRangeRe.test(symbol)) return false;

  // Prefer near-term markets (games), not long-duration futures.
  // If Kalshi gives a close/resolution time, use it to keep only markets closing soon.
  // Some markets may omit timestamps in list responses; don't drop everything if missing.
  const ts = market.resolutionTime ? Date.parse(market.resolutionTime) : NaN;
  if (Number.isFinite(ts)) {
    const hoursUntilClose = (ts - Date.now()) / (1000 * 60 * 60);
    // Keep markets closing within the next ~48h.
    if (hoursUntilClose < -12 || hoursUntilClose > 48) return false;
  }

  // Now that we have time-bounded markets, accept common matchup phrasing OR recognizable team names.
  const matchupIndicators = [' vs ', ' vs. ', ' versus ', ' @ ', ' against ', ' beat ', ' beats ', ' defeat ', ' defeats '];
  const hasMatchupIndicator = matchupIndicators.some((t) => question.includes(t) || symbol.includes(t));

  // For basketball, require it to look like a matchup.
  return hasMatchupIndicator;
}

/**
 * Check if the question contains common team name patterns
 */
function hasTeamNames(text: string): boolean {
  // Common team name patterns (city + mascot, or just well-known team names)
  const teamPatterns = [
    /\b(lakers|celtics|warriors|heat|bulls|spurs|mavericks|nets|knicks|76ers|bucks|suns|nuggets|clippers)\b/i,
    /\b(patriots|chiefs|bills|bengals|ravens|steelers|browns|colts|titans|texans|jaguars|dolphins|jets|raiders)\b/i,
    /\b(yankees|red sox|astros|dodgers|braves|cardinals|cubs|phillies|mets|giants|padres)\b/i,
    /\b(real madrid|barcelona|manchester|liverpool|chelsea|arsenal|bayern|psg|juventus|inter|ac milan)\b/i,
    /\b(detroit|san antonio|houston|miami|philadelphia|boston|la|new york|chicago|dallas)\b/i
  ];
  
  return teamPatterns.some(pattern => pattern.test(text));
}

/**
 * Get only sports arbitrage opportunities from Kalshi (specific games, not long futures).
 */
export async function getKalshiSportsMarkets(): Promise<UnifiedMarket[]> {
  const allMarkets = await getKalshiMarkets();
  return allMarkets.filter(isSportsMarket);
}
