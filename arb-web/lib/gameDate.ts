// Which calendar day a fixture belongs to.
//
// This is the key both venues must agree on before a game can be paired, and they express
// it differently. Kalshi encodes the US Eastern date in its game ticker
// (KXNFLGAME-26SEP09NESEA). Polymarket is not self-consistent about its slug:
//
//   NFL  "nfl-ne-sea-2026-09-10"   kicks off 00:20 UTC -> Eastern 09-09  (slug is UTC)
//   MLB  "mlb-cin-lad-2026-09-08"  starts   02:10 UTC -> Eastern 09-08  (slug is Eastern)
//
// So every NFL prime-time game — Thursday, Sunday and Monday night — looked like a
// different day on each venue and could not be matched at all: 7 of the week's 32 games.
// Deriving the day from the real kick-off timestamp in Eastern time makes both venues
// agree, without relaxing the same-day rule. That rule has to stay strict: baseball plays
// the same opponent on consecutive days, so a +/-1 day tolerance would happily pair
// Tuesday's game with Wednesday's.
//
// Kept in lib/ with no path-alias imports so the regression suite can load it bare.

const EASTERN_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * US Eastern calendar date (YYYY-MM-DD) of a kick-off timestamp, or null if absent or
 * unparseable — callers fall back to the slug date. Intl handles the EDT/EST switch; a
 * fixed offset would be wrong for half the season.
 */
export function easternDateOf(gameStartTime: unknown): string | null {
  if (typeof gameStartTime !== 'string' || !gameStartTime) return null;
  // Gamma emits "2026-09-10 00:20:00+00", which Date.parse does not handle consistently.
  const normalized = gameStartTime.replace(' ', 'T').replace(/\+00(:00)?$/, 'Z');
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  const formatted = EASTERN_DATE_FMT.format(new Date(ms));
  return /^\d{4}-\d{2}-\d{2}$/.test(formatted) ? formatted : null;
}
