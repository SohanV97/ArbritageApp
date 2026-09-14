import crypto from 'node:crypto';
import fs from 'node:fs';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiOrderRequest {
  ticker: string;       // e.g. "KXWCGAME-26JUN25BELNZL-BEL"
  side: 'yes' | 'no';  // which outcome the position is in
  count: number;        // contracts = max payout in dollars
  priceCents: number;   // limit price in cents (1–99)
  /**
   * 'sell' closes an existing position rather than opening one. Needed to unwind a leg that
   * ends up alone: selling YES is the ask side, and selling NO is the bid side — the exact
   * mirror of buying it.
   */
  action?: 'buy' | 'sell';
}

export interface KalshiOrderResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  filledCount?: number;
  avgPriceCents?: number;
  error?: string;
}

export interface KalshiAuthTest {
  ok: boolean;
  /** Total across every shard. NOT what funds an order — see balanceByShard. */
  balanceDollars?: number;
  /**
   * Dollars available on each exchange shard, keyed by exchange_index.
   *
   * Kalshi funds an order solely from the shard its market trades on. MLB sits on shard 3
   * and college football on shard 0, so a deposit that lands on one leaves the other at
   * zero — and the total balance says nothing about whether an order can pay.
   */
  balanceByShard?: Record<number, number>;
  error?: string;
}

// Kalshi authenticated endpoints require request signing, not just the key ID:
//   KALSHI-ACCESS-KEY:       the API key ID (KALSHI_API_KEY)
//   KALSHI-ACCESS-TIMESTAMP: unix millis as a string
//   KALSHI-ACCESS-SIGNATURE: base64 RSA-PSS-SHA256 over `${timestamp}${METHOD}${path}`
// Path is signed WITHOUT query parameters. The RSA private key is the .pem Kalshi
// lets you download once when creating the API key. Provide it via environment
// variable, either as:
//   KALSHI_PRIVATE_KEY_PATH — path to the downloaded .pem file (easiest on Windows)
//   KALSHI_PRIVATE_KEY      — the pem text itself (literal \n for newlines is fine)
function loadKalshiPem(): { pem: string } | { error: string } {
  const inline = process.env.KALSHI_PRIVATE_KEY;
  if (inline && inline.trim()) return { pem: inline.replace(/\\n/g, '\n') };
  const path = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (path && path.trim()) {
    try {
      return { pem: fs.readFileSync(path.trim(), 'utf8') };
    } catch (err) {
      return { error: `KALSHI_PRIVATE_KEY_PATH is set but the file could not be read (${path.trim()}): ${String(err)}` };
    }
  }
  return { error: '' }; // caller builds the contextual message
}

function signKalshiRequest(method: string, path: string): { headers: Record<string, string> } | { error: string } {
  const keyId = process.env.KALSHI_API_KEY;
  if (!keyId) return { error: 'KALSHI_API_KEY not set in your environment variables' };
  const loaded = loadKalshiPem();
  if ('error' in loaded) {
    return {
      error: loaded.error ||
        `API key ID found (${keyId.slice(0, 8)}…) — but placing orders also requires the RSA private key paired with it. ` +
        `Set the environment variable KALSHI_PRIVATE_KEY_PATH to the .pem file you downloaded when creating this key ` +
        `(or KALSHI_PRIVATE_KEY with the pem text, \\n for line breaks). If you no longer have the .pem, create a new API key ` +
        `at kalshi.com → Settings → API and download it this time. Restart the terminal after setting.`,
    };
  }
  const pem = loaded.pem;
  const timestamp = Date.now().toString();
  try {
    const signature = crypto
      .sign('sha256', Buffer.from(`${timestamp}${method}${path}`), {
        key: pem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString('base64');
    return {
      headers: {
        'KALSHI-ACCESS-KEY': keyId,
        'KALSHI-ACCESS-TIMESTAMP': timestamp,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'Content-Type': 'application/json',
      },
    };
  } catch (err) {
    return { error: `Failed to sign request (is KALSHI_PRIVATE_KEY a valid RSA PEM?): ${String(err)}` };
  }
}

// Kalshi errors arrive as {"error":{"code":"...","message":"..."}} — surface the message.
function kalshiErrorText(status: number, body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { code?: string; message?: string } };
    if (j.error?.message) return `${status}: ${j.error.message}${j.error.code ? ` (${j.error.code})` : ''}`;
  } catch { /* not JSON */ }
  return `${status}: ${body.slice(0, 200)}`;
}

// Verifies key + signature + account access without placing any order.
export async function testKalshiAuth(): Promise<KalshiAuthTest> {
  const path = '/trade-api/v2/portfolio/balance';
  const signed = signKalshiRequest('GET', path);
  if ('error' in signed) return { ok: false, error: signed.error };
  try {
    const res = await fetch(`${KALSHI_API_BASE}/portfolio/balance`, { headers: signed.headers });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: kalshiErrorText(res.status, text) };
    const data = JSON.parse(text) as {
      balance?: number;
      balance_breakdown?: { balance?: string; exchange_index?: number }[];
    };
    // Kalshi splits a balance across exchange shards, and an order is funded ONLY by the
    // shard its market sits on. Reporting the total is what let a $102 account be refused
    // "insufficient shard balance" on an MLB order: MLB trades on shard 3 and every dollar
    // was on shard 0. The Polymarket leg had already filled by then.
    const byShard: Record<number, number> = {};
    for (const b of data.balance_breakdown ?? []) {
      const dollars = parseFloat(b?.balance ?? '');
      if (typeof b?.exchange_index === 'number' && Number.isFinite(dollars)) {
        byShard[b.exchange_index] = dollars;
      }
    }
    return {
      ok: true,
      balanceDollars: typeof data.balance === 'number' ? data.balance / 100 : undefined,
      balanceByShard: Object.keys(byShard).length > 0 ? byShard : undefined,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * The order book, read through this module's signing rather than the discovery module's.
 *
 * api/kalshi.ts has the richer reader, but it imports through the "@/" path alias and so
 * cannot be loaded by a plain Node script. Closing a position from the command line has to
 * work when the app is not running — that is the situation it exists for — so the few lines
 * of fetch live here, next to the signing they need.
 */
export async function getKalshiBook(ticker: string): Promise<
  { yes_dollars?: [string, string][]; no_dollars?: [string, string][] } | null
> {
  const path = `/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`;
  const signed = signKalshiRequest('GET', path);
  if ('error' in signed) return null;
  try {
    const res = await fetch(`${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`, { headers: signed.headers });
    if (!res.ok) return null;
    const data = await res.json() as {
      orderbook?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
    };
    return data?.orderbook ?? null;
  } catch {
    return null;
  }
}

/**
 * How much of one order actually filled, asked of Kalshi rather than remembered.
 *
 * The mirror of the Polymarket check, and needed for the same reason: an order response is
 * what a venue believed at that instant, and unwinding a hedge on a wrong zero is the
 * expensive mistake. Polymarket now legs first, so the leg that can strand a position by
 * reporting a miss it did not have is this one.
 */
export async function getKalshiOrderFill(orderId: string): Promise<number | null> {
  const path = `/trade-api/v2/portfolio/orders/${encodeURIComponent(orderId)}`;
  const signed = signKalshiRequest('GET', path);
  if ('error' in signed) return null;
  try {
    const res = await fetch(`${KALSHI_API_BASE}/portfolio/orders/${encodeURIComponent(orderId)}`, { headers: signed.headers });
    if (!res.ok) return null;
    const data = await res.json() as { order?: { fill_count_fp?: string; fill_count?: number } };
    const o = data?.order;
    if (!o) return null;
    const n = o.fill_count_fp != null ? Number(o.fill_count_fp) : Number(o.fill_count);
    return Number.isFinite(n) ? n : null;
  } catch {
    // Unknown is NOT zero. Returning 0 here would be the very error this guards against.
    return null;
  }
}

export interface KalshiPosition {
  ticker: string;
  /** Signed contract count on the YES side. Negative is short. */
  contracts: number;
  exposureDollars: number;
  exchangeIndex?: number;
}

/**
 * Open positions, so something already on the books can be seen and closed.
 *
 * The executor unwinds a leg that fills alone, but only in the moment it trades. Anything
 * already open when that fails — a missed unwind, a restart, an order placed by hand — was
 * invisible to this app entirely and could only be found on Kalshi's website.
 */
export async function getKalshiPositions(): Promise<
  { ok: true; positions: KalshiPosition[] } | { ok: false; error: string }
> {
  const path = '/trade-api/v2/portfolio/positions';
  const signed = signKalshiRequest('GET', path);
  if ('error' in signed) return { ok: false, error: signed.error };
  try {
    const res = await fetch(`${KALSHI_API_BASE}/portfolio/positions?limit=200`, { headers: signed.headers });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: kalshiErrorText(res.status, text) };
    const data = JSON.parse(text) as {
      market_positions?: {
        ticker?: string;
        // Fractional, and a STRING: Kalshi trades partial contracts, so parsing this as an
        // integer silently reads a 0.01 dust position as flat.
        position_fp?: string;
        market_exposure_dollars?: string;
        exchange_index?: number;
      }[];
    };
    const positions: KalshiPosition[] = [];
    for (const p of data.market_positions ?? []) {
      const contracts = parseFloat(p?.position_fp ?? '');
      if (!p?.ticker || !Number.isFinite(contracts)) continue;
      positions.push({
        ticker: p.ticker,
        contracts,
        exposureDollars: parseFloat(p?.market_exposure_dollars ?? '0') || 0,
        exchangeIndex: p?.exchange_index,
      });
    }
    return { ok: true, positions };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function placeKalshiOrder(req: KalshiOrderRequest): Promise<KalshiOrderResult> {
  // Kalshi deprecated POST /portfolio/orders between 18–25 June 2026; it now answers 410
  // "Please switch to the V2 endpoints" and places nothing. The replacement is
  // /portfolio/events/orders, which is not just a new path — it changes the whole shape:
  //
  //   * side is the YES book only — `bid` = buy YES, `ask` = sell YES. There is no "no"
  //     side any more. Buying NO at n is quoted as selling YES at (1 - n).
  //   * price is a fixed-point DOLLAR string ("0.4800"), not integer cents.
  //   * count is a fixed-point string ("5"), not a number.
  //   * self_trade_prevention_type is required.
  //
  // Getting the side mapping wrong would buy the opposite contract and leave the arb
  // unhedged, so the NO -> ask/(1-price) conversion is applied on the way out and undone
  // on the way back when reporting the fill price.
  const path = '/trade-api/v2/portfolio/events/orders';
  const signed = signKalshiRequest('POST', path);
  if ('error' in signed) return { ok: false, error: signed.error };

  const selling = req.action === 'sell';
  const buyingYes = req.side === 'yes';
  // Everything is expressed on the YES book. Buying YES is a bid; buying NO is an ask at
  // (100 - n). Selling reverses the book side while the price stays on the same scale, so
  // closing a YES position is an ask and closing a NO position is a bid.
  const yesSidePriceCents = buyingYes ? req.priceCents : 100 - req.priceCents;
  const bookSide = selling ? (buyingYes ? 'ask' : 'bid') : (buyingYes ? 'bid' : 'ask');

  const body: Record<string, unknown> = {
    ticker: req.ticker,
    client_order_id: crypto.randomUUID(),
    side: bookSide,
    count: String(req.count),
    price: (yesSidePriceCents / 100).toFixed(4),
    // Arb legs must never rest one-sided on the book: fill what's available at our
    // limit right now, cancel the remainder.
    time_in_force: 'immediate_or_cancel',
    self_trade_prevention_type: 'taker_at_cross',
  };

  try {
    const res = await fetch(`${KALSHI_API_BASE}/portfolio/events/orders`, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: kalshiErrorText(res.status, text) };

    // V2 returns the fill inline (201) rather than nesting it under `order`.
    const data = JSON.parse(text) as {
      order_id?: string;
      fill_count?: string;
      remaining_count?: string;
      average_fill_price?: string;
    };

    const filled = data.fill_count != null ? Number(data.fill_count) : undefined;
    const remaining = data.remaining_count != null ? Number(data.remaining_count) : undefined;
    // average_fill_price is always a YES-side price; convert back to the side we bought.
    const avgYes = data.average_fill_price != null ? Number(data.average_fill_price) : undefined;
    const avgPriceCents = avgYes != null && Number.isFinite(avgYes)
      ? Math.round((buyingYes ? avgYes : 1 - avgYes) * 100)
      : undefined;

    // IOC: anything not filled immediately is cancelled, so a leftover remainder means a
    // partial fill, not a resting order.
    const status = filled === 0 ? 'canceled'
      : remaining && remaining > 0 ? 'partially_filled'
      : 'executed';

    return {
      ok: true,
      orderId: data.order_id,
      status,
      filledCount: filled,
      avgPriceCents,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Move collateral between Kalshi exchange shards.
 *
 * Kalshi's own interface hides sharding — you deposit once and can bet on anything — but it
 * is doing this transfer for you behind the scenes. The API does not: "Programmatic traders
 * must preallocate collateral on a given exchange shard before order placement." A deposit
 * lands on shard 0, MLB trades on shard 3, and an order there is refused with "insufficient
 * shard balance" no matter how healthy the account total looks.
 *
 * Amounts are in CENTICENTS — hundredths of a cent — so a dollar is 10,000. Getting that
 * wrong by a factor of a hundred in either direction is the obvious way to move the wrong
 * amount of real money, which is why the conversion lives here rather than at each call.
 */
export async function transferBetweenKalshiShards(
  fromShard: number,
  toShard: number,
  dollars: number,
): Promise<{ ok: boolean; transferId?: string; error?: string }> {
  if (!Number.isFinite(dollars) || dollars <= 0) return { ok: false, error: 'Transfer amount must be positive' };
  if (!Number.isInteger(fromShard) || !Number.isInteger(toShard)) return { ok: false, error: 'Shard indexes must be integers' };
  if (fromShard === toShard) return { ok: false, error: 'Source and destination shard are the same' };

  const path = '/trade-api/v2/portfolio/intra_exchange_instance_transfer';
  const signed = signKalshiRequest('POST', path);
  if ('error' in signed) return { ok: false, error: signed.error };

  const centicents = Math.floor(dollars * 10_000);
  try {
    const res = await fetch(`${KALSHI_API_BASE}/portfolio/intra_exchange_instance_transfer`, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify({
        source: 'event_contract',
        destination: 'event_contract',
        amount: centicents,
        source_exchange_shard: fromShard,
        destination_exchange_shard: toShard,
        source_subaccount: 0,
        destination_subaccount: 0,
      }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: kalshiErrorText(res.status, text) };
    const data = JSON.parse(text) as { transfer_id?: string };
    return { ok: true, transferId: data.transfer_id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
