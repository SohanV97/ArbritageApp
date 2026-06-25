import type { UnifiedMarket, Category } from '@/lib/market-types';
import type { PolymarketMarketKind } from '@/lib/fees';
import {
  POLYMARKET_SPORT_KEYWORDS,
  POLYMARKET_POLITICS_TAG_SLUGS,
} from '@/lib/categories';

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
  noTokenId?: string;
}

function normalizeEvents(
  events: GammaEvent[],
  category: Category,
  feeKind: PolymarketMarketKind
): PolymarketMarketWithKind[] {
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
      let noTokenId: string | undefined;
      try {
        if (typeof m.clobTokenIds === 'string') {
          const ids = JSON.parse(m.clobTokenIds) as string[];
          yesTokenId = ids[0];
          noTokenId = ids[1];
        }
      } catch { /* ok */ }

      out.push({
        id: `pm-${conditionId || slug}`,
        venue: 'polymarket',
        question,
        yesPriceCents: yes,
        noPriceCents: no,
        resolutionTime: m.end_date_iso ?? m.endDateIso ?? endDate,
        url: `https://polymarket.com/event/${eventSlug}`,
        polymarketFeeKind: feeKind,
        yesTokenId,
        noTokenId,
        category,
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

// Keywords that Kalshi's political markets tend to focus on.
// This trims Polymarket's huge politics catalogue to the slice that overlaps with Kalshi.
const POLITICS_MATCH_KEYWORDS = [
  'president', 'presidential', 'senate', 'senator', 'house', 'congress', 'congressional',
  'governor', 'election', 'primary', 'republican', 'democrat', 'gop',
  'trump', 'harris', 'biden', 'administration', 'white house',
  'supreme court', 'cabinet', 'nomination', 'electoral', 'midterm',
  'legislation', 'bill', 'veto', 'executive order', 'impeach',
  'approval rating', 'polling', 'swing state', 'battleground',
];

function isPoliticsMarket(market: PolymarketMarketWithKind): boolean {
  if (market.resolutionTime && Date.parse(market.resolutionTime) < Date.now()) return false;
  const q = market.question.toLowerCase();
  return POLITICS_MATCH_KEYWORDS.some(kw => q.includes(kw));
}

// ─── event fetching helpers ──────────────────────────────────────────────────

async function fetchEventsByIds(
  idParam: string,
  ids: Set<string>
): Promise<GammaEvent[]> {
  const all: GammaEvent[] = [];
  const limit = 100;
  for (const id of ids) {
    let offset = 0;
    while (true) {
      try {
        const url = `${POLYMARKET_GAMMA_API}/events?${idParam}=${encodeURIComponent(id)}&active=true&closed=false&limit=${limit}&offset=${offset}`;
        const res = await fetch(url, { headers: polymarketHeaders() });
        if (!res.ok) break;
        const events = await res.json() as GammaEvent[];
        if (!Array.isArray(events) || events.length === 0) break;
        all.push(...events);
        if (events.length < limit) break;
        offset += limit;
      } catch { break; }
    }
  }
  return all;
}

async function dedupeEvents(events: GammaEvent[]): Promise<GammaEvent[]> {
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

  // Fetch the /sports metadata once
  let sportsData: GammaSportMetadata[] = [];
  try {
    const res = await fetch(`${POLYMARKET_GAMMA_API}/sports`, { headers: polymarketHeaders() });
    if (res.ok) {
      const d = await res.json();
      sportsData = Array.isArray(d) ? d : [];
    }
  } catch { /* ok */ }

  // Fetch all tags once
  let allTags: GammaTag[] = [];
  try {
    const res = await fetch(`${POLYMARKET_GAMMA_API}/tags`, { headers: polymarketHeaders() });
    if (res.ok) {
      const d = await res.json();
      allTags = Array.isArray(d) ? d : [];
    }
  } catch { /* ok */ }

  // ── Sports categories ────────────────────────────────────────────────────
  const sportCategories: Category[] = ['mlb', 'soccer'];

  await Promise.all(sportCategories.map(async (cat) => {
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

    const allEvents: GammaEvent[] = [];
    const [bySeriesEvents, byTagEvents] = await Promise.all([
      seriesIds.size > 0 ? fetchEventsByIds('series_id', seriesIds) : Promise.resolve([]),
      tagIds.size > 0 ? fetchEventsByIds('tag_id', tagIds) : Promise.resolve([]),
    ]);
    allEvents.push(...bySeriesEvents, ...byTagEvents);

    const deduped = await dedupeEvents(allEvents);
    console.log(`[Polymarket] ${cat}: ${deduped.length} events`);

    const normalized = normalizeEvents(deduped, cat, 'sports');
    const filtered = normalized.filter(m => isSportMoneyline(m, cat));
    console.log(`[Polymarket] ${cat}: ${filtered.length} moneyline markets`);
    result.set(cat, filtered);
  }));

  // ── Politics ─────────────────────────────────────────────────────────────
  const politicsTagIds = new Set<string>();
  for (const tag of allTags) {
    const slug = (tag.slug ?? '').toLowerCase();
    const label = (tag.label ?? '').toLowerCase();
    if (POLYMARKET_POLITICS_TAG_SLUGS.some(kw => slug.includes(kw) || label.includes(kw))) {
      if (tag.id) politicsTagIds.add(tag.id);
    }
  }

  // Also try fetching by category param directly
  const politicsEvents: GammaEvent[] = [];
  try {
    const res = await fetch(
      `${POLYMARKET_GAMMA_API}/events?category=politics&active=true&closed=false&limit=100`,
      { headers: polymarketHeaders() }
    );
    if (res.ok) {
      const d = await res.json();
      if (Array.isArray(d)) politicsEvents.push(...d);
    }
  } catch { /* ok */ }

  const politicsByTag = politicsTagIds.size > 0
    ? await fetchEventsByIds('tag_id', politicsTagIds)
    : [];

  politicsEvents.push(...politicsByTag);
  const dedupedPol = await dedupeEvents(politicsEvents);
  console.log(`[Polymarket] politics: ${dedupedPol.length} events`);

  const normalizedPol = normalizeEvents(dedupedPol, 'politics', 'fee_free');
  const filteredPol = normalizedPol.filter(isPoliticsMarket);
  console.log(`[Polymarket] politics: ${filteredPol.length} markets`);
  result.set('politics', filteredPol);

  return result;
}
