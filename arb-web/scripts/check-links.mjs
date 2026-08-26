#!/usr/bin/env node
/**
 * Validates every venue link the app produces.
 *
 *   npm run check:links          (dev server must be running on :3000)
 *   BASE_URL=http://host:port npm run check:links
 *
 * Why this exists: a card's link is built from a slug/ticker, and a value from the
 * wrong namespace still *looks* fine in the UI while 404-ing when clicked. That
 * happened for real — Polymarket pages are addressed ONLY by EVENT slug, but the app
 * used the market slug, which silently broke every soccer link (one market per team,
 * e.g. "mls-atl-clt-2026-08-29-clt"). MLB masked the bug because its moneyline market
 * slug happens to equal its event slug.
 *
 * Rules enforced here:
 *   Polymarket — the slug must resolve as an EVENT via Gamma.
 *   Kalshi     — the last path segment must be a real event_ticker, and the first
 *                segment must be that event's series.
 * Exits non-zero if any link is broken, so it can gate a deploy.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const GAMMA = 'https://gamma-api.polymarket.com';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pmEventExists(slug) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
      if (r.status === 429) { await wait(600 * (i + 1)); continue; }
      if (!r.ok) return false;
      const j = await r.json();
      return Array.isArray(j) && j.length > 0;
    } catch { await wait(300); }
  }
  return false;
}

// Retry 429s: a throttled response must not be mistaken for a broken link.
async function kalshiEvent(ticker) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${KALSHI}/events/${encodeURIComponent(ticker)}`);
      if (r.status === 429) { await wait(700 * (i + 1)); continue; }
      if (!r.ok) return null;
      return (await r.json()).event ?? null;
    } catch { await wait(300); }
  }
  return null;
}

async function main() {
  let data;
  try {
    const res = await fetch(`${BASE}/api/opportunities?fresh=1`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(`Could not reach ${BASE}/api/opportunities — is the dev server running?`);
    console.error(String(err));
    process.exit(2);
  }

  // Deduplicate links, remembering one example question per link for the report.
  const pm = new Map();
  const kal = new Map();
  const note = (map, url, cat, q) => { if (url && !map.has(url)) map.set(url, { cat, q: (q || '').slice(0, 60) }); };
  for (const o of data.opportunities ?? []) {
    note(pm, o.pair?.polymarket?.url, o.pair?.polymarket?.category, o.pair?.polymarket?.question);
    note(kal, o.pair?.kalshi?.url, o.pair?.polymarket?.category, o.pair?.kalshi?.question);
  }
  for (const p of data.pairsDetail ?? []) {
    note(pm, p.pmUrl, p.category, p.pmQuestion);
    note(kal, p.kalUrl, p.category, p.kalQuestion);
  }

  const broken = [];
  let okCount = 0;

  for (const [url, meta] of pm) {
    const slug = url.split('/event/')[1] || '';
    let ok = url.startsWith('https://polymarket.com/') && !!slug;
    if (ok) ok = await pmEventExists(slug);
    if (ok) okCount++; else broken.push({ venue: 'polymarket', url, cat: meta.cat, q: meta.q, why: slug ? 'slug does not resolve as an event' : 'no slug in url' });
  }

  for (const [url, meta] of kal) {
    if (!url.startsWith('https://kalshi.com/markets/')) {
      broken.push({ venue: 'kalshi', url, cat: meta.cat, q: meta.q, why: 'unexpected url shape' });
      continue;
    }
    const parts = url.replace('https://kalshi.com/markets/', '').split('/');
    const ticker = (parts.at(-1) || '').toUpperCase();
    const seriesSeg = (parts[0] || '').toUpperCase();
    const ev = ticker ? await kalshiEvent(ticker) : null;
    if (!ev) broken.push({ venue: 'kalshi', url, cat: meta.cat, q: meta.q, why: 'event ticker not found' });
    else if (String(ev.series_ticker || '').toUpperCase() !== seriesSeg) {
      broken.push({ venue: 'kalshi', url, cat: meta.cat, q: meta.q, why: `series segment "${seriesSeg}" != "${ev.series_ticker}"` });
    } else okCount++;
    await wait(120); // stay under Kalshi's burst limit
  }

  const total = pm.size + kal.size;
  console.log(`checked ${total} links (${pm.size} Polymarket, ${kal.size} Kalshi) — ${okCount} ok, ${broken.length} broken`);
  if (broken.length) {
    console.log('\nBROKEN LINKS');
    for (const b of broken) console.log(`  [${b.venue}/${b.cat}] ${b.url}\n      ${b.why}\n      ${b.q}`);
    process.exit(1);
  }
  console.log('all venue links resolve');
}

main();
