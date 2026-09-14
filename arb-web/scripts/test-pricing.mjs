#!/usr/bin/env node
/**
 * The rules that decide what a trade is allowed to cost.
 *
 *   npm run test:pricing
 *
 * This is the calculation that turned a real hedge into a guaranteed loss once already: the
 * Wake Forest trade filled 9c on Kalshi and 91c on Polymarket, a perfect hedge that cost
 * exactly its own 100c payout. Every check below is a property that failure violated, plus
 * the ones added since, so a future change to the buffers cannot quietly reintroduce it.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const load = (...p) => import(pathToFileURL(path.join(process.cwd(), ...p)).href);
const { pairLimits } = await load('lib', 'pricing.ts');
const fees = await load('lib', 'fees.ts');

let failed = 0;
const t = (name, ok, got) => {
  if (ok) { console.log('  PASS  ' + name); return; }
  failed++;
  console.log('  FAIL  ' + name);
  console.log('        got: ' + JSON.stringify(got));
};

const flat = () => 0.6;      // ~0.6c per contract across both venues
const none = () => 0;
const realFee = (pm, kal) =>
  fees.estimateKalshiFeeCents(kal, 1) + fees.estimatePolymarketFeeCents('sports', pm, 1);

console.log('\npair pricing');

// The trade that made this file necessary: book 8 + 88, buffers 1 and 3 would have priced
// the pair at exactly 100c against a 100c payout.
const wake = pairLimits({ kalAtBook: 8, pmAtBook: 88, kalBuffer: 1, pmBuffer: 3, feePerContract: flat });
t('the wake forest pair never reaches 100c', wake !== null && wake.kalLimit + wake.pmLimit < 100, wake);
t('the wake forest pair keeps a positive net edge', wake !== null && wake.netEdgeCents > 0, wake);

// A pair that costs its own payout is not an arb at any buffer.
t('a pair costing its payout is refused',
  pairLimits({ kalAtBook: 50, pmAtBook: 50, kalBuffer: 1, pmBuffer: 2, feePerContract: flat }) === null);
t('exact break-even is refused',
  pairLimits({ kalAtBook: 40, pmAtBook: 60, kalBuffer: 0, pmBuffer: 0, feePerContract: none }) === null);

const thin = pairLimits({ kalAtBook: 40, pmAtBook: 59, kalBuffer: 0, pmBuffer: 0, feePerContract: none });
t('one cent of room is tradeable', thin !== null && thin.netEdgeCents === 1, thin);

// Buffers may not eat the edge they are protecting. A wide edge used to come out worth the
// same ~1c as a marginal one, because the buffer grew with it.
const wide = pairLimits({ kalAtBook: 40, pmAtBook: 50, kalBuffer: 3, pmBuffer: 4, feePerContract: flat });
const wideGross = 100 - 40 - 50 - 0.6;
t('a wide edge keeps at least half of itself',
  wide !== null && wide.netEdgeCents >= wideGross / 2 - 0.01, { wide, wideGross });

// ...and the net has to actually rise with the gross, or good edges are subsidising bad ones.
const nets = [];
for (const gross of [1, 2, 4, 6, 8]) {
  const kalAtBook = 67;
  const pmAtBook = Math.floor(100 - kalAtBook - gross - realFee(100 - kalAtBook - gross, kalAtBook));
  const r = pairLimits({
    kalAtBook, pmAtBook,
    pmBuffer: Math.min(3, Math.floor(gross)),
    kalBuffer: Math.min(4, Math.floor(gross) + 2),
    feePerContract: realFee,
  });
  nets.push(r ? r.netEdgeCents : null);
}
t('net edge rises with gross edge',
  nets.every(n => n !== null) && nets.every((n, i) => i === 0 || n > nets[i - 1]), nets);

// Exhaustive: the two properties that make a limit safe at all.
const all = [];
for (let k = 1; k <= 95; k++) {
  for (let p = 1; p + k <= 99; p++) {
    const r = pairLimits({ kalAtBook: k, pmAtBook: p, kalBuffer: 3, pmBuffer: 4, feePerContract: flat });
    if (r) all.push({ k, p, r });
  }
}
t('no result ever prices a leg below its own book',
  all.every(x => x.r.kalLimit >= x.k && x.r.pmLimit >= x.p),
  all.find(x => x.r.kalLimit < x.k || x.r.pmLimit < x.p));
t('no result ever sums to a loss',
  all.every(x => x.r.kalLimit + x.r.pmLimit + 0.6 < 100),
  all.find(x => x.r.kalLimit + x.r.pmLimit + 0.6 >= 100));
t('no result ever keeps less than half its gross edge',
  all.every(x => {
    const gross = 100 - x.k - x.p - 0.6;
    return x.r.netEdgeCents >= Math.min(gross, Math.max(0.5, gross / 2)) - 0.01;
  }),
  all.find(x => {
    const gross = 100 - x.k - x.p - 0.6;
    return x.r.netEdgeCents < Math.min(gross, Math.max(0.5, gross / 2)) - 0.01;
  }));

console.log('\n  ' + all.length + ' book combinations checked');
console.log(failed === 0 ? '  pair pricing holds\n' : '  ' + failed + ' FAILED\n');
process.exit(failed ? 1 : 0);
