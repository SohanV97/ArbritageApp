/**
 * Polymarket CLOB trading.
 *
 * Environment variables (OS env vars and .env.local both work):
 *   POLYMARKET_PRIVATE_KEY=0x...your_polygon_wallet_private_key...
 *   POLYMARKET_FUNDER_ADDRESS=0x...   (optional — only if your USDC sits in a
 *                                      Polymarket proxy wallet, i.e. you signed up
 *                                      through the website rather than an EOA)
 *   POLYMARKET_SIGNATURE_TYPE=1|2     (optional override: 1 = email/Magic signup,
 *                                      2 = browser-wallet signup; default 2 when
 *                                      a funder address is set)
 *
 * Flow: the private key (L1) signs a request deriving the CLOB API credentials
 * (L2, cached after first derivation), then orders are created + posted with them.
 * The clob-client auto-resolves tick size, negRisk (multi-outcome politics events),
 * and the taker feeRateBps per market, and signs against the correct exchange
 * contract. Orders post as FAK (fill-and-kill): fill whatever is available at the
 * limit price immediately, cancel the rest — an arb leg must never rest one-sided.
 *
 * EOA note: a fresh wallet must approve USDC/CTF allowances for the Polymarket
 * exchange contracts once before its first trade (the website does this for proxy
 * wallets automatically). If the preflight shows allowance 0 with a positive
 * balance, that approval is what's missing.
 */
import type { ClobClient as ClobClientType } from '@polymarket/clob-client';

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

export interface PolymarketAuthTest {
  ok: boolean;
  address?: string;
  usdcBalance?: number;
  usdcAllowance?: number;
  error?: string;
}

// L2 creds are derived deterministically from the wallet key — derive once, reuse.
let _cachedClient: { key: string; client: ClobClientType } | null = null;

async function getTradingClient(): Promise<{ client: ClobClientType; address: string } | { error: string }> {
  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    return {
      error: 'POLYMARKET_PRIVATE_KEY not set — orders are signed by your Polygon wallet key (0x + 64 hex chars), ' +
        'which is separate from the API key UUID (that only covers market data). Set it as an environment variable ' +
        'and restart the terminal. Wallet apps expose it under account details → show private key.',
    };
  }
  try {
    const { Wallet } = await import('ethers');
    const { ClobClient } = await import('@polymarket/clob-client');

    const wallet = new Wallet(privateKey);
    if (_cachedClient && _cachedClient.key === privateKey) {
      return { client: _cachedClient.client, address: wallet.address };
    }

    // clob-client accepts an ethers-v5-style signer exposing `_signTypedData`;
    // ethers v6 renamed it, so shim it back on.
    const signer = Object.assign(wallet, {
      _signTypedData: wallet.signTypedData.bind(wallet),
    });

    const host = 'https://clob.polymarket.com';
    const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
    // 1 = email/Magic-link signup proxy, 2 = browser-wallet signup (Gnosis Safe).
    const signatureType = funder
      ? Number(process.env.POLYMARKET_SIGNATURE_TYPE ?? 2)
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const l1Client = new ClobClient(host, 137, signer as any, undefined, signatureType, funder);
    const creds = await l1Client.createOrDeriveApiKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new ClobClient(host, 137, signer as any, creds, signatureType, funder);
    _cachedClient = { key: privateKey, client };
    return { client, address: wallet.address };
  } catch (err) {
    return { error: `Failed to initialize CLOB client: ${String(err)}` };
  }
}

// Translate raw CLOB rejections into something actionable.
function mapClobError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('not enough balance') || s.includes('allowance')) {
    return `${raw} — fund the wallet with USDC on Polygon and/or approve the Polymarket exchange allowance (run one trade through the website, or set POLYMARKET_FUNDER_ADDRESS if your funds live in a Polymarket account wallet)`;
  }
  if (s.includes('minimum') || s.includes('min size')) {
    return `${raw} — order below this market's minimum size; increase the amount`;
  }
  if (s.includes('invalid price') || s.includes('tick')) {
    return `${raw} — price does not conform to this market's tick size`;
  }
  return raw;
}

// Verifies key, L2 credential derivation, and reads USDC balance + exchange
// allowance — the exact prerequisites for an order to succeed. Places nothing.
export async function testPolymarketAuth(): Promise<PolymarketAuthTest> {
  const init = await getTradingClient();
  if ('error' in init) return { ok: false, error: init.error };
  try {
    const { AssetType } = await import('@polymarket/clob-client');
    const bal = await init.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    // Values are reported in USDC micro-units (6 decimals)
    const toUsd = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n / 1e6 : 0; };
    return {
      ok: true,
      address: init.address,
      usdcBalance: toUsd(bal.balance),
      usdcAllowance: toUsd(bal.allowance),
    };
  } catch (err) {
    return { ok: false, error: mapClobError(String(err)) };
  }
}

export async function placePolymarketOrder(req: PolymarketOrderRequest): Promise<PolymarketOrderResult> {
  const init = await getTradingClient();
  if ('error' in init) return { ok: false, error: init.error };

  try {
    const { Side, OrderType } = await import('@polymarket/clob-client');

    const order = await init.client.createOrder({
      tokenID: req.tokenId,
      price: req.priceCents / 100,
      side: Side.BUY,
      size: req.count,
    });

    // FAK: immediate fill up to our size at the limit, cancel any remainder.
    const resp = await init.client.postOrder(order, OrderType.FAK);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = resp as any;
    if (r.errorCode || r.error) return { ok: false, error: mapClobError(String(r.errorCode ?? r.error)) };

    return { ok: true, orderId: r.orderID ?? r.order_id ?? r.id, status: r.status };
  } catch (err) {
    return { ok: false, error: mapClobError(String(err)) };
  }
}
