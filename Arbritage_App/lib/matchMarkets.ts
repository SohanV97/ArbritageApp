import type { UnifiedMarket } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import type { MatchedPair } from './market-types';

/** Normalize text for matching: lowercase, collapse spaces, remove punctuation */
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common abbreviations so "lal" can match "lakers", etc. */
const TOKEN_ALIASES: Record<string, string[]> = {
  lal: ['lakers', 'los angeles lakers'],
  lakers: ['lal'],
  bos: ['celtics', 'boston celtics'],
  celtics: ['bos'],
  gsw: ['warriors', 'golden state warriors'],
  warriors: ['gsw'],
  nba: ['basketball'],
  nfl: ['football'],
  mlb: ['baseball'],
  nhl: ['hockey'],
  kc: ['chiefs', 'kansas city'],
  chiefs: ['kc'],
  sf: ['49ers', 'niners', 'san francisco'],
  '49ers': ['sf', 'niners'],
  niners: ['sf', '49ers'],
  philly: ['philadelphia', 'eagles'],
  eagles: ['philly'],
  bucs: ['buccaneers', 'tampa'],
  buccaneers: ['bucs'],
};

function expandToken(t: string): Set<string> {
  const out = new Set<string>([t]);
  const aliases = TOKEN_ALIASES[t];
  if (aliases) for (const a of aliases) out.add(a);
  return out;
}

/** Extract tokens for overlap scoring (length > 1 to skip single chars) */
function tokenize(s: string): Set<string> {
  const normalized = normalizeTitle(s);
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 1);
  return new Set(tokens);
}

/** Whether token from set A matches any token in set B (direct or via alias) */
function tokenMatchesAny(aToken: string, bSet: Set<string>): boolean {
  if (bSet.has(aToken)) return true;
  const expanded = expandToken(aToken);
  for (const e of expanded) {
    if (e !== aToken && bSet.has(e)) return true;
  }
  return false;
}

/** Number of tokens that appear in both sets (or match via alias) */
function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) {
    if (tokenMatchesAny(x, b)) n++;
  }
  return n;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = overlapCount(a, b);
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Parse ISO or partial date for comparison */
function parseResolutionDay(resolutionTime?: string): string | null {
  if (!resolutionTime) return null;
  const d = resolutionTime.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * Match Polymarket and Kalshi markets by title similarity and optional resolution date.
 * Uses: (1) Jaccard similarity threshold, or (2) at least minOverlapTokens in common.
 *
 * For each Polymarket market we keep only the ONE Kalshi market that best represents
 * the same outcome (same team/result), by picking the Kalshi market whose yes price
 * is closest to Polymarket's yes price. This avoids pairing "Real Madrid wins" (PM)
 * with "Girona wins" (Kalshi 1¢) when "Real Madrid wins" (Kalshi 55¢) is the correct pair.
 */
export function matchMarkets(
  polymarketMarkets: PolymarketMarketWithKind[],
  kalshiMarkets: UnifiedMarket[],
  options: {
    minTitleSimilarity?: number;
    minOverlapTokens?: number;
    requireSameDay?: boolean;
  } = {}
): MatchedPair[] {
  const minSim = options.minTitleSimilarity ?? 0.15;
  const minOverlap = options.minOverlapTokens ?? 2;
  const requireSameDay = options.requireSameDay ?? false;
  const rawPairs: MatchedPair[] = [];

  for (const pm of polymarketMarkets) {
    const pmTokens = tokenize(pm.question);
    const pmDay = parseResolutionDay(pm.resolutionTime);

    for (const k of kalshiMarkets) {
      const kDay = parseResolutionDay(k.resolutionTime);
      if (requireSameDay && (pmDay == null || kDay == null || pmDay !== kDay)) {
        continue;
      }
      const kTokens = tokenize(k.question);
      const overlap = overlapCount(pmTokens, kTokens);
      const sim = jaccardSimilarity(pmTokens, kTokens);
      const match = sim >= minSim || overlap >= minOverlap;
      if (match) {
        rawPairs.push({ polymarket: pm, kalshi: k });
      }
    }
  }

  // One Polymarket market can match many Kalshi markets (e.g. "La Liga" → Real Madrid, Barcelona, Girona...).
  // Keep only the Kalshi market that is the same outcome: closest yes price to PM yes price.
  const pairsByPmId = new Map<string, MatchedPair[]>();
  for (const pair of rawPairs) {
    const id = pair.polymarket.id;
    if (!pairsByPmId.has(id)) pairsByPmId.set(id, []);
    pairsByPmId.get(id)!.push(pair);
  }

  const pairs: MatchedPair[] = [];
  for (const [, group] of pairsByPmId) {
    if (group.length === 0) continue;
    if (group.length === 1) {
      pairs.push(group[0]);
      continue;
    }
    const pm = group[0].polymarket;
    let best = group[0];
    let bestDist = Math.abs(group[0].kalshi.yesPriceCents - pm.yesPriceCents);
    for (let i = 1; i < group.length; i++) {
      const dist = Math.abs(group[i].kalshi.yesPriceCents - pm.yesPriceCents);
      if (dist < bestDist) {
        bestDist = dist;
        best = group[i];
      }
    }
    pairs.push(best);
  }

  return pairs;
}
