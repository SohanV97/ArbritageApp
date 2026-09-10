#!/usr/bin/env node
/**
 * Proves the Polymarket order path works, without risking money.
 *
 *   npm run test:pm-order          place a probe order, verify, cancel
 *   npm run test:pm-order -- --dry rehearse everything except the order itself
 *
 * Why this exists: every other check in this repo stops short of the one thing that matters,
 * because the only honest test of "can this app place an order" is placing one. Reading the
 * balance, deriving credentials and typechecking against the SDK all pass on an account that
 * cannot actually trade.
 *
 * How it avoids costing anything: it bids 1c on a market trading far above that. The order is
 * accepted by the exchange and rests on the book unfilled — which exercises the whole path
 * (signing, authentication, submission, venue acceptance) — and is then cancelled. A resting
 * order that never matches moves no money.
 *
 * The one residual risk is a fill, and it is bounded: the script refuses to run unless the
 * market's best bid is far above the probe price, and the order is $1 in total. What this
 * does NOT prove is the matching path — a real fill behaves differently from a resting order,
 * so the first genuine trade is still the first genuine trade.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DRY = process.argv.includes('--dry');
const PROBE_PRICE_CENTS = 1;      // far below any real market
const PROBE_SIZE = 100;           // 100 shares x 1c = $1.00, meets the venue minimum
const MIN_SAFE_BID_CENTS = 20;    // refuse markets whose bid is anywhere near the probe

const root = process.cwd();
try {
  const raw = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* fall back to the ambient environment */ }

const mod = await import(pathToFileURL(path.join(root, 'api', 'polymarket-trading.ts')).href);

// ── 1. account is reachable and funded ───────────────────────────────────────
const auth = await mod.testPolymarketAuth();
if (!auth.ok) {
  // A failure with a diagnosis has already worked out what is wrong and how to fix it;
  // printing only the one-line error throws that away and leaves nothing to act on.
  console.error(`\n${auth.error ?? 'Cannot reach the account.'}`);
  if (auth.address) console.error(`\n  key controls   ${auth.address}`);
  if (auth.funderAddress) console.error(`  funder wallet  ${auth.funderAddress}`);
  if (auth.walletOwner) console.error(`  owned by       ${auth.walletOwner}`);
  if (auth.diagnosis) console.error(`\n${auth.diagnosis}`);
  console.error('');
  process.exit(2);
}
console.log(`\nsigner   ${auth.address}`);
console.log(`wallet   ${auth.funderAddress}${auth.walletOwner ? `  (owned by ${auth.walletOwner})` : ''}`);
console.log(`balance  $${(auth.usdcBalance ?? 0).toFixed(2)}`);

// Check this before touching a market. A key that only authenticates gets all the way to
// the order and is rejected there, which reads as a broken order path rather than a wrong
// key — the venue's wording ("the order signer address has to be the address of the API
// KEY") does not say which key it means, or that a session key is the problem.
if (auth.canSignOrders === false) {
  console.error(`\nThis key cannot sign orders for that wallet.\n\n${auth.diagnosis}\n`);
  process.exit(2);
}
if (auth.canSignOrders === undefined) {
  console.log('owner    (could not read the wallet owner on-chain — proceeding)');
}
if ((auth.usdcBalance ?? 0) < 1) {
  console.error('\nNeeds at least $1 to place even a probe order.\n');
  process.exit(2);
}

// ── 2. find a liquid market whose price is nowhere near the probe ────────────
// Ordered by liquidity, not volume: the highest-volume markets are long shots priced at a
// fraction of a cent, which are precisely the ones a 1c bid could accidentally cross.
const res = await fetch(
  'https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=100&order=liquidityNum&ascending=false',
);
if (!res.ok) {
  console.error(`\nCould not list markets: HTTP ${res.status}\n`);
  process.exit(2);
}

let target = null;
for (const m of await res.json()) {
  const bidCents = Math.round(Number(m.bestBid) * 100);
  if (!Number.isFinite(bidCents) || bidCents < MIN_SAFE_BID_CENTS || bidCents > 90) continue;
  let ids;
  try { ids = JSON.parse(m.clobTokenIds); } catch { continue; }
  if (!Array.isArray(ids) || !ids[0]) continue;
  target = { question: m.question, tokenId: String(ids[0]), bidCents };
  break;
}

if (!target) {
  console.error('\nNo market found with a bid far enough above the probe price to be safe.\n');
  process.exit(2);
}

console.log(`\nmarket   ${target.question.slice(0, 68)}`);
console.log(`  best bid       ${target.bidCents}c`);
console.log(`  probe bid      ${PROBE_PRICE_CENTS}c x ${PROBE_SIZE} shares  ($${(PROBE_PRICE_CENTS * PROBE_SIZE / 100).toFixed(2)} if it filled)`);
console.log(`  gap            ${target.bidCents - PROBE_PRICE_CENTS}c below the best bid, so it rests rather than matching`);

if (DRY) {
  console.log('\n--dry: stopping before placing. Everything above this line is verified.\n');
  process.exit(0);
}

// ── 3. place it ──────────────────────────────────────────────────────────────
console.log('\nplacing...');
const placed = await mod.placePolymarketOrder({
  tokenId: target.tokenId,
  count: PROBE_SIZE,
  priceCents: PROBE_PRICE_CENTS,
});

if (!placed.ok) {
  console.error(`\nREJECTED: ${placed.error}\n`);
  console.error('The order path does NOT work yet. Nothing was spent.\n');
  process.exit(1);
}

console.log(`  accepted       orderId ${placed.orderId}`);
console.log(`  status         ${placed.status}`);
console.log(`  filled         ${placed.filledCount ?? 0} shares`);

// ── 4. always clean up, even if something above surprised us ─────────────────
let cancelNote = '';
if (placed.orderId) {
  const cancelled = await mod.cancelPolymarketOrder(placed.orderId);
  cancelNote = cancelled.ok
    ? '  cancelled      yes'
    : `  cancelled      FAILED: ${cancelled.error}\n  Cancel it by hand at polymarket.com before leaving it resting.`;
  console.log(cancelNote);
}

const filled = placed.filledCount ?? 0;
if (filled > 0) {
  console.log(`\nNote: ${filled} shares actually filled, so this cost real money.`);
  console.log('That means the probe crossed the book — check the position on polymarket.com.');
}

console.log('\nThe order path works: signed, authenticated, accepted by the exchange.');
console.log('A real fill still behaves differently from a resting order, so keep the first');
console.log('live trade at minimum size.\n');
