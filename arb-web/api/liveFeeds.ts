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
  liveBookStats,
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
  /** Subscription id, needed to add markets to the socket instead of rebuilding it. */
  kalshiSid?: number;
  kalshiTickers: string[];
  kalshiReconnectAt: number;
  /**
   * Bumped for every socket. A replaced socket keeps delivering for a while — close() is
   * asynchronous — and its handler would still be writing to the shared book store. That is
   * how a book that had JUST been reset by a fresh snapshot ended up corrupted: late deltas
   * from the previous socket landed on top of it. A handler now ignores anything that
   * arrives once its own generation is no longer current.
   */
  kalshiGeneration: number;
  pmHandle?: { return?: () => unknown };
  pmAssets: string[];
  pmReconnectAt: number;
  pmGeneration: number;
}
type Host = { [FEEDS]?: FeedState };
function feeds(): FeedState {
  const host = globalThis as unknown as Host;
  const existing = host[FEEDS];
  if (!existing) {
    host[FEEDS] = {
      kalshiTickers: [], kalshiReconnectAt: 0, kalshiGeneration: 0,
      pmAssets: [], pmReconnectAt: 0, pmGeneration: 0,
    };
    return host[FEEDS];
  }
  // Backfill anything added to this shape since the object was created.
  //
  // The state is pinned to the process so it survives dev HMR — which means a reload gets
  // the OLD object, missing whatever fields the new code expects. That is not theoretical:
  // adding kalshiGeneration made `++s.kalshiGeneration` evaluate to NaN on the existing
  // state, and since NaN !== NaN the message handler treated every single message as coming
  // from a superseded socket and dropped it. The feed went to zero healthy books while
  // appearing connected.
  if (typeof existing.kalshiGeneration !== 'number' || !Number.isFinite(existing.kalshiGeneration)) existing.kalshiGeneration = 0;
  if (typeof existing.pmGeneration !== 'number' || !Number.isFinite(existing.pmGeneration)) existing.pmGeneration = 0;
  if (!Array.isArray(existing.kalshiTickers)) existing.kalshiTickers = [];
  if (!Array.isArray(existing.pmAssets)) existing.pmAssets = [];
  if (typeof existing.kalshiReconnectAt !== 'number') existing.kalshiReconnectAt = 0;
  if (typeof existing.pmReconnectAt !== 'number') existing.pmReconnectAt = 0;
  return existing;
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
  // Claim this generation. Any socket opened after this one supersedes it, and the older
  // handler goes inert rather than racing it for the same books.
  const generation = ++s.kalshiGeneration;
  s.kalshiSocket = ws;
  s.kalshiSid = undefined;
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
    if (s.kalshiGeneration !== generation) return;   // superseded socket: must not touch the store
    let m: {
      type?: string; seq?: number; sid?: number;
      msg?: {
        market_ticker?: string;
        yes_dollars_fp?: [string, string][]; no_dollars_fp?: [string, string][];
        price_dollars?: string; delta_fp?: string; side?: string;
      };
    };
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    // The subscription id is what lets markets be added later without rebuilding the socket.
    if (m.type === 'subscribed') { s.kalshiSid = (m.msg as { sid?: number } | undefined)?.sid ?? m.sid; return; }
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

  ws.addEventListener('error', () => { if (s.kalshiGeneration === generation) markKalshiUnhealthy(); });
  ws.addEventListener('close', () => {
    // Only the CURRENT socket closing means the feed is down. A superseded one closing is
    // just cleanup, and marking every book unhealthy there would throw away the fresh books
    // its replacement had already delivered.
    if (s.kalshiGeneration !== generation) return;
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
  // Same supersede guard as Kalshi: the previous stream is still draining, and its events
  // must not be applied to books the new one has already refreshed.
  const generation = ++s.pmGeneration;
  s.pmHandle = handle as unknown as { return?: () => unknown };
  s.pmAssets = [...assetIds];
  console.log(`[livefeed] polymarket connected, ${assetIds.length} tokens`);

  void (async () => {
    try {
      for await (const ev of handle as AsyncIterable<{ type?: string; payload?: Record<string, unknown> }>) {
        if (s.pmGeneration !== generation) break;   // superseded: stop feeding the store
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
      // Only the CURRENT stream ending means the feed is down.
      if (s.pmGeneration === generation) {
        markPolymarketUnhealthy();
        if (s.pmHandle === (handle as unknown)) s.pmHandle = undefined;
      }
    }
  })();
}

// ─── driver ──────────────────────────────────────────────────────────────────

const RECONNECT_COOLDOWN_MS = 5_000;

// Rebuild the socket once the subscription has collected this much history. Markets are
// added as games start and simply left in place when they end, so the list only grows; this
// prunes it occasionally rather than on every change.
const MAX_TRACKED_MARKETS = 400;

let _kalshiCmdId = 100;

/**
 * Add markets to the live subscription without rebuilding it.
 *
 * Rebuilding was the whole problem. The in-play set changes constantly — the log shows it
 * walking 145, 144, 143, 142 as games finish — and every change tore down the socket and
 * re-subscribed all ~145 markets. Each rebuild drops every delta between the close and the
 * arrival of that market's new snapshot, and with the old socket still delivering into the
 * same store, late deltas landed on top of freshly reset books.
 *
 * The damage was measured, not theorised: the app's stored book for one market was missing
 * exactly the deltas seen on an independent socket at the same moment — a -1750 at 36c and
 * a +1750 at 38c — leaving phantom depth of 2000 contracts at prices where 501 existed.
 * Orders were then sized against that: 102 contracts requested, 5 filled.
 */
function addKalshiMarkets(tickers: string[]): boolean {
  const s = feeds();
  const ws = s.kalshiSocket;
  if (!ws || ws.readyState !== 1 || s.kalshiSid === undefined || tickers.length === 0) return false;
  try {
    ws.send(JSON.stringify({
      id: ++_kalshiCmdId,
      cmd: 'update_subscription',
      params: { sids: [s.kalshiSid], market_tickers: tickers, action: 'add_markets' },
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Point the feeds at the markets currently worth trading. Cheap to call every tick.
 *
 * Markets that leave the set are deliberately NOT unsubscribed. Leaving them costs a little
 * bandwidth; removing them costs a reconnect, and a reconnect is what corrupts books.
 */
export function syncLiveFeeds(kalshiTickers: string[], pmAssetIds: string[]): void {
  const s = feeds();
  const now = Date.now();

  const kalTargets = [...new Set(kalshiTickers)].sort();
  const kalDown = !s.kalshiSocket || s.kalshiSocket.readyState > 1;   // CLOSING or CLOSED
  const kalKnown = new Set(s.kalshiTickers);
  const kalAdded = kalTargets.filter(t => !kalKnown.has(t));

  // A socket can be OPEN and still be delivering nothing usable. Readiness is not health,
  // and without this the feed had no way back: a handler that stopped applying messages left
  // every book unhealthy while readyState stayed 1, so no reconnect was ever triggered and
  // the order path silently fetched for the rest of the session. If markets are tracked and
  // not one book is healthy, the socket is not doing its job whatever it reports.
  const kalDead = !kalDown && s.kalshiTickers.length > 0 && liveBookStats().kalshiHealthy === 0;

  if (kalDown || kalDead || s.kalshiTickers.length > MAX_TRACKED_MARKETS) {
    if (now >= s.kalshiReconnectAt) {
      s.kalshiReconnectAt = now + RECONNECT_COOLDOWN_MS;
      if (kalDead) console.warn('[livefeed] kalshi socket open but no healthy books — reconnecting');
      connectKalshi(kalTargets);
    }
  } else if (kalAdded.length > 0) {
    if (addKalshiMarkets(kalAdded)) {
      s.kalshiTickers = [...new Set([...s.kalshiTickers, ...kalAdded])].sort();
      console.log(`[livefeed] kalshi +${kalAdded.length} markets (${s.kalshiTickers.length} tracked)`);
    } else if (now >= s.kalshiReconnectAt) {
      s.kalshiReconnectAt = now + RECONNECT_COOLDOWN_MS;
      connectKalshi(kalTargets);
    }
  }

  // Polymarket's client has no incremental update, so the same principle is applied with the
  // only lever available: reconnect when markets are ADDED, never merely because some left.
  const pmTargets = [...new Set(pmAssetIds)].sort();
  const pmKnown = new Set(s.pmAssets);
  const pmAdded = pmTargets.filter(t => !pmKnown.has(t));
  const pmDown = !s.pmHandle;
  if ((pmDown || pmAdded.length > 0 || s.pmAssets.length > MAX_TRACKED_MARKETS) && now >= s.pmReconnectAt) {
    s.pmReconnectAt = now + RECONNECT_COOLDOWN_MS;
    const union = s.pmAssets.length > MAX_TRACKED_MARKETS
      ? pmTargets
      : [...new Set([...s.pmAssets, ...pmTargets])].sort();
    void connectPolymarket(union).catch(err =>
      console.warn('[livefeed] polymarket connect failed:', err instanceof Error ? err.message : String(err)));
  }
}
