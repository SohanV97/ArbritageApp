/**
 * Polymarket API client (Gamma + CLOB).
 * - API key: set EXPO_PUBLIC_POLYMARKET_API_KEY in Arbritage_App/.env → app.config.js extra.polymarketApiKey → sent as header POLY_API_KEY (optional for read).
 * - Events: GET {POLYMARKET_GAMMA_API}/events?limit=&closed=false. Each event has markets with outcomePrices (JSON string "[yes, no]" 0–1), outcomes "[\"Yes\",\"No\"]".
 */
import Constants from 'expo-constants';
import type { UnifiedMarket } from '@/lib/market-types';
import type { PolymarketMarketKind } from '@/lib/fees';
import { POLYMARKET_GAMMA_API, POLYMARKET_CLOB_API } from '@/constants/config';

function getPolymarketApiKey(): string | null {
  const key = Constants.expoConfig?.extra?.polymarketApiKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

function polymarketHeaders(): Record<string, string> {
  const key = getPolymarketApiKey();
  const headers: Record<string, string> = {};
  if (key) headers['POLY_API_KEY'] = key;
  return headers;
}

/** Raw market from Gamma API (snake_case and camelCase variants) */
interface GammaMarket {
  id?: string;
  condition_id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  outcomes?: string;
  outcomePrices?: string;
  volume?: number;
  end_date_iso?: string;
  endDateIso?: string;
  enable_order_book?: boolean;
  clobTokenIds?: string;
  market_slug?: string;
  groupItemTitle?: string;
  [key: string]: unknown;
}

/** Raw event from Gamma API (can contain markets) */
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
  [key: string]: unknown;
}

/** CLOB price response */
interface ClobPriceRow {
  price: string;
  size: string;
  [key: string]: unknown;
}

/** outcomePrices maps 1:1 to outcomes: index 0 = Yes, 1 = No. Enforce yes+no ≈ 100. */
function parseOutcomePrices(outcomePrices: string | undefined): { yes: number; no: number } {
  if (!outcomePrices) return { yes: 50, no: 50 };
  try {
    const arr = JSON.parse(outcomePrices) as string[];
    let yes = Math.round(parseFloat(arr[0] ?? '0.5') * 100);
    let no = Math.round(parseFloat(arr[1] ?? '0.5') * 100);
    yes = Math.max(1, Math.min(99, yes));
    no = Math.max(1, Math.min(99, no));
    if (yes + no < 99 || yes + no > 101) no = 100 - yes;
    return { yes, no };
  } catch {
    return { yes: 50, no: 50 };
  }
}

function inferPolymarketFeeKind(m: GammaMarket): PolymarketMarketKind {
  const slug = (m.slug ?? m.market_slug ?? '').toLowerCase();
  const title = (m.question ?? '').toLowerCase();
  if (
    slug.includes('5min') ||
    slug.includes('15min') ||
    title.includes('5-minute') ||
    title.includes('15-minute')
  ) {
    return 'short_term_crypto';
  }
  if (
    slug.includes('ncaab') ||
    slug.includes('serie-a') ||
    title.includes('ncaab') ||
    title.includes('serie a')
  ) {
    return 'sports';
  }
  return 'fee_free';
}

export interface PolymarketMarketWithKind extends UnifiedMarket {
  polymarketFeeKind: PolymarketMarketKind;
  /** Yes-side CLOB token ID for fee-rate API */
  yesTokenId?: string;
}

/**
 * Fetch events with nested markets from Gamma API (binary markets only).
 */
export async function fetchPolymarketEvents(limit = 100): Promise<GammaEvent[]> {
  const url = `${POLYMARKET_GAMMA_API}/events?limit=${limit}&closed=false`;
  const res = await fetch(url, { headers: polymarketHeaders() });
  if (!res.ok) throw new Error(`Polymarket Gamma: ${res.status}`);
  const data = (await res.json()) as GammaEvent[];
  return Array.isArray(data) ? data : [];
}

export async function fetchPolymarketSportsMetadata(): Promise<GammaSportMetadata[]> {
  const url = `${POLYMARKET_GAMMA_API}/sports`;
  const res = await fetch(url, { headers: polymarketHeaders() });
  if (!res.ok) throw new Error(`Polymarket Gamma sports: ${res.status}`);
  const data = (await res.json()) as GammaSportMetadata[];
  return Array.isArray(data) ? data : [];
}

async function fetchPolymarketEventsByTag(tagId: string, limit = 100): Promise<GammaEvent[]> {
  const url = `${POLYMARKET_GAMMA_API}/events?tag_id=${encodeURIComponent(tagId)}&limit=${limit}&active=true&closed=false`;
  const res = await fetch(url, { headers: polymarketHeaders() });
  if (!res.ok) throw new Error(`Polymarket Gamma tag ${tagId}: ${res.status}`);
  const data = (await res.json()) as GammaEvent[];
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch single market by slug from Gamma.
 */
export async function fetchPolymarketMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const url = `${POLYMARKET_GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: polymarketHeaders() });
  if (!res.ok) return null;
  const data = (await res.json()) as GammaMarket[];
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/**
 * Get CLOB fee rate in bps for a token (0 = fee-free).
 */
export async function fetchPolymarketFeeRateBps(tokenId: string): Promise<number> {
  try {
    const url = `${POLYMARKET_CLOB_API}/fee-rate?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url, { headers: polymarketHeaders() });
    if (!res.ok) return 0;
    const data = (await res.json()) as { feeRateBps?: string; fee_rate_bps?: number };
    const bps = data.feeRateBps ?? data.fee_rate_bps;
    return typeof bps === 'string' ? parseInt(bps, 10) : Number(bps) || 0;
  } catch {
    return 0;
  }
}

/**
 * Build unified markets from Gamma events (one market per binary event or per sub-market).
 */
export function normalizePolymarketMarkets(events: GammaEvent[]): PolymarketMarketWithKind[] {
  const out: PolymarketMarketWithKind[] = [];
  for (const event of events) {
    const markets = event.markets ?? [];
    const eventTitle = event.title ?? '';
    const eventSlug = event.slug ?? event.id ?? '';
    const endDate = event.end_date_iso;
    for (const m of markets) {
      const outcomes = (m.outcomes ?? '["Yes","No"]').toLowerCase();
      if (!outcomes.includes('yes') || !outcomes.includes('no')) continue;
      const { yes, no } = parseOutcomePrices(m.outcomePrices);
      const question = m.question ?? m.groupItemTitle ?? eventTitle;
      const slug = m.slug ?? m.market_slug ?? m.condition_id ?? m.conditionId ?? m.id ?? '';
      const conditionId = m.condition_id ?? m.conditionId ?? m.id ?? '';
      const tokenIds = m.clobTokenIds;
      let yesTokenId: string | undefined;
      try {
        if (typeof tokenIds === 'string') {
          const arr = JSON.parse(tokenIds) as string[];
          yesTokenId = arr[0];
        }
      } catch {
        // ignore
      }
      const marketUrl = slug
        ? `https://polymarket.com/event/${eventSlug}${slug !== eventSlug ? `?slug=${slug}` : ''}`
        : `https://polymarket.com/event/${eventSlug}`;
      const polymarketFeeKind = inferPolymarketFeeKind(m);
      out.push({
        id: `pm-${conditionId || slug || question}`,
        venue: 'polymarket',
        question,
        yesPriceCents: yes,
        noPriceCents: no,
        resolutionTime: m.end_date_iso ?? m.endDateIso ?? endDate,
        url: marketUrl,
        rulesDescription: undefined,
        polymarketFeeKind,
        yesTokenId,
      });
    }
  }
  return out;
}

/**
 * Fetch Polymarket binary markets as unified shape (from events endpoint).
 */
export async function getPolymarketMarkets(limit = 80): Promise<PolymarketMarketWithKind[]> {
  const events = await fetchPolymarketEvents(limit);
  return normalizePolymarketMarkets(events);
}

export async function getPolymarketBasketballMarkets(limit = 120): Promise<PolymarketMarketWithKind[]> {
  const sports = await fetchPolymarketSportsMetadata();
  const basketballSports = sports.filter((s) => {
    const name = (s.sport ?? '').toLowerCase();
    return name.includes('nba') || name.includes('college basketball') || name.includes('ncaab');
  });

  const tagIds = new Set<string>();
  for (const s of basketballSports) {
    const raw = (s.tags ?? '').trim();
    if (!raw) continue;
    raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((t) => tagIds.add(t));
  }

  // Fallback: if sports metadata doesn't include tags, just return empty rather than fetching everything.
  if (tagIds.size === 0) return [];

  const allEvents: GammaEvent[] = [];
  for (const tagId of tagIds) {
    try {
      const events = await fetchPolymarketEventsByTag(tagId, limit);
      allEvents.push(...events);
    } catch {
      // ignore individual tag failures
    }
  }

  // De-dupe by id/slug
  const seen = new Set<string>();
  const deduped: GammaEvent[] = [];
  for (const e of allEvents) {
    const key = e.id ?? e.slug;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }

  return normalizePolymarketMarkets(deduped);
}
