#!/usr/bin/env node
/**
 * Close open Kalshi positions by selling into the bid.
 *
 *   npm run kalshi:close                 list open positions, sell nothing
 *   npm run kalshi:close -- --all        close every open position
 *   npm run kalshi:close -- TICKER       close just this one
 *
 * The app unwinds a leg that fills alone, but only at the moment it trades. A position that
 * is already open when something goes wrong — a missed unwind, a crash, an order placed by
 * hand — is out of its reach, and until now the only route was the Kalshi website.
 *
 * Prices the exit off the CURRENT BID rather than any remembered entry, for the same reason
 * the executor does: an exit is needed precisely when the price has moved, so a limit
 * anchored to the entry can sit above the book and never fill.
 */
import fs from 'node:fs';
import path from 'node:path';
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
} catch { /* fall back to the ambient environment */ }

const load = (p) => import(pathToFileURL(path.join(root, ...p)).href);
const { placeKalshiOrder, getKalshiPositions, getKalshiBook } = await load(['api', 'kalshi-trading.ts']);
const { kalshiBidLadder, bidSweep } = await load(['lib', 'depth.ts']);

const args = process.argv.slice(2);
const all = args.includes('--all');
const only = args.find(a => !a.startsWith('--'));

const positions = await getKalshiPositions();
if (!positions.ok) {
  console.error(`\nCannot read positions: ${positions.error}\n`);
  process.exit(2);
}
const open = positions.positions.filter(p => p.contracts !== 0);

console.log(`\nopen positions: ${open.length}`);
for (const p of open) {
  console.log(`  ${p.ticker}  ${p.contracts > 0 ? 'LONG' : 'SHORT'} ${Math.abs(p.contracts)}  exposure $${p.exposureDollars.toFixed(2)}`);
}
if (open.length === 0) { console.log(); process.exit(0); }

const targets = only ? open.filter(p => p.ticker === only) : (all ? open : []);
if (targets.length === 0) {
  console.log(`\nTo close:  npm run kalshi:close -- --all      (or a single TICKER)\n`);
  process.exit(0);
}

let failures = 0;
for (const pos of targets) {
  // A SHORT is closed by buying back, which this script does not do: the app only ever opens
  // longs, so a short here means something unexpected and a human should look at it.
  if (pos.contracts < 0) {
    console.log(`\n${pos.ticker}: SHORT ${Math.abs(pos.contracts)} — buying back is not handled here, close it on Kalshi.`);
    failures++;
    continue;
  }
  let remaining = pos.contracts;
  console.log(`\n${pos.ticker}: closing ${remaining}`);
  for (let attempt = 1; attempt <= 3 && remaining > 0; attempt++) {
    const book = await getKalshiBook(pos.ticker);
    const ladder = kalshiBidLadder(book, 'yes');
    const sweep = bidSweep(ladder, remaining);
    if (!sweep || sweep.available <= 0) { console.log('  no bids on the book'); break; }
    const limit = Math.max(1, Math.min(99, sweep.priceCents - 1));
    const size = Math.min(remaining, sweep.available);
    const res = await placeKalshiOrder({
      ticker: pos.ticker, side: 'yes', count: size, priceCents: limit, action: 'sell',
    });
    const got = res.ok ? (res.filledCount ?? 0) : 0;
    remaining -= got;
    console.log(`  attempt ${attempt}: offered ${size} at ${limit}c -> filled ${got}, ${remaining} left${res.ok ? '' : ` (${res.error})`}`);
    if (!res.ok) break;
  }
  if (remaining > 0) { console.log(`  STILL OPEN: ${remaining} — close on Kalshi by hand`); failures++; }
  else console.log('  closed');
}
console.log();
process.exit(failures ? 1 : 0);
