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

export async function placeKalshiOrder(req: KalshiOrderRequest): Promise<KalshiOrderResult> {
  const key = process.env.KALSHI_API_KEY;
  if (!key) return { ok: false, error: 'KALSHI_API_KEY not set' };

  const body: Record<string, unknown> = {
    ticker: req.ticker,
    client_order_id: crypto.randomUUID(),
    type: 'limit',
    action: 'buy',
    side: req.side,
    count: req.count,
  };
  // Kalshi expects yes_price for YES orders, no_price for NO orders
  body[req.side === 'yes' ? 'yes_price' : 'no_price'] = req.priceCents;

  try {
    const res = await fetch(`${KALSHI_API_BASE}/portfolio/orders`, {
      method: 'POST',
      headers: {
        'KALSHI-ACCESS-KEY': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) return { ok: false, error: `${res.status}: ${text}` };

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
