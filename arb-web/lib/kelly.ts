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
  const fraction = Math.min((edgePercent / 100) * 2, 0.20);
  return Math.max(1, Math.round(bankroll * fraction));
}
