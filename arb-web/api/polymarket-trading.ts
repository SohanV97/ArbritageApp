/**
 * Polymarket CLOB trading using L1 (wallet) auth.
 * No CLOB API key required — the wallet private key signs each request directly.
 *
 * Add to .env.local:
 *   POLYMARKET_PRIVATE_KEY=0x...your_polygon_wallet_private_key...
 *
 * Your wallet needs USDC on Polygon to cover trade costs.
 * Bridge USDC to Polygon at https://app.across.to or buy directly on Coinbase.
 */

export interface PolymarketOrderRequest {
  tokenId: string;    // YES or NO CLOB token ID
  count: number;      // shares = max payout in dollars
  priceCents: number; // limit price in cents (1–99)
}

export interface PolymarketOrderResult {
  ok: boolean;
  orderId?: string;
  status?: string;
  error?: string;
}

export async function placePolymarketOrder(req: PolymarketOrderRequest): Promise<PolymarketOrderResult> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) return { ok: false, error: 'POLYMARKET_PRIVATE_KEY not set in .env.local' };

  try {
    const { createWalletClient, http } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { polygon } = await import('viem/chains');
    const { ClobClient, Side, OrderType } = await import('@polymarket/clob-client');

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

    // L1 auth: pass no clobApiKey — wallet signs every request directly
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new ClobClient('https://clob.polymarket.com', 137, walletClient as any);

    const order = await client.createOrder({
      tokenID: req.tokenId,
      price: req.priceCents / 100,
      side: Side.BUY,
      size: req.count,
    });

    const resp = await client.postOrder(order, OrderType.GTC);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = resp as any;
    if (r.errorCode || r.error) return { ok: false, error: String(r.errorCode ?? r.error) };

    return { ok: true, orderId: r.orderID ?? r.order_id ?? r.id, status: r.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
