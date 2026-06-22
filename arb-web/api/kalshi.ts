import type { UnifiedMarket } from '@/lib/market-types';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_PAGE_LIMIT = 100;
const KALSHI_PAGE_DELAY_MS = 300;
const KALSHI_MAX_PAGES = 25;

function getKalshiApiKey(): string | null {
  const key = process.env.KALSHI_API_KEY;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  yes_bid?: number;
  yes_bid_dollars?: number | string;
  yes_ask?: number;
  yes_ask_dollars?: number | string;
  no_bid?: number;
  no_bid_dollars?: number | string;
  no_ask?: number;
  no_ask_dollars?: number | string;
  close_time?: string;
  expiration_time?: string;
  market?: KalshiMarket;
  [key: string]: unknown;
}

interface KalshiMarketsResponse {
  markets?: KalshiMarket[];
  cursor?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getPrice(m: KalshiMarket, ...keys: string[]): number | string | undefined {
  const src = (m.market as Record<string, unknown> | undefined) ?? m;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== '') return v as number | string;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractCents(val: any): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  if (Number.isNaN(n)) return null;
  if (n > 0 && n < 1) return Math.round(n * 100);
  if (n === 1) return 100;
  if (n >= 1 && n <= 100) return Math.round(n);
  return null;
}

async function fetchKalshiMarketsPage(opts: { cursor?: string | null; seriesTicker?: string }): Promise<{ markets: KalshiMarket[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  params.set('status', 'open');
  params.set('limit', String(KALSHI_PAGE_LIMIT));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.seriesTicker) params.set('series_ticker', opts.seriesTicker);

  const headers: Record<string, string> = {};
  const key = getKalshiApiKey();
  if (key) headers['KALSHI-ACCESS-KEY'] = key;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${KALSHI_API_BASE}/markets?${params.toString()}`, { headers });
    if (res.status === 429) {
      lastError = new Error('Kalshi API: 429 too many requests');
      await delay(2500);
      continue;
    }
    if (!res.ok) throw new Error(`Kalshi API: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as KalshiMarketsResponse;
    const binary = (data.markets ?? []).filter(m => {
      const mt = m.market_type;
      return !mt || (mt !== 'scalar' && mt !== 'multivariate');
    });
    const nextCursor = data.cursor != null && String(data.cursor).length > 0 ? String(data.cursor) : null;
    return { markets: binary, nextCursor };
  }
  throw lastError ?? new Error('Kalshi API: failed after retry');
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
    const { markets, nextCursor } = await fetchKalshiMarketsPage({ cursor, seriesTicker });
    all.push(...markets);
    cursor = nextCursor;
    pageCount++;
  } while (cursor != null);
  return all;
}

export function normalizeKalshiMarkets(markets: KalshiMarket[]): UnifiedMarket[] {
  const result: UnifiedMarket[] = [];
  for (const m of markets) {
    if (typeof m.ticker === 'string' && (m.ticker.includes('KXMV') || m.market_type === 'scalar')) continue;

    let yesCents = extractCents(getPrice(m, 'yes_ask_dollars', 'yes_ask'));
    let noCents = extractCents(getPrice(m, 'no_ask_dollars', 'no_ask'));
    if (!yesCents) yesCents = extractCents(getPrice(m, 'yes_bid_dollars', 'yes_bid'));
    if (!noCents) noCents = extractCents(getPrice(m, 'no_bid_dollars', 'no_bid'));
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

export async function getKalshiBaseballMarkets(): Promise<UnifiedMarket[]> {
  console.log('[Kalshi] Fetching KXMLBGAME series...');
  const raw = await fetchKalshiMarketsBySeries('KXMLBGAME');
  console.log(`[Kalshi] Raw markets: ${raw.length}`);
  if (raw.length === 0) return [];

  const normalized = normalizeKalshiMarkets(raw);
  const dailyMoneylineRegex = /^KXMLBGAME-[A-Z0-9]+-[A-Z0-9]+$/i;
  const filtered = normalized.filter(m => dailyMoneylineRegex.test(m.symbol?.toUpperCase() ?? ''));
  console.log(`[Kalshi] Filtered MLB moneyline markets: ${filtered.length}`);
  return filtered;
}
