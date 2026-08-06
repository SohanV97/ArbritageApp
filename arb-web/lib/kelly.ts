/**
 * Fractional Kelly bet sizing for arbitrage.
 *
 * Pure arb is theoretically risk-free, so full Kelly = all-in.
 * In practice, execution risk (one leg fills, other doesn't) caps us.
 * We use quarter-Kelly scaled by edge strength, capped at 20% of bankroll.
 *
 * Examples at $10k bankroll:
 *   1% edge → $200   (2% of bankroll)
 *   2% edge → $400   (4%)
 *   5% edge → $1000  (10%)
 *   10%+ edge → $2000 (20% hard cap)
 */
export function kellyBet(bankroll: number, edgePercent: number): number {
  // Guard non-finite inputs: Math.min(NaN, 0.2) is NaN and propagates all the way to
  // an order size, so a single bad number would size a real trade as NaN.
  if (!Number.isFinite(bankroll) || bankroll <= 0) return 1;
  if (!Number.isFinite(edgePercent) || edgePercent <= 0) return 1;
  const fraction = Math.min((edgePercent / 100) * 2, 0.20);
  const bet = Math.round(bankroll * fraction);
  return Number.isFinite(bet) ? Math.max(1, bet) : 1;
}
