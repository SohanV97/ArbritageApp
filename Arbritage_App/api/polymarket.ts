/**
 * Polymarket API client (Gamma + CLOB).
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
  tags?: GammaTag[];
  [key: string]: unknown;
}

interface GammaSportMetadata {
  sport?: string;
  tags?: string;
  series?: string;
  [key: string]: unknown;
}

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

export interface PolymarketMarketWithKind extends UnifiedMarket {
  polymarketFeeKind: PolymarketMarketKind;
  yesTokenId?: string;
}

export async function fetchPolymarketSportsMetadata(): Promise<GammaSportMetadata[]> {
  const url = `${POLYMARKET_GAMMA_API}/sports`;
  const res = await fetch(url, { headers: polymarketHeaders() });
  if (!res.ok) throw new Error(`Polymarket Gamma sports: ${res.status}`);
  const data = (await res.json()) as GammaSportMetadata[];
  return Array.isArray(data) ? data : [];
}

export function normalizePolymarketMarkets(events: GammaEvent[]): PolymarketMarketWithKind[] {
  const out: PolymarketMarketWithKind[] = [];
  for (const event of events) {
    const markets = event.markets ?? [];
    const eventTitle = event.title ?? '';
    const eventSlug = event.slug ?? event.id ?? '';
    const endDate = event.end_date_iso;
    
    for (const m of markets) {
      let outcomesArr: string[] = [];
      try {
        outcomesArr = JSON.parse(m.outcomes ?? '["Yes","No"]');
      } catch {
        outcomesArr = ["Yes", "No"];
      }
      
      if (outcomesArr.length !== 2) continue;

      const { yes, no } = parseOutcomePrices(m.outcomePrices);
      
      const rawQuestion = m.question ?? m.groupItemTitle ?? '';
      let question = rawQuestion.toLowerCase().includes(eventTitle.toLowerCase()) 
        ? rawQuestion 
        : `${eventTitle}: ${rawQuestion}`;
      
      const isYesNo = outcomesArr[0].toLowerCase() === 'yes' || outcomesArr[1].toLowerCase() === 'no';
      if (!isYesNo) {
        question = `${question} [${outcomesArr[0]} vs ${outcomesArr[1]}]`;
      }
      
      const slug = m.slug ?? m.market_slug ?? m.condition_id ?? m.conditionId ?? m.id ?? '';
      const conditionId = m.condition_id ?? m.conditionId ?? m.id ?? '';
      
      let yesTokenId: string | undefined;
      try {
        if (typeof m.clobTokenIds === 'string') {
          yesTokenId = (JSON.parse(m.clobTokenIds) as string[])[0];
        }
      } catch {}

      const marketUrl = `https://polymarket.com/event/${eventSlug}`;
      
      out.push({
        id: `pm-${conditionId || slug}`,
        venue: 'polymarket',
        question,
        yesPriceCents: yes,
        noPriceCents: no,
        resolutionTime: m.end_date_iso ?? m.endDateIso ?? endDate,
        url: marketUrl,
        rulesDescription: undefined,
        polymarketFeeKind: 'sports',
        yesTokenId,
      });
    }
  }
  return out;
}

// ==========================================
// STRICT STRUCTURAL MONEYLINE FILTER
// ==========================================

function isPureMoneyline(market: PolymarketMarketWithKind): boolean {
  const q = market.question.toLowerCase();

  // 1. MUST HAVE A MATCHUP INDICATOR
  if (![' vs ', ' vs. ', ' versus ', ' @ ', ' at '].some(t => q.includes(t))) return false;

  // 2. NUKE FUTURES, PROPS, AND LEFTOVER JUNK
  const junk = [
    'championship', 'title', 'season', 'award', 'mvp', 'rookie', 'draft',
    'conference winner', 'division winner', 'defensive',
    'coach of the year', 'make the playoffs', 'win the', 'series winner', 
    'points', 'rebounds', 'assists', 'score', 'stats', 'most valuable',
    'half', 'quarter', 'margin', 'seed',
    ' fc', 'fc ', ' sc', 'sc ', 'club', 'draw', 'tie', 'league',
    'nhl', 'hockey', 'nfl', 'football', 'mlb', 'baseball', 'tennis', 'csgo',
    'will be traded', 'trade destination'
  ];
  if (junk.some(word => q.includes(word))) return false;

  // 3. NUKE SPREADS AND TOTALS
  if (['spread', 'over/under', 'cover', 'total', 'over', 'under'].some(word => q.includes(word))) return false;
  if (/(?:\s|^)[+-]\d+(\.\d+)?(?:\s|$)/.test(q)) return false;

  // 4. THE TIME MACHINE CHECK
  if (market.resolutionTime) {
    const expirationMs = Date.parse(market.resolutionTime);
    if (expirationMs < Date.now()) return false;
  }

  return true;
}

// ==========================================
// MAIN PAGINATED FETCHER (DUAL-PRONGED)
// ==========================================

export async function getPolymarketBasketballMarkets(): Promise<PolymarketMarketWithKind[]> {
  const allEvents: GammaEvent[] = [];
  const limit = 100;

  // =========================================================
  // PRONG 1: FETCH NBA BY SERIES_ID
  // =========================================================
  const seriesIds = new Set<string>();
  seriesIds.add('10345');

  for (const seriesId of seriesIds) {
    let offset = 0;
    while (true) {
      try {
        const url = `${POLYMARKET_GAMMA_API}/events?series_id=${encodeURIComponent(seriesId)}&active=true&closed=false&limit=${limit}&offset=${offset}`;
        const res = await fetch(url, { headers: polymarketHeaders() });
        if (!res.ok) break;
        const events = (await res.json()) as GammaEvent[];
        if (!Array.isArray(events) || events.length === 0) break;

        allEvents.push(...events);
        if (events.length < limit) break;
        offset += limit;
      } catch (e) {
        break;
      }
    }
  }

  // =========================================================
  // PRONG 2: FETCH CBB BY TAG_ID
  // =========================================================
  const tagIds = new Set<string>();

  const sports = await fetchPolymarketSportsMetadata();
  for (const s of sports) {
    const name = (s.sport ?? '').toLowerCase();
    if (name.includes('cbb') || name.includes('ncaab') || name.includes('college basketball')) {
      if (s.tags) {
        s.tags.split(',').forEach(t => tagIds.add(t.trim()));
      }
    }
  }

  try {
    const tagUrl = `${POLYMARKET_GAMMA_API}/tags`;
    const res = await fetch(tagUrl, { headers: polymarketHeaders() });
    if (res.ok) {
      const allTags = (await res.json()) as GammaTag[];
      allTags.forEach(t => {
        const slug = (t.slug ?? '').toLowerCase();
        if (slug === 'cbb' || slug === 'ncaab' || slug === 'mens-college-basketball') {
          if (t.id) tagIds.add(t.id);
        }
      });
    }
  } catch (e) {}

  for (const tagId of tagIds) {
    let offset = 0;
    while (true) {
      try {
        const url = `${POLYMARKET_GAMMA_API}/events?tag_id=${encodeURIComponent(tagId)}&active=true&closed=false&limit=${limit}&offset=${offset}`;
        const res = await fetch(url, { headers: polymarketHeaders() });
        if (!res.ok) break;
        const events = (await res.json()) as GammaEvent[];
        if (!Array.isArray(events) || events.length === 0) break;

        allEvents.push(...events);
        if (events.length < limit) break;
        offset += limit;
      } catch (e) {
        break;
      }
    }
  }

  // =========================================================
  // DOCS LOGIC: STRICT EVENT-LEVEL SCRUBBING
  // =========================================================

  const seen = new Set<string>();
  const dedupedEvents: GammaEvent[] = [];

  for (const e of allEvents) {
    const key = e.id ?? e.slug;
    if (!key || seen.has(key)) continue;

    let isWomensGame = false;

    // 1. Logically inspect the official API tags array.
    // If a market maker cross-tagged a women's game into the men's feed, this catches it.
    if (Array.isArray(e.tags)) {
      for (const t of e.tags) {
        const slug = (t.slug ?? '').toLowerCase();
        if (slug.includes('women') || slug === 'ncaaw' || slug === 'wbb' || slug === 'wnba') {
          isWomensGame = true;
          break;
        }
      }
    }

    // 2. Secondary API Title check.
    // This is the fail-safe to catch lazy market makers who didn't assign tags at all but used (W).
    const titleText = (e.title ?? '').toLowerCase();
    if (titleText.includes('(w)') || titleText.includes('women')) {
      isWomensGame = true;
    }

    // Immediately drop the event if it triggered any women's flags.
    if (isWomensGame) {
      continue;
    }

    seen.add(key);
    dedupedEvents.push(e);
  }

  console.log(`[Polymarket] Checkpoint 1: Fetched ${dedupedEvents.length} strictly Men's basketball events.`);

  const normalized = normalizePolymarketMarkets(dedupedEvents);

  const filtered = normalized.filter(isPureMoneyline);
  console.log(`[Polymarket] Checkpoint 2: Verified upcoming Men's moneyline games = ${filtered.length}`);

  return filtered;
}

export async function getPolymarketMarkets(): Promise<PolymarketMarketWithKind[]> {
  return getPolymarketBasketballMarkets();
}