/**
 * Websocket connections that keep lib/liveBooks current.
 *
 * Both venues are subscribed only for the markets worth trading right now — games in play
 * and the handful of pairs actually showing an edge. Subscribing to everything would be
 * thousands of books for markets nobody is about to trade.
 *
 * Everything here is best-effort by design: if a socket drops, the books it fed are marked
 * unhealthy and the order path silently falls back to fetching. A missing feed makes trading
 * slower, never wrong.
 */
import crypto from 'node:crypto';
import {
  kalshiSnapshot, kalshiDelta, markKalshiUnhealthy,
  polymarketSnapshot, polymarketPriceChange, markPolymarketUnhealthy,
} from '@/lib/liveBooks';

const KALSHI_WS = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const KALSHI_WS_PATH = '/trade-api/ws/v2';

function kalshiPem(): string | undefined {
  const inline = process.env.KALSHI_PRIVATE_KEY;
  if (inline && inline.includes('BEGIN')) return inline.replace(/\\n/g, '\n');
  return undefined;
}

/**
 * Sign the websocket upgrade exactly as a REST call is signed, over the WS path. Kalshi
 * rejects a signature computed for any other path.
 */
function kalshiAuthHeaders(): Record<string, string> | undefined {
  const keyId = process.env.KALSHI_API_KEY;
  const pem = kalshiPem();
  if (!keyId || !pem) return undefined;
  try {
    const ts = Date.now().toString();
    const signature = crypto
      .sign('sha256', Buffer.from(`${ts}GET${KALSHI_WS_PATH}`), {
        key: pem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString('base64');
    return {
      'KALSHI-ACCESS-KEY': keyId,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'KALSHI-ACCESS-SIGNATURE': signature,
    };
  } catch {
    return undefined;
  }
}

// One connection per process, surviving dev HMR for the same reason the refresh loop does.
const FEEDS = Symbol.for('arb.liveFeeds.state');
interface FeedState {
  kalshiSocket?: WebSocket;
  kalshiTickers: string[];
  kalshiReconnectAt: number;
  pmHandle?: { return?: () => unknown };
  pmAssets: string[];
  pmReconnectAt: number;
}
type Host = { [FEEDS]?: FeedState };
function feeds(): FeedState {
  const host = globalThis as unknown as Host;
  if (!host[FEEDS]) host[FEEDS] = { kalshiTickers: [], kalshiReconnectAt: 0, pmAssets: [], pmReconnectAt: 0 };
  return host[FEEDS];
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ─── Kalshi ──────────────────────────────────────────────────────────────────

function connectKalshi(tickers: string[]): void {
  const s = feeds();
  const headers = kalshiAuthHeaders();
  if (!headers || tickers.length === 0) return;

  try { s.kalshiSocket?.close(); } catch { /* already gone */ }
  markKalshiUnhealthy();

  // Node's WebSocket accepts headers via a non-standard option, which is the only way to
  // authenticate an upgrade — Kalshi has no post-connect auth message.
  const ws = new WebSocket(KALSHI_WS, { headers } as unknown as string[]);
  s.kalshiSocket = ws;
  s.kalshiTickers = [...tickers];
  // Kalshi numbers messages per SUBSCRIPTION, so ordering is tracked for the connection as
  // a whole rather than per market.
  let lastSeq = 0;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      cmd: 'subscribe',
      params: { channels: ['orderbook_delta'], market_tickers: tickers },
    }));
    console.log(`[livefeed] kalshi connected, ${tickers.length} markets`);
  });

  ws.addEventListener('message', ev => {
    let m: {
      type?: string; seq?: number;
      msg?: {
        market_ticker?: string;
        yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][];
        price_dollars?: string; delta_fp?: string; side?: string;
      };
    };
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    const body = m.msg; const ticker = body?.market_ticker;
    if (!ticker) return;

    const seq = m.seq ?? 0;
    if (m.type === 'orderbook_snapshot') {
      kalshiSnapshot(ticker, body?.yes_dollars_fp ?? [], body?.no_dollars_fp ?? []);
      lastSeq = seq;
      return;
    }
    if (m.type === 'orderbook_delta') {
      const delta = parseFloat(body?.delta_fp ?? '');
      const side = body?.side === 'yes' ? 'yes' : 'no';
      if (!body?.price_dollars || !Number.isFinite(delta)) return;
      // A gap in the connection's sequence means a message was missed, so some book is now
      // wrong and there is no way to know which. Resubscribing rebuilds every snapshot;
      // applying further deltas to a broken book is how a bad price reaches an order.
      if (lastSeq !== 0 && seq !== lastSeq + 1) {
        console.warn(`[livefeed] kalshi sequence gap (${lastSeq} -> ${seq}) — resubscribing`);
        markKalshiUnhealthy();
        s.kalshiReconnectAt = 0;
        try { ws.close(); } catch { /* closing anyway */ }
        return;
      }
      lastSeq = seq;
      kalshiDelta(ticker, body.price_dollars, delta, side);
    }
  });

  ws.addEventListener('error', () => { markKalshiUnhealthy(); });
  ws.addEventListener('close', () => {
    markKalshiUnhealthy();
    if (s.kalshiSocket === ws) s.kalshiSocket = undefined;
  });
}

// ─── Polymarket ──────────────────────────────────────────────────────────────

async function connectPolymarket(assetIds: string[]): Promise<void> {
  const s = feeds();
  if (assetIds.length === 0) return;
  try { await s.pmHandle?.return?.(); } catch { /* already gone */ }
  markPolymarketUnhealthy();

  const { createPublicClient } = await import('@polymarket/client');
  const client = createPublicClient();
  const handle = await client.subscribe([{ topic: 'market', assetIds }]);
  s.pmHandle = handle as unknown as { return?: () => unknown };
  s.pmAssets = [...assetIds];
  console.log(`[livefeed] polymarket connected, ${assetIds.length} tokens`);

  void (async () => {
    try {
      for await (const ev of handle as AsyncIterable<{ type?: string; payload?: Record<string, unknown> }>) {
        const p = ev.payload as {
          assetId?: string;
          bids?: { price?: string; size?: string }[];
          asks?: { price?: string; size?: string }[];
          priceChanges?: { assetId?: string; price?: string; size?: string; side?: string }[];
        } | undefined;
        if (!p) continue;

        if (ev.type === 'book' && p.assetId) {
          polymarketSnapshot(p.assetId, p.bids ?? [], p.asks ?? []);
          continue;
        }
        if (ev.type === 'price_change' && Array.isArray(p.priceChanges)) {
          // One message carries changes for BOTH tokens of a market, so each entry names its
          // own asset — applying them all to the subscribed token would corrupt the book.
          for (const c of p.priceChanges) {
            const size = parseFloat(c?.size ?? '');
            if (!c?.assetId || !c?.price || !Number.isFinite(size)) continue;
            polymarketPriceChange(c.assetId, c.price, size, c.side === 'BUY' ? 'BUY' : 'SELL');
          }
        }
      }
    } catch (err) {
      console.warn('[livefeed] polymarket stream ended:', err instanceof Error ? err.message : String(err));
    } finally {
      markPolymarketUnhealthy();
      if (s.pmHandle === (handle as unknown)) s.pmHandle = undefined;
    }
  })();
}

// ─── driver ──────────────────────────────────────────────────────────────────

const RECONNECT_COOLDOWN_MS = 5_000;

/**
 * Point the feeds at the markets currently worth trading. Cheap to call every tick: it only
 * reconnects when the set actually changes, or when a socket has dropped.
 */
export function syncLiveFeeds(kalshiTickers: string[], pmAssetIds: string[]): void {
  const s = feeds();
  const now = Date.now();

  const kalTargets = [...new Set(kalshiTickers)].sort();
  const kalDown = !s.kalshiSocket || s.kalshiSocket.readyState > 1;   // CLOSING or CLOSED
  if ((kalDown || !sameSet(kalTargets, s.kalshiTickers)) && now >= s.kalshiReconnectAt) {
    s.kalshiReconnectAt = now + RECONNECT_COOLDOWN_MS;
    connectKalshi(kalTargets);
  }

  const pmTargets = [...new Set(pmAssetIds)].sort();
  const pmDown = !s.pmHandle;
  if ((pmDown || !sameSet(pmTargets, s.pmAssets)) && now >= s.pmReconnectAt) {
    s.pmReconnectAt = now + RECONNECT_COOLDOWN_MS;
    void connectPolymarket(pmTargets).catch(err =>
      console.warn('[livefeed] polymarket connect failed:', err instanceof Error ? err.message : String(err)));
  }
}
