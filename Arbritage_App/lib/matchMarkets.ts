import type { UnifiedMarket } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import type { MatchedPair } from './market-types';

export interface ArbitrageOpportunity {
  isArb: boolean;
  scenario1Cost: number; 
  scenario2Cost: number; 
  scenario1Profit: number;
  scenario2Profit: number;
  scenario1Description: string;
  scenario2Description: string;
}

export type AnalyzedPair = MatchedPair & {
  arbitrage: ArbitrageOpportunity;
};

/** Normalize text for matching: lowercase, expand abbreviations, strip noise */
function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bst\.?\b/g, 'state')
    .replace(/\bva\.?\b/g, 'virginia')
    .replace(/\bnc\.?\b/g, 'north carolina')
    .replace(/\ba&m\b/g, 'am')
    .replace(/[^\w\s@]/g, ' ') // Keep @ for splitting later
    .replace(/\b(the|men|mens|women|womens|basketball|ncaab|ncaa|game|moneyline|winner)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common abbreviations */
const TOKEN_ALIASES: Record<string, string[]> = {
  lal: ['lakers'], lac: ['clippers'], bos: ['celtics'], nyk: ['knicks'], bkn: ['nets'],
  chi: ['bulls'], cle: ['cavaliers', 'cavs'], ind: ['pacers'], phi: ['76ers', 'sixers'],
  mil: ['bucks'], mia: ['heat'], atl: ['hawks'], cha: ['hornets'], det: ['pistons'],
  tor: ['raptors'], was: ['wizards'], gsw: ['warriors'], hou: ['rockets'],
  dal: ['mavericks', 'mavs'], den: ['nuggets'], mem: ['grizzlies'], min: ['timberwolves', 'wolves'],
  nop: ['pelicans'], okc: ['thunder'], orl: ['magic'], phx: ['suns'], por: ['blazers'],
  sac: ['kings'], sas: ['spurs'], uta: ['jazz'],
  unc: ['north carolina', 'tar heels'], 
  usc: ['southern california', 'trojans'],
  ucla: ['bruins'],
  lsu: ['louisiana state', 'tigers'],
  ucf: ['central florida', 'knights'],
  smu: ['southern methodist', 'mustangs'],
  tcu: ['texas christian', 'horned frogs'],
  byu: ['brigham young', 'cougars'],
  msu: ['michigan state', 'spartans'],
  umass: ['massachusetts', 'minutemen'],
  pitt: ['pittsburgh', 'panthers'],
  sdsu: ['san diego state', 'aztecs']
};

function expandToken(t: string): Set<string> {
  const out = new Set<string>([t]);
  const aliases = TOKEN_ALIASES[t];
  if (aliases) {
    for (const a of aliases) {
      out.add(a);
      const normalized = normalizeTitle(a)
        .replace(/\b(?:vs|at|@)\b/g, '') // strip matchup delimiters when expanding
        .replace(/\s+/g, ' ')
        .trim();
      if (normalized.includes(' ')) {
        for (const part of normalized.split(/\s+/)) {
          if (part.length > 1) out.add(part);
        }
      }
    }
  }
  return out;
}

function tokenize(s: string): Set<string> {
  const normalized = normalizeTitle(s)
    .replace(/\b(?:vs|at|@)\b/g, ' ') // Clean out delimiters for pure token matching
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 1);
  return new Set(tokens);
}

function tokenMatchesAny(aToken: string, bSet: Set<string>): boolean {
  if (bSet.has(aToken)) return true;
  const expanded = expandToken(aToken);
  for (const e of expanded) {
    if (e !== aToken && bSet.has(e)) return true;
  }
  return false;
}

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

function parseResolutionDay(resolutionTime?: string): string | null {
  if (!resolutionTime) return null;
  const d = resolutionTime.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// ==========================================
// THE BIPARTITE MATCHUP EXTRACTOR
// ==========================================
// Forcefully slices a matchup string into [Team 1, Team 2] to prevent cross-contamination
function getTeams(q: string): [Set<string>, Set<string>] {
  // If Polymarket appended the clean brackets [TeamA vs TeamB], use ONLY the brackets
  const bracketMatch = q.match(/\[(.*?)\]$/);
  let textToParse = bracketMatch ? bracketMatch[1] : q;

  const lower = normalizeTitle(textToParse);
  const parts = lower.split(/\b(?:\s+vs\s+|\s+at\s+|\s+@\s+)\b/);

  if (parts.length >= 2) {
    return [tokenize(parts[0]), tokenize(parts[parts.length - 1])];
  }
  return [tokenize(q), new Set()];
}

export function matchMarkets(
  polymarketMarkets: PolymarketMarketWithKind[],
  kalshiMarkets: UnifiedMarket[],
  options: {
    minTitleSimilarity?: number;
    minOverlapTokens?: number;
    requireSameDay?: boolean;
    debug?: boolean;
    debugTopCandidates?: number;
  } = {}
): AnalyzedPair[] {
  const minSim = options.minTitleSimilarity ?? 0.35; 
  const minOverlap = options.minOverlapTokens ?? 2;
  const requireSameDay = options.requireSameDay ?? false;
  const debug = options.debug ?? false;
  const debugTop = options.debugTopCandidates ?? 3;
  const rawPairs: MatchedPair[] = [];

  const STRICT_MODIFIERS = [
    'state', 'tech', 'eastern', 'western', 'northern', 'southern', 'central', 
    'am', 'saint', 'san', 'poly'
  ];

  for (const pm of polymarketMarkets) {
    const pmTokens = tokenize(pm.question);
    const pmDay = parseResolutionDay(pm.resolutionTime);
    const pmTeams = getTeams(pm.question); // Extract Team A and Team B

    let bestCandidates: Array<{ k: UnifiedMarket; overlap: number; sim: number }> = [];

    for (const k of kalshiMarkets) {
      const kDay = parseResolutionDay(k.resolutionTime);
      if (requireSameDay && (pmDay == null || kDay == null || pmDay !== kDay)) {
        continue;
      }
      
      const kTokens = tokenize(k.question);
      const kTeams = getTeams(k.question); // Extract Team A and Team B
      const overlap = overlapCount(pmTokens, kTokens);
      let sim = jaccardSimilarity(pmTokens, kTokens);
      
      // 1. THE BIPARTITE CHECK (Solves Cross-Contamination)
      // Both PM teams must share at least 1 word with the respective Kalshi teams!
      if (pmTeams[0].size > 0 && pmTeams[1].size > 0 && kTeams[0].size > 0 && kTeams[1].size > 0) {
        const directMatch = overlapCount(pmTeams[0], kTeams[0]) > 0 && overlapCount(pmTeams[1], kTeams[1]) > 0;
        const flippedMatch = overlapCount(pmTeams[0], kTeams[1]) > 0 && overlapCount(pmTeams[1], kTeams[0]) > 0;

        if (!directMatch && !flippedMatch) {
          sim -= 1.0; // Mathematically nuke the match if opponents don't align
        }
      }

      // 2. THE PENALTY CHECK (Solves Missing Modifiers)
      for (const word of STRICT_MODIFIERS) {
        const pmHas = pmTokens.has(word);
        const kHas = kTokens.has(word);
        if (pmHas !== kHas) {
          sim -= 0.4; 
        }
      }

      const match = sim >= minSim && overlap >= minOverlap;
      
      if (match) {
        rawPairs.push({ polymarket: pm, kalshi: k });
      } else if (debug && debugTop > 0) {
        bestCandidates.push({ k, overlap, sim });
      }
    }
  }

  // Deduplicate closest price (Account for flipped outcomes in distance check)
  const pairsByPmId = new Map<string, MatchedPair[]>();
  for (const pair of rawPairs) {
    const id = pair.polymarket.id;
    if (!pairsByPmId.has(id)) pairsByPmId.set(id, []);
    pairsByPmId.get(id)!.push(pair);
  }

  const finalPairs: AnalyzedPair[] = [];
  
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
      if (dist < bestDist) {
        bestDist = dist;
        best = group[i];
      }
    }

    const pmYes = best.polymarket.yesPriceCents;
    const pmNo = best.polymarket.noPriceCents;
    const kalYes = best.kalshi.yesPriceCents;
    const kalNo = best.kalshi.noPriceCents;

    const isAligned = Math.abs(pmYes - kalYes) < Math.abs(pmYes - kalNo);

    let cost1, cost2;
    let desc1, desc2;

    if (isAligned) {
      cost1 = pmYes + kalNo;
      cost2 = pmNo + kalYes;
      desc1 = `PM Yes (${pmYes}¢) + Kalshi No (${kalNo}¢)`;
      desc2 = `PM No (${pmNo}¢) + Kalshi Yes (${kalYes}¢)`;
    } else {
      cost1 = pmYes + kalYes;
      cost2 = pmNo + kalNo;
      desc1 = `PM Yes (${pmYes}¢) + Kalshi Yes (${kalYes}¢) [Flipped Teams]`;
      desc2 = `PM No (${pmNo}¢) + Kalshi No (${kalNo}¢) [Flipped Teams]`;
    }
    
    const isArb = cost1 < 100 || cost2 < 100;

    if (isArb) {
      console.log(`\n🚨 ARBITRAGE OPPORTUNITY FOUND! 🚨`);
      console.log(`PM: ${best.polymarket.question}`);
      console.log(`KAL: ${best.kalshi.question}`);
      if (cost1 < 100) console.log(`👉 ${desc1} = ${cost1}¢ total (${100 - cost1}¢ profit)`);
      if (cost2 < 100) console.log(`👉 ${desc2} = ${cost2}¢ total (${100 - cost2}¢ profit)`);
    }

    const analyzedPair: AnalyzedPair = {
      ...best,
      arbitrage: {
        isArb,
        scenario1Cost: cost1,
        scenario2Cost: cost2,
        scenario1Profit: 100 - cost1,
        scenario2Profit: 100 - cost2,
        scenario1Description: desc1,
        scenario2Description: desc2
      }
    };

    finalPairs.push(analyzedPair);
  }

  return finalPairs;
}