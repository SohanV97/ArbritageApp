/**
 * Kalshi API client.
 * - API key: set EXPO_PUBLIC_KALSHI_API_KEY in Arbritage_App/.env → app.config.js extra.kalshiApiKey → sent as header KALSHI-ACCESS-KEY.
 * - Endpoint: GET {KALSHI_API_BASE}/markets?status=open&limit=100&cursor=...
 * - Response: { markets: [...], cursor? }. Each market: yes_ask_dollars (string "0.55"), no_ask_dollars (string), yes_ask/no_ask (deprecated cents).
 */
import Constants from 'expo-constants';
import type { UnifiedMarket } from '@/lib/market-types';
import { KALSHI_API_BASE } from '@/constants/config';

// ==========================================
// CONFIG & TYPES
// ==========================================

const KALSHI_PAGE_LIMIT = 100;
/** Delay between pagination requests to avoid 429 rate limit */
const KALSHI_PAGE_DELAY_MS = 300;
/** Stop after this many pages so refresh finishes in ~15–20s max */
const KALSHI_MAX_PAGES = 25;

function getKalshiApiKey(): string | null {
  const key = Constants.expoConfig?.extra?.kalshiApiKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

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

// ==========================================
// UTILS & HELPERS
// ==========================================

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** * Restored: Digs through Kalshi's nested objects and handles both snake_case and camelCase 
 */
function getPrice(m: KalshiMarket, ...keys: string[]): number | string | undefined {
  const src = (m.market as Record<string, unknown> | undefined) ?? m;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== '') return v as number | string;
  }
  return undefined;
}

/**
 * Strict Price Extractor: Matches the Kalshi UI by converting both "0.99" formats and "99" formats to cents.
 */
function extractCents(val: any): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  if (Number.isNaN(n)) return null;
  
  if (n > 0 && n < 1) return Math.round(n * 100);
  if (n === 1) return 100;
  if (n >= 1 && n <= 100) return Math.round(n);
  
  return null;
}

// ==========================================
// API FETCHING
// ==========================================

async function fetchKalshiMarketsPageWithParams(opts: {
  cursor?: string | null;
  seriesTicker?: string;
}): Promise<{
  markets: KalshiMarket[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  params.set('status', 'open');
  params.set('limit', String(KALSHI_PAGE_LIMIT));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.seriesTicker) params.set('series_ticker', opts.seriesTicker);
  const url = `${KALSHI_API_BASE}/markets?${params.toString()}`;
  
  const headers: Record<string, string> = {};

  const key = getKalshiApiKey();
  if (key) headers['KALSHI-ACCESS-KEY'] = key;

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
    
    const binary = list.filter((m) => {
      const mt = (m as KalshiMarket).market_type ?? (m as KalshiMarket).marketType;
      if (!mt) return true;
      if (mt === 'scalar' || mt === 'multivariate') return false;
      return true;
    }) as KalshiMarket[];
    
    const nextCursor = data.cursor != null && String(data.cursor).length > 0 ? String(data.cursor) : null;
    return { markets: binary, nextCursor };
  }
  throw lastError ?? new Error('Kalshi API: failed after retry');
}

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

// ==========================================
// NORMALIZATION & PARSING
// ==========================================

export function normalizeKalshiMarketsToUnified(markets: KalshiMarket[]): UnifiedMarket[] {
  return normalizeKalshiMarkets(markets);
}

export function normalizeKalshiMarkets(markets: KalshiMarket[]): UnifiedMarket[] {
  const result: UnifiedMarket[] = [];
  for (const m of markets) {
    if (typeof m.ticker === 'string' && (m.ticker.includes('KXMV') || m.market_type === 'scalar')) continue;

    let yesCents = extractCents(getPrice(m, 'yes_ask_dollars', 'yesAskDollars', 'yes_ask', 'yesAsk'));
    let noCents = extractCents(getPrice(m, 'no_ask_dollars', 'noAskDollars', 'no_ask', 'noAsk'));

    if (!yesCents) yesCents = extractCents(getPrice(m, 'yes_bid_dollars', 'yesBidDollars', 'yes_bid', 'yesBid'));
    if (!noCents) noCents = extractCents(getPrice(m, 'no_bid_dollars', 'noBidDollars', 'no_bid', 'noBid'));

    if (yesCents && !noCents) noCents = 100 - yesCents;
    if (noCents && !yesCents) yesCents = 100 - noCents;

    if (!yesCents || !noCents || yesCents + noCents > 105) continue;

    result.push({
      id: `kalshi-${m.ticker}`,
      venue: 'kalshi',
      question: m.title ?? m.subtitle ?? m.ticker ?? '',
      symbol: m.ticker,
      yesPriceCents: yesCents,
      noPriceCents: noCents,
      resolutionTime: m.close_time ?? m.expiration_time,
      url: `https://kalshi.com/markets/${m.ticker}`,
    });
  }
  return result;
}

// ==========================================
// MAIN EXPORT FUNCTIONS
// ==========================================

export async function getKalshiMarkets(): Promise<UnifiedMarket[]> {
  const raw = await fetchKalshiMarkets();
  return normalizeKalshiMarkets(raw);
}

export async function getKalshiBaseballMarkets(): Promise<UnifiedMarket[]> {
  const raw: KalshiMarket[] = [];

  console.log(`[Kalshi] Fetching markets for series: KXMLBGAME...`);
  try {
    const seriesMarkets = await fetchKalshiMarketsBySeries('KXMLBGAME');
    raw.push(...seriesMarkets);
  } catch (error) {
    console.error(`[Kalshi ERROR] Failed to fetch KXMLBGAME:`, error);
  }

  console.log(`[Kalshi] Checkpoint 1: Total raw markets fetched = ${raw.length}`);
  if (raw.length === 0) return [];

  const normalized = normalizeKalshiMarkets(raw);
  console.log(`[Kalshi] Checkpoint 2: Markets with valid Yes/No prices = ${normalized.length}`);

  // e.g. KXMLBGAME-25JUN26NYYBOS-NYY
  const dailyMoneylineRegex = /^KXMLBGAME-[A-Z0-9]+-[A-Z0-9]+$/i;

  const filtered = normalized.filter(market => {
    const symbol = market.symbol?.toUpperCase() || '';
    return dailyMoneylineRegex.test(symbol);
  });

  console.log(`[Kalshi] Checkpoint 3: Verified daily moneyline games = ${filtered.length}`);
  return filtered;
}

export async function getKalshiSportsMarkets(): Promise<UnifiedMarket[]> {
  return getKalshiBaseballMarkets();
}