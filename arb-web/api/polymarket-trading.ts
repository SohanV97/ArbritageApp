/**
 * Polymarket trading, on the PUSD-era SDK.
 *
 * Environment variables (OS env vars and .env.local both work):
 *   POLYMARKET_PRIVATE_KEY=0x...      the key that signs orders (0x + 64 hex)
 *   POLYMARKET_FUNDER_ADDRESS=0x...   the wallet holding your collateral. Omit it and the
 *                                     SDK derives the signer's deterministic Deposit
 *                                     Wallet, which only works if that wallet is already
 *                                     deployed — pass the address Polymarket shows you.
 *   POLYMARKET_RELAYER_API_KEY=...    optional, and only needed for on-chain operations
 *   POLYMARKET_RELAYER_ADDRESS=0x...  (granting trading approvals). Placing orders does not
 *                                     need it: orders are signed messages, not transactions.
 *
 * ─── why this was rewritten ───────────────────────────────────────────────────
 * This module used @polymarket/clob-client, whose Polygon config hardcodes the collateral
 * token as USDC.e (0x2791Bca1…). Polymarket has since migrated to its own token, PUSD
 * (0xC011a7E1…). A genuinely funded account therefore reported a balance of $0.00 — the
 * client was reading a token the account did not hold, and would have signed orders against
 * the wrong exchange. The symptom was indistinguishable from "you have no money".
 *
 * @polymarket/client is the current SDK: its production config names PUSD as the collateral
 * token, and it targets the same clob.polymarket.com the app already used. The conditional
 * token contract (0x4D97DCd9…) is unchanged between the two, so this is the same venue and
 * the same markets — only the dollar token and the client moved.
 *
 * Orders are placed as marketable LIMIT orders: priced at (or through) the resting ask so
 * they fill immediately against existing liquidity rather than resting on the book. An arb
 * leg must never sit one-sided, and a limit price keeps the fill size exact, which matters
 * because both legs must end up with the same number of contracts to stay hedged.
 */
import type { SecureClient } from '@polymarket/client';

export interface PolymarketOrderRequest {
  tokenId: string;    // YES or NO CLOB token ID
  count: number;      // shares = max payout in dollars
  priceCents: number; // limit price in cents (1–99)
}

export interface PolymarketOrderResult {
  ok: boolean;          // order accepted by the CLOB without error
  orderId?: string;
  status?: string;      // e.g. "matched", "live", "unmatched"
  filledCount?: number; // shares actually filled (takingAmount on a BUY)
  error?: string;
}

export interface PolymarketAuthTest {
  ok: boolean;
  /** The signer derived from POLYMARKET_PRIVATE_KEY. This is NOT where funds live. */
  address?: string;
  /** The wallet collateral is held in and orders are funded from. */
  funderAddress?: string;
  /** Spendable collateral, in dollars. Denominated in PUSD since the migration. */
  usdcBalance?: number;
  /** Balance read straight from Polygon, independent of Polymarket's API. */
  onChainUsdc?: number;
  /** False when the wallet still needs its one-time trading approvals. */
  approvalsReady?: boolean;
  /** Plain-language explanation when something is off, rather than a silent zero. */
  diagnosis?: string;
  error?: string;
}

// ─── on-chain reads ──────────────────────────────────────────────────────────
// Polymarket settles in PUSD, not the bridged USDC.e it used to. Reading the balance
// straight from the chain is what distinguishes "this wallet is empty" from "the SDK is
// looking at the wrong token" — the failure that made a funded account read as $0.00.
const PUSD_POLYGON = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com',
];

async function erc20Balance(token: string, address: string): Promise<number | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  const data = '0x70a08231' + address.toLowerCase().slice(2).padStart(64, '0');
  for (const url of POLYGON_RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
      });
      if (!res.ok) continue;
      const j = await res.json() as { result?: string; error?: unknown };
      if (j.error || !j.result || j.result === '0x') continue;
      return Number(BigInt(j.result)) / 1e6;   // PUSD and USDC.e are both 6-decimal
    } catch { /* try the next endpoint */ }
  }
  return undefined;
}

/** Spendable collateral on Polygon: PUSD, falling back to legacy USDC.e. */
async function onChainCollateral(address: string): Promise<number | undefined> {
  const pusd = await erc20Balance(PUSD_POLYGON, address);
  if (typeof pusd === 'number' && pusd > 0) return pusd;
  const usdc = await erc20Balance(USDC_E_POLYGON, address);
  if (typeof usdc === 'number' && usdc > 0) return usdc;
  return pusd ?? usdc;
}

// ─── client ──────────────────────────────────────────────────────────────────
// createSecureClient authenticates over the network, so build it once and reuse it. Keyed
// on the credentials so an env change during dev is picked up rather than cached forever.
type CachedClient = { key: string; wallet: string; relayer: string; client: SecureClient };
let _cached: CachedClient | null = null;

async function getSecureClient(): Promise<{ client: SecureClient; address: string; wallet: string } | { error: string }> {
  const key = process.env.POLYMARKET_PRIVATE_KEY?.trim();
  if (!key) {
    return {
      error: 'POLYMARKET_PRIVATE_KEY not set — orders are signed by your Polygon wallet key ' +
        '(0x + 64 hex chars), which is separate from the API key UUID (that only covers market ' +
        'data). Set it as an environment variable and restart.',
    };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return { error: `POLYMARKET_PRIVATE_KEY is not a private key (${key.length} chars). Expected 0x followed by 64 hex characters.` };
  }
  const wallet = process.env.POLYMARKET_FUNDER_ADDRESS?.trim() ?? '';

  // A Relayer API key is what lets Polymarket submit transactions on the wallet's behalf.
  // Trading itself does not need it — orders are signed messages, not transactions — but
  // anything that touches the chain does: granting trading approvals, deploying a deposit
  // wallet, returning collateral. Without it the SDK reports supportsGasless === false and
  // refuses those operations outright.
  const relayerKey = process.env.POLYMARKET_RELAYER_API_KEY?.trim() ?? '';
  const relayerAddress = process.env.POLYMARKET_RELAYER_ADDRESS?.trim() ?? '';
  const relayer = relayerKey && relayerAddress ? `${relayerKey}@${relayerAddress}` : '';

  try {
    const { privateKey } = await import('@polymarket/client/viem');
    const { createSecureClient, relayerApiKey } = await import('@polymarket/client');
    const signer = privateKey(key as `0x${string}`);
    const address = await signer.getAddress();

    if (_cached && _cached.key === key && _cached.wallet === wallet && _cached.relayer === relayer) {
      return { client: _cached.client, address, wallet: wallet || address };
    }

    // Passing `wallet` explicitly matters: without it the SDK derives the signer's
    // deterministic Deposit Wallet and tries to DEPLOY it, which needs a relayer key. The
    // deposit wallet Polymarket already created is the one to use.
    const client = await createSecureClient({
      signer,
      ...(wallet ? { wallet } : {}),
      ...(relayer ? { apiKey: relayerApiKey({ key: relayerKey, address: relayerAddress }) } : {}),
    });

    _cached = { key, wallet, relayer, client };
    return { client, address, wallet: wallet || address };
  } catch (err) {
    return { error: `Failed to initialize Polymarket client: ${describeError(err)}` };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)); }
  catch { return String(err); }
}

// The venue rejects with a machine-readable code; turn the ones a trader can act on into
// instructions rather than passing the bare enum through to the UI.
function mapOrderError(code: string, message: string): string {
  switch (code) {
    case 'insufficient_balance_or_allowance':
      return `${message} — either the wallet is short of collateral, or it has not granted the ` +
        `exchange permission to move it. Run "npm run setup:approvals" to grant the approvals; ` +
        `a connection test reports the balance.`;
    case 'market_not_ready':
      return `${message} — this market is not accepting orders yet.`;
    case 'unmatched':
    case 'fok_not_filled':
    case 'fak_not_filled':
      return `${message} — no resting liquidity at this price; the book moved between the ` +
        `quote and the order.`;
    case 'invalid_nonce':
      return `${message} — the signing nonce is stale, which usually means orders were ` +
        `cancelled elsewhere. Retry.`;
    case 'post_only_would_cross':
    case 'post_only_mode':
      return `${message} — the market is post-only right now, so an immediate-fill order ` +
        `cannot be placed.`;
    default:
      return message || `order rejected (${code})`;
  }
}

/**
 * Build the client ahead of any order. Authentication is a network round trip, and paying it
 * on the first order costs ~half a second — long enough on a live in-play edge for the price
 * to move and the trade to abort.
 */
export async function warmPolymarketTrading(): Promise<void> {
  try { await getSecureClient(); } catch { /* warming must never break startup */ }
}

export async function testPolymarketAuth(): Promise<PolymarketAuthTest> {
  const init = await getSecureClient();
  if ('error' in init) return { ok: false, error: init.error };

  try {
    const onChainUsdc = await onChainCollateral(init.wallet);

    // Reports whether the wallet has granted the exchange ERC-20/ERC-1155 permissions.
    //
    // Do NOT treat false as "cannot trade". This was verified against a live account: a
    // Polymarket Deposit Wallet traded successfully with every one of these approvals reading
    // zero on-chain. Deposit wallets are proxy contracts the exchange moves funds through
    // directly, authorized by the signer — the allowance model applies to plain EOA accounts.
    // Reported for diagnostics only; nothing gates on it.
    let approvalsReady: boolean | undefined;
    try {
      const state = await init.client.fetchTradingApprovalsState();
      approvalsReady = state?.isFullyApproved === true;
    } catch { approvalsReady = undefined; }

    const balance = onChainUsdc ?? 0;
    let diagnosis: string | undefined;
    if (balance === 0) {
      diagnosis =
        `No collateral at ${init.wallet}. Polymarket settles in PUSD (0xC011a7E1…) — check that ` +
        `POLYMARKET_FUNDER_ADDRESS is the wallet Polymarket shows for your account, and that the ` +
        `deposit has landed there.`;
    }

    return {
      ok: true,
      address: init.address,
      funderAddress: init.wallet,
      usdcBalance: balance,
      onChainUsdc,
      approvalsReady,
      diagnosis,
    };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export async function placePolymarketOrder(req: PolymarketOrderRequest): Promise<PolymarketOrderResult> {
  const init = await getSecureClient();
  if ('error' in init) return { ok: false, error: init.error };

  try {
    const { OrderSide } = await import('@polymarket/client');

    // Marketable limit: priced at the ask we already quoted, so it crosses immediately
    // against resting liquidity instead of sitting on the book. A limit keeps the size and
    // the worst-case price exact, which is what holds the two legs of the hedge equal.
    const result = await init.client.placeLimitOrder({
      assetId: req.tokenId,
      price: (req.priceCents / 100).toFixed(4),
      size: req.count,
      side: OrderSide.BUY,
    });

    if (!result.ok) {
      return { ok: false, error: mapOrderError(result.code, result.message) };
    }

    // On a BUY the taker asset is the outcome share, so takingAmount is the number of
    // contracts filled. It is '0' for an order that rested without matching — the caller
    // compares this against the other leg to decide whether the position is actually hedged,
    // so an unfilled order must report 0 rather than the requested size.
    const filled = Number(result.takingAmount);
    return {
      ok: true,
      orderId: result.orderId,
      status: result.status,
      filledCount: Number.isFinite(filled) ? filled : undefined,
    };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Grants the exchange the one-time on-chain approvals trading requires: an ERC-20 allowance
 * over the collateral token, and ERC-1155 operator approvals over the outcome tokens. Until
 * these exist every order is rejected as "insufficient balance or allowance", even with money
 * in the wallet — the exchange simply cannot move funds it was never permitted to touch.
 *
 * Normally the Polymarket website does this the first time you trade there. This exists so an
 * account funded but never traded on can be made ready without leaving the app.
 *
 * These are real transactions against a real wallet, so this is deliberately NOT called during
 * warm-up or order placement. It is invoked only by `npm run setup:approvals`. Polymarket's
 * relayer pays the gas, so the wallet needs no MATIC.
 */
export async function setupPolymarketApprovals(): Promise<{ ok: boolean; alreadyApproved?: boolean; error?: string }> {
  const init = await getSecureClient();
  if ('error' in init) return { ok: false, error: init.error };

  try {
    const before = await init.client.fetchTradingApprovalsState();
    if (before.isFullyApproved) return { ok: true, alreadyApproved: true };

    await init.client.setupTradingApprovals();

    // Confirm against chain state rather than trusting the call returned cleanly.
    const after = await init.client.fetchTradingApprovalsState();
    return after.isFullyApproved
      ? { ok: true }
      : { ok: false, error: 'Approvals were submitted but the wallet still reads as not fully approved. Re-run to retry the remaining ones.' };
  } catch (err) {
    const msg = describeError(err);
    if (/Relayer API Key|Builder API Key|gasless/i.test(msg)) {
      return {
        ok: false,
        error:
          'Granting approvals is an on-chain transaction, and this wallet holds no MATIC to pay ' +
          'for one, so it has to go through the Polymarket relayer — which the SDK will only use ' +
          'when it is given a Relayer API key.\n\n' +
          'Two ways forward:\n' +
          '  1. Place one small trade on polymarket.com. Their own frontend has relayer access ' +
          'and sets these exact approvals; this app then picks them up automatically, because ' +
          'approvals live on the wallet rather than in any one app.\n' +
          '  2. If you hold a Relayer API key, set POLYMARKET_RELAYER_API_KEY and ' +
          'POLYMARKET_RELAYER_ADDRESS in .env.local and re-run.\n\n' +
          'Option 1 is the normal path; relayer keys are issued to Polymarket integration ' +
          'partners, not handed out with a regular account.',
      };
    }
    return { ok: false, error: msg };
  }
}

/**
 * Cancels a resting order. Needed whenever an order is placed that must not be left on the
 * book — a hedge whose other leg failed, or a deliberately unfillable probe order.
 */
export async function cancelPolymarketOrder(orderId: string): Promise<{ ok: boolean; error?: string }> {
  const init = await getSecureClient();
  if ('error' in init) return { ok: false, error: init.error };
  try {
    await init.client.cancelOrder({ orderId });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
