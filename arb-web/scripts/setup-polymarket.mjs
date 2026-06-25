/**
 * One-time script to generate Polymarket CLOB API credentials.
 *
 * Run:  node scripts/setup-polymarket.mjs
 *
 * Prerequisites:
 *   1. Set POLYMARKET_PRIVATE_KEY in .env.local (your Polygon wallet private key, starts with 0x)
 *   2. Your wallet needs USDC on Polygon for trading (fund via bridge or exchange)
 *
 * Output:
 *   Prints POLYMARKET_CLOB_KEY, POLYMARKET_CLOB_SECRET, POLYMARKET_CLOB_PASSPHRASE
 *   Copy these into .env.local
 */

import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import { ClobClient } from '@polymarket/clob-client';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local manually (dotenv not required)
const envPath = resolve(process.cwd(), '.env.local');
let privateKey = process.env.POLYMARKET_PRIVATE_KEY;
if (!privateKey) {
  try {
    const env = readFileSync(envPath, 'utf8');
    for (const line of env.split('\n')) {
      const [k, ...vParts] = line.split('=');
      if (k?.trim() === 'POLYMARKET_PRIVATE_KEY') {
        privateKey = vParts.join('=').trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* .env.local not found */ }
}

if (!privateKey) {
  console.error('Error: POLYMARKET_PRIVATE_KEY not found in .env.local or environment');
  process.exit(1);
}

const account = privateKeyToAccount(privateKey);
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
const client = new ClobClient('https://clob.polymarket.com', 137, walletClient);

console.log('Generating CLOB API credentials for wallet:', account.address);
console.log('(This requires one signature from your private key)\n');

const creds = await client.createApiKey();
console.log('Add these to your .env.local:\n');
console.log(`POLYMARKET_CLOB_KEY=${creds.key}`);
console.log(`POLYMARKET_CLOB_SECRET=${creds.secret}`);
console.log(`POLYMARKET_CLOB_PASSPHRASE=${creds.passphrase}`);
