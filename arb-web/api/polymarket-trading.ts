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
  /** 'sell' closes an existing position rather than opening one. */
  action?: 'buy' | 'sell';
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
  /**
   * False when the signing key is not the wallet's owner, so orders will be rejected however
   * healthy everything else looks. Reading a balance only proves the key can authenticate.
   */
  canSignOrders?: boolean;
  /** The address that actually controls the funder wallet, read from the proxy on-chain. */
  walletOwner?: string;
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

/**
 * Who actually controls a Polymarket Deposit Wallet.
 *
 * These wallets are EIP-1167 minimal proxies with the controlling address appended to the
 * runtime bytecode, so ownership can be read straight from the chain without trusting any
 * API. This matters because a key that is merely a SESSION KEY on the wallet authenticates
 * fine and reads balances fine — it just cannot sign orders, and the venue only says so at
 * order time, with "the order signer address has to be the address of the API KEY".
 */
async function walletOwnerOnChain(address: string): Promise<string | undefined> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return undefined;
  for (const url of POLYGON_RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
      });
      if (!res.ok) continue;
      const j = await res.json() as { result?: string };
      const code = j.result;
      if (!code || code === '0x') return undefined;      // an EOA controls itself
      const tail = code.slice(-64);
      if (!/^0{24}[0-9a-fA-F]{40}$/.test(tail)) return undefined;
      const owner = '0x' + tail.slice(24);
      return /^0x0+$/.test(owner) ? undefined : owner;
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

/**
 * The venue reports this as free text that blames the API key, which is misleading: the key
 * is valid, and authenticated reads succeed with it. The signing key is simply not the one
 * that owns the wallet.
 *
 * On an email/Magic account this is easy to hit, because Magic holds more than one wallet
 * per login and the export screen names whichever is currently active. Logging out of Magic
 * and back in can surface a different one — that is how the owning key was eventually found
 * here, after the first export had returned a non-owning address.
 */
function explainSignerMismatch(raw: string): string | undefined {
  if (!/signer address has to be the address of the api key/i.test(raw)) return undefined;
  return `${raw}\n\n` +
    `The API key is fine — authenticated reads work with it. POLYMARKET_PRIVATE_KEY is simply ` +
    `not the key that owns POLYMARKET_FUNDER_ADDRESS. Run "npm run check:wallet" to see which ` +
    `address it controls and which one owns the wallet. On an email/Magic account, log out of ` +
    `the Magic export screen and log back in: it can reveal a different wallet, and the export ` +
    `header names the address before it shows the key.`;
}

/**
 * Polymarket blocks trading from restricted regions at the venue, after the order is signed
 * and sent. Nothing local can satisfy it, so say plainly that this is not a configuration
 * problem — otherwise it reads like one more thing to fix in .env.local.
 */
function explainGeoblock(raw: string): string | undefined {
  if (!/restricted in your region|geoblock/i.test(raw)) return undefined;
  return `${raw}\n\n` +
    `This is a venue-side regional restriction, not a problem with your keys or this app: ` +
    `the account, the signing key and the order were all accepted, and the block is applied ` +
    `to where the request came from. polymarket.com does not serve US traders; ` +
    `polymarket.us is the separate US venue, and it is a different API this app does not ` +
    `implement. Kalshi is already US-regulated, so the Kalshi leg is unaffected.`;
}

// The venue rejects with a machine-readable code; turn the ones a trader can act on into
// instructions rather than passing the bare enum through to the UI.
function mapOrderError(code: string, message: string): string {
  const mismatch = explainSignerMismatch(message) ?? explainGeoblock(message);
  if (mismatch) return mismatch;
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

    // Can this key actually sign orders, or does it merely authenticate?
    //
    // On an email/Magic account the wallet's on-chain controller is Polymarket's own relayer
    // signer, not anything the user holds — so the exported Magic key is never the owner, and
    // "export the owner's key" is not a fix available to anyone. Such a key is a SESSION KEY:
    // an externally managed signer that works only once its ADDRESS has been authorized on
    // the wallet, with scopes and an expiry.
    //
    // Unauthorized, it still passes every check above. It builds a client, reads the balance,
    // and even satisfies authenticated reads (listOpenOrders, listPositions and
    // fetchPortfolioValue all succeed) — then every order is rejected with "the order signer
    // address has to be the address of the API KEY". Comparing the signer against the proxy's
    // on-chain controller catches it here, before a trade is attempted.
    const walletOwner = await walletOwnerOnChain(init.wallet);
    const canSignOrders = walletOwner === undefined
      ? undefined                                     // not a proxy, or the chain read failed
      : walletOwner.toLowerCase() === init.address.toLowerCase();

    const balance = onChainUsdc ?? 0;
    let diagnosis: string | undefined;
    if (canSignOrders === false) {
      diagnosis =
        `POLYMARKET_PRIVATE_KEY controls ${init.address}, but ${init.wallet} was created for ` +
        `signer ${walletOwner} — the address Polymarket shows under Settings → Relayer API keys. ` +
        `Reads work and the $${balance.toFixed(2)} balance is real, but orders are rejected ` +
        `("the order signer address has to be the address of the API KEY"). ` +
        `Magic holds more than one wallet per login and its export screen shows whichever is ` +
        `active, so the first export can hand you a non-owning address: log out on the Magic ` +
        `export screen and back in until its header names ${walletOwner}, then check the key ` +
        `with "npm run check:wallet -- 0x<key>" before saving it.`;
    } else if (balance === 0) {
      diagnosis =
        `No collateral at ${init.wallet}. Polymarket settles in PUSD (0xC011a7E1…) — check that ` +
        `POLYMARKET_FUNDER_ADDRESS is the wallet Polymarket shows for your account, and that the ` +
        `deposit has landed there.`;
    }

    return {
      // A key that cannot sign orders is not a working connection, however much it can read.
      // Reporting ok here is what let a broken setup look green right up to the first trade.
      ok: canSignOrders !== false,
      address: init.address,
      funderAddress: init.wallet,
      usdcBalance: balance,
      onChainUsdc,
      approvalsReady,
      canSignOrders,
      walletOwner,
      diagnosis,
      error: canSignOrders === false ? 'Signing key is not this wallet\'s owner — orders will be rejected' : undefined,
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
      side: req.action === 'sell' ? OrderSide.SELL : OrderSide.BUY,
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
    const raw = describeError(err);
    return { ok: false, error: explainSignerMismatch(raw) ?? explainGeoblock(raw) ?? raw };
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

// ─── funding snapshot ────────────────────────────────────────────────────────
// testPolymarketAuth is a diagnostic: it reads the collateral balance, the wallet's owner
// and the trading approvals, which measured a median of 309ms and a worst case of 2.7s. It
// was being called on the pre-order path to check funding, so every trade waited on all
// three — more than the entire order-book re-check (~162ms), and invisible because it is not
// counted in revalidateMs.
//
// The order path only needs the balance. Ownership cannot change between two orders, and
// approvals are not consulted. The balance is cached briefly because it moves only when a
// trade settles, and staleness here is harmless in a way stale PRICES are not: this check is
// belt-and-braces, and the venue itself rejects an underfunded order. Getting it slightly
// wrong costs a rejection; being slow costs the edge.
let _fundingCache: { at: number; dollars: number } | null = null;
const FUNDING_TTL_MS = 5_000;

export async function polymarketFundingDollars(): Promise<number | undefined> {
  if (_fundingCache && Date.now() - _fundingCache.at < FUNDING_TTL_MS) return _fundingCache.dollars;
  const init = await getSecureClient();
  if ('error' in init) return undefined;
  const dollars = await onChainCollateral(init.wallet);
  if (dollars === undefined) return _fundingCache?.dollars;   // keep the last good reading
  _fundingCache = { at: Date.now(), dollars };
  return dollars;
}

/** Drop the cached balance so the next check re-reads it — call after a fill changes it. */
export function invalidatePolymarketFunding(): void {
  _fundingCache = null;
}
