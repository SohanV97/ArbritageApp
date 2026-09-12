/**
 * Order books kept current by websocket, rather than sampled by polling.
 *
 * Polling cannot price an in-play game. Measured end to end, a poll-built card was ~280ms
 * old before anything acted on it, and the pre-order check then spent ~160ms re-reading the
 * same books — so an order landed 450-600ms after the prices that justified it. In-play
 * baseball edges do not last that long: cards reading +0.56/+3.59/+2.55/+0.54% re-checked at
 * -4.37/-3.31/-2.40/-8.49% roughly 160ms later, every time negative, which is the gap
 * between two sampled feeds rather than a price anyone could trade.
 *
 * A pushed book has no sampling gap. The venue sends every change as it happens, so what is
 * held here IS the book, not a photograph of it taken a moment ago. That is also why reading
 * from here is safe where reading a cached poll response was not: a cached response is stale
 * by construction, while this is stale only if the connection has actually stopped — which
 * is tracked explicitly below and falls back to a fetch.
 */

/** Kalshi publishes RESTING BIDS per side; the shape mirrors its REST orderbook_fp. */
export interface KalshiBookShape {
  yes_dollars?: [string, string][];
  no_dollars?: [string, string][];
}

/** Polymarket publishes one book per token, with bids and asks as price/size levels. */
export interface PolymarketBookShape {
  bids?: { price?: string; size?: string }[];
  asks?: { price?: string; size?: string }[];
}

interface KalshiEntry {
  yes: Map<string, number>;
  no: Map<string, number>;
  updatedAt: number;
  healthy: boolean;
}

interface PolymarketEntry {
  bids: Map<string, number>;
  asks: Map<string, number>;
  updatedAt: number;
  healthy: boolean;
}

// Dev HMR re-evaluates modules; a fresh instance would drop every book and silently fall
// back to polling. Pin to the process, as the refresh loop pins its timer.
const STORE = Symbol.for('arb.liveBooks.store');
interface Store { kalshi: Map<string, KalshiEntry>; pm: Map<string, PolymarketEntry> }
type Host = { [STORE]?: Store };

function store(): Store {
  const host = globalThis as unknown as Host;
  if (!host[STORE]) host[STORE] = { kalshi: new Map(), pm: new Map() };
  return host[STORE];
}

/**
 * How long a pushed book stays trustworthy without an update.
 *
 * This is not a staleness budget the way a poll cache needs one — a quiet book is simply a
 * market nobody is trading, and it is still correct. It only guards against a socket that
 * has silently stopped delivering while appearing open.
 */
export const LIVE_BOOK_MAX_AGE_MS = 15_000;

// ─── Kalshi ──────────────────────────────────────────────────────────────────

export function kalshiSnapshot(ticker: string, yes: [string, string][], no: [string, string][]): void {
  const toMap = (levels: [string, string][]) => {
    const m = new Map<string, number>();
    for (const [price, size] of levels ?? []) {
      const n = parseFloat(size);
      if (Number.isFinite(n) && n > 0) m.set(price, n);
    }
    return m;
  };
  store().kalshi.set(ticker, { yes: toMap(yes), no: toMap(no), updatedAt: Date.now(), healthy: true });
}

/**
 * Apply one incremental change.
 *
 * Ordering is NOT checked here. Kalshi's seq counts messages per SUBSCRIPTION, not per
 * market, so with many markets on one socket a book's own deltas are never consecutive —
 * checking per market rejected almost every update and resubscribed in a loop. The caller
 * validates the single per-connection sequence instead, which is what the venue actually
 * guarantees.
 */
export function kalshiDelta(ticker: string, price: string, delta: number, side: 'yes' | 'no'): boolean {
  const e = store().kalshi.get(ticker);
  if (!e) return false;
  const book = side === 'yes' ? e.yes : e.no;
  const next = (book.get(price) ?? 0) + delta;
  if (next > 0) book.set(price, next); else book.delete(price);
  e.updatedAt = Date.now();
  return true;
}

export function markKalshiUnhealthy(ticker?: string): void {
  const s = store();
  if (ticker) { const e = s.kalshi.get(ticker); if (e) e.healthy = false; return; }
  for (const e of s.kalshi.values()) e.healthy = false;
}

/** The live book in the same shape the REST path returns, or undefined if not trustworthy. */
export function getLiveKalshiBook(ticker: string): KalshiBookShape | undefined {
  const e = store().kalshi.get(ticker);
  if (!e || !e.healthy) return undefined;
  if (Date.now() - e.updatedAt > LIVE_BOOK_MAX_AGE_MS) return undefined;
  const out = (m: Map<string, number>): [string, string][] =>
    [...m.entries()].map(([p, s]) => [p, String(s)] as [string, string]);
  return { yes_dollars: out(e.yes), no_dollars: out(e.no) };
}

// ─── Polymarket ──────────────────────────────────────────────────────────────

export function polymarketSnapshot(
  assetId: string,
  bids: { price?: string; size?: string }[],
  asks: { price?: string; size?: string }[],
): void {
  const toMap = (levels: { price?: string; size?: string }[]) => {
    const m = new Map<string, number>();
    for (const l of levels ?? []) {
      const n = parseFloat(l?.size ?? '');
      if (l?.price && Number.isFinite(n) && n > 0) m.set(l.price, n);
    }
    return m;
  };
  store().pm.set(assetId, { bids: toMap(bids), asks: toMap(asks), updatedAt: Date.now(), healthy: true });
}

/**
 * Polymarket sends the resulting SIZE at a level, not a delta, so this overwrites rather
 * than accumulates. BUY is a bid, SELL an ask; size 0 removes the level.
 */
export function polymarketPriceChange(assetId: string, price: string, size: number, side: 'BUY' | 'SELL'): void {
  const e = store().pm.get(assetId);
  if (!e) return;                       // no snapshot yet: wait for the book event
  const book = side === 'BUY' ? e.bids : e.asks;
  if (size > 0) book.set(price, size); else book.delete(price);
  e.updatedAt = Date.now();
}

export function markPolymarketUnhealthy(assetId?: string): void {
  const s = store();
  if (assetId) { const e = s.pm.get(assetId); if (e) e.healthy = false; return; }
  for (const e of s.pm.values()) e.healthy = false;
}

export function getLivePolymarketBook(assetId: string): PolymarketBookShape | undefined {
  const e = store().pm.get(assetId);
  if (!e || !e.healthy) return undefined;
  if (Date.now() - e.updatedAt > LIVE_BOOK_MAX_AGE_MS) return undefined;
  const out = (m: Map<string, number>) =>
    [...m.entries()].map(([price, size]) => ({ price, size: String(size) }));
  return { bids: out(e.bids), asks: out(e.asks) };
}

// ─── reporting ───────────────────────────────────────────────────────────────

export function liveBookStats(): { kalshi: number; polymarket: number; kalshiHealthy: number; pmHealthy: number } {
  const s = store();
  let kh = 0, ph = 0;
  for (const e of s.kalshi.values()) if (e.healthy) kh++;
  for (const e of s.pm.values()) if (e.healthy) ph++;
  return { kalshi: s.kalshi.size, polymarket: s.pm.size, kalshiHealthy: kh, pmHealthy: ph };
}

export function forgetLiveBooks(keepKalshi: Set<string>, keepPm: Set<string>): void {
  const s = store();
  for (const k of s.kalshi.keys()) if (!keepKalshi.has(k)) s.kalshi.delete(k);
  for (const k of s.pm.keys()) if (!keepPm.has(k)) s.pm.delete(k);
}
