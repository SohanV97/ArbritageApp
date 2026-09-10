/**
 * Position sizing from a dollar budget.
 *
 * Orders are placed in contracts, but a contract is not a natural unit to think in: its
 * cost depends on the pair of prices, so "20 contracts" is a different amount of money in
 * every market. This converts the number a trader actually has in mind — how much cash to
 * put at risk on this trade — into the contract count the venues need.
 *
 * An arb buys one side on each venue: legA at its price, legB at its price, summing to less
 * than $1.00. Each contract pays out exactly $1 whichever way the event resolves, so the
 * capital deployed is contracts x (legA + legB), and the profit is the shortfall from $1.
 * The budget is spread across BOTH legs — a $300 risk means $300 total, roughly half landing
 * on each venue, not $300 per venue.
 */
/**
 * Polymarket's 5-share floor, inlined rather than imported.
 *
 * A value import of MIN_ORDER_CONTRACTS from './market-types' cannot be resolved by bare
 * Node (no extension, and tsconfig does not allow importing .ts paths), which is what the
 * offline test runner uses. Callers in the app pass MIN_ORDER_CONTRACTS explicitly, and a
 * test pins this default to that constant so the two cannot drift apart.
 */
const DEFAULT_MIN_CONTRACTS = 5;

export interface RiskSizing {
  /** Contracts to buy on each leg. Zero means this trade cannot be placed at this budget. */
  contracts: number;
  /** Capital actually deployed across both legs — at or just under the budget, never over. */
  costDollars: number;
  /** Split of that capital, so the trader can see what each venue needs to cover. */
  legADollars: number;
  legBDollars: number;
  /** Guaranteed return if both legs fill: contracts x $1. */
  payoutDollars: number;
  /** Locked-in profit, being the shortfall of the combined price from $1 per contract. */
  profitDollars: number;
  /** What determined the final size, so the UI can explain itself rather than just shrink. */
  limitedBy: 'risk' | 'depth' | 'below-minimum';
}

const NOTHING: RiskSizing = {
  contracts: 0,
  costDollars: 0,
  legADollars: 0,
  legBDollars: 0,
  payoutDollars: 0,
  profitDollars: 0,
  limitedBy: 'below-minimum',
};

export function sizeByRisk(params: {
  /** Total dollars to deploy across both legs combined. */
  riskDollars: number;
  legAPriceCents: number;
  legBPriceCents: number;
  /** Contracts the thinner of the two books can actually fill, when known. */
  maxContracts?: number | null;
  /** Venue minimum. Defaults to Polymarket's 5-share floor. */
  minContracts?: number;
}): RiskSizing {
  const { riskDollars, legAPriceCents, legBPriceCents, maxContracts } = params;
  const minContracts = params.minContracts ?? DEFAULT_MIN_CONTRACTS;
  const totalCents = legAPriceCents + legBPriceCents;

  // Guard every non-finite path: a NaN here becomes a NaN order size, and Math.min does
  // not filter it out — it propagates all the way to a live venue.
  if (!Number.isFinite(riskDollars) || riskDollars <= 0) return NOTHING;
  if (!Number.isFinite(totalCents) || totalCents <= 0) return NOTHING;

  // Convert the budget to whole cents FIRST, then divide integers. Dividing the float
  // directly loses contracts at exact boundaries: 4.85 * 100 is 484.99999999999994, so a
  // budget that affords exactly 5 contracts at 97c floors to 4 — and at the venue minimum
  // that turns a valid trade into no trade at all.
  const budgetCents = Math.round(riskDollars * 100);
  if (!Number.isFinite(budgetCents) || budgetCents <= 0) return NOTHING;

  // Floor, never round up: spending more than the stated budget is the one thing a risk
  // limit must never do.
  let contracts = Math.floor(budgetCents / totalCents);
  let limitedBy: RiskSizing['limitedBy'] = 'risk';

  if (maxContracts != null && Number.isFinite(maxContracts) && maxContracts < contracts) {
    contracts = Math.floor(maxContracts);
    limitedBy = 'depth';
  }

  // Below the venue minimum the Polymarket leg is rejected while Kalshi fills, which is a
  // naked position rather than a small one. Report zero so callers skip it outright.
  if (contracts < minContracts) return { ...NOTHING };

  const costDollars = (contracts * totalCents) / 100;
  return {
    contracts,
    costDollars,
    legADollars: (contracts * legAPriceCents) / 100,
    legBDollars: (contracts * legBPriceCents) / 100,
    payoutDollars: contracts,
    profitDollars: contracts - costDollars,
    limitedBy,
  };
}
