#!/usr/bin/env node
/**
 * What the execution journal says about why trades are or are not happening.
 *
 *   npm run trades:report            everything on file
 *   npm run trades:report -- 2h      the last two hours (m/h/d)
 *
 * Ordered by what actually decides whether this app makes money. Latency first: an edge that
 * lasts under a second is not captured by being right about it, only by being fast, so the
 * time between seeing a price and the venue answering is the number that matters most. Then
 * the refusals, because most attempts never reach a venue and the reason they stop is the
 * clearest signal available about what to fix next.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { readAttempts } = await import(
  pathToFileURL(path.join(process.cwd(), 'lib', 'tradeJournal.ts')).href
);

const arg = process.argv.slice(2).find(a => /^\d+[mhd]$/.test(a));
const UNITS = { m: 60e3, h: 3600e3, d: 86400e3 };
const windowMs = arg ? Number(arg.slice(0, -1)) * UNITS[arg.slice(-1)] : Infinity;

const all = readAttempts();
const cutoff = Date.now() - windowMs;
const rows = all.filter(a => Date.parse(a.ts) >= cutoff);

if (rows.length === 0) {
  console.log('\nNo attempts recorded yet.');
  console.log('The journal fills as the auto-executor runs; refused attempts count too.\n');
  process.exit(0);
}

const pct = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const fmt = (n, unit) => (n === null || n === undefined ? '-' : Math.round(n) + (unit || 'ms'));
const bar = (n, total, width) => {
  const w = width || 28;
  return '#'.repeat(Math.round((n / Math.max(1, total)) * w)).padEnd(w, '.');
};

console.log('\n' + '='.repeat(74));
console.log('  ' + rows.length + ' attempts' + (arg ? ' in the last ' + arg : '') + '   (' + all.length + ' on file)');
console.log('='.repeat(74));

const byOutcome = {};
for (const a of rows) byOutcome[a.outcome] = (byOutcome[a.outcome] || 0) + 1;
console.log('\nOUTCOMES');
for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
  console.log('  ' + k.padEnd(10) + String(v).padStart(4) + '  ' + bar(v, rows.length) + '  ' + ((v / rows.length) * 100).toFixed(1) + '%');
}

// ── latency: the number that decides everything ──
const sent = rows.filter(a => a.legs.length > 0);
console.log('\nLATENCY  (attempts that reached a venue: ' + sent.length + ')');
if (sent.length === 0) {
  console.log('  No orders were sent, so there is nothing to time.');
} else {
  const line = (name, arr) => console.log(
    '  ' + name.padEnd(22) +
    'p50 ' + fmt(pct(arr, 0.5)).padStart(7) +
    '   p90 ' + fmt(pct(arr, 0.9)).padStart(7) +
    '   max ' + fmt(pct(arr, 1)).padStart(7));
  line('whole attempt', sent.map(a => a.totalMs).filter(Number.isFinite));
  line('  re-quote books', sent.map(a => a.edge && a.edge.revalidateMs).filter(Number.isFinite));
  line('  funding wait', sent.map(a => a.timings && a.timings.fundingWaitMs).filter(Number.isFinite));
  line('  polymarket order', sent.flatMap(a => a.legs.filter(l => l.venue === 'polymarket').map(l => l.ms)));
  line('  kalshi order', sent.flatMap(a => a.legs.filter(l => l.venue === 'kalshi').map(l => l.ms)));
  const slow = sent.filter(a => a.totalMs > 2000).length;
  if (slow) console.log('  ' + slow + ' of ' + sent.length + ' took over 2s - long enough for the edge to be gone.');
}

// ── why nothing was sent ──
const refused = rows.filter(a => a.outcome === 'no-orders');
if (refused.length) {
  console.log('\nWHY NOTHING WAS SENT  (' + refused.length + ')');
  const groups = {};
  for (const a of refused) {
    // Collapse to the distinguishing clause: the numbers differ on every message.
    const raw = String(a.refusedReason || 'unknown').replace(/\s+/g, ' ');
    const key = raw.replace(/-?\d+(\.\d+)?/g, 'N').slice(0, 96);
    (groups[key] = groups[key] || []).push(a);
  }
  const sorted = Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
  for (const [k, list] of sorted.slice(0, 8)) {
    console.log('  ' + String(list.length).padStart(4) + 'x  ' + k);
  }
}

// ── did the legs fill ──
console.log('\nFILL RATE  (per venue, orders actually sent)');
for (const venue of ['polymarket', 'kalshi']) {
  const legs = rows.flatMap(a => a.legs.filter(l => l.venue === venue));
  if (!legs.length) { console.log('  ' + venue.padEnd(12) + 'no orders sent'); continue; }
  const any = legs.filter(l => l.reportedFill > 0).length;
  const full = legs.filter(l => l.reportedFill >= l.requested).length;
  const req = legs.reduce((s, l) => s + l.requested, 0);
  const got = legs.reduce((s, l) => s + l.reportedFill, 0);
  console.log('  ' + venue.padEnd(12) + legs.length + ' orders | any fill ' + any +
    ' (' + ((any / legs.length) * 100).toFixed(0) + '%) | complete ' + full +
    ' | shares ' + got.toFixed(0) + '/' + req.toFixed(0));
  const statuses = {};
  for (const l of legs) {
    const key = l.status || (l.ok ? 'ok' : 'rejected');
    statuses[key] = (statuses[key] || 0) + 1;
  }
  console.log('  '.padEnd(14) + 'status: ' + Object.entries(statuses).map(([k, v]) => k + '=' + v).join(' '));
}

// ── the book promised depth that was not there ──
const underfilled = rows.filter(a =>
  a.plan && a.legs.some(l => l.ok && l.reportedFill > 0 && l.reportedFill < l.requested));
if (underfilled.length) {
  console.log('\nDEPTH THAT WAS NOT THERE  (' + underfilled.length + ')');
  for (const a of underfilled.slice(0, 6)) {
    const l = a.legs.find(x => x.reportedFill > 0 && x.reportedFill < x.requested);
    const claimed = l.venue === 'kalshi' ? a.plan.kalDepth : a.plan.pmDepth;
    console.log('  ' + a.ts.slice(11, 19) + ' ' + a.market.kalshiTicker.slice(-22).padEnd(24) +
      l.venue.padEnd(11) + 'asked ' + String(l.requested).padStart(5) +
      ' got ' + String(l.reportedFill).padStart(5) +
      '  book claimed ' + (claimed === undefined ? '-' : claimed) + ' @ ' + l.limitCents + 'c' +
      '  [' + (a.edge.bookSource || '?') + ']');
  }
}

// ── the edge between quote and order ──
const decayed = rows.filter(a => a.edge &&
  Number.isFinite(a.edge.quotedPercent) && Number.isFinite(a.edge.freshPercent));
if (decayed.length) {
  const drops = decayed.map(a => a.edge.freshPercent - a.edge.quotedPercent);
  const gone = decayed.filter(a => a.edge.quotedPercent > 0 && a.edge.freshPercent <= 0).length;
  console.log('\nEDGE BETWEEN QUOTE AND ORDER');
  console.log('  change  p50 ' + fmt(pct(drops, 0.5), 'c') + '   p10 ' + fmt(pct(drops, 0.1), 'c') +
    '   worst ' + fmt(pct(drops, 0), 'c'));
  console.log('  ' + gone + ' of ' + decayed.length + ' had gone negative by the time the books were re-read');
}

// ── live books versus fetched ──
const bySource = {};
for (const a of rows) {
  if (!a.edge || !a.edge.bookSource) continue;
  const e = bySource[a.edge.bookSource] = bySource[a.edge.bookSource] || { n: 0, hedged: 0, ms: [] };
  e.n++;
  if (a.outcome === 'hedged') e.hedged++;
  if (Number.isFinite(a.totalMs)) e.ms.push(a.totalMs);
}
if (Object.keys(bySource).length) {
  console.log('\nBOOK SOURCE  (kalshi/polymarket)');
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1].n - a[1].n)) {
    console.log('  ' + k.padEnd(13) + String(v.n).padStart(4) + ' attempts | hedged ' + v.hedged +
      ' | median ' + fmt(pct(v.ms, 0.5)));
  }
}

// ── where the venue disagreed with us ──
const mismatches = rows.filter(a => a.reconciliation && a.reconciliation.mismatch);
if (mismatches.length) {
  console.log('\n!! THE VENUE DISAGREED WITH WHAT WE RECORDED  (' + mismatches.length + ')');
  for (const a of mismatches.slice(0, 8)) {
    console.log('  ' + a.ts.slice(11, 19) + ' ' + a.market.kalshiTicker.slice(-22).padEnd(24) +
      (a.reconciliation.note || ''));
  }
  console.log('  These are the dangerous ones: the app acted on a fill count that was wrong.');
} else if (rows.some(a => a.reconciliation)) {
  console.log('\nRECONCILED: every recorded fill matches what the venue reports.');
} else if (sent.length) {
  console.log('\nNot reconciled yet - run  npm run trades:reconcile  to check these against the venues.');
}

console.log('');

// ── the buffer: planned to be paid, usually returned ──
//
// Each leg is priced a little through the book so it still fills if the book moves. That
// buffer is the dominant cost of qualifying: a pair only clears the profitability guard if
// its gross edge exceeds both buffers plus fees, so a 4c of buffer means nothing under a
// ~5.5c edge is ever tradeable. But a marketable limit fills at the RESTING price, so the
// buffer is usually not actually paid. Measured live on the Alabama/Kentucky win: the Kalshi
// leg was limited at 68c and filled at 66.9c, returning the whole buffer and turning a
// planned $0.44 into a realised $1.59.
//
// If it comes back most of the time, the buffer is too big, and shrinking it widens the set
// of tradeable pairs far more than it costs.
const withFills = rows.filter(a => a.plan && a.legs.some(l => Number.isFinite(l.avgPriceCents) && l.reportedFill > 0));
if (withFills.length) {
  console.log('\nBUFFER: PLANNED vs PAID  (' + withFills.length + ' filled attempts)');
  const paid = [];
  for (const a of withFills) {
    for (const l of a.legs) {
      if (!Number.isFinite(l.avgPriceCents) || l.reportedFill <= 0) continue;
      const atBook = l.venue === 'kalshi' ? a.plan.kalAtBookCents : a.plan.pmAtBookCents;
      if (!Number.isFinite(atBook)) continue;
      const budget = l.limitCents - atBook;        // cents of buffer we were willing to pay
      const actual = l.avgPriceCents - atBook;     // cents we actually paid through the book
      paid.push({ venue: l.venue, budget, actual, returned: budget - actual });
    }
  }
  for (const venue of ['polymarket', 'kalshi']) {
    const v = paid.filter(p => p.venue === venue);
    if (!v.length) continue;
    const avgBudget = v.reduce((s, p) => s + p.budget, 0) / v.length;
    const avgActual = v.reduce((s, p) => s + p.actual, 0) / v.length;
    const neverPaid = v.filter(p => p.actual <= 0).length;
    console.log('  ' + venue.padEnd(12) + 'budgeted ' + avgBudget.toFixed(2) + 'c, paid ' +
      avgActual.toFixed(2) + 'c  |  filled at or better than book ' + neverPaid + '/' + v.length);
  }
  console.log('  A buffer that is budgeted and not paid is edge given away at selection time,');
  console.log('  not at execution: every cent of it raises the edge a pair needs to qualify.');

  // Planned versus realised, per attempt.
  console.log('\nPLANNED vs REALISED  (per contract, net of fees)');
  for (const a of withFills.slice(-8)) {
    const k = a.legs.find(l => l.venue === 'kalshi');
    const p = a.legs.find(l => l.venue === 'polymarket');
    if (!k || !p) continue;
    const plannedNet = 100 - a.plan.kalLimitCents - a.plan.pmLimitCents - (100 - a.plan.kalLimitCents - a.plan.pmLimitCents - a.plan.netEdgeCents);
    const realKal = Number.isFinite(k.avgPriceCents) ? k.avgPriceCents : k.limitCents;
    const realPm = Number.isFinite(p.avgPriceCents) ? p.avgPriceCents : p.limitCents;
    const feeCents = a.plan.kalLimitCents + a.plan.pmLimitCents + a.plan.netEdgeCents - 100;
    const realisedNet = 100 - realKal - realPm + feeCents;
    console.log('  ' + a.ts.slice(11, 19) + ' ' + a.market.kalshiTicker.slice(-20).padEnd(22) +
      'planned ' + a.plan.netEdgeCents.toFixed(2) + 'c  realised ' + realisedNet.toFixed(2) + 'c' +
      '  (' + k.reportedFill + ' contracts)');
  }
}

// ── which leg moved between the list and the order path ──
//
// An edge that vanishes is either the market moving or the two pricing paths disagreeing,
// and the totals alone cannot tell them apart. The same pair aborting twice with IDENTICAL
// quoted and fresh numbers minutes apart is a disagreement, not movement.
const legMoves = rows.filter(a => a.edge &&
  Number.isFinite(a.edge.quotedKalCents) && Number.isFinite(a.edge.freshKalCents) &&
  Number.isFinite(a.edge.quotedPmCents) && Number.isFinite(a.edge.freshPmCents));
if (legMoves.length) {
  console.log('\nWHICH LEG MOVED  (quoted price -> price at order time)');
  const kalD = legMoves.map(a => a.edge.freshKalCents - a.edge.quotedKalCents);
  const pmD = legMoves.map(a => a.edge.freshPmCents - a.edge.quotedPmCents);
  const avg = arr => arr.reduce((s, n) => s + n, 0) / arr.length;
  console.log('  kalshi      p50 ' + fmt(pct(kalD, 0.5), 'c') + '  mean ' + avg(kalD).toFixed(2) + 'c  worst ' + fmt(pct(kalD, 1), 'c'));
  console.log('  polymarket  p50 ' + fmt(pct(pmD, 0.5), 'c') + '  mean ' + avg(pmD).toFixed(2) + 'c  worst ' + fmt(pct(pmD, 1), 'c'));
  const biasedK = kalD.filter(d => d > 0).length, biasedP = pmD.filter(d => d > 0).length;
  console.log('  priced worse at order time: kalshi ' + biasedK + '/' + kalD.length + ', polymarket ' + biasedP + '/' + pmD.length);
  console.log('  A leg that is consistently worse one way is a pricing disagreement, not movement.');
  for (const a of legMoves.slice(-5)) {
    console.log('  ' + a.ts.slice(11, 19) + ' ' + a.market.kalshiTicker.slice(-18).padEnd(20) +
      'kal ' + a.edge.quotedKalCents + '->' + a.edge.freshKalCents + 'c (depth ' + (a.edge.kalTopDepth ?? '-') + ')  ' +
      'pm ' + a.edge.quotedPmCents + '->' + a.edge.freshPmCents + 'c (depth ' + (a.edge.pmTopDepth ?? '-') + ')');
  }
}
