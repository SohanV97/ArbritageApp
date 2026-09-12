#!/usr/bin/env node
/**
 * Move Kalshi collateral onto the exchange shard a market actually trades on.
 *
 *   npm run kalshi:allocate                 show the balance on every shard, move nothing
 *   npm run kalshi:allocate -- 3 50         move $50 onto shard 3
 *   npm run kalshi:allocate -- 3 50 --from 0   take it from shard 0 (default: the richest)
 *
 * Why this is needed at all: Kalshi's website hides sharding — you deposit once and can bet
 * on anything, because the site allocates for you. The API does not. Its own docs say
 * "Programmatic traders must preallocate collateral on a given exchange shard before order
 * placement", and an order against a shard holding nothing is refused with "insufficient
 * shard balance" however healthy the account total looks.
 *
 * That is not a theoretical problem: a deposit sat entirely on shard 0 while every MLB
 * market trades on shard 3, so the Polymarket leg of an arb filled and the Kalshi leg was
 * refused, leaving a one-sided position.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
try {
  const raw = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  // The RSA key spans many lines, so match it as a block rather than line by line.
  const pem = raw.match(/^KALSHI_PRIVATE_KEY\s*=\s*"?([\s\S]*?-----END RSA PRIVATE KEY-----)"?\s*$/m);
  if (pem && !process.env.KALSHI_PRIVATE_KEY) process.env.KALSHI_PRIVATE_KEY = pem[1];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] !== 'KALSHI_PRIVATE_KEY' && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* fall back to the ambient environment */ }

const mod = await import(pathToFileURL(path.join(root, 'api', 'kalshi-trading.ts')).href);

const auth = await mod.testKalshiAuth();
if (!auth.ok) {
  console.error(`\nCannot read the Kalshi balance: ${auth.error}\n`);
  process.exit(2);
}

const shards = auth.balanceByShard ?? {};
console.log(`\ntotal  $${(auth.balanceDollars ?? 0).toFixed(2)}`);
console.log('by exchange shard:');
for (const [idx, dollars] of Object.entries(shards).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  shard ${idx}   $${Number(dollars).toFixed(2)}`);
}
console.log('\n  MLB trades on shard 3; college football and politics on shard 0.');
console.log('  Check any market\'s exchange_index — it is the authoritative source.');

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const fromFlag = process.argv.indexOf('--from');
if (args.length < 2) {
  console.log('\nTo move money:  npm run kalshi:allocate -- <toShard> <dollars> [--from <shard>]\n');
  process.exit(0);
}

const toShard = Number(args[0]);
const dollars = Number(args[1]);
if (!Number.isInteger(toShard) || !Number.isFinite(dollars) || dollars <= 0) {
  console.error('\nUsage: npm run kalshi:allocate -- <toShard> <dollars> [--from <shard>]\n');
  process.exit(2);
}

// Default to whichever shard actually holds the money, so the common case needs no thought.
const richest = Object.entries(shards)
  .map(([i, d]) => [Number(i), Number(d)])
  .sort((a, b) => b[1] - a[1])[0];
const fromShard = fromFlag > -1 ? Number(process.argv[fromFlag + 1]) : (richest ? richest[0] : 0);

if (fromShard === toShard) {
  console.error(`\nShard ${toShard} is already the source — nothing to do.\n`);
  process.exit(2);
}
const available = Number(shards[fromShard] ?? 0);
if (available < dollars) {
  console.error(`\nShard ${fromShard} holds $${available.toFixed(2)}, which is less than the $${dollars.toFixed(2)} requested.\n`);
  process.exit(2);
}

console.log(`\nmoving $${dollars.toFixed(2)} from shard ${fromShard} to shard ${toShard}...`);
const res = await mod.transferBetweenKalshiShards(fromShard, toShard, dollars);
if (!res.ok) {
  console.error(`\nTransfer failed: ${res.error}\n`);
  process.exit(1);
}
console.log(`  accepted${res.transferId ? ` (transfer ${res.transferId})` : ''}`);

// Confirm against the account rather than trusting the response: the whole point is that
// the money is where an order can spend it.
await new Promise(r => setTimeout(r, 2000));
const after = await mod.testKalshiAuth();
const now = after.balanceByShard ?? {};
console.log('\nafter:');
for (const [idx, d] of Object.entries(now).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  console.log(`  shard ${idx}   $${Number(d).toFixed(2)}`);
}
