import type { ArbitrageOpportunity, BinarySide, MatchedPair, Venue } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import { estimatePolymarketFeeCents, estimateKalshiFeeCents } from './fees';

const CONTRACTS_PER_LEG = 1;

export type PairWithKind = { polymarket: PolymarketMarketWithKind; kalshi: MatchedPair['kalshi'] };

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

export function findArbitrageOpportunities(
  pairs: PairWithKind[],
  minEdgePercent = 0
): ArbitrageOpportunity[] {
  const opportunities: ArbitrageOpportunity[] = [];

  for (const pair of pairs) {
    const pm = pair.polymarket;
    const k = pair.kalshi;
    if (pm.yesPriceCents < 1 || pm.noPriceCents < 1 || k.yesPriceCents < 1 || k.noPriceCents < 1) continue;
    const kind = pm.polymarketFeeKind ?? 'fee_free';

    const legPmYes = computeLeg('polymarket', 'yes', pm.yesPriceCents, kind);
    const legKNo = computeLeg('kalshi', 'no', k.noPriceCents);
    const cost1 = legPmYes.priceCents + legPmYes.feeCents + legKNo.priceCents + legKNo.feeCents;
    // Allow negative edge so "near arb" pairs bubble up correctly (previously clamped to 0)
    const edge1 = ((100 - cost1) / 100) * 100;

    const legPmNo = computeLeg('polymarket', 'no', pm.noPriceCents, kind);
    const legKYes = computeLeg('kalshi', 'yes', k.yesPriceCents);
    const cost2 = legPmNo.priceCents + legPmNo.feeCents + legKYes.priceCents + legKYes.feeCents;
    const edge2 = ((100 - cost2) / 100) * 100;

    // Pick the best leg combo; include it if its edge meets the threshold
    const bestEdge = Math.max(edge1, edge2);
    if (bestEdge < minEdgePercent) continue;

    if (edge1 >= edge2) {
      opportunities.push({ pair: { polymarket: pm, kalshi: k }, legA: { venue: 'polymarket', side: 'yes', ...legPmYes }, legB: { venue: 'kalshi', side: 'no', ...legKNo }, totalCostCents: cost1, maxPayoutCents: 100, edgePercent: edge1 });
    } else {
      opportunities.push({ pair: { polymarket: pm, kalshi: k }, legA: { venue: 'polymarket', side: 'no', ...legPmNo }, legB: { venue: 'kalshi', side: 'yes', ...legKYes }, totalCostCents: cost2, maxPayoutCents: 100, edgePercent: edge2 });
    }
  }

  return opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
}
