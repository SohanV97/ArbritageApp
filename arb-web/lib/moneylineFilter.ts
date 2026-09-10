// Which Polymarket sports markets are eligible to be matched against Kalshi.
// Kept in lib/ with no path-alias imports so the regression suite can load it under
// bare Node — sports is the default auto-execute scope, so a market that slips through
// here is the one most likely to be traded automatically on a fake edge.
const SPORT_JUNK: Record<string, string[]> = {
  mlb: ['nhl', 'hockey', 'nba', 'basketball', 'nfl', 'soccer', 'football'],
  soccer: ['mlb', 'baseball', 'nhl', 'hockey', 'nba', 'basketball', 'nfl'],
  // Note: "football" is NOT junk here — it's the sport. Guard against the OTHER code's
  // markets instead so pro and college feeds can't contaminate each other.
  nfl: ['mlb', 'baseball', 'nhl', 'hockey', 'nba', 'basketball', 'soccer', 'ncaa', 'college'],
  cfb: ['mlb', 'baseball', 'nhl', 'hockey', 'nba', 'basketball', 'soccer'],
};

const COMMON_SPORT_JUNK = [
  'championship', 'award', 'mvp', 'rookie', 'draft', 'most valuable',
  'division winner', 'pennant', 'wild card', 'make the playoffs', 'series winner',
  'margin', 'stats', 'will be traded', 'trade destination',
  // Esports / gaming — these appear in PM's "sports" feed but Kalshi doesn't cover them
  'valorant', 'vct', 'vcl', 'esports', 'e-sports', 'gaming',
  'map 1', 'map 2', 'map 3', 'map 4', 'map 5', 'bo1', 'bo3', 'bo5',
  'league of legends', 'counter-strike', 'cs:go', 'dota', 'overwatch',
  'mobile legends', 'bang bang', 'mlbb', 'mid season cup',
  // Prop-bet markets about commentary / broadcasting — not the same as match winner
  'announcer', 'commentator', 'broadcast',
];

// Shared by both football codes — the market shapes are identical on Polymarket.
const FOOTBALL_JUNK = [
  'season series',            // settles over a season, not this game
  'safety', 'longest', 'shortest', 'both teams', ' fg', 'overtime', 'coin toss',
  // The real game moneyline's question is just "A vs. B" — every partial-game variant
  // ("1Q Moneyline", "2H Moneyline") spells the word out, so this one term removes them
  // all rather than chasing each quarter/half spelling.
  'moneyline',
  'first half', 'second half', 'halftime', 'half time', 'quarter',
  'touchdown', 'passing', 'rushing', 'receiving', 'yards', 'sack', 'interception',
  'field goal', 'player', 'anytime td', 'first td',
  'to make postseason', 'playoff', 'super bowl', 'heisman', 'national champion',
  'conference', 'coach', 'heisman award',
  'overtime', 'over time', 'tie',
  'more markets',
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
    // Time/outcome prop markets — NOT the same as a match winner market
    'extra time', 'overtime', 'over time',
    'draw', 'tie',
    // Polymarket "More Markets" sub-events contain props like extra time, draw, etc.
    // The event title is prefixed with "- More Markets:" so blocking this catches them all.
    'more markets',
  ],
  // Football markets that read like a matchup but don't resolve on the game's winner.
  // "Season Series Winner" is the dangerous one: it contains "A vs. B" and would sail
  // through the moneyline check while actually settling over a whole season.
  nfl: FOOTBALL_JUNK,
  cfb: FOOTBALL_JUNK,
};

// A game is still tradeable for HOURS after the calendar date in its slug. `resolutionTime`
// is synthesised as `<gameDate>T23:59:00Z` purely so both venues agree on a fixture date —
// it is NOT when the game ends. Treating it as an expiry silently dropped every game in
// progress: a Sept 8 game starting 01:40 UTC on the 9th was discarded 29 minutes after
// first pitch, while Kalshi happily kept quoting it. In-play is where the venues disagree
// most, so this removed exactly the window with the best edges.
//
// Liveness now comes from the venue's own `tradeable` flag, which flips only on
// settlement. This date check remains as a backstop for stale data, with a window wide
// enough for the latest possible start (a ~22:10 local west-coast game is 05:10 UTC the
// next day) plus a long extra-innings game.
const STALE_AFTER_MS = 14 * 60 * 60 * 1000;

export function isSportMoneyline(
  market: { question: string; resolutionTime?: string | null; tradeable?: boolean },
  cat: string,
): boolean {
  const q = market.question.toLowerCase();
  // ' at ' excluded — too ambiguous ("score at least", "win at home"); ' @ ' covers venue format
  if (![' vs ', ' vs. ', ' versus ', ' @ '].some(t => q.includes(t))) return false;
  const junk = [...COMMON_SPORT_JUNK, ...(SPORT_JUNK[cat] ?? []), ...(SPORT_EXTRA_JUNK[cat] ?? [])];
  if (junk.some(word => q.includes(word))) return false;

  // Whitelist the moneyline SHAPE instead of blacklisting every prop name. Polymarket
  // hangs its prop bets off the same fixture title with a colon clause:
  //   "Bears vs. Panthers"                              <- the game moneyline
  //   "Bears vs. Panthers: Safety?"                     <- prop
  //   "Bears vs. Panthers: Team to Record Longest FG"   <- prop
  //   "Bears vs. Panthers: Both Teams to Score Points - 1Q"
  // The blacklist missed all three (it spells out "field goal", not "FG"), so 18 NFL
  // fixtures each matched ~3 props against Kalshi's plain "Chicago wins" — markets that
  // resolve on completely different events. Chasing prop names is unwinnable; the clause
  // itself is the signal. The only legitimate colon form is soccer's explicit
  // "…: Will <team> win on <date>?", so keep that and drop the rest.
  const colon = q.indexOf(':');
  if (colon !== -1) {
    const clause = q.slice(colon + 1).replace(/\[.*?\]/g, ' ').trim();
    if (clause && !/^will\b.*\bwin\b/.test(clause)) return false;
  }
  if (['spread', 'over/under', 'o/u', 'cover', 'total', 'nrfi', 'run line'].some(word => q.includes(word))) return false;
  if (/(?:\s|^)[+-]\d+(\.\d+)?(?:\s|$)/.test(q)) return false;
  // Exact score patterns like "Switzerland 0 - 3 Canada" or "2-1"
  // Strip ISO dates first so "2026-06-23" (which contains "06-23") isn't a false hit
  if (/\b\d+\s*-\s*\d+\b/.test(q.replace(/\d{4}-\d{2}-\d{2}/g, ''))) return false;
  // The venue said this market has settled or stopped accepting orders.
  if (market.tradeable === false) return false;
  // Backstop only — see STALE_AFTER_MS. Must not fire while a game is still being played.
  if (market.resolutionTime) {
    const t = Date.parse(market.resolutionTime);
    if (Number.isFinite(t) && t < Date.now() - STALE_AFTER_MS) return false;
  }
  return true;
}
