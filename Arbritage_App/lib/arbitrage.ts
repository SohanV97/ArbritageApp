import type { ArbitrageOpportunity, BinarySide, Venue } from './market-types';
import type { MatchedPair } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import {
  estimatePolymarketFeeCents,
  estimateKalshiFeeCents,
} from './fees';

const CONTRACTS_PER_LEG = 1;

type PairWithKind = { polymarket: PolymarketMarketWithKind; kalshi: MatchedPair['kalshi'] };

function computeLeg(
  venue: Venue,
  side: BinarySide,
  priceCents: number,
  polymarketFeeKind?: PolymarketMarketWithKind['polymarketFeeKind']
): { priceCents: number; feeCents: number } {
  const feeCents =
    venue === 'polymarket'
      ? estimatePolymarketFeeCents(polymarketFeeKind ?? 'fee_free', priceCents, CONTRACTS_PER_LEG)
      : estimateKalshiFeeCents(priceCents, CONTRACTS_PER_LEG);
  return { priceCents, feeCents };
}

/**
 * For a matched pair, compute both arb directions (Yes on A + No on B, No on A + Yes on B).
 * Returns opportunities where total cost (prices + fees) < 100.
 */
export function findArbitrageOpportunities(
  pairs: PairWithKind[],
  minEdgePercent = 0
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];

  for (const pair of pairs) {
    const pm = pair.polymarket;
    const k = pair.kalshi;
    const kind = pm.polymarketFeeKind ?? 'fee_free';

    // Direction 1: Yes Polymarket + No Kalshi
    const legPmYes = computeLeg('polymarket', 'yes', pm.yesPriceCents, kind);
    const legKNo = computeLeg('kalshi', 'no', k.noPriceCents);
    const cost1 = legPmYes.priceCents + legPmYes.feeCents + legKNo.priceCents + legKNo.feeCents;
    if (cost1 < 100) {
      const edgePercent = ((100 - cost1) / 100) * 100;
      if (edgePercent >= minEdgePercent) {
        opportunities.push({
          pair: { polymarket: pm, kalshi: k },
          legA: { venue: 'polymarket', side: 'yes', priceCents: legPmYes.priceCents, feeCents: legPmYes.feeCents },
          legB: { venue: 'kalshi', side: 'no', priceCents: legKNo.priceCents, feeCents: legKNo.feeCents },
          totalCostCents: cost1,
          maxPayoutCents: 100,
          edgePercent,
        });
      }
    }

    // Direction 2: No Polymarket + Yes Kalshi
    const legPmNo = computeLeg('polymarket', 'no', pm.noPriceCents, kind);
    const legKYes = computeLeg('kalshi', 'yes', k.yesPriceCents);
    const cost2 = legPmNo.priceCents + legPmNo.feeCents + legKYes.priceCents + legKYes.feeCents;
    if (cost2 < 100) {
      const edgePercent = ((100 - cost2) / 100) * 100;
      if (edgePercent >= minEdgePercent) {
        opportunities.push({
          pair: { polymarket: pm, kalshi: k },
          legA: { venue: 'polymarket', side: 'no', priceCents: legPmNo.priceCents, feeCents: legPmNo.feeCents },
          legB: { venue: 'kalshi', side: 'yes', priceCents: legKYes.priceCents, feeCents: legKYes.feeCents },
          totalCostCents: cost2,
          maxPayoutCents: 100,
          edgePercent,
        });
      }
    }

  }

  return opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
}
