const SPORTS_KEYWORDS = [
  'nba',
  'wnba',
  'nfl',
  'mlb',
  'nhl',
  'ncaa',
  'ncaab',
  'ncaaf',
  'college basketball',
  'college football',
  'premier league',
  'epl',
  'la liga',
  'serie a',
  'bundesliga',
  'champions league',
  'mls',
  'uefa',
  'ufc',
  'mma',
  'boxing',
  'tennis',
  'atp',
  'wta',
  'golf',
  'pga',
  'f1',
  'formula 1',
  'nascar',
  'moneyline',
  'spread',
  'point spread',
  'total points',
  'over/under',
  'over under',
];

function normalize(s?: string | null): string {
  return (s ?? '').toLowerCase();
}

function includesKeyword(haystack: string, keyword: string): boolean {
  if (!keyword) return false;
  // For short acronyms (nba, nfl, mlb, etc.) avoid substring matches like "bontenbal".
  if (/^[a-z0-9]+$/.test(keyword) && keyword.length <= 5) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i');
    return re.test(haystack);
  }
  return haystack.includes(keyword);
}

/**
 * Heuristic check: does this look like a sports market?
 * Uses league/team/market-structure keywords in the question and optional slug/symbol.
 */
export function isSportsMarket(question: string, symbolOrSlug?: string): boolean {
  const q = normalize(question);
  const sym = normalize(symbolOrSlug);

  for (const kw of SPORTS_KEYWORDS) {
    if (includesKeyword(q, kw) || includesKeyword(sym, kw)) {
      return true;
    }
  }

  // Very rough fallback: patterns like "Team A vs Team B"
  if (q.includes(' vs ') || q.includes(' vs. ') || q.includes(' at ')) {
    return true;
  }

  return false;
}

