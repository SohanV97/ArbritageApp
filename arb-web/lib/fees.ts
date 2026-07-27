import type { Venue } from './market-types';

export type PolymarketMarketKind = 'fee_free' | 'sports' | 'short_term_crypto';

export interface PolymarketFeeParams {
  feeRate: number;
  exponent: number;
}

// Per Polymarket's published taker-fee schedule (help.polymarket.com, effective
// 2026-03-30): sports fee = 0.03 × p × (1−p) per share, peaking at $0.75 per 100
// shares at 50¢. Geopolitics/politics markets are fee-free. Fees hit taker buys —
// which is every leg this app takes.
const POLYMARKET_FEE_TABLE: Record<PolymarketMarketKind, PolymarketFeeParams> = {
  fee_free: { feeRate: 0, exponent: 1 },
  sports: { feeRate: 0.03, exponent: 1 },
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
  // Kalshi's general trading fee: 0.07 × contracts × price × (1 − price), charged on
  // execution (win or lose) and rounded UP to the next whole cent per order. We apply
  // that ceil so the edge is never overstated — e.g. a single 50¢ contract is billed
  // 2¢ (ceil of 1.75¢), not 1.75¢.
  const p = Math.max(0, Math.min(1, priceCents / 100));
  return Math.ceil(0.07 * p * (1 - p) * 100 * contracts);
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
