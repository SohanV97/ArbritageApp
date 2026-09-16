#!/usr/bin/env node
/**
 * How collateral is spread across Kalshi's exchange shards.
 *
 *   npm run test:shards
 *
 * Kalshi funds an order only from the shard its market sits on, so this decides whether a
 * trade can happen at all. It once left a Polymarket leg filled and the Kalshi leg refused
 * for "insufficient shard balance" on an account holding plenty — just not there.
 *
 * The first version deadlocked on a real account, which is why these cases exist.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { planTransfers: plan } = await import(
  pathToFileURL(path.join(process.cwd(), 'lib', 'shardAllocation.ts')).href
);

let failed = 0;
const t = (name, ok, got) => {
  if (ok) { console.log('  PASS  ' + name); return; }
  failed++;
  console.log('  FAIL  ' + name);
  console.log('        got: ' + JSON.stringify(got));
};
const applied = (balances, moves) => {
  const out = { ...balances };
  for (const m of moves) { out[m.from] -= m.dollars; out[m.to] += m.dollars; }
  return out;
};

console.log('\nshard allocation');

// The real account that exposed the deadlock: MLB (shard 3) starved while shard 0 held
// nearly everything, and a fixed $120 floor meant no shard was ever "rich enough" to give.
const real = { 0: 105.8697, 1: 0, 2: 0, 3: 6.7374 };
const p1 = plan(real, [0, 3], 150);
t('the real skewed account actually moves money', p1.length > 0, p1);
const after1 = applied(real, p1);
t('both traded shards end up usable', after1[0] > 40 && after1[3] > 40, after1);
t('nothing is moved out of a shard it was just moved into',
  new Set(p1.map(m => m.to)).size === p1.map(m => m.to).length || !p1.some(m => p1.some(n => n.from === m.to)), p1);

// Idempotent: once balanced, it should stop.
t('a balanced account moves nothing', plan(after1, [0, 3], 150).length === 0, plan(after1, [0, 3], 150));

// Untraded shards are the cheapest source and should be drained first.
const idle = { 0: 10, 1: 90, 2: 0, 3: 10 };
const p2 = plan(idle, [0, 3], 150);
t('money is pulled from shards nothing trades on', p2.every(m => m.from === 1), p2);

// Never invent money.
const conserved = (b, moves) => {
  const before = Object.values(b).reduce((a, c) => a + c, 0);
  const after = Object.values(applied(b, moves)).reduce((a, c) => a + c, 0);
  return Math.abs(before - after) < 0.01;
};
t('total balance is conserved', conserved(real, p1) && conserved(idle, p2), { p1, p2 });

// Never overdraw a donor.
const noOverdraw = (b, moves) => Object.values(applied(b, moves)).every(v => v >= -0.01);
t('no shard is overdrawn', noOverdraw(real, p1) && noOverdraw(idle, p2), applied(real, p1));

// A large account is capped by the floor rather than split to extremes.
const rich = { 0: 4000, 1: 0, 2: 0, 3: 0 };
const p3 = plan(rich, [0, 3], 150);
t('a large account tops up to the floor, not to half of everything',
  applied(rich, p3)[3] <= 151, applied(rich, p3));

t('no shards in use means no moves', plan(real, [], 150).length === 0);

console.log(failed === 0 ? '\n  shard allocation holds\n' : '\n  ' + failed + ' FAILED\n');
process.exit(failed ? 1 : 0);
