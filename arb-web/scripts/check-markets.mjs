#!/usr/bin/env node
/**
 * Validates the live opportunity feed: correct fixtures, sane prices, valid hedges.
 *
 *   npm run check:markets        (dev server must be running on :3000)
 *   BASE_URL=http://host:port npm run check:markets
 *
 * The check that matters most is CROSS-FIXTURE matching. Kalshi titles game markets one
 * team at a time ("San Diego FC wins"), so only half a fixture is named. Comparing that
 * against a Polymarket "A vs B" market once paired "San Diego FC wins" with
 * "FC Schalke 04 vs FC Bayern München" — two unrelated games — because both share the
 * generic token "FC". Every sports pair must name the SAME TWO TEAMS on both venues,
 * compared on identifying tokens only (club boilerplate like fc/united/city and squad
 * numbers like "04" carry no signal).
 *
 * Exits non-zero on any violation so it can gate a deploy.
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Club-name boilerplate — shared by unrelated teams, so it can't identify a fixture.
const GENERIC = new Set([
  'fc', 'sc', 'afc', 'cf', 'ac', 'sv', 'fk', 'bk', 'cd', 'ud', 'rc', 'cfc', 'sk',
  'united', 'city', 'club', 'sporting', 'real', 'athletic', 'atletico', 'deportivo',
  'sociedad', 'town', 'county', 'wanderers', 'rovers', 'albion', 'inter',
  'sport', 'sports', 'football', 'soccer', 'team', 'women', 'reserves',
]);
const STOP = /\b(the|on|end|in|be|or|draw|baseball|mlb|nba|nfl|nhl|game|moneyline|winner|will|beat|to|win|hockey|basketball|football)\b/g;

// Saint-prefixed place names, spelled out so "St. Louis" is never read as "State".
const SAINT_PLACES = ['louis', 'paul', 'petersburg', 'johns', 'gallen', 'etienne', 'pauli', 'mirren', 'kitts', 'thomas'];
const SAINT_PREFIX = new RegExp(String.raw`\bst\.?\s+(?=(?:${SAINT_PLACES.join('|')})\b)`, 'g');

const norm = (s) => s.toLowerCase()
  // Fold accents, matching the app. Without this "CF Montréal" normalizes to "montr al"
  // and the checker reports six perfectly correct Montréal fixtures as cross-fixture.
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\d{4}-\d{2}-\d{2}/g, ' ').replace(/'s\b/g, 's')
  .replace(SAINT_PREFIX, 'saint ')
  .replace(/[^\w\s@]/g, ' ').replace(STOP, ' ')
  // Re-join dotted initialisms ("d c united" -> "dc united"), matching the app.
  .replace(/\b[a-z](?:\s+[a-z])+\b/g, (m) => m.replace(/\s+/g, ''))
  .replace(/\s+/g, ' ').trim();
const toks = (s) => new Set(norm(s).replace(/\b(?:vs\.?|at|@)\b/g, ' ').split(/\s+/).filter((t) => t.length > 1));
const identifying = (set) => {
  const out = new Set();
  for (const t of set) if (!GENERIC.has(t) && !/^\d+$/.test(t)) out.add(t);
  return out.size ? out : set;
};
const splitTeams = (q) => {
  const br = q.match(/\[(.*?)\]$/);
  const parts = norm(br ? br[1] : q).split(/\b(?:\s+vs\.?\s+|\s+at\s+|\s+@\s+)\b/);
  return parts.length >= 2 ? [toks(parts[0]), toks(parts.at(-1))] : [toks(q), new Set()];
};
const expand = (t, aliases) => {
  const out = new Set([t]);
  for (const a of aliases[t] ?? []) for (const w of a.toLowerCase().split(/\s+/)) if (w.length > 1) out.add(w);
  return out;
};
const overlaps = (a, b, aliases) => {
  for (const x of a) for (const y of b) {
    if (x === y || expand(x, aliases).has(y) || expand(y, aliases).has(x)) return true;
  }
  return false;
};

// Use the SAME alias table the app matches with, rather than a copy. A local copy went
// stale the moment football was added: Polymarket writes NFL nicknames ("Raiders vs.
// Chargers") while Kalshi writes cities ("Las Vegas (LV) vs Los Angeles C (LAC)"), which
// share no word at all — so every correct NFL pair was reported as a cross-fixture.
const { SPORT_ALIASES: ALIASES } = await import('../lib/categories.ts');

const fail = [];
const note = (msg) => fail.push(msg);

async function main() {
  let d;
  try {
    const r = await fetch(`${BASE}/api/opportunities?fresh=1&pairs=1`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    d = await r.json();
  } catch (err) {
    console.error(`Could not reach ${BASE}/api/opportunities — is the dev server running?`);
    console.error(String(err));
    process.exit(2);
  }

  const opps = d.opportunities ?? [];
  const pairs = d.pairsDetail ?? [];

  // ── 1. cross-fixture matching ──
  const sports = pairs.filter((p) => p.category !== 'politics');
  let bothOk = 0, singleTitle = 0;
  for (const p of sports) {
    const aliases = ALIASES[p.category] ?? {};
    const [pa, pb] = splitTeams(p.pmQuestion).map(identifying);
    const [ka, kb] = splitTeams(p.kalQuestion).map(identifying);
    if (kb.size === 0) {
      singleTitle++;
      note(`single-team Kalshi title (only half the fixture is named): "${p.kalQuestion}"`);
      continue;
    }
    const direct = overlaps(pa, ka, aliases) && overlaps(pb, kb, aliases);
    const flipped = overlaps(pa, kb, aliases) && overlaps(pb, ka, aliases);
    if (direct || flipped) bothOk++;
    else note(`CROSS-FIXTURE [${p.category} ${p.pmDate}]\n      PM:  ${p.pmQuestion}\n      KAL: ${p.kalQuestion}`);
  }

  // ── 2. arb invariants ──
  let priceBad = 0, mathBad = 0, hedgeBad = 0;
  for (const o of opps) {
    const legs = [o.legA, o.legB];
    if (!legs.every((l) => Number.isInteger(l.priceCents) && l.priceCents >= 1 && l.priceCents <= 99)) priceBad++;
    if (!Number.isFinite(o.edgePercent) || Math.abs(o.edgePercent - (100 - o.totalCostCents)) > 1e-6) mathBad++;
    // Exactly one leg must pay out on each outcome.
    const pm = o.legA.venue === 'polymarket' ? o.legA : o.legB;
    const kal = o.legA.venue === 'kalshi' ? o.legA : o.legB;
    const onTrue = (pm.side === 'yes' ? 100 : 0) + (kal.side === 'yes' ? 100 : 0);
    const onFalse = (pm.side === 'no' ? 100 : 0) + (kal.side === 'no' ? 100 : 0);
    if (onTrue !== 100 || onFalse !== 100 || o.legA.venue === o.legB.venue) hedgeBad++;
  }
  if (priceBad) note(`${priceBad} opportunit(ies) with a price outside 1-99c`);
  if (mathBad) note(`${mathBad} opportunit(ies) where edge != 100 - cost`);
  if (hedgeBad) note(`${hedgeBad} opportunit(ies) that do not hedge (legs pay on the same outcome)`);

  // ── 3. duplicate React keys / duplicate positions ──
  const keys = opps.map((o) => `${o.pair.polymarket.id}|${o.pair.kalshi.id}`);
  if (new Set(keys).size !== keys.length) note(`${keys.length - new Set(keys).size} duplicate opportunity key(s)`);

  // ── 4. quote freshness ──
  if (typeof d.stats?.ageMs === 'number' && d.stats.ageMs > 60_000) {
    note(`quotes are ${Math.round(d.stats.ageMs / 1000)}s old after a forced refresh`);
  }

  console.log(`sports pairs ${sports.length} (both teams match: ${bothOk}, single-team titles: ${singleTitle})`);
  console.log(`opportunities ${opps.length} — prices ok: ${opps.length - priceBad}, math ok: ${opps.length - mathBad}, hedged: ${opps.length - hedgeBad}`);

  if (fail.length) {
    console.log(`\n${fail.length} PROBLEM(S):`);
    for (const f of fail) console.log('  ' + f);
    process.exit(1);
  }
  console.log('all matches name the same two teams; all opportunities price, compute and hedge correctly');
}

main();
