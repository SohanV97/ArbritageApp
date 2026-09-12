#!/usr/bin/env node
/**
 * Check every recorded trade against what the venues say actually happened.
 *
 *   npm run trades:reconcile
 *
 * This exists because the venues' immediate answers have been wrong in ways that cost money.
 * Polymarket reported a fill of zero on an order that had filled 5 shares at 91c, and the
 * app very nearly sold a properly hedged Kalshi leg on the strength of it. An order response
 * is what a venue believed at that instant; the position is what is true.
 *
 * So this asks again, long after settlement, and marks any disagreement. A mismatch is not a
 * bookkeeping nit: it means the app made a decision on a number that was wrong, and every
 * such case is a bug worth chasing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
try {
  const raw = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  const pem = raw.match(/^KALSHI_PRIVATE_KEY\s*=\s*"?([\s\S]*?-----END RSA PRIVATE KEY-----)"?\s*$/m);
  if (pem && !process.env.KALSHI_PRIVATE_KEY) process.env.KALSHI_PRIVATE_KEY = pem[1];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] !== 'KALSHI_PRIVATE_KEY' && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* ambient environment */ }

const load = (...p) => import(pathToFileURL(path.join(root, ...p)).href);
const { readAttempts, rewriteAttempts } = await load('lib', 'tradeJournal.ts');

// Anything younger than this may still be settling; asking too early re-creates the very
// mistake being checked for.
const SETTLE_MS = 60_000;

const all = readAttempts();
const targets = all.filter(a =>
  a.legs.some(l => l.orderId) &&
  !a.reconciliation &&
  Date.now() - Date.parse(a.ts) > SETTLE_MS);

console.log('\n' + all.length + ' attempts on file, ' + targets.length + ' ready to reconcile');
if (targets.length === 0) {
  console.log('Nothing to do. Attempts are checked once they are at least 60s old.\n');
  process.exit(0);
}

// ── Kalshi: one call returns every recent order with its true fill ──
const B = 'https://api.elections.kalshi.com/trade-api/v2';
const pem = process.env.KALSHI_PRIVATE_KEY;
const keyId = process.env.KALSHI_API_KEY;
const kalshiFills = new Map();
if (pem && keyId) {
  const sign = (ts, m, p) => crypto
    .sign('sha256', Buffer.from(ts + m + p), {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString('base64');
  try {
    const ts = Date.now().toString();
    const res = await fetch(B + '/portfolio/orders?limit=200', {
      headers: {
        'KALSHI-ACCESS-KEY': keyId,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-SIGNATURE': sign(ts, 'GET', '/trade-api/v2/portfolio/orders'),
      },
    });
    if (res.ok) {
      const data = await res.json();
      for (const o of data.orders || []) {
        if (o.order_id) kalshiFills.set(o.order_id, Number(o.fill_count_fp ?? o.fill_count ?? 0));
      }
    } else {
      console.warn('  Kalshi orders unavailable: HTTP ' + res.status);
    }
  } catch (err) {
    console.warn('  Kalshi orders unavailable: ' + (err && err.message));
  }
}
console.log('  Kalshi knows about ' + kalshiFills.size + ' recent orders');

// ── Polymarket: asked one order at a time ──
let pmFill = async () => null;
try {
  const mod = await load('api', 'polymarket-trading.ts');
  if (typeof mod.polymarketOrderFill === 'function') pmFill = mod.polymarketOrderFill;
} catch (err) {
  console.warn('  Polymarket client unavailable: ' + (err && err.message));
}

let checked = 0, mismatched = 0;
for (const a of targets) {
  const notes = [];
  let mismatch = false;
  const rec = { checkedAt: new Date().toISOString(), mismatch: false };

  for (const leg of a.legs) {
    if (!leg.orderId) continue;
    let actual = null;
    if (leg.venue === 'kalshi') {
      actual = kalshiFills.has(leg.orderId) ? kalshiFills.get(leg.orderId) : null;
      if (actual !== null) rec.kalshiActualFill = actual;
    } else {
      try { actual = await pmFill(leg.orderId); } catch { actual = null; }
      if (actual !== null) rec.polymarketActualFill = actual;
    }
    if (actual === null) continue;
    // Sub-share rounding is not a disagreement; a whole share is.
    if (Math.abs(actual - leg.reportedFill) >= 1) {
      mismatch = true;
      notes.push(leg.venue + ' recorded ' + leg.reportedFill + ' but actually filled ' + actual);
    }
  }

  rec.mismatch = mismatch;
  if (notes.length) rec.note = notes.join('; ');
  a.reconciliation = rec;
  checked++;
  if (mismatch) {
    mismatched++;
    console.log('  MISMATCH ' + a.ts.slice(11, 19) + ' ' + a.market.kalshiTicker + ': ' + rec.note);
  }
}

rewriteAttempts(all);
console.log('\nreconciled ' + checked + ' attempts, ' + mismatched + ' disagreed with the venue');
if (mismatched > 0) {
  console.log('A disagreement means the app decided on a fill count that was wrong. Chase each one.');
}
console.log('');
