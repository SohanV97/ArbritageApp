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
  market_type?: string;
  marketType?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  yes_ask?: number;
  yes_ask_dollars?: number | string;
  yesAsk?: number;
  yesAskDollars?: number | string;
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
  if (isDollarString || (n > 0 && n < 1)) {
    cents = Math.round(n * 100);
  } else if (n >= 1 && n <= 99) {
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
  const params = new URLSearchParams();
  params.set('status', 'open');
  params.set('limit', String(KALSHI_PAGE_LIMIT));
  if (cursor) params.set('cursor', cursor);
  const url = `${KALSHI_API_BASE}/markets?${params.toString()}`;
  const headers: Record<string, string> = {};
  const apiKey = getKalshiApiKey();
  if (apiKey) headers['KALSH-ACCESS-KEY'] = apiKey;

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
    if (list.length > 0) {
      const raw = list[0] as Record<string, unknown>;
      const priceKeys = ['yes_ask_dollars', 'yesAskDollars', 'yes_ask', 'yesAsk', 'no_ask_dollars', 'noAskDollars', 'no_ask', 'noAsk', 'last_price_dollars', 'last_price', 'yes_bid_dollars', 'no_bid_dollars', 'yes_bid', 'no_bid'];
      const sample: Record<string, unknown> = { ticker: raw?.ticker, title: typeof raw?.title === 'string' ? raw.title.slice(0, 60) : raw?.title, topLevelKeys: Object.keys(raw || {}) };
      priceKeys.forEach((k) => { if (raw?.[k] !== undefined) sample[k] = raw[k]; });
      const payload = { sessionId: '6ebff7', location: 'kalshi.ts:fetchPage', message: 'Kalshi first market raw', data: sample, timestamp: Date.now(), hypothesisId: 'H1-H4-H5' };
      fetch('http://127.0.0.1:7864/ingest/1db4401f-b144-4aed-9aa6-5a1876b1005e', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6ebff7' }, body: JSON.stringify(payload) }).catch(() => {});
      console.log('[DEBUG Kalshi] first market raw:', JSON.stringify(sample));
    }
    // #endregion
    const binary = list.filter(
      (m) => (m as KalshiMarket).market_type !== 'scalar' && (m as KalshiMarket).marketType !== 'scalar'
    ) as KalshiMarket[];
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
    const { markets, nextCursor } = await fetchKalshiMarketsPage(cursor);
    all.push(...markets);
    cursor = nextCursor;
    pageCount++;
  } while (cursor != null);
  return all;
}

/**
 * Normalize Kalshi markets to UnifiedMarket. Reads all known price keys (snake + camel).
 * Skips markets with missing or invalid yes/no prices.
 */
export function normalizeKalshiMarkets(markets: KalshiMarket[]): UnifiedMarket[] {
  return markets
    .map((m) => {
      const yesDollars = getPrice(m, 'yes_ask_dollars', 'yesAskDollars');
      const noDollars = getPrice(m, 'no_ask_dollars', 'noAskDollars');
      const yesCentsRaw = getPrice(m, 'yes_ask', 'yesAsk');
      const noCentsRaw = getPrice(m, 'no_ask', 'noAsk');
      const lastPrice = getPrice(m, 'last_price_dollars', 'last_price');
      // Prefer dollar fields; fall back to deprecated cent fields; when both asks empty (0/100), use last trade price.
      let yesCents = kalshiPriceToCents(yesDollars ?? yesCentsRaw ?? lastPrice);
      let noCents = kalshiPriceToCents(noDollars ?? noCentsRaw);
      const yesCentsFromRaw = kalshiPriceToCents(yesCentsRaw);
      const noCentsFromRaw = kalshiPriceToCents(noCentsRaw);
      if (yesCents === 1 && yesCentsFromRaw != null && yesCentsFromRaw >= 5 && yesCentsFromRaw <= 95) yesCents = yesCentsFromRaw;
      if (noCents === 1 && noCentsFromRaw != null && noCentsFromRaw >= 5 && noCentsFromRaw <= 95) noCents = noCentsFromRaw;
      // Binary markets: yes+no≈100. When one side is 0 or 100 (API returns "0.0000"/"1.0000" = no liquidity), derive from the other.
      if (yesCents != null && noCents == null) noCents = deriveMissingPrice(yesCents);
      if (noCents != null && yesCents == null) yesCents = deriveMissingPrice(noCents);
      // #region agent log
      if (markets[0] && m.ticker === markets[0].ticker) {
        const normPayload = { sessionId: '6ebff7', location: 'kalshi.ts:normalize', message: 'Kalshi first market parsed', data: { ticker: m.ticker, yesDollars, noDollars, yesCentsRaw, noCentsRaw, lastPrice, finalYes: yesCents, finalNo: noCents }, timestamp: Date.now(), hypothesisId: 'H2-H4' };
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
