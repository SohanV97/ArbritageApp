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

/** Extract tokens for overlap scoring */
function tokenize(s: string): Set<string> {
  const normalized = normalizeTitle(s);
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 1);
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) {
    if (b.has(x)) intersection++;
  }
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
 * Returns pairs that are likely the same event.
 */
export function matchMarkets(
  polymarketMarkets: PolymarketMarketWithKind[],
  kalshiMarkets: UnifiedMarket[],
  options: { minTitleSimilarity?: number; requireSameDay?: boolean } = {}
): MatchedPair[] {
  const minSim = options.minTitleSimilarity ?? 0.25;
  const requireSameDay = options.requireSameDay ?? false;
  const pairs: MatchedPair[] = [];

  for (const pm of polymarketMarkets) {
    const pmTokens = tokenize(pm.question);
    const pmDay = parseResolutionDay(pm.resolutionTime);

    for (const k of kalshiMarkets) {
      const kDay = parseResolutionDay(k.resolutionTime);
      if (requireSameDay && (pmDay == null || kDay == null || pmDay !== kDay)) {
        continue;
      }
      const kTokens = tokenize(k.question);
      const sim = jaccardSimilarity(pmTokens, kTokens);
      if (sim >= minSim) {
        pairs.push({ polymarket: pm, kalshi: k });
      }
    }
  }

  return pairs;
}
