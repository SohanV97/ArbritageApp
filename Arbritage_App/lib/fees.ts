import type { Venue } from './market-types';

export type PolymarketMarketKind = 'fee_free' | 'sports' | 'short_term_crypto';

export interface PolymarketFeeParams {
  feeRate: number;
  exponent: number;
}

const POLYMARKET_FEE_TABLE: Record<PolymarketMarketKind, PolymarketFeeParams> = {
  fee_free: { feeRate: 0, exponent: 1 },
  sports: { feeRate: 0.0175, exponent: 1 },
  short_term_crypto: { feeRate: 0.25, exponent: 2 },
};

/**
 * Approximate Polymarket fee in cents for a given trade.
 *
 * C = number of shares
 * p = price in [0, 1]
 * fee = C × feeRate × (p × (1 - p))^exponent
 *
 * We then round to 4 decimals in USDC and convert to cents.
 */
export function estimatePolymarketFeeCents(
  marketKind: PolymarketMarketKind,
  priceCents: number,
  contracts: number
): number {
  const params = POLYMARKET_FEE_TABLE[marketKind];
  if (!params || params.feeRate === 0 || contracts <= 0) {
    return 0;
  }
  const p = Math.max(0, Math.min(1, priceCents / 100));
  const base = p * (1 - p);
  const feeUsd = contracts * params.feeRate * Math.pow(base, params.exponent);
  const roundedUsd = Math.max(0, Math.round(feeUsd * 10000) / 10000);
  if (roundedUsd < 0.0001) {
    return 0;
  }
  return Math.round(roundedUsd * 100);
}

/**
 * Very rough Kalshi fee approximation in cents for a single-leg trade.
 *
 * The structure is:
 * - Fee scales with price and contracts, peaking near 50c and getting smaller toward extremes.
 * - We intentionally over-estimate a bit so arb edges are conservative.
 */
export function estimateKalshiFeeCents(priceCents: number, contracts: number): number {
  if (contracts <= 0) return 0;
  const p = Math.max(0, Math.min(1, priceCents / 100));
  const maxPotentialProfitCents = Math.round(contracts * (100 - priceCents));
  const shape = p * (1 - p);
  const baseRate = 0.015;
  const feeCents = maxPotentialProfitCents * baseRate * shape * 4;
  return Math.ceil(feeCents);
}

export function estimateFeeCentsForVenue(
  venue: Venue,
  priceCents: number,
  contracts: number,
  polymarketKind: PolymarketMarketKind = 'fee_free'
): number {
  if (venue === 'polymarket') {
    return estimatePolymarketFeeCents(polymarketKind, priceCents, contracts);
  }
  return estimateKalshiFeeCents(priceCents, contracts);
}

