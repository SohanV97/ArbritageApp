import type { UnifiedMarket, MatchedPair } from './market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';

// "St." is two different words. As a SUFFIX it abbreviates State ("Oregon St.", "Illinois
// St.") and is a qualifier that must match. As a PREFIX it abbreviates Saint ("St. Louis")
// and is part of the city's name. Tokenizing loses the ordering that tells them apart, so
// the qualifier gate read Polymarket's "St. Louis City SC" as carrying the State qualifier
// while Kalshi's "Saint Louis" carried none, and refused all three St. Louis fixtures.
// Spell the prefix out here so both venues produce the same tokens and no qualifier.
const SAINT_PLACES = ['louis', 'paul', 'petersburg', 'johns', 'gallen', 'etienne', 'pauli', 'mirren', 'kitts', 'thomas'];
const SAINT_PREFIX = new RegExp(String.raw`\bst\.?\s+(?=(?:${SAINT_PLACES.join('|')})\b)`, 'g');

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    // Fold accents before punctuation is stripped: "é" is not a \w character, so
    // "CF Montréal" became "montr al" and could never match Kalshi's "Montreal".
    // Also covers München, Atlético, Bogotá and every other accented club name.
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/'s\b/g, 's')
    .replace(SAINT_PREFIX, 'saint ')
    .replace(/[^\w\s@]/g, ' ')
    .replace(/\b(the|on|end|in|be|or|draw|baseball|mlb|nba|nfl|nhl|game|moneyline|winner|will|beat|to|win|hockey|basketball|football)\b/g, ' ')
    // Re-join dotted initialisms flattened by the punctuation strip above: "d c united"
    // -> "dc united". Without this the single letters are dropped by the length filter in
    // tokenize(), leaving "D.C. United" as the generic token "united" alone, unmatchable
    // against Kalshi's "DC". Runs of 2+ only — a lone trailing letter is Kalshi's
    // disambiguator ("Los Angeles C" = Cubs) and must stay its own token.
    .replace(/\b[a-z](?:\s+[a-z])+\b/g, (m) => m.replace(/\s+/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// expandToken is called repeatedly with the same token during a matching run.
// Pass a per-run cache map to avoid redundant alias lookups.
function expandToken(t: string, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): Set<string> {
  const hit = cache.get(t);
  if (hit) return hit;
  const out = new Set<string>([t]);
  const aliasList = aliases[t];
  if (Array.isArray(aliasList)) {
    for (const a of aliasList) {
      out.add(a);
      const norm = normalizeTitle(a).replace(/\b(?:vs|at|@)\b/g, '').replace(/\s+/g, ' ').trim();
      // Single-word aliases only. A multi-word alias used to be exploded into its
      // individual words, which made every word of it independently identifying:
      // `utsa: ['texas san antonio']` put the bare token "texas" into UTSA's expansion,
      // so "North Texas vs. Texas State" matched Kalshi's "UTSA vs Texas" — a different
      // game on the same day. Phrases are matched as phrases instead (see phrasesFor).
      if (!norm.includes(' ') && norm.length > 1) out.add(norm);
    }
  }
  cache.set(t, out);
  return out;
}

function tokenize(s: string): Set<string> {
  const norm = normalizeTitle(s).replace(/\b(?:vs\.?|at|@)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return new Set(norm.split(/\s+/).filter(t => t.length > 1));
}

function tokensMatch(a: string, b: string, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): boolean {
  if (a === b) return true;
  if (expandToken(a, aliases, cache).has(b)) return true;
  if (expandToken(b, aliases, cache).has(a)) return true;
  return false;
}

// Multi-word aliases ("los angeles", "texas san antonio") match only when EVERY word is
// present. Treating their words separately let one shared word ("texas") stand in for the
// whole name and cross-matched unrelated schools.
const phraseCache = new WeakMap<Record<string, string[]>, Map<string, string[][]>>();
function phrasesFor(t: string, aliases: Record<string, string[]>): string[][] {
  let byToken = phraseCache.get(aliases);
  if (!byToken) { byToken = new Map(); phraseCache.set(aliases, byToken); }
  const hit = byToken.get(t);
  if (hit) return hit;
  const out: string[][] = [];
  for (const a of aliases[t] ?? []) {
    const norm = normalizeTitle(a).replace(/\b(?:vs|at|@)\b/g, '').replace(/\s+/g, ' ').trim();
    if (norm.includes(' ')) {
      const words = norm.split(/\s+/).filter(w => w.length > 1);
      if (words.length > 1) out.push(words);
    }
  }
  byToken.set(t, out);
  return out;
}

// Count unique b-tokens matched by at least one a-token (bidirectional with aliases).
function matchedCount(a: Set<string>, b: Set<string>, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): number {
  const matched = new Set<string>();
  for (const aToken of a) {
    for (const bToken of b) {
      if (tokensMatch(aToken, bToken, aliases, cache)) matched.add(bToken);
    }
  }
  // Phrase aliases: credit the words only when the complete phrase is present.
  for (const aToken of a) {
    for (const words of phrasesFor(aToken, aliases)) {
      if (words.every(w => b.has(w))) for (const w of words) matched.add(w);
    }
  }
  for (const bToken of b) {
    for (const words of phrasesFor(bToken, aliases)) {
      if (words.every(w => a.has(w))) matched.add(bToken);
    }
  }
  return matched.size;
}

// Symmetric Jaccard using bidirectional overlap.
function jaccardSim(a: Set<string>, b: Set<string>, aliases: Record<string, string[]>, cache: Map<string, Set<string>>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const inter = Math.min(matchedCount(a, b, aliases, cache), matchedCount(b, a, aliases, cache));
  const union = a.size + b.size - inter;
  return union <= 0 ? 1 : inter / union;
}

function parseResolutionDay(t?: string): string | null {
  if (!t) return null;
  const d = t.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// Club-name boilerplate that many unrelated teams share, so an overlap on one of these
// carries no evidence that two markets are the same fixture. Squad numbers (Schalke 04,
// Mainz 05) are stripped separately. Deliberately excludes 'as' — that is a real Kalshi
// code for the Athletics.
const GENERIC_TEAM_TOKENS = new Set([
  'fc', 'sc', 'afc', 'cf', 'ac', 'sv', 'fk', 'bk', 'cd', 'ud', 'rc', 'cfc', 'sk',
  'united', 'city', 'club', 'sporting', 'real', 'athletic', 'atletico', 'deportivo',
  'sociedad', 'town', 'county', 'wanderers', 'rovers', 'albion', 'inter',
  'sport', 'sports', 'football', 'soccer', 'team', 'women', 'reserves',
  // College-football boilerplate. "State"/"St." appears in a large share of school
  // names, so treating it as identifying let "Portland State" pair with
  // "Sacramento St." — the same failure mode as matching two clubs on "FC".
  'st', 'state', 'university', 'univ', 'college', 'the',
  // Shared by the Red Sox and the White Sox. The alias "chicago -> white sox" expands to
  // this token, which let a Boston game match a Chicago one; the city word identifies
  // each club perfectly well without it.
  'sox',
]);

// Keep only tokens that actually identify a club.
function distinctiveTokens(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (GENERIC_TEAM_TOKENS.has(t)) continue;
    if (/^\d+$/.test(t)) continue; // "04" in Schalke 04, "05" in Mainz 05
    out.add(t);
  }
  return out;
}

// Same, but never returns an empty set: if a name is entirely boilerplate there is
// nothing better to compare on, so keep the original rather than dropping the team.
function identifyingTokens(tokens: Set<string>): Set<string> {
  const d = distinctiveTokens(tokens);
  return d.size > 0 ? d : tokens;
}

// Directional and "State" qualifiers distinguish otherwise identical school names:
// Illinois, Illinois State, Eastern Illinois and Southern Illinois are four different
// programmes that all reduce to the token "illinois" once "state" is treated as generic
// boilerplate. That let Polymarket's "Southern Illinois vs. Illinois" pair with Kalshi's
// "Illinois St. vs Eastern Illinois" — both halves overlapped on "illinois", so the
// both-teams-must-match rule was satisfied by a completely different fixture.
//
// These tokens can't simply be made identifying: "state" really is shared boilerplate, and
// treating it as a distinguishing word made every school match every other. So they stay
// generic for SCORING and act as a GATE instead — two names can only be the same team when
// they carry exactly the same qualifiers.
const QUALIFIER_CANON = new Map<string, string>([
  ['state', 'state'], ['st', 'state'],
  ['north', 'north'], ['northern', 'north'],
  ['south', 'south'], ['southern', 'south'],
  ['east', 'east'], ['eastern', 'east'],
  ['west', 'west'], ['western', 'west'],
  ['central', 'central'],
]);

// Clubs that SHARE a city are separated only by their nickname or Kalshi code — the city
// words are identical. "Los Angeles Angels" and Kalshi's "Los Angeles D (LAD)" overlap on
// los+angeles, which satisfies the both-teams rule, so the Angels market would pair with a
// DODGERS contract whenever the true Angels fixture is missing from the same day. The
// nickname->code aliases already present steer the SCORER, but scoring only chooses among
// pairs the boolean gate has already accepted, so it cannot prevent this.
//
// Each group lists the tokens that identify one specific club. Two names may only be the
// same team if they don't resolve to different members of the same group.
const SAME_CITY_GROUPS: string[][] = [
  ['lad', 'dodgers'],   ['laa', 'angels'],          // Los Angeles
  ['nyy', 'yankees'],   ['nym', 'mets'],            // New York
  ['chc', 'cubs'],      ['cws', 'ws', 'white'],     // Chicago  ('white' not 'sox': Red Sox
                                                    //  share "sox", never "white")
];
// Members that belong to the same city, keyed by the first entry of each pair of groups.
const CLUB_CITY = ['la', 'la', 'ny', 'ny', 'chi', 'chi'];

const CLUB_ID = new Map<string, number>();
SAME_CITY_GROUPS.forEach((tokens, idx) => { for (const t of tokens) CLUB_ID.set(t, idx); });

function clubIndex(tokens: Set<string>): number | null {
  for (const t of tokens) {
    const idx = CLUB_ID.get(t);
    if (idx !== undefined) return idx;
  }
  return null;
}

// True when both names name a club and those clubs share a city but are not the same club.
function clubsConflict(a: Set<string>, b: Set<string>): boolean {
  const ia = clubIndex(a), ib = clubIndex(b);
  if (ia === null || ib === null) return false;
  return CLUB_CITY[ia] === CLUB_CITY[ib] && ia !== ib;
}

// Do two team NAMES refer to different teams for a reason that token overlap cannot see?
// Used by YES/NO alignment as well as by pairing. Alignment compares "Eastern Washington"
// against Kalshi's "WASH Washington": they overlap on "washington", the yes/no scores tie,
// and the tie falls through to PRICE proximity — which is inverted precisely when the two
// venues disagree, i.e. exactly when a fake edge appears. That produced a reported 14.35%
// "arb" whose two legs both paid out on Eastern Washington winning: not a hedge at all,
// and in the default auto-execute scope.
export function teamsAreDifferent(a: string, b: string): boolean {
  const ta = tokenize(a), tb = tokenize(b);
  if (qualifierKey(ta) !== qualifierKey(tb)) return true;
  return clubsConflict(ta, tb);
}

function qualifierKey(tokens: Set<string>): string {
  const found = new Set<string>();
  for (const t of tokens) {
    const canon = QUALIFIER_CANON.get(t);
    if (canon) found.add(canon);
  }
  return [...found].sort().join('|');
}

// Split "Team A vs Team B" into two token sets.
function splitTeams(q: string): [Set<string>, Set<string>] {
  const bracketMatch = q.match(/\[(.*?)\]$/);
  const text = bracketMatch ? bracketMatch[1] : q;
  const lower = normalizeTitle(text);
  const parts = lower.split(/\b(?:\s+vs\.?\s+|\s+at\s+|\s+@\s+)\b/);
  if (parts.length >= 2) return [tokenize(parts[0]), tokenize(parts[parts.length - 1])];
  return [tokenize(q), new Set()];
}

// ─── Politics: structured identity matching ──────────────────────────────────
// Senate/House markets nearly all read "…win the Senate race … 2026", so token
// similarity collapses every state onto every other state (the state name is one
// token out of five). Instead we parse each market's structured identity —
// (state, chamber, year, control-vs-race) — and require those to line up, exactly
// as sports matching requires the same two teams. Party is captured only to prefer
// a same-party pairing when scoring; the arb layer handles the YES/NO flip.
const US_STATES = [
  // Multi-word names first so "new hampshire" matches before "new".
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina',
  'north dakota', 'south carolina', 'south dakota', 'west virginia', 'rhode island',
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut',
  'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
  'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan',
  'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'tennessee', 'texas', 'utah', 'vermont',
  'virginia', 'washington', 'wisconsin', 'wyoming',
];

interface PoliticsKey {
  state: string | null;
  chamber: 'senate' | 'house' | null;
  year: string | null;
  party: 'republican' | 'democrat' | 'independent' | 'other';
  isControl: boolean;
  isCombo: boolean;
}

function parsePolitics(q: string): PoliticsKey {
  const s = q.toLowerCase();
  let state: string | null = null;
  for (const name of US_STATES) {
    if (new RegExp(`\\b${name}\\b`).test(s)) { state = name; break; }
  }
  const ym = s.match(/\b(20\d{2})\b/);
  const year = ym ? ym[1] : null;
  const mentionsHouse = /\bhouse\b/.test(s);
  const mentionsSenate = /\bsenate\b|\bsenator\b/.test(s);
  const chamber: PoliticsKey['chamber'] =
    mentionsHouse ? 'house' : (mentionsSenate ? 'senate' : null);
  let party: PoliticsKey['party'] = 'other';
  if (/\brepublican(s)?\b|\bgop\b/.test(s)) party = 'republican';
  else if (/\bdemocrat(s|ic|ics)?\b/.test(s)) party = 'democrat';
  else if (/\bindependent(s)?\b/.test(s)) party = 'independent';
  // A "control" market names a chamber but no specific state.
  const isControl = state === null && chamber !== null;
  // House-AND-Senate combos resolve on two chambers at once — never a 1:1 match
  // for any single-chamber market.
  const isCombo = mentionsHouse && mentionsSenate;
  return { state, chamber, year, party, isControl, isCombo };
}

// True when two markets are the same underlying political event.
function politicsEventMatch(a: PoliticsKey, b: PoliticsKey): boolean {
  if (a.isCombo || b.isCombo) return false;
  if (!a.chamber || !b.chamber) return false;
  if (a.chamber !== b.chamber) return false;               // never senate ↔ house
  if (a.year && b.year && a.year !== b.year) return false; // same year when both known
  if (a.state && b.state) return a.state === b.state;      // state races: same state
  if (a.isControl && b.isControl) return true;             // chamber-control markets
  return false;                                            // don't mix a state race with control
}

export function matchMarkets(
  polymarketMarkets: PolymarketMarketWithKind[],
  kalshiMarkets: UnifiedMarket[],
  options: {
    minTitleSimilarity?: number;
    minOverlapTokens?: number;
    requireSameDay?: boolean;
    politics?: boolean;
    aliases?: Record<string, string[]>;
  } = {}
): MatchedPair[] {
  const requireSameDay = options.requireSameDay ?? false;
  const isPolitics = options.politics ?? false;
  const isSport = requireSameDay;
  const aliases = options.aliases ?? {};
  const minSim = options.minTitleSimilarity ?? 0.35;
  const minOverlap = options.minOverlapTokens ?? 1;

  // One memoization map shared across the entire matching run.
  const expandCache = new Map<string, Set<string>>();

  // ── Precompute per-Kalshi-market values ──────────────────────────────────
  // These would otherwise be recomputed on every PM×Kalshi inner-loop iteration.
  const kalshiDays = requireSameDay
    ? kalshiMarkets.map(k => parseResolutionDay(k.resolutionTime))
    : null;

  // Sports: precompute team-split sets. Politics: structured keys. MLB: token sets.
  const kalshiSplits = isSport
    ? kalshiMarkets.map(k => splitTeams(k.question))
    : null;
  // Identifying (non-boilerplate) tokens, precomputed so the PM×Kalshi loop stays cheap.
  const kalshiIdent = isSport
    ? kalshiSplits!.map(([a, b]) => [identifyingTokens(a), identifyingTokens(b)] as [Set<string>, Set<string>])
    : null;
  const kalshiKeys = isPolitics
    ? kalshiMarkets.map(k => parsePolitics(k.question))
    : null;
  const kalshiTokens = (isSport || isPolitics)
    ? null
    : kalshiMarkets.map(k => tokenize(k.question));

  const rawPairs: MatchedPair[] = [];

  for (const pm of polymarketMarkets) {
    const pmDay = parseResolutionDay(pm.resolutionTime);

    if (isPolitics) {
      // Structured identity match — same (state | control) + chamber + year.
      const pmKey = parsePolitics(pm.question);
      if (!pmKey.chamber) continue; // not a race/control market we can align
      for (let ki = 0; ki < kalshiMarkets.length; ki++) {
        if (politicsEventMatch(pmKey, kalshiKeys![ki])) {
          rawPairs.push({ polymarket: pm, kalshi: kalshiMarkets[ki] });
        }
      }
    } else if (isSport) {
      // Precompute PM team split once per PM market instead of once per PM×K pair.
      const [pmA, pmB] = splitTeams(pm.question);
      const pmAi = identifyingTokens(pmA);
      const pmBi = identifyingTokens(pmB);

      for (let ki = 0; ki < kalshiMarkets.length; ki++) {
        const kDay = kalshiDays![ki];
        if (pmDay !== null && kDay !== null && pmDay !== kDay) continue;

        const k = kalshiMarkets[ki];
        const [kA, kB] = kalshiSplits![ki];

        let matches = false;
        if (pmA.size === 0 || pmB.size === 0) {
          // PM market missing team tokens — fall back to whole-title Jaccard
          matches = jaccardSim(tokenize(pm.question), tokenize(k.question), aliases, expandCache) >= 0.15;
        } else if (kB.size === 0) {
          // Kalshi named only ONE side (e.g. "San Diego FC wins"), so only half the
          // fixture can be compared. Require the overlap to be on a DISTINCTIVE token:
          // club boilerplate ("fc", "united", "city") and squad numbers ("04") are shared
          // by unrelated clubs, and matching on those paired "San Diego FC wins" with
          // "FC Schalke 04 vs FC Bayern München".
          const kD = distinctiveTokens(kA);
          matches = kD.size > 0 && (
            matchedCount(kD, distinctiveTokens(pmA), aliases, expandCache) > 0
            || matchedCount(kD, distinctiveTokens(pmB), aliases, expandCache) > 0
          );
        } else {
          // Both sides name two teams — require BOTH to correspond, comparing only
          // identifying tokens. Without that, two unrelated fixtures whose teams each
          // carry "FC" (common in soccer) satisfy both halves and falsely pair.
          const [kAi, kBi] = kalshiIdent![ki];
          // Qualifiers are compared on the RAW token sets — identifyingTokens has already
          // stripped "state"/"st" as boilerplate by this point.
          const qPmA = qualifierKey(pmA), qPmB = qualifierKey(pmB);
          const qKA = qualifierKey(kA), qKB = qualifierKey(kB);
          const direct = qPmA === qKA && qPmB === qKB
                      && !clubsConflict(pmA, kA) && !clubsConflict(pmB, kB)
                      && matchedCount(pmAi, kAi, aliases, expandCache) > 0
                      && matchedCount(pmBi, kBi, aliases, expandCache) > 0;
          matches = direct || (
            qPmA === qKB && qPmB === qKA
            && !clubsConflict(pmA, kB) && !clubsConflict(pmB, kA)
            && matchedCount(pmAi, kBi, aliases, expandCache) > 0
            && matchedCount(pmBi, kAi, aliases, expandCache) > 0
          );
        }
        if (matches) rawPairs.push({ polymarket: pm, kalshi: k });
      }
    } else {
      // Politics / MLB: Jaccard similarity with alias-expanded overlap.
      // Combine overlap + Jaccard into one pass — avoids calling matchedCount 3× per pair.
      const pmTokens = tokenize(pm.question);

      for (let ki = 0; ki < kalshiMarkets.length; ki++) {
        const kTokens = kalshiTokens![ki];

        // Compute intersection once; reuse for both the overlap check and Jaccard score.
        const ab = matchedCount(pmTokens, kTokens, aliases, expandCache);
        const ba = matchedCount(kTokens, pmTokens, aliases, expandCache);
        const inter = Math.min(ab, ba);
        if (inter < minOverlap) continue; // early exit before the division

        const union = pmTokens.size + kTokens.size - inter;
        const sim = union <= 0 ? 1 : inter / union;
        if (sim >= minSim) rawPairs.push({ polymarket: pm, kalshi: kalshiMarkets[ki] });
      }
    }
  }

  // Per PM market: keep the single best Kalshi match (closest price alignment).
  const byPmId = new Map<string, MatchedPair[]>();
  for (const pair of rawPairs) {
    const id = pair.polymarket.id;
    if (!byPmId.has(id)) byPmId.set(id, []);
    byPmId.get(id)!.push(pair);
  }

  const finalPairs: MatchedPair[] = [];
  for (const [, group] of byPmId) {
    if (group.length === 0) continue;
    const pm = group[0].polymarket;
    const pmDay = parseResolutionDay(pm.resolutionTime);
    const pmParty = isPolitics ? parsePolitics(pm.question).party : null;

    function scorePair(pair: MatchedPair): number {
      const priceDist = Math.min(
        Math.abs(pair.kalshi.yesPriceCents - pm.yesPriceCents),
        Math.abs(pair.kalshi.noPriceCents - pm.yesPriceCents)
      );
      const kDay = parseResolutionDay(pair.kalshi.resolutionTime);
      // Strongly prefer same-date Kalshi games — a 100¢ bonus makes same-day always win
      // over any cross-series match regardless of price closeness.
      const sameDayBonus = (pmDay && kDay && pmDay === kDay) ? -100 : 0;
      // Sports: prefer the Kalshi contract for the SAME team this PM market is about.
      // Both contracts of an event now share a title, so without this the choice falls to
      // price and can land on the opponent's contract. That matters most in a three-way
      // sport, where only the same-team pairing hedges the draw at all.
      // Graded, not boolean: two clubs from the same city ("Los Angeles Dodgers" vs
      // "Los Angeles Angels") both overlap on the city words, so a yes/no bonus ties and
      // the choice falls through to price. Counting shared identity tokens lets the club
      // that also matches on nickname/code win outright. Capped below sameDayBonus so it
      // can never outrank playing on the right date.
      let sameTeamBonus = 0;
      if (isSport && pm.yesTeam && pair.kalshi.yesTeam) {
        const a = identifyingTokens(tokenize(pm.yesTeam));
        const b = identifyingTokens(tokenize(pair.kalshi.yesTeam));
        const overlap = matchedCount(a, b, aliases, expandCache);
        sameTeamBonus = -Math.min(overlap, 4) * 20;
      }
      // Also prefer the Kalshi market that names this game's OPPONENT, so a contract is
      // chosen on the whole fixture rather than on one team plus price.
      let opponentBonus = 0;
      if (isSport && pm.noTeam) {
        const opp = identifyingTokens(tokenize(pm.noTeam));
        const kq = identifyingTokens(tokenize(pair.kalshi.question));
        opponentBonus = -Math.min(matchedCount(opp, kq, aliases, expandCache), 3) * 15;
      }
      // Politics: prefer a same-party Kalshi market (a clean direct YES↔YES pairing)
      // over the complementary other-party market, which the arb layer would flip.
      let partyBonus = 0;
      if (pmParty && pmParty !== 'other') {
        const kParty = parsePolitics(pair.kalshi.question).party;
        if (kParty === pmParty) partyBonus = -30;
      }
      return priceDist + sameDayBonus + sameTeamBonus + opponentBonus + partyBonus;
    }

    let best = group[0];
    let bestScore = scorePair(group[0]);
    for (let i = 1; i < group.length; i++) {
      const s = scorePair(group[i]);
      if (s < bestScore) { bestScore = s; best = group[i]; }
    }
    finalPairs.push(best);
  }

  return finalPairs;
}
