/**
 * How to spread Kalshi collateral across exchange shards.
 *
 * Kalshi funds an order only from the shard its market sits on, so this decides whether a
 * trade can happen at all — an account holding plenty, just not there, is refused for
 * "insufficient shard balance", which once left a Polymarket leg filled and the Kalshi leg
 * rejected.
 *
 * Kept here with no path-alias imports so it can be tested under bare Node, like the other
 * calculations that move real money.
 */

/** Never bother moving less than this; the round trip is not worth it. */
export const MIN_MOVE_DOLLARS = 2;

export interface ShardTransfer {
  from: number;
  to: number;
  dollars: number;
}

/**
 * Spread the account across the shards being traded.
 *
 * The first version of this asked for a fixed floor on each shard and refused to take the
 * source below the same floor. With a real account that deadlocks: $112.60 held as $105.87
 * on shard 0 and $6.74 on shard 3, against a $120 floor, leaves every shard "too poor to
 * give" and nothing ever moves — so every MLB order, which trades on shard 3, is refused
 * for insufficient collateral while the account looks perfectly healthy.
 *
 * Allocating by FAIR SHARE has no such deadlock. Each shard in use is targeted at an equal
 * slice of the account, capped by the floor when the account is large enough that an equal
 * split would be more than a trade could use. Shards not in use are drained first, since
 * money sitting where nothing trades is the cheapest source there is.
 */
export function planTransfers(
  balances: Record<number, number>,
  inUse: number[],
  floorDollars: number,
): { from: number; to: number; dollars: number }[] {
  if (inUse.length === 0) return [];
  const total = Object.values(balances).reduce((a, b) => a + b, 0);
  const target = Math.min(floorDollars, total / inUse.length);

  // Everything not being traded is spare in full; a shard in use is spare only above target.
  const inUseSet = new Set(inUse);
  const donors = Object.entries(balances)
    .map(([i, d]) => ({ shard: Number(i), spare: inUseSet.has(Number(i)) ? Math.max(0, d - target) : d }))
    .filter(x => x.spare >= MIN_MOVE_DOLLARS)
    .sort((a, b) => b.spare - a.spare);

  const plan: { from: number; to: number; dollars: number }[] = [];
  for (const shard of inUse) {
    let need = target - (balances[shard] ?? 0);
    if (need < MIN_MOVE_DOLLARS) continue;
    for (const donor of donors) {
      if (need < MIN_MOVE_DOLLARS) break;
      if (donor.shard === shard || donor.spare < MIN_MOVE_DOLLARS) continue;
      const move = Math.min(need, donor.spare);
      plan.push({ from: donor.shard, to: shard, dollars: Number(move.toFixed(2)) });
      donor.spare -= move;
      need -= move;
    }
  }
  return plan;
}
