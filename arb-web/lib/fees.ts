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

export function estimatePolymarketFeeCents(
  marketKind: PolymarketMarketKind,
  priceCents: number,
  contracts: number
): number {
  const params = POLYMARKET_FEE_TABLE[marketKind];
  if (!params || params.feeRate === 0 || contracts <= 0) return 0;
  const p = Math.max(0, Math.min(1, priceCents / 100));
  const base = p * (1 - p);
  const feeUsd = contracts * params.feeRate * Math.pow(base, params.exponent);
  // Return fractional cents so edge calculations stay accurate for small positions
  return Math.max(0, feeUsd * 100);
}

export function estimateKalshiFeeCents(priceCents: number, contracts: number): number {
  if (contracts <= 0) return 0;
  // Kalshi charges 3% of profit on winning contracts; use worst-case (assume this leg wins)
  return Math.ceil(0.03 * (100 - priceCents) * contracts);
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
