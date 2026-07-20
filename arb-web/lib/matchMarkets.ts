import type { UnifiedMarket, MatchedPair } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/'s\b/g, 's')
    .replace(/[^\w\s@]/g, ' ')
    .replace(/\b(the|on|end|in|be|or|draw|baseball|mlb|nba|nfl|nhl|game|moneyline|winner|will|beat|to|win|hockey|basketball|football)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// expandToken is called repeatedly with the same token during a matching run.
// Pass a per-run cache map to avoid redundant alias lookups.
function expandToken(t: string, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): Set<string> {
  const hit = cache.get(t);
  if (hit) return hit;
  const out = new Set<string>([t]);
  const aliasList = aliases[t];
  if (Array.isArray(aliasList)) {
    for (const a of aliasList) {
      out.add(a);
      const norm = normalizeTitle(a).replace(/\b(?:vs|at|@)\b/g, '').replace(/\s+/g, ' ').trim();
      if (norm.includes(' ')) {
        for (const part of norm.split(/\s+/)) { if (part.length > 1) out.add(part); }
      }
    }
  }
  cache.set(t, out);
  return out;
}

function tokenize(s: string): Set<string> {
  const norm = normalizeTitle(s).replace(/\b(?:vs\.?|at|@)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return new Set(norm.split(/\s+/).filter(t => t.length > 1));
}

function tokensMatch(a: string, b: string, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): boolean {
  if (a === b) return true;
  if (expandToken(a, aliases, cache).has(b)) return true;
  if (expandToken(b, aliases, cache).has(a)) return true;
  return false;
}

// Count unique b-tokens matched by at least one a-token (bidirectional with aliases).
function matchedCount(a: Set<string>, b: Set<string>, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): number {
  const matched = new Set<string>();
  for (const aToken of a) {
    for (const bToken of b) {
      if (tokensMatch(aToken, bToken, aliases, cache)) matched.add(bToken);
    }
  }
  return matched.size;
}

// Symmetric Jaccard using bidirectional overlap.
function jaccardSim(a: Set<string>, b: Set<string>, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const inter = Math.min(matchedCount(a, b, aliases, cache), matchedCount(b, a, aliases, cache));
  const union = a.size + b.size - inter;
  return union <= 0 ? 1 : inter / union;
}

function parseResolutionDay(t?: string): string | null {
  if (!t) return null;
  const d = t.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// Split "Team A vs Team B" into two token sets.
function splitTeams(q: string): [Set<string>, Set<string>] {
  const bracketMatch = q.match(/\[(.*?)\]$/);
  const text = bracketMatch ? bracketMatch[1] : q;
  const lower = normalizeTitle(text);
  const parts = lower.split(/\b(?:\s+vs\.?\s+|\s+at\s+|\s+@\s+)\b/);
  if (parts.length >= 2) return [tokenize(parts[0]), tokenize(parts[parts.length - 1])];
  return [tokenize(q), new Set()];
}

// ─── Politics: structured identity matching ──────────────────────────────────
// Senate/House markets nearly all read "…win the Senate race … 2026", so token
// similarity collapses every state onto every other state (the state name is one
// token out of five). Instead we parse each market's structured identity —
// (state, chamber, year, control-vs-race) — and require those to line up, exactly
// as sports matching requires the same two teams. Party is captured only to prefer
// a same-party pairing when scoring; the arb layer handles the YES/NO flip.
const US_STATES = [
  // Multi-word names first so "new hampshire" matches before "new".
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'south carolina', 'south dakota', 'west virginia', 'rhode island',
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'wisconsin', 'wyoming',
];

interface PoliticsKey {
  state: string | null;
  chamber: 'senate' | 'house' | null;
  year: string | null;
  party: 'republican' | 'democrat' | 'independent' | 'other';
  isControl: boolean;
  isCombo: boolean;
}

function parsePolitics(q: string): PoliticsKey {
  const s = q.toLowerCase();
  let state: string | null = null;
  for (const name of US_STATES) {
    if (new RegExp(`\\b${name}\\b`).test(s)) { state = name; break; }
  }
  const ym = s.match(/\b(20\d{2})\b/);
  const year = ym ? ym[1] : null;
  const mentionsHouse = /\bhouse\b/.test(s);
  const mentionsSenate = /\bsenate\b|\bsenator\b/.test(s);
  const chamber: PoliticsKey['chamber'] =
    mentionsHouse ? 'house' : (mentionsSenate ? 'senate' : null);
  let party: PoliticsKey['party'] = 'other';
  if (/\brepublican(s)?\b|\bgop\b/.test(s)) party = 'republican';
  else if (/\bdemocrat(s|ic|ics)?\b/.test(s)) party = 'democrat';
  else if (/\bindependent(s)?\b/.test(s)) party = 'independent';
  // A "control" market names a chamber but no specific state.
  const isControl = state === null && chamber !== null;
  // House-AND-Senate combos resolve on two chambers at once — never a 1:1 match
  // for any single-chamber market.
  const isCombo = mentionsHouse && mentionsSenate;
  return { state, chamber, year, party, isControl, isCombo };
}

// True when two markets are the same underlying political event.
function politicsEventMatch(a: PoliticsKey, b: PoliticsKey): boolean {
  if (a.isCombo || b.isCombo) return false;
  if (!a.chamber || !b.chamber) return false;
  if (a.chamber !== b.chamber) return false;               // never senate ↔ house
  if (a.year && b.year && a.year !== b.year) return false; // same year when both known
  if (a.state && b.state) return a.state === b.state;      // state races: same state
  if (a.isControl && b.isControl) return true;             // chamber-control markets
  return false;                                            // don't mix a state race with control
}

export function matchMarkets(
  polymarketMarkets: PolymarketMarketWithKind[],
  kalshiMarkets: UnifiedMarket[],
  options: {
    minTitleSimilarity?: number;
    minOverlapTokens?: number;
    requireSameDay?: boolean;
    politics?: boolean;
    aliases?: Record<string, string[]>;
  } = {}
): MatchedPair[] {
  const requireSameDay = options.requireSameDay ?? false;
  const isPolitics = options.politics ?? false;
  const isSport = requireSameDay;
  const aliases = options.aliases ?? {};
  const minSim = options.minTitleSimilarity ?? 0.35;
  const minOverlap = options.minOverlapTokens ?? 1;

  // One memoization map shared across the entire matching run.
  const expandCache = new Map<string, Set<string>>();

  // ── Precompute per-Kalshi-market values ──────────────────────────────────
  // These would otherwise be recomputed on every PM×Kalshi inner-loop iteration.
  const kalshiDays = requireSameDay
    ? kalshiMarkets.map(k => parseResolutionDay(k.resolutionTime))
    : null;

  // Sports: precompute team-split sets. Politics: structured keys. MLB: token sets.
  const kalshiSplits = isSport
    ? kalshiMarkets.map(k => splitTeams(k.question))
    : null;
  const kalshiKeys = isPolitics
    ? kalshiMarkets.map(k => parsePolitics(k.question))
    : null;
  const kalshiTokens = (isSport || isPolitics)
    ? null
    : kalshiMarkets.map(k => tokenize(k.question));

  const rawPairs: MatchedPair[] = [];

  for (const pm of polymarketMarkets) {
    const pmDay = parseResolutionDay(pm.resolutionTime);

    if (isPolitics) {
      // Structured identity match — same (state | control) + chamber + year.
      const pmKey = parsePolitics(pm.question);
      if (!pmKey.chamber) continue; // not a race/control market we can align
      for (let ki = 0; ki < kalshiMarkets.length; ki++) {
        if (politicsEventMatch(pmKey, kalshiKeys![ki])) {
          rawPairs.push({ polymarket: pm, kalshi: kalshiMarkets[ki] });
        }
      }
    } else if (isSport) {
      // Precompute PM team split once per PM market instead of once per PM×K pair.
      const [pmA, pmB] = splitTeams(pm.question);

      for (let ki = 0; ki < kalshiMarkets.length; ki++) {
        const kDay = kalshiDays![ki];
        if (pmDay !== null && kDay !== null && pmDay !== kDay) continue;

        const k = kalshiMarkets[ki];
        const [kA, kB] = kalshiSplits![ki];

        let matches = false;
        if (pmA.size === 0 || pmB.size === 0) {
          // PM market missing team tokens — fall back to whole-title Jaccard
          matches = jaccardSim(tokenize(pm.question), tokenize(k.question), aliases, expandCache) >= 0.15;
        } else if (kB.size === 0) {
          // Kalshi single-team market (e.g. "NYY to win")
          matches = matchedCount(kA, pmA, aliases, expandCache) > 0
                 || matchedCount(kA, pmB, aliases, expandCache) > 0;
        } else {
          // Both sides have two teams — check direct and flipped
          const direct = matchedCount(pmA, kA, aliases, expandCache) > 0
                      && matchedCount(pmB, kB, aliases, expandCache) > 0;
          matches = direct || (
            matchedCount(pmA, kB, aliases, expandCache) > 0
            && matchedCount(pmB, kA, aliases, expandCache) > 0
          );
        }
        if (matches) rawPairs.push({ polymarket: pm, kalshi: k });
      }
    } else {
      // Politics / MLB: Jaccard similarity with alias-expanded overlap.
      // Combine overlap + Jaccard into one pass — avoids calling matchedCount 3× per pair.
      const pmTokens = tokenize(pm.question);

      for (let ki = 0; ki < kalshiMarkets.length; ki++) {
        const kTokens = kalshiTokens![ki];

        // Compute intersection once; reuse for both the overlap check and Jaccard score.
        const ab = matchedCount(pmTokens, kTokens, aliases, expandCache);
        const ba = matchedCount(kTokens, pmTokens, aliases, expandCache);
        const inter = Math.min(ab, ba);
        if (inter < minOverlap) continue; // early exit before the division

        const union = pmTokens.size + kTokens.size - inter;
        const sim = union <= 0 ? 1 : inter / union;
        if (sim >= minSim) rawPairs.push({ polymarket: pm, kalshi: kalshiMarkets[ki] });
      }
    }
  }

  // Per PM market: keep the single best Kalshi match (closest price alignment).
  const byPmId = new Map<string, MatchedPair[]>();
  for (const pair of rawPairs) {
    const id = pair.polymarket.id;
    if (!byPmId.has(id)) byPmId.set(id, []);
    byPmId.get(id)!.push(pair);
  }

  const finalPairs: MatchedPair[] = [];
  for (const [, group] of byPmId) {
    if (group.length === 0) continue;
    const pm = group[0].polymarket;
    const pmDay = parseResolutionDay(pm.resolutionTime);
    const pmParty = isPolitics ? parsePolitics(pm.question).party : null;

    function scorePair(pair: MatchedPair): number {
      const priceDist = Math.min(
        Math.abs(pair.kalshi.yesPriceCents - pm.yesPriceCents),
        Math.abs(pair.kalshi.noPriceCents - pm.yesPriceCents)
      );
      const kDay = parseResolutionDay(pair.kalshi.resolutionTime);
      // Strongly prefer same-date Kalshi games — a 100¢ bonus makes same-day always win
      // over any cross-series match regardless of price closeness.
      const sameDayBonus = (pmDay && kDay && pmDay === kDay) ? -100 : 0;
      // Politics: prefer a same-party Kalshi market (a clean direct YES↔YES pairing)
      // over the complementary other-party market, which the arb layer would flip.
      let partyBonus = 0;
      if (pmParty && pmParty !== 'other') {
        const kParty = parsePolitics(pair.kalshi.question).party;
        if (kParty === pmParty) partyBonus = -30;
      }
      return priceDist + sameDayBonus + partyBonus;
    }

    let best = group[0];
    let bestScore = scorePair(group[0]);
    for (let i = 1; i < group.length; i++) {
      const s = scorePair(group[i]);
      if (s < bestScore) { bestScore = s; best = group[i]; }
    }
    finalPairs.push(best);
  }

  return finalPairs;
}
