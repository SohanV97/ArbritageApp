import type { UnifiedMarket, Category } from '@/lib/market-types';
import { KALSHI_MONEYLINE_PATTERN } from '@/lib/categories';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_PAGE_LIMIT = 100;
const KALSHI_PAGE_DELAY_MS = 300;
const KALSHI_MAX_PAGES = 30;

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

async function fetchKalshiMarketsPage(opts: {
  cursor?: string | null;
  seriesTicker?: string;
}): Promise<{ markets: KalshiMarket[]; nextCursor: string | null }> {
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

const MONTH_ABBR: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

// Extracts the actual game date from tickers like KXWCGAME-26JUN25TURUSA-USA.
// Kalshi uses tournament end date as close_time for soccer (e.g. July 11 for WC final),
// so we must read the date embedded in the ticker instead.
function parseKalshiGameDate(ticker: string): string | null {
  const m = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return null;
  const mm = MONTH_ABBR[m[2].toUpperCase()];
  return mm ? `20${m[1]}-${mm}-${m[3]}` : null;
}

async function paginateKalshi(seriesTicker?: string): Promise<KalshiMarket[]> {
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

export function normalizeKalshiMarkets(markets: KalshiMarket[], category?: Category): UnifiedMarket[] {
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
      resolutionTime: parseKalshiGameDate(m.ticker)
        ? `${parseKalshiGameDate(m.ticker)}T23:59:00Z`
        : (m.close_time ?? m.expiration_time),
      url: `https://kalshi.com/markets/${m.ticker}`,
      category,
    });
  }
  return result;
}

// Explicit series tickers to try per category. The API requires series_ticker to return
// sports markets — an unfiltered request returns only election markets.
// Multiple series are tried in parallel; empty/missing series return [] gracefully.
const CATEGORY_SERIES: Record<Category, string[]> = {
  mlb: ['KXMLBGAME'],
  soccer: [
    'KXWCGAME',   // World Cup games (2026)
    'KXWC',       // World Cup generic
    'KXWC2026',   // World Cup 2026 explicit
    'KXFIFAWC',   // FIFA World Cup
    'KXSOCCER',   // General soccer
    'KXMLSGAME',  // MLS games
    'KXMLS',      // MLS generic
    'KXEPL',      // English Premier League
    'KXUEFACL',   // UEFA Champions League
  ],
  politics: [
    // Chamber control (confirmed working)
    'CONTROLS',             // Which party controls the US Senate
    'KXBALANCEPOWERCOMBO',  // Which party controls House + Senate combo
    // 2026 Senate midterm races — pattern: SENATE{2-letter-state}
    'SENATETX', // Texas
    'SENATEIA', // Iowa
    'SENATEAK', // Alaska
    'SENATEGA', // Georgia
    'SENATEMI', // Michigan
    'SENATEWI', // Wisconsin
    'SENATEMT', // Montana
    'SENATEME', // Maine
    'SENATENJ', // New Jersey
    'SENATENH', // New Hampshire
    'SENATECO', // Colorado
    'SENATENM', // New Mexico
    'SENATENC', // North Carolina
    'SENATEOR', // Oregon
    'SENATEIL', // Illinois
    'SENATEMD', // Maryland
    'SENATEVA', // Virginia
    'SENATENV', // Nevada
    'SENATEDE', // Delaware
    'SENATELA', // Louisiana
    'SENATEAL', // Alabama
    'SENATEAR', // Arkansas
    'SENATEID', // Idaho
    'SENATEKS', // Kansas
    'SENATEMN', // Minnesota
    'SENATESC', // South Carolina
  ],
};

export async function getKalshiMarketsForAllCategories(): Promise<Map<Category, UnifiedMarket[]>> {
  const result = new Map<Category, UnifiedMarket[]>();

  await Promise.all(
    (Object.entries(CATEGORY_SERIES) as [Category, string[]][]).map(async ([cat, seriesList]) => {
      // Fetch all series for this category concurrently; swallow per-series errors
      // Fetch series sequentially to avoid burst rate-limiting (37+ parallel requests → 429s)
      const raw: KalshiMarket[] = [];
      for (let i = 0; i < seriesList.length; i++) {
        const markets = await paginateKalshi(seriesList[i]).catch((err: Error) => {
          console.error(`[Kalshi] ${cat}/${seriesList[i]} error: ${err.message}`);
          return [] as KalshiMarket[];
        });
        raw.push(...markets);
        if (i < seriesList.length - 1) await delay(150);
      }

      // Deduplicate by ticker across series
      const seen = new Set<string>();
      const deduped = raw.filter(m => {
        if (seen.has(m.ticker)) return false;
        seen.add(m.ticker);
        return true;
      });

      console.log(`[Kalshi] ${cat}: ${deduped.length} raw markets`);
      if (deduped.length === 0) return;

      const normalized = normalizeKalshiMarkets(deduped, cat);
      const pattern = KALSHI_MONEYLINE_PATTERN[cat];

      let filtered: UnifiedMarket[];
      if (cat === 'politics') {
        filtered = normalized.filter(
          m => !m.resolutionTime || Date.parse(m.resolutionTime) > Date.now()
        );
      } else if (pattern) {
        filtered = normalized.filter(m => pattern.test(m.symbol?.toUpperCase() ?? ''));
      } else {
        filtered = normalized;
      }

      console.log(`[Kalshi] ${cat}: ${filtered.length} markets after filter`);
      if (filtered.length > 0) result.set(cat, filtered);
    })
  );

  return result;
}
