#!/usr/bin/env node
/**
 * One-time: grant the Polymarket exchange permission to move this wallet's collateral.
 *
 *   npm run setup:approvals
 *
 * A funded Polymarket wallet still cannot trade until it has granted an ERC-20 allowance on
 * the collateral token and ERC-1155 operator approvals on the outcome tokens. The website
 * does this behind the scenes on your first trade there; an account funded through a deposit
 * but never traded on has none of it, and every order comes back "insufficient balance or
 * allowance" while the balance plainly shows money.
 *
 * Polymarket's relayer pays the gas, so the wallet does not need MATIC. Approvals are a
 * standing permission and can be revoked later from the Polymarket interface.
 *
 * The private key is read from .env.local, used locally to sign, and never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
try {
  const raw = fs.readFileSync(path.join(root, '.env.local'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* fall back to whatever is already in the environment */ }

const mod = await import(pathToFileURL(path.join(root, 'api', 'polymarket-trading.ts')).href);

const before = await mod.testPolymarketAuth();
if (!before.ok) {
  console.error(`\nCannot reach the wallet: ${before.error}\n`);
  process.exit(2);
}

console.log(`\nwallet    ${before.funderAddress}`);
console.log(`balance   $${(before.usdcBalance ?? 0).toFixed(2)}`);
console.log(`approvals ${before.approvalsReady ? 'already in place' : 'missing — granting now'}`);

if (before.approvalsReady) {
  console.log('\nNothing to do; this wallet can already trade.\n');
  process.exit(0);
}

console.log('\nSigning approval transactions (relayed by Polymarket, no gas needed)...');
const result = await mod.setupPolymarketApprovals();

if (!result.ok) {
  console.error(`\nFailed: ${result.error}\n`);
  process.exit(1);
}
console.log('\nDone — this wallet can now trade. Run a connection test in the app to confirm.\n');
