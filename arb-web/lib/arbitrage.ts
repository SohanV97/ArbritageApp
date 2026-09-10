import type { ArbitrageOpportunity, BinarySide, MatchedPair, Venue } from './market-types';
import { MIN_ORDER_CONTRACTS } from './market-types';
import { quoteIsTradeable } from './depth';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import { estimatePolymarketFeeCents, estimateKalshiFeeCents } from './fees';

const CONTRACTS_PER_LEG = 1;

export type PairWithKind = { polymarket: PolymarketMarketWithKind; kalshi: MatchedPair['kalshi'] };

// A tradeable contract price: a real number in 1–99 cents. Rejects NaN/Infinity/
// undefined/null and non-numeric values, all of which pass a naive `< 1` check.
function isValidPriceCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 99;
}

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
    // Validate explicitly rather than with `< 1`: that comparison is FALSE for NaN and
    // undefined, so a corrupt price used to sail through and produce an opportunity with
    // edge = NaN, which then rendered as "NaN%" and could be handed to the order path.
    if (!isValidPriceCents(pm.yesPriceCents) || !isValidPriceCents(pm.noPriceCents)
      || !isValidPriceCents(k.yesPriceCents) || !isValidPriceCents(k.noPriceCents)) continue;
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

    // Kalshi's quoted ask can be backed by a resting order of 0.01 contracts, and that dust
    // sets the quote. Pricing a leg off it manufactures an edge that disappears the instant
    // anyone tries to take it: the pre-order depth check then finds zero fillable contracts
    // and backs out, so the card was never tradeable in the first place. The size at each
    // ask arrives in the same batched request as the price, so this costs nothing.
    const noUsable = quoteIsTradeable(k.noDepth, MIN_ORDER_CONTRACTS);
    const yesUsable = quoteIsTradeable(k.yesDepth, MIN_ORDER_CONTRACTS);
    const usableEdge1 = noUsable ? edge1 : Number.NEGATIVE_INFINITY;
    const usableEdge2 = yesUsable ? edge2 : Number.NEGATIVE_INFINITY;

    // Pick the best leg combo; include it if its edge meets the threshold
    const bestEdge = Math.max(usableEdge1, usableEdge2);
    if (!Number.isFinite(bestEdge) || bestEdge < minEdgePercent) continue;

    if (usableEdge1 >= usableEdge2) {
      // Kalshi leg buys NO → fillable size is the NO-side depth
      opportunities.push({ pair: { polymarket: pm, kalshi: k }, legA: { venue: 'polymarket', side: 'yes', ...legPmYes }, legB: { venue: 'kalshi', side: 'no', ...legKNo }, totalCostCents: cost1, maxPayoutCents: 100, edgePercent: edge1, maxContracts: k.noDepth });
    } else {
      opportunities.push({ pair: { polymarket: pm, kalshi: k }, legA: { venue: 'polymarket', side: 'no', ...legPmNo }, legB: { venue: 'kalshi', side: 'yes', ...legKYes }, totalCostCents: cost2, maxPayoutCents: 100, edgePercent: edge2, maxContracts: k.yesDepth });
    }
  }

  return opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
}
