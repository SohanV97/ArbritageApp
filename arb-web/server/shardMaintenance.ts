/**
 * Keep every Kalshi shard the app trades on funded, in the background.
 *
 * Kalshi's website hides sharding — you deposit once and can bet on anything — but the API
 * requires collateral to be preallocated per shard, and an order against a shard holding
 * nothing is refused however healthy the account total looks. That is not theoretical: a
 * deposit sat entirely on shard 0 while every MLB market trades on shard 3, the Polymarket
 * leg filled, the Kalshi leg was refused, and the position was left one-sided.
 *
 * The fix for that was to move collateral inside the order path. It worked, and it was in
 * the worst possible place: the transfer is followed by polling for settlement, up to six
 * rounds of a 250ms wait plus a balance read, so roughly TWO SECONDS could be spent before
 * the first order was sent — on the first trade against a shard, which is exactly the
 * unrepeatable in-play edge this app exists to catch.
 *
 * Doing it here instead costs nothing at trade time. The order path keeps its funding check,
 * but now that check only ever REFUSES; it never tries to fix things while an edge expires.
 */
import { testKalshiAuth, transferBetweenKalshiShards } from '@/api/kalshi-trading';
import { planTransfers } from '@/lib/shardAllocation';
import { invalidateKalshiAuth } from '@/api/kalshi-trading';

const CHECK_MS = 60_000;
/** Never bother moving less than this; the round trip is not worth it. */

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** Which shards matter right now, from the markets actually on offer. */
export type ShardSource = () => number[];

async function rebalanceOnce(neededShards: number[], floorDollars: number): Promise<void> {
  if (running || neededShards.length === 0) return;
  running = true;
  try {
    const auth = await testKalshiAuth();
    if (!auth.ok || !auth.balanceByShard) return;
    const plan = planTransfers(auth.balanceByShard, neededShards, floorDollars);
    for (const move of plan) {
      const res = await transferBetweenKalshiShards(move.from, move.to, move.dollars);
      console.log('[shards] top-up', JSON.stringify({ ...move, ok: res.ok, error: res.error }));
      // Per-shard balances just changed; a cached reading would size the next order against
      // money that is no longer on that shard.
      invalidateKalshiAuth();
      if (!res.ok) break;   // a failure now will fail again; try on the next tick
    }
  } catch (err) {
    console.warn('[shards] maintenance failed:', err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
  }
}
export function startShardMaintenance(shardsInUse: ShardSource, floorDollars = 150): void {
  const tick = () => void rebalanceOnce(shardsInUse(), floorDollars);
  // Not at startup: the first discovery has not happened, so nothing is known to be in use.
  timer = setInterval(tick, CHECK_MS);
  timer.unref?.();
}

export function stopShardMaintenance(): void {
  if (timer) { clearInterval(timer); timer = undefined; }
}
