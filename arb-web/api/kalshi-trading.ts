import crypto from 'node:crypto';
import fs from 'node:fs';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

export interface KalshiOrderRequest {
  ticker: string;       // e.g. "KXWCGAME-26JUN25BELNZL-BEL"
  side: 'yes' | 'no';  // which outcome to buy
  count: number;        // contracts = max payout in dollars
  priceCents: number;   // limit price in cents (1–99)
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
  balanceDollars?: number;
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
    const data = JSON.parse(text) as { balance?: number };
    // balance is in cents
    return { ok: true, balanceDollars: typeof data.balance === 'number' ? data.balance / 100 : undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function placeKalshiOrder(req: KalshiOrderRequest): Promise<KalshiOrderResult> {
  const path = '/trade-api/v2/portfolio/orders';
  const signed = signKalshiRequest('POST', path);
  if ('error' in signed) return { ok: false, error: signed.error };

  const body: Record<string, unknown> = {
    ticker: req.ticker,
    client_order_id: crypto.randomUUID(),
    type: 'limit',
    action: 'buy',
    side: req.side,
    count: req.count,
    // Arb legs must never rest one-sided on the book: fill what's available at our
    // limit right now, cancel the remainder.
    time_in_force: 'immediate_or_cancel',
  };
  // Kalshi expects yes_price for YES orders, no_price for NO orders (integer cents)
  body[req.side === 'yes' ? 'yes_price' : 'no_price'] = req.priceCents;

  try {
    const res = await fetch(`${KALSHI_API_BASE}/portfolio/orders`, {
      method: 'POST',
      headers: signed.headers,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: kalshiErrorText(res.status, text) };

    const data = JSON.parse(text) as {
      order?: {
        order_id?: string;
        status?: string;
        filled_count?: number;
        avg_yes_price?: number;
        avg_no_price?: number;
      };
    };
    const order = data.order ?? {};
    const avgPrice = req.side === 'yes' ? order.avg_yes_price : order.avg_no_price;

    return {
      ok: true,
      orderId: order.order_id,
      status: order.status,
      filledCount: order.filled_count,
      avgPriceCents: avgPrice != null ? Math.round(avgPrice) : undefined,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
