import Constants from 'expo-constants';
import type { UnifiedMarket } from '@/lib/market-types';
import { KALSHI_API_BASE } from '@/constants/config';

function getKalshiApiKey(): string | null {
  const key = Constants.expoConfig?.extra?.kalshiApiKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** Kalshi API market (subset we use) */
interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  yes_ask?: number;
  yes_ask_dollars?: number | string;
  no_ask?: number;
  no_ask_dollars?: number | string;
  close_time?: string;
  expiration_time?: string;
  latest_expiration_time?: string;
  [key: string]: unknown;
}

interface KalshiMarketsResponse {
  markets?: KalshiMarket[];
  cursor?: string;
}

function toCents(v: number | string | undefined): number {
  if (v === undefined || v === null) return 50;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (Number.isNaN(n)) return 50;
  return Math.round(n * 100);
}

/**
 * Fetch open markets from Kalshi.
 * If EXPO_PUBLIC_KALSHI_API_KEY is set in .env, sends it as KALSHI-ACCESS-KEY (optional; public /markets may not require it).
 */
export async function fetchKalshiMarkets(limit = 200): Promise<KalshiMarket[]> {
  const url = `${KALSHI_API_BASE}/markets?status=open&limit=${limit}`;
  const headers: Record<string, string> = {};
  const apiKey = getKalshiApiKey();
  if (apiKey) headers['KALSHI-ACCESS-KEY'] = apiKey;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Kalshi API: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as KalshiMarketsResponse;
  const list = data.markets ?? [];
  return list.filter((m) => (m as KalshiMarket).market_type !== 'scalar') as KalshiMarket[];
}

/**
 * Normalize Kalshi markets to UnifiedMarket. Uses yes_ask/no_ask (taker side).
 */
export function normalizeKalshiMarkets(markets: KalshiMarket[]): UnifiedMarket[] {
  return markets.map((m) => {
    const yesCents = toCents(m.yes_ask_dollars ?? m.yes_ask);
    const noCents = toCents(m.no_ask_dollars ?? m.no_ask);
    const question = m.title ?? m.subtitle ?? m.ticker ?? '';
    const closeTime = m.close_time ?? m.latest_expiration_time ?? m.expiration_time;
    const marketUrl = `https://kalshi.com/markets/${m.ticker}`;
    return {
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
  });
}

/**
 * Get Kalshi binary markets as unified shape.
 */
export async function getKalshiMarkets(limit = 200): Promise<UnifiedMarket[]> {
  const raw = await fetchKalshiMarkets(limit);
  return normalizeKalshiMarkets(raw);
}
