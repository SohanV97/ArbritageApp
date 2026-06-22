import type { UnifiedMarket } from '@/lib/market-types';
import type { PolymarketMarketKind } from '@/lib/fees';

const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

function getPolymarketApiKey(): string | null {
  const key = process.env.POLYMARKET_API_KEY;
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

export function normalizePolymarketMarkets(events: GammaEvent[]): PolymarketMarketWithKind[] {
  const out: PolymarketMarketWithKind[] = [];
  for (const event of events) {
    const markets = event.markets ?? [];
    const eventTitle = event.title ?? '';
    const eventSlug = event.slug ?? event.id ?? '';
    const endDate = event.end_date_iso;

    for (const m of markets) {
      let outcomesArr: string[] = [];
      try { outcomesArr = JSON.parse(m.outcomes ?? '["Yes","No"]'); } catch { outcomesArr = ['Yes', 'No']; }
      if (outcomesArr.length !== 2) continue;

      const { yes, no } = parseOutcomePrices(m.outcomePrices);
      const rawQuestion = m.question ?? m.groupItemTitle ?? '';
      let question = rawQuestion.toLowerCase().includes(eventTitle.toLowerCase()) ? rawQuestion : `${eventTitle}: ${rawQuestion}`;
      const isYesNo = outcomesArr[0].toLowerCase() === 'yes' || outcomesArr[1].toLowerCase() === 'no';
      if (!isYesNo) question = `${question} [${outcomesArr[0]} vs ${outcomesArr[1]}]`;

      const slug = m.slug ?? m.market_slug ?? m.condition_id ?? m.conditionId ?? m.id ?? '';
      const conditionId = m.condition_id ?? m.conditionId ?? m.id ?? '';

      let yesTokenId: string | undefined;
      try { if (typeof m.clobTokenIds === 'string') yesTokenId = (JSON.parse(m.clobTokenIds) as string[])[0]; } catch { /* ok */ }

      out.push({
        id: `pm-${conditionId || slug}`,
        venue: 'polymarket',
        question,
        yesPriceCents: yes,
        noPriceCents: no,
        resolutionTime: m.end_date_iso ?? m.endDateIso ?? endDate,
        url: `https://polymarket.com/event/${eventSlug}`,
        polymarketFeeKind: 'sports',
        yesTokenId,
      });
    }
  }
  return out;
}

function isPureMoneyline(market: PolymarketMarketWithKind): boolean {
  const q = market.question.toLowerCase();
  if (![' vs ', ' vs. ', ' versus ', ' @ ', ' at '].some(t => q.includes(t))) return false;
  const junk = [
    'championship', 'award', 'mvp', 'rookie', 'draft', 'most valuable',
    'division winner', 'pennant', 'wild card', 'make the playoffs', 'series winner',
    'strikeout', 'home run', 'batting', 'earned run', 'hits allowed', 'run line',
    'margin', 'inning', 'score', 'stats',
    'draw', 'tie', ' fc', 'fc ',
    'nhl', 'hockey', 'nba', 'basketball', 'nfl', 'football', 'tennis', 'soccer', 'csgo',
    'will be traded', 'trade destination',
  ];
  if (junk.some(word => q.includes(word))) return false;
  if (['spread', 'over/under', 'cover', 'total', 'over', 'under'].some(word => q.includes(word))) return false;
  if (/(?:\s|^)[+-]\d+(\.\d+)?(?:\s|$)/.test(q)) return false;
  if (market.resolutionTime && Date.parse(market.resolutionTime) < Date.now()) return false;
  return true;
}

export async function getPolymarketBaseballMarkets(): Promise<PolymarketMarketWithKind[]> {
  const allEvents: GammaEvent[] = [];
  const limit = 100;

  const sports = await (async () => {
    try {
      const res = await fetch(`${POLYMARKET_GAMMA_API}/sports`, { headers: polymarketHeaders() });
      if (!res.ok) return [] as GammaSportMetadata[];
      const data = await res.json() as GammaSportMetadata[];
      return Array.isArray(data) ? data : [] as GammaSportMetadata[];
    } catch { return [] as GammaSportMetadata[]; }
  })();

  const seriesIds = new Set<string>();
  const tagIds = new Set<string>();

  for (const s of sports) {
    const name = (s.sport ?? '').toLowerCase();
    if (name.includes('mlb') || name.includes('baseball')) {
      if (s.series) s.series.split(',').forEach(id => { const t = id.trim(); if (t) seriesIds.add(t); });
      if (s.tags) s.tags.split(',').forEach(t => { const tr = t.trim(); if (tr) tagIds.add(tr); });
    }
  }

  try {
    const res = await fetch(`${POLYMARKET_GAMMA_API}/tags`, { headers: polymarketHeaders() });
    if (res.ok) {
      const allTags = await res.json() as GammaTag[];
      allTags.forEach(t => {
        const slug = (t.slug ?? '').toLowerCase();
        if (slug === 'mlb' || slug === 'baseball' || slug === 'major-league-baseball') {
          if (t.id) tagIds.add(t.id);
        }
      });
    }
  } catch { /* ok */ }

  for (const seriesId of seriesIds) {
    let offset = 0;
    while (true) {
      try {
        const res = await fetch(`${POLYMARKET_GAMMA_API}/events?series_id=${encodeURIComponent(seriesId)}&active=true&closed=false&limit=${limit}&offset=${offset}`, { headers: polymarketHeaders() });
        if (!res.ok) break;
        const events = await res.json() as GammaEvent[];
        if (!Array.isArray(events) || events.length === 0) break;
        allEvents.push(...events);
        if (events.length < limit) break;
        offset += limit;
      } catch { break; }
    }
  }

  for (const tagId of tagIds) {
    let offset = 0;
    while (true) {
      try {
        const res = await fetch(`${POLYMARKET_GAMMA_API}/events?tag_id=${encodeURIComponent(tagId)}&active=true&closed=false&limit=${limit}&offset=${offset}`, { headers: polymarketHeaders() });
        if (!res.ok) break;
        const events = await res.json() as GammaEvent[];
        if (!Array.isArray(events) || events.length === 0) break;
        allEvents.push(...events);
        if (events.length < limit) break;
        offset += limit;
      } catch { break; }
    }
  }

  const seen = new Set<string>();
  const deduped = allEvents.filter(e => {
    const key = e.id ?? e.slug;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[Polymarket] Fetched ${deduped.length} MLB events`);
  const normalized = normalizePolymarketMarkets(deduped);
  const filtered = normalized.filter(isPureMoneyline);
  console.log(`[Polymarket] Filtered to ${filtered.length} moneyline games`);
  return filtered;
}
