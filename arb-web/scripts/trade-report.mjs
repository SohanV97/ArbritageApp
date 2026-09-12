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
