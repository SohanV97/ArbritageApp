/**
 * One connection pool for the whole process, kept warm.
 *
 * Measured against both venues from this machine: a cold socket costs ~176-206ms to
 * Polymarket and ~64-66ms to Kalshi; a reused one costs ~124-137ms and ~34-37ms. So roughly
 * 50-70ms and 30ms respectively are TCP and TLS setup, paid again every time a socket has
 * gone idle.
 *
 * That matters unevenly. The polling loops keep the Kalshi and Gamma hosts busy, but
 * clob.polymarket.com's ORDER endpoint is touched only when a trade is placed — so the one
 * request in this application where latency actually decides whether the trade happens is
 * the one most likely to be paying full connection setup.
 *
 * Node's global `fetch` reads the undici global dispatcher, and the Polymarket SDK sets no
 * dispatcher of its own (it goes through `ky` to global fetch), so installing one here
 * reaches the order-signing path too — not just our own calls.
 */
import { Agent, setGlobalDispatcher, request } from 'undici';

/** Hosts worth holding a warm socket to. */
const ORIGINS = [
  'https://clob.polymarket.com',        // orders and books — the latency-critical one
  'https://api.elections.kalshi.com',   // orders, balances, books
  'https://gamma-api.polymarket.com',   // discovery
];

// Comfortably longer than the heartbeat below, so a socket is never dropped between beats.
const KEEP_ALIVE_MS = 60_000;
const HEARTBEAT_MS = 20_000;

let heartbeat: ReturnType<typeof setInterval> | undefined;

export function installHttpAgent(): void {
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: KEEP_ALIVE_MS,
    keepAliveMaxTimeout: 10 * 60_000,
    // Enough for the discovery fan-out without becoming a way to get rate limited; the
    // per-venue gates in api/kalshi.ts and api/polymarket.ts still do the real limiting.
    connections: 16,
    connect: { timeout: 5_000 },
  }));
}

/** Open the sockets now, and touch them often enough that they never go idle. */
export function startConnectionWarmth(): void {
  const touch = async (origin: string): Promise<void> => {
    try {
      const res = await request(origin + '/', { method: 'GET' });
      // The body must be consumed or the socket cannot be returned to the pool.
      await res.body.dump();
    } catch {
      // A venue being briefly unreachable is not this function's problem; the next beat retries.
    }
  };
  const beat = () => { for (const o of ORIGINS) void touch(o); };
  beat();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref?.();
}

export function stopConnectionWarmth(): void {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
}
