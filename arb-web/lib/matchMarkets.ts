import type { UnifiedMarket, MatchedPair } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')   // strip ISO dates before splitting on punctuation
    .replace(/'s\b/g, 's')                 // "A's" → "As" so it tokenizes as a 2-char token
    .replace(/[^\w\s@]/g, ' ')
    .replace(/\b(the|on|end|in|draw|baseball|mlb|nba|nfl|nhl|game|moneyline|winner|will|beat|to|win|hockey|basketball|football)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandToken(t: string, aliases: Record<string, string[]>): Set<string> {
  const out = new Set<string>([t]);
  const aliasList = aliases[t];
  if (Array.isArray(aliasList)) {
    for (const a of aliasList) {
      out.add(a);
      const normalized = normalizeTitle(a).replace(/\b(?:vs|at|@)\b/g, '').replace(/\s+/g, ' ').trim();
      if (normalized.includes(' ')) {
        for (const part of normalized.split(/\s+/)) { if (part.length > 1) out.add(part); }
      }
    }
  }
  return out;
}

function tokenize(s: string): Set<string> {
  const normalized = normalizeTitle(s).replace(/\b(?:vs|at|@)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return new Set(normalized.split(/\s+/).filter(t => t.length > 1));
}

function tokenMatchesAny(aToken: string, bSet: Set<string>, aliases: Record<string, string[]>): boolean {
  if (bSet.has(aToken)) return true;
  for (const e of expandToken(aToken, aliases)) { if (e !== aToken && bSet.has(e)) return true; }
  return false;
}

function overlapCount(a: Set<string>, b: Set<string>, aliases: Record<string, string[]>): number {
  let n = 0;
  for (const x of a) { if (tokenMatchesAny(x, b, aliases)) n++; }
  return n;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>, aliases: Record<string, string[]>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = overlapCount(a, b, aliases);
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function parseResolutionDay(resolutionTime?: string): string | null {
  if (!resolutionTime) return null;
  const d = resolutionTime.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function getTeams(q: string): [Set<string>, Set<string>] {
  const bracketMatch = q.match(/\[(.*?)\]$/);
  const textToParse = bracketMatch ? bracketMatch[1] : q;
  const lower = normalizeTitle(textToParse);
  const parts = lower.split(/\b(?:\s+vs\s+|\s+at\s+|\s+@\s+)\b/);
  if (parts.length >= 2) return [tokenize(parts[0]), tokenize(parts[parts.length - 1])];
  return [tokenize(q), new Set()];
}

export function matchMarkets(
  polymarketMarkets: PolymarketMarketWithKind[],
  kalshiMarkets: UnifiedMarket[],
  options: {
    minTitleSimilarity?: number;
    minOverlapTokens?: number;
    requireSameDay?: boolean;
    aliases?: Record<string, string[]>;
  } = {}
): MatchedPair[] {
  const minSim = options.minTitleSimilarity ?? 0.35;
  const minOverlap = options.minOverlapTokens ?? 2;
  const requireSameDay = options.requireSameDay ?? false;
  const aliases = options.aliases ?? {};
  const rawPairs: MatchedPair[] = [];

  for (const pm of polymarketMarkets) {
    const pmTokens = tokenize(pm.question);
    const pmDay = parseResolutionDay(pm.resolutionTime);
    const pmTeams = getTeams(pm.question);

    for (const k of kalshiMarkets) {
      const kDay = parseResolutionDay(k.resolutionTime);
      // Only enforce date check when both dates are present; allow ±1 calendar day for UTC/ET offset
      if (requireSameDay && pmDay !== null && kDay !== null) {
        if (Math.abs(Date.parse(pmDay) - Date.parse(kDay)) > 86_400_000) continue;
      }

      const kTokens = tokenize(k.question);
      const kTeams = getTeams(k.question);
      const overlap = overlapCount(pmTokens, kTokens, aliases);
      let sim = jaccardSimilarity(pmTokens, kTokens, aliases);

      if (pmTeams[0].size > 0 && pmTeams[1].size > 0 && kTeams[0].size > 0 && kTeams[1].size > 0) {
        const directMatch =
          overlapCount(pmTeams[0], kTeams[0], aliases) > 0 &&
          overlapCount(pmTeams[1], kTeams[1], aliases) > 0;
        const flippedMatch =
          overlapCount(pmTeams[0], kTeams[1], aliases) > 0 &&
          overlapCount(pmTeams[1], kTeams[0], aliases) > 0;
        if (!directMatch && !flippedMatch) sim -= 1.0;
      }

      if (sim >= minSim && overlap >= minOverlap) rawPairs.push({ polymarket: pm, kalshi: k });
    }
  }

  // Deduplicate: per Polymarket market keep the Kalshi market whose price is closest
  const pairsByPmId = new Map<string, MatchedPair[]>();
  for (const pair of rawPairs) {
    const id = pair.polymarket.id;
    if (!pairsByPmId.has(id)) pairsByPmId.set(id, []);
    pairsByPmId.get(id)!.push(pair);
  }

  const finalPairs: MatchedPair[] = [];
  for (const [, group] of pairsByPmId) {
    if (group.length === 0) continue;
    const pm = group[0].polymarket;
    let best = group[0];
    let bestDist = Math.min(
      Math.abs(group[0].kalshi.yesPriceCents - pm.yesPriceCents),
      Math.abs(group[0].kalshi.noPriceCents - pm.yesPriceCents)
    );
    for (let i = 1; i < group.length; i++) {
      const dist = Math.min(
        Math.abs(group[i].kalshi.yesPriceCents - pm.yesPriceCents),
        Math.abs(group[i].kalshi.noPriceCents - pm.yesPriceCents)
      );
      if (dist < bestDist) { bestDist = dist; best = group[i]; }
    }
    finalPairs.push(best);
  }

  return finalPairs;
}
