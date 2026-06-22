import type { UnifiedMarket, MatchedPair } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s@]/g, ' ')
    .replace(/\b(the|baseball|mlb|game|moneyline|winner|will|beat|to|win)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TOKEN_ALIASES: Record<string, string[]> = {
  nyy: ['yankees'], bos: ['red sox', 'redsox'], tor: ['blue jays', 'bluejays'],
  bal: ['orioles'], tb: ['rays'], tbr: ['rays'],
  cle: ['guardians'], det: ['tigers'], kc: ['royals', 'kansas city'],
  kcr: ['royals', 'kansas city'], min: ['twins'], cws: ['white sox', 'whitesox'],
  hou: ['astros'], tex: ['rangers'], sea: ['mariners'], laa: ['angels'], oak: ['athletics'],
  atl: ['braves'], phi: ['phillies'], nym: ['mets'], mia: ['marlins'],
  wsh: ['nationals'], was: ['nationals'],
  chc: ['cubs'], mil: ['brewers'], pit: ['pirates'], stl: ['cardinals'], cin: ['reds'],
  lad: ['dodgers'], sf: ['giants'], sfg: ['giants'],
  ari: ['diamondbacks', 'd-backs'], col: ['rockies'], sd: ['padres'], sdp: ['padres'],
};

function expandToken(t: string): Set<string> {
  const out = new Set<string>([t]);
  const aliases = TOKEN_ALIASES[t];
  // Array.isArray guards against prototype properties (e.g. TOKEN_ALIASES['constructor'])
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
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

function tokenMatchesAny(aToken: string, bSet: Set<string>): boolean {
  if (bSet.has(aToken)) return true;
  for (const e of expandToken(aToken)) { if (e !== aToken && bSet.has(e)) return true; }
  return false;
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) { if (tokenMatchesAny(x, b)) n++; }
  return n;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = overlapCount(a, b);
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
  options: { minTitleSimilarity?: number; minOverlapTokens?: number; requireSameDay?: boolean } = {}
): MatchedPair[] {
  const minSim = options.minTitleSimilarity ?? 0.35;
  const minOverlap = options.minOverlapTokens ?? 2;
  const requireSameDay = options.requireSameDay ?? false;
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
      const overlap = overlapCount(pmTokens, kTokens);
      let sim = jaccardSimilarity(pmTokens, kTokens);

      if (pmTeams[0].size > 0 && pmTeams[1].size > 0 && kTeams[0].size > 0 && kTeams[1].size > 0) {
        const directMatch = overlapCount(pmTeams[0], kTeams[0]) > 0 && overlapCount(pmTeams[1], kTeams[1]) > 0;
        const flippedMatch = overlapCount(pmTeams[0], kTeams[1]) > 0 && overlapCount(pmTeams[1], kTeams[0]) > 0;
        if (!directMatch && !flippedMatch) sim -= 1.0;
      }

      if (sim >= minSim && overlap >= minOverlap) rawPairs.push({ polymarket: pm, kalshi: k });
    }
  }

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
