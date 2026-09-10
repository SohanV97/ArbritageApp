#!/usr/bin/env node
/**
 * Does a private key actually control the Polymarket wallet holding your money?
 *
 *   npm run check:wallet                 checks the key already in .env.local
 *   npm run check:wallet -- 0xabc123...  checks a key WITHOUT saving it anywhere
 *
 * Why this exists: a key that belongs to the wrong wallet authenticates perfectly and then
 * reports $0.00 forever, which looks identical to an unfunded account. This says outright
 * which address a key controls, which address holds the funds, and whether the two match —
 * so a candidate key can be checked in one command instead of by attempting a trade.
 *
 * The key is only ever used locally to derive its address. It is never sent anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.join(process.cwd(), '.env.local');
const readEnv = (name) => {
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    const m = raw.match(new RegExp('^' + name + '\\s*=\\s*(.*)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
};

// Polymarket's own collateral token. It is NOT USDC — an account funded in PUSD reads as
// zero if you only look at USDC.e, which is exactly how a funded wallet appeared empty.
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const RPCS = ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.llamarpc.com'];

async function rpc(method, params) {
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.error) continue;
      return j.result;
    } catch { /* next endpoint */ }
  }
  return null;
}

const balanceOf = async (token, addr) => {
  const data = '0x70a08231' + addr.toLowerCase().slice(2).padStart(64, '0');
  const r = await rpc('eth_call', [{ to: token, data }, 'latest']);
  return r && r !== '0x' ? Number(BigInt(r)) / 1e6 : 0;
};

// Polymarket deposit wallets are minimal proxies with the controlling address appended to
// the runtime bytecode; read it straight off the chain.
async function controllerOf(addr) {
  const code = await rpc('eth_getCode', [addr, 'latest']);
  if (!code || code === '0x') return null;
  const tail = code.slice(-64);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(tail)) return null;
  const owner = '0x' + tail.slice(24);
  return /^0x0+$/.test(owner) ? null : owner;
}

const key = (process.argv[2] || readEnv('POLYMARKET_PRIVATE_KEY') || '').trim();
const funder = (readEnv('POLYMARKET_FUNDER_ADDRESS') || '').trim();

if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error(
    `\nNot a private key: ${key ? `${key.length} characters` : '(nothing supplied)'}\n` +
    `A Polygon private key is 0x followed by 64 hex characters (66 in total), no dashes.\n` +
    `A value like "01234567-89ab-cdef-0123-456789abcdef" is an API key — a different thing,\n` +
    `and not something that can sign an order.\n`
  );
  process.exit(2);
}

const { Wallet } = await import('ethers');
const address = new Wallet(key).address;

console.log(`\nthis key controls   ${address}`);
if (!funder) {
  console.log('POLYMARKET_FUNDER_ADDRESS is not set, so there is nothing to compare against.');
  process.exit(1);
}

const [pusd, usdce, controller] = await Promise.all([
  balanceOf(PUSD, funder), balanceOf(USDC_E, funder), controllerOf(funder),
]);

console.log(`funder wallet       ${funder}`);
console.log(`  holds             $${pusd.toFixed(2)} PUSD` + (usdce > 0 ? `  +  $${usdce.toFixed(2)} USDC.e` : ''));
console.log(`  controlled by     ${controller ?? '(not a proxy — it controls itself)'}`);

const expected = controller ?? funder;
const ok = address.toLowerCase() === expected.toLowerCase();
console.log(`\n${ok ? 'MATCH — this key can sign for that wallet.' : 'NO MATCH — this key CANNOT sign for that wallet.'}`);
if (!ok) {
  // On an email/Magic account the owner is Polymarket's own relayer signer, so "get the
  // owner's key" is not a route anyone has. Authorizing this address as a session key is.
  console.log(`
  ${expected} is the wallet's on-chain owner. On an email/Magic account that is`);
  console.log("  Polymarket's relayer signer, not a key you can export — so do not go looking for it.");
  console.log(`
  Instead authorize ${address} as a session key:`);
  console.log('    polymarket.com -> Settings -> Session keys -> authorize that address (trading scope)');
  console.log('  Or create a session key there and put the private key it gives you in .env.local.');
  console.log('  Session keys carry an expiry, so this can need renewing.');
}
process.exit(ok ? 0 : 1);
