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

const CHECK_MS = 60_000;
/** Leave at least this much on a shard we trade, so a trade never waits on a transfer. */
const DEFAULT_FLOOR_DOLLARS = 120;

let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

/** Which shards matter right now, from the markets actually on offer. */
export type ShardSource = () => number[];

async function rebalanceOnce(neededShards: number[], floorDollars: number): Promise<void> {
  if (running || neededShards.length === 0) return;
  running = true;
  try {
    const auth = await testKalshiAuth();
    const shards = auth.balanceByShard;
    if (!auth.ok || !shards) return;

    for (const shard of neededShards) {
      const have = shards[shard] ?? 0;
      if (have >= floorDollars) continue;

      const [richest, richestDollars] = Object.entries(shards)
        .map(([i, d]) => [Number(i), Number(d)] as [number, number])
        .filter(([i]) => i !== shard)
        .sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
      if (richest === undefined) continue;

      // Never strip the source below the floor to fill the destination; that just moves the
      // problem and guarantees the next trade on the source shard is the one that waits.
      const spare = Math.max(0, richestDollars - floorDollars);
      const want = floorDollars - have;
      const move = Math.min(want, spare);
      if (move < 1) continue;

      const res = await transferBetweenKalshiShards(richest, shard, move);
      console.log('[shards] top-up', JSON.stringify({
        from: richest, to: shard, dollars: Number(move.toFixed(2)), ok: res.ok, error: res.error,
      }));
      if (res.ok) {
        shards[shard] = have + move;
        shards[richest] = richestDollars - move;
      }
    }
  } catch (err) {
    console.warn('[shards] maintenance failed:', err instanceof Error ? err.message : String(err));
  } finally {
    running = false;
  }
}

export function startShardMaintenance(shardsInUse: ShardSource, floorDollars = DEFAULT_FLOOR_DOLLARS): void {
  const tick = () => void rebalanceOnce(shardsInUse(), floorDollars);
  // Not at startup: the first discovery has not happened, so nothing is known to be in use.
  timer = setInterval(tick, CHECK_MS);
  timer.unref?.();
}

export function stopShardMaintenance(): void {
  if (timer) { clearInterval(timer); timer = undefined; }
}
