#!/usr/bin/env node
/**
 * Offline regression tests for market matching. No network, no dev server.
 *
 *   npm run test:matching
 *
 * These lock in the cross-fixture bugs that reached production, so they can't come back:
 *   - "San Diego FC wins" paired with "FC Schalke 04 vs FC Bayern München" because both
 *     names contain "FC".
 *   - "Portland State vs San Diego State" paired with "Sacramento St. vs Mississippi
 *     Valley St." because State/St. was aliased and nearly every school carries it.
 *   - Same-city clubs (Yankees/Mets, Giants/Jets) matching each other's games.
 * Exits non-zero on any failure so it can gate a commit or deploy.
 */
import { matchMarkets } from '../lib/matchMarkets.ts';
import { SPORT_ALIASES } from '../lib/categories.ts';

let pass = 0, fail = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; failures.push(name + (detail ? ` :: ${detail}` : '')); }
};

const DAY = '2026-09-05';
const pm = (q, day = DAY) => ({
  id: 'pm-' + q.slice(0, 24), venue: 'polymarket', question: q,
  yesPriceCents: 50, noPriceCents: 50, resolutionTime: `${day}T23:59:00Z`,
  url: '', polymarketFeeKind: 'sports',
});
const kal = (q, day = DAY) => ({
  id: 'k-' + q.slice(0, 24), venue: 'kalshi', question: q,
  yesPriceCents: 50, noPriceCents: 50, resolutionTime: `${day}T23:59:00Z`, url: '',
});
const opts = (cat) => ({
  minTitleSimilarity: 0.35, minOverlapTokens: 1, requireSameDay: true,
  aliases: SPORT_ALIASES[cat],
});
const n = (cat, pq, kq, pDay = DAY, kDay = DAY) =>
  matchMarkets([pm(pq, pDay)], [kal(kq, kDay)], opts(cat)).length;

// Pairs that MUST NOT match (different fixtures)
const mustNotMatch = [
  // the two production bugs
  ['soccer', 'FC Schalke 04 vs. FC Bayern München: Will FC Schalke 04 win on 2026-09-05?', 'San Diego FC wins'],
  ['cfb', 'Portland State vs. San Diego State [Portland State vs San Diego State]', 'Sacramento St. vs Mississippi Valley St. Winner?'],
  // generic-token traps
  ['soccer', 'Fulham FC vs. Crystal Palace FC: Will Fulham FC win on 2026-09-05?', 'Brighton vs Leeds Winner?'],
  ['cfb', 'Ohio State vs. Michigan State [Ohio State vs Michigan State]', 'Iowa St. vs Kansas St. Winner?'],
  ['cfb', 'Florida State vs. Miami [Florida State vs Miami]', 'Oregon St. vs Arizona St. Winner?'],
  ['cfb', 'University of Utah vs. Baylor [University of Utah vs Baylor]', 'University of Toledo vs Ball St. Winner?'],
  // same-city / same-word traps
  ['mlb', 'New York Mets vs. Atlanta Braves [New York Mets vs Atlanta Braves]', 'New York Y vs Boston Winner?'],
  ['nfl', 'New York Giants vs. Dallas Cowboys [New York Giants vs Dallas Cowboys]', 'New York J vs Buffalo Winner?'],
  ['nfl', 'Los Angeles Rams vs. Seattle Seahawks [Los Angeles Rams vs Seattle Seahawks]', 'Los Angeles C vs Denver Winner?'],
  ['cfb', 'Michigan vs. Ohio State [Michigan vs Ohio State]', 'Western Michigan vs Toledo Winner?'],
];
for (const [cat, p, k] of mustNotMatch) {
  check(`[${cat}] no match: "${p.slice(0, 40)}…" vs "${k.slice(0, 34)}"`, n(cat, p, k) === 0);
}

// Pairs that MUST match (same fixture, different naming conventions)
const mustMatch = [
  ['cfb', 'Oregon State vs. Houston [Oregon State vs Houston]', 'Oregon St. vs Houston Winner?'],
  ['cfb', 'Tennessee State vs. Georgia [Tennessee State vs Georgia]', 'Georgia vs Tennessee St. Winner?'],
  ['cfb', 'Western Michigan vs. Michigan [Western Michigan vs Michigan]', 'Western Michigan vs Michigan Winner?'],
  ['cfb', 'East Texas A&M vs. Stephen F. Austin [East Texas A&M vs Stephen F. Austin]', 'Stephen F. Austin vs East Texas A&M Winner?'],
  ['cfb', 'The Citadel vs. Charlotte [The Citadel vs Charlotte]', 'The Citadel vs Charlotte Winner?'],
  ['nfl', 'New York Giants vs. Los Angeles Rams [New York Giants vs Los Angeles Rams]', 'New York G vs Los Angeles R Winner?'],
  ['nfl', 'Kansas City Chiefs vs. Indianapolis Colts [Kansas City Chiefs vs Indianapolis Colts]', 'Kansas City vs Indianapolis Winner?'],
  ['nfl', 'Indianapolis Colts vs. Kansas City Chiefs [Indianapolis Colts vs Kansas City Chiefs]', 'Kansas City vs Indianapolis Winner?'],
  ['mlb', 'Toronto Blue Jays vs. Houston Astros [Toronto Blue Jays vs Houston Astros]', 'Toronto vs Houston Winner?'],
  ['mlb', 'Athletics vs. Boston Red Sox [Athletics vs Boston Red Sox]', "A's vs Boston Winner?"],
  ['soccer', 'Charlotte FC vs. Columbus Crew: Will Charlotte FC win on 2026-09-05?', 'Charlotte vs Columbus Winner?'],
];
for (const [cat, p, k] of mustMatch) {
  check(`[${cat}] matches: "${p.slice(0, 40)}…" <-> "${k.slice(0, 34)}"`, n(cat, p, k) === 1);
}

// Three-way sports: the matcher must pick the Kalshi contract for the SAME team as the
// Polymarket market. Both contracts of a soccer event share a title, so if selection fell
// back to price it could land on the opponent — and pairing across teams there leaves the
// draw uncovered (an unhedged bet that prices like a huge edge).
{
  const pmMkt = pm('Los Angeles Galaxy vs. New England Revolution: Will Los Angeles Galaxy win on 2026-09-05?');
  pmMkt.yesTeam = 'Los Angeles Galaxy';
  pmMkt.noTeam = 'New England Revolution';
  pmMkt.yesPriceCents = 38; pmMkt.noPriceCents = 63;
  const kSame = kal('New England vs Los Angeles G Winner?');
  kSame.id = 'k-same'; kSame.yesTeam = 'LAG Los Angeles G';
  kSame.yesPriceCents = 40; kSame.noPriceCents = 62;
  const kOpp = kal('New England vs Los Angeles G Winner?');
  kOpp.id = 'k-opp'; kOpp.yesTeam = 'NE New England';
  // Priced to look far more attractive, so only the same-team preference can win.
  kOpp.yesPriceCents = 38; kOpp.noPriceCents = 63;
  const picked = matchMarkets([pmMkt], [kOpp, kSame], opts('soccer'));
  check('[soccer] picks the same-team Kalshi contract (draw safety)',
    picked.length === 1 && picked[0].kalshi.id === 'k-same',
    picked.length ? picked[0].kalshi.id : 'no match');
}

// ── NFL: Polymarket uses NICKNAMES, Kalshi uses CITY (+ ticker code) ──────────
// Polymarket titles NFL games "Cowboys vs. Giants"; Kalshi says "Dallas (DAL) vs
// New York G (NYG)". Five teams — Packers, Giants, Jets, Rams, Chargers — share no word
// at all with their Kalshi name, so without aliases they never matched. Every club is
// checked here against a known-good opponent.
const NFL_TEAMS = [
  ['Cardinals', 'Arizona (ARI)'], ['Falcons', 'Atlanta (ATL)'], ['Ravens', 'Baltimore (BAL)'],
  ['Bills', 'Buffalo (BUF)'], ['Panthers', 'Carolina (CAR)'], ['Bears', 'Chicago (CHI)'],
  ['Bengals', 'Cincinnati (CIN)'], ['Browns', 'Cleveland (CLE)'], ['Cowboys', 'Dallas (DAL)'],
  ['Broncos', 'Denver (DEN)'], ['Lions', 'Detroit (DET)'], ['Packers', 'Green Bay (GB)'],
  // Kalshi's Jacksonville code is JAC, not the more common JAX — verified against live
  // tickers, and both spellings are covered.
  ['Texans', 'Houston (HOU)'], ['Colts', 'Indianapolis (IND)'], ['Jaguars', 'Jacksonville (JAC)'],
  ['Raiders', 'Las Vegas (LV)'], ['Chargers', 'Los Angeles C (LAC)'], ['Rams', 'Los Angeles R (LAR)'],
  ['Dolphins', 'Miami (MIA)'], ['Vikings', 'Minnesota (MIN)'], ['Patriots', 'New England (NE)'],
  ['Saints', 'New Orleans (NO)'], ['Giants', 'New York G (NYG)'], ['Jets', 'New York J (NYJ)'],
  ['Eagles', 'Philadelphia (PHI)'], ['Steelers', 'Pittsburgh (PIT)'], ['49ers', 'San Francisco (SF)'],
  ['Seahawks', 'Seattle (SEA)'], ['Buccaneers', 'Tampa Bay (TB)'], ['Titans', 'Tennessee (TEN)'],
  ['Commanders', 'Washington (WAS)'],
];
for (const [nick, kalName] of NFL_TEAMS) {
  check(`[nfl] ${nick} <-> ${kalName}`,
    n('nfl', `${nick} vs. Chiefs [${nick} vs Chiefs]`, `${kalName} vs Kansas City (KC) Winner?`) === 1);
}
// Shared-city clubs must not take each other's game. The ticker code is what separates
// them, so these must fail even though the city words are identical.
const NFL_CROSS = [
  ['Giants vs. Cowboys [Giants vs Cowboys]', 'New York J (NYJ) vs Buffalo (BUF) Winner?'],
  ['Jets vs. Dolphins [Jets vs Dolphins]', 'New York G (NYG) vs Dallas (DAL) Winner?'],
  ['Rams vs. Seahawks [Rams vs Seahawks]', 'Los Angeles C (LAC) vs Denver (DEN) Winner?'],
  ['Chargers vs. Broncos [Chargers vs Broncos]', 'Los Angeles R (LAR) vs Seattle (SEA) Winner?'],
  // hardest case: same city AND the same opponent city
  ['Giants vs. Eagles [Giants vs Eagles]', 'New York J (NYJ) vs Philadelphia (PHI) Winner?'],
  // "Bay" is shared by Green Bay and Tampa Bay
  ['Packers vs. Bears [Packers vs Bears]', 'Tampa Bay (TB) vs Atlanta (ATL) Winner?'],
];
for (const [p, k] of NFL_CROSS) {
  check(`[nfl] no cross-match: ${p.slice(0, 26)}… vs ${k.slice(0, 26)}…`, n('nfl', p, k) === 0);
}

// The code-bearing matchup format must not disturb the other sports.
const CODED = [
  ['mlb', 'Toronto Blue Jays vs. Houston Astros [Toronto Blue Jays vs Houston Astros]', 'Toronto (TOR) vs Houston (HOU) Winner?'],
  ['mlb', 'Athletics vs. Boston Red Sox [Athletics vs Boston Red Sox]', "A's (ATH) vs Boston (BOS) Winner?"],
  ['cfb', 'Oregon State vs. Houston [Oregon State vs Houston]', 'Oregon St. (ORST) vs Houston (HOU) Winner?'],
  ['cfb', 'Washington State vs. Washington [Washington State vs Washington]', 'Washington St. (WSU) vs Washington (WASH) Winner?'],
  ['soccer', 'Toronto FC vs. Nashville SC: Will Toronto FC win on 2026-09-05?', 'Toronto (TOR) vs Nashville (NSH) Winner?'],
];
for (const [cat, p, k] of CODED) {
  check(`[${cat}] coded format still matches: ${p.slice(0, 30)}…`, n(cat, p, k) === 1);
}

// A game only matches on its own date — the same teams meet again in a series.
check('[mlb] different day does not match',
  n('mlb', 'Toronto Blue Jays vs. Houston Astros [Toronto Blue Jays vs Houston Astros]',
    'Toronto vs Houston Winner?', '2026-09-05', '2026-09-06') === 0);
check('[cfb] different day does not match',
  n('cfb', 'Oregon State vs. Houston [Oregon State vs Houston]',
    'Oregon St. vs Houston Winner?', '2026-09-05', '2026-09-12') === 0);


// A multi-word alias must match as a whole phrase. `utsa: ['texas san antonio']` used to
// be exploded into its words, putting the bare token "texas" into UTSA's expansion — so
// "North Texas vs. Texas State" paired with Kalshi's "UTSA vs Texas", a different game
// on the same day that the both-teams check could not catch (every token was "texas").
check('[cfb] shared city word does not cross-match schools',
  n('cfb', 'North Texas vs. Texas State [North Texas vs Texas State]',
    'UTSA (UTSA) vs Texas (TEX) Winner?') === 0);
check('[cfb] the real UTSA fixture still matches',
  n('cfb', 'UTSA vs. Texas [UTSA vs Texas]',
    'UTSA (UTSA) vs Texas (TEX) Winner?') === 1);

// Directional / "State" qualifiers must agree. Illinois, Illinois State, Eastern Illinois
// and Southern Illinois are four different programmes that all reduce to the token
// "illinois" once "state" is treated as generic — so "Southern Illinois vs. Illinois"
// satisfied the both-teams rule against "Illinois St. vs Eastern Illinois", a different
// fixture entirely. Caught by verifying pairs against the venues' own ticker codes.
check('[cfb] qualifier mismatch does not cross-match Illinois schools',
  n('cfb', 'Southern Illinois vs. Illinois [Southern Illinois vs Illinois]',
    'Illinois St. (ILST) vs Eastern Illinois (EIU) Winner?') === 0);
check('[cfb] the real Illinois St. fixture still matches',
  n('cfb', 'Eastern Illinois vs. Illinois State [Eastern Illinois vs Illinois State]',
    'Illinois St. (ILST) vs Eastern Illinois (EIU) Winner?') === 1);
check('[cfb] plain Illinois still matches itself',
  n('cfb', 'Duke vs. Illinois [Duke vs Illinois]',
    'Illinois (ILL) vs Duke (DUKE) Winner?') === 1);

// A dotted initialism loses its punctuation during normalization and becomes separate
// single letters, which the tokenizer drops as noise — "D.C. United" collapsed to the
// generic token "united" alone and could never match Kalshi's "DC".
check('[soccer] D.C. United matches Kalshi DC',
  n('soccer', 'D.C. United vs. New York City FC: Will D.C. United win on 2026-09-19?',
    'DC (DC) vs New York City (NYC) Winner?') === 1);

// Clubs sharing a city overlap entirely on the city words, so the both-teams rule
// accepted either contract: an Angels market paired with a DODGERS contract whenever the
// real Angels fixture was absent that day. The nickname->code aliases only steer the
// scorer, and scoring picks among pairs the gate has already let through.
check('[mlb] Angels market does not pair with a Dodgers contract',
  n('mlb', 'Los Angeles Angels vs. Boston Red Sox [Los Angeles Angels vs Boston Red Sox]',
    'Los Angeles D (LAD) vs Boston (BOS) Winner?') === 0);
check('[mlb] Mets market does not pair with a Yankees contract',
  n('mlb', 'New York Mets vs. Miami Marlins [New York Mets vs Miami Marlins]',
    'New York Y (NYY) vs Miami (MIA) Winner?') === 0);
check('[mlb] Cubs market does not pair with a White Sox contract',
  n('mlb', 'Chicago Cubs vs. Milwaukee Brewers [Chicago Cubs vs Milwaukee Brewers]',
    'Chicago WS (CWS) vs Milwaukee (MIL) Winner?') === 0);
check('[mlb] the real Angels fixture still matches',
  n('mlb', 'Los Angeles Angels vs. Boston Red Sox [Los Angeles Angels vs Boston Red Sox]',
    'Los Angeles A (LAA) vs Boston (BOS) Winner?') === 1);
check('[mlb] the real Dodgers fixture still matches',
  n('mlb', 'Cincinnati Reds vs. Los Angeles Dodgers [Cincinnati Reds vs Los Angeles Dodgers]',
    'Los Angeles D (LAD) vs Cincinnati (CIN) Winner?') === 1);
check('[mlb] the real White Sox fixture still matches',
  n('mlb', 'Pittsburgh Pirates vs. Chicago White Sox [Pittsburgh Pirates vs Chicago White Sox]',
    'Pittsburgh (PIT) vs Chicago WS (CWS) Winner?') === 1);
check('[mlb] Red Sox are not confused with White Sox',
  n('mlb', 'Los Angeles Angels vs. Boston Red Sox [Los Angeles Angels vs Boston Red Sox]',
    'Los Angeles A (LAA) vs Boston (BOS) Winner?') === 1);

// Reported from the live app: a card read "Eastern Washington vs. Washington" but was
// paired to the WASHINGTON STATE contract — a different game on a different date — so the
// prices were nonsense and the Polymarket page did not show the advertised fixture.
// Three distinct programmes share the token "washington" once "state" is treated as
// generic boilerplate, so only the directional/State qualifier separates them.
// Both events are real and both must keep matching their OWN contract.
check('[cfb] Eastern Washington does not pair with the Washington State contract',
  n('cfb', 'Eastern Washington vs. Washington [Eastern Washington vs Washington]',
    'Washington St. (WSU) vs Washington (WASH) Winner?') === 0);
check('[cfb] Washington State does not pair with the Eastern Washington contract',
  n('cfb', 'Washington State vs. Washington [Washington State vs Washington]',
    'Washington (WASH) vs Eastern Washington (EWU) Winner?') === 0);
check('[cfb] the real Eastern Washington fixture still matches',
  n('cfb', 'Eastern Washington vs. Washington [Eastern Washington vs Washington]',
    'Washington (WASH) vs Eastern Washington (EWU) Winner?') === 1);
check('[cfb] the real Washington State fixture still matches',
  n('cfb', 'Washington State vs. Washington [Washington State vs Washington]',
    'Washington St. (WSU) vs Washington (WASH) Winner?') === 1);
check('[cfb] Eastern Washington vs South Dakota still matches',
  n('cfb', 'Eastern Washington vs. South Dakota [Eastern Washington vs South Dakota]',
    'Eastern Washington (EWU) vs South Dakota (SDAK) Winner?') === 1);


// "St." is two different words. As a SUFFIX it means State ("Oregon St.") and is a
// qualifier that must match; as a PREFIX it means Saint ("St. Louis") and is part of the
// city name. Tokenizing loses the ordering, so the qualifier gate read Polymarket's
// "St. Louis City SC" as carrying the State qualifier while Kalshi's "Saint Louis" carried
// none, and silently refused every St. Louis fixture.
check('[soccer] St. Louis (Saint) matches Kalshi\'s spelled-out Saint Louis',
  n('soccer', 'St. Louis City SC vs. Toronto FC: Will St. Louis City SC win on 2026-09-19?',
    'Saint Louis (STL) vs Toronto (TOR) Winner?') === 1);
check('[soccer] St. Louis as the away side also matches',
  n('soccer', 'Portland Timbers vs. St. Louis City SC: Will Portland Timbers win on 2026-09-19?',
    'Portland (POR) vs Saint Louis (STL) Winner?') === 1);

// Accents are not \w characters, so stripping punctuation turned "CF Montréal" into
// "montr al", which could never match Kalshi's "Montreal". Folding diacritics first also
// covers München, Atlético and every other accented club.
check('[soccer] accented club name folds to its plain spelling',
  n('soccer', 'CF Montréal vs. Charlotte FC: Will CF Montréal win on 2026-09-19?',
    'Montreal (MTL) vs Charlotte (CLT) Winner?') === 1);
check('[soccer] Bayern München still matches',
  n('soccer', 'FC Schalke 04 vs. FC Bayern München: Will FC Bayern München win on 2026-09-19?',
    'Schalke (S04) vs Bayern Munchen (FCB) Winner?') === 1);

// The State suffix must keep working as a qualifier — these are the regressions the
// Saint fix could plausibly have caused.
check('[cfb] Oregon St. still matches Oregon State',
  n('cfb', 'Oregon State vs. Houston [Oregon State vs Houston]',
    'Oregon St. (ORST) vs Houston (HOU) Winner?') === 1);

// ── how much of a hedged pair is actually fillable ──
// maxContracts used to be Kalshi's top-of-book size alone, which is wrong both ways and
// both were seen live: one pair advertised 10,000 contracts when Polymarket had 190 at a
// profitable price (sizing to that fills one leg and leaves the other naked), and another
// advertised 10,961 when 26,709 were fillable a cent deeper, so the UI warned "exceeds
// visible book depth" on an order that would have filled fine.
const { fillableContracts, kalshiAskLadder, polymarketAskLadder } = await import('../lib/depth.ts');
const noFee = () => 0;

// Polymarket is the binding side: 190 available against 10,000 on Kalshi.
check('[depth] limited by the shallower venue',
  fillableContracts([{ priceCents: 96, size: 190 }], [{ priceCents: 3, size: 10000 }], noFee).contracts === 190);

// Deeper levels count while the pair still profits: 100@40 + 50@41 against plenty.
check('[depth] accumulates across levels while profitable',
  fillableContracts(
    [{ priceCents: 40, size: 100 }, { priceCents: 41, size: 50 }],
    [{ priceCents: 55, size: 1000 }], noFee).contracts === 150);

// Stops at the level where the two legs stop summing under 100.
check('[depth] stops when the next level is no longer profitable',
  fillableContracts(
    [{ priceCents: 40, size: 100 }, { priceCents: 45, size: 999 }],
    [{ priceCents: 55, size: 1000 }], noFee).contracts === 100);

check('[depth] nothing profitable yields zero',
  fillableContracts([{ priceCents: 96, size: 10 }], [{ priceCents: 6, size: 10 }], noFee).contracts === 0);

check('[depth] empty book yields zero, not NaN',
  fillableContracts([], [{ priceCents: 3, size: 10 }], noFee).contracts === 0);

check('[depth] fees can make a thin edge unfillable',
  fillableContracts([{ priceCents: 49, size: 10 }], [{ priceCents: 50, size: 10 }], () => 5).contracts === 0);

check('[depth] respects an explicit cap',
  fillableContracts([{ priceCents: 40, size: 100 }], [{ priceCents: 55, size: 100 }], noFee, 25).contracts === 25);

// Average cost rises as you size into worse levels — the edge at size is lower than the
// edge at the top of the book, which is the number that matters when sizing up.
check('[depth] average cost reflects the deeper levels',
  Math.abs(fillableContracts(
    [{ priceCents: 40, size: 100 }, { priceCents: 42, size: 100 }],
    [{ priceCents: 55, size: 1000 }], noFee).avgCostCents - 96) < 1e-9);

// Kalshi publishes resting BIDS; buying YES means matching a NO bid at 1 - price.
// A NO bid of $0.46 for 998 is exactly the reported yes_ask of $0.54 size 998.
check('[depth] kalshi ladder mirrors the opposite side\'s bids',
  (() => {
    const l = kalshiAskLadder({ no_dollars: [['0.4600', '998.00'], ['0.4400', '1077.00']] }, 'yes');
    return l.length === 2 && l[0].priceCents === 54 && l[0].size === 998 && l[1].priceCents === 56;
  })());

// Both Polymarket sides come from the YES token book: asks buy YES, bids mirrored buy NO.
check('[depth] polymarket yes ladder uses asks',
  (() => {
    const l = polymarketAskLadder({ asks: [{ price: '0.30', size: '40' }] }, 'yes');
    return l.length === 1 && l[0].priceCents === 30 && l[0].size === 40;
  })());
check('[depth] polymarket no ladder mirrors the bids',
  (() => {
    const l = polymarketAskLadder({ bids: [{ price: '0.70', size: '40' }] }, 'no');
    return l.length === 1 && l[0].priceCents === 30 && l[0].size === 40;
  })());

// Dust smaller than one contract is not depth.
check('[depth] sub-contract sizes are discarded',
  polymarketAskLadder({ asks: [{ price: '0.30', size: '0.4' }] }, 'yes').length === 0);

// ── Polymarket politics: only race-WINNER markets may reach the matcher ──
// Polymarket lists ~10 "margin of victory" buckets and a full seat-count ladder per race.
// Their wording is nearly identical to a winner market ("Will the Republican Party
// candidate win the 2026 Alabama Senate election by 15%-20%?"), so they used to sail past
// the party+senate+state check and pair with Kalshi's plain "Will Republicans win the
// Alabama Senate race?". Those are different events — both legs can lose — and they showed
// up as fake 21% arbs at the very top of the list, which is what the auto-execute button
// reaches for first. 333 politics pairs collapsed to the 60 real ones once these were cut.
const { isPoliticsMarket } = await import('../lib/politicsFilter.ts');
const pol = (question) => isPoliticsMarket({ question });

const POLITICS_KEEP = [
  'Will the Republicans win the Alabama Senate race in 2026?',
  'Will the Democrats win the Georgia Senate race in 2026?',
  'Will the Republican Party control the Senate after the 2026 Midterm elections?',
];
const POLITICS_DROP = [
  'Will the Republican Party candidate win the 2026 Alabama Senate election by 35% or more?',
  'Will the Republican Party candidate win the 2026 Alabama Senate election by 5%-10%?',
  'Will the Republican Party candidate win the 2026 Alabama Senate election by 0%-5%?',
  'Will the Republican Party hold exactly 51 Senate seats after the 2026 midterm elections?',
  'Will the Republican Party hold 47 or fewer Senate seats after the 2026 midterm elections?',
  'Will the Republicans win the Maine Senate Election Margin of Victory (First Round)?',
];
for (const q of POLITICS_KEEP) check(`[politics] keeps winner market: ${q.slice(0, 46)}…`, pol(q) === true);
for (const q of POLITICS_DROP) check(`[politics] drops derivative: ${q.slice(0, 52)}…`, pol(q) === false);

console.log(`politics filter: ${POLITICS_KEEP.length} kept, ${POLITICS_DROP.length} dropped`);


// ── Polymarket sports: only the game moneyline may reach the matcher ──
// Polymarket hangs prop bets off the same fixture title with a colon clause, and the
// junk-word blacklist missed them ("FG" not "field goal", "Safety?" not listed at all).
// 18 NFL fixtures each matched ~3 props against Kalshi's plain "Chicago wins" — markets
// that resolve on entirely different events. Sports is the DEFAULT auto-execute scope,
// so a fake edge here is the one most likely to be traded automatically.
const { isSportMoneyline } = await import('../lib/moneylineFilter.ts');

const ML_KEEP = [
  ['nfl', 'Bears vs. Panthers [Bears vs Panthers]'],
  ['cfb', 'North Texas vs. Texas State [North Texas vs Texas State]'],
  ['mlb', 'Toronto Blue Jays vs. Houston Astros [Toronto Blue Jays vs Houston Astros]'],
  ['soccer', 'Toronto FC vs. Nashville SC: Will Toronto FC win on 2026-09-05?'],
];
const ML_DROP = [
  ['nfl', 'Bears vs. Panthers: Safety?'],
  ['nfl', 'Bears vs. Panthers: Team to Record Longest FG [Bears vs Panthers]'],
  ['nfl', 'Bears vs. Panthers: Both Teams to Score Points - 1Q'],
  ['nfl', 'Buccaneers vs. Bengals: Safety?'],
  ['cfb', 'UTSA vs. Texas: Team to Record Longest FG [UTSA vs Texas]'],
];
for (const [cat, q] of ML_KEEP) {
  check(`[${cat}] keeps game moneyline: ${q.slice(0, 42)}…`, isSportMoneyline({ question: q }, cat) === true);
}
for (const [cat, q] of ML_DROP) {
  check(`[${cat}] drops prop market: ${q.slice(0, 46)}…`, isSportMoneyline({ question: q }, cat) === false);
}
console.log(`moneyline filter: ${ML_KEEP.length} kept, ${ML_DROP.length} dropped`);

// ── the in-play mechanism must hold for EVERY sport, not just the one in season ──
// NFL and college football have no games in progress most days, so a regression there
// would stay invisible until a Sunday. Assert the liveness rules directly per sport.
const HOUR2 = 3600e3;
const at = (ms) => new Date(ms).toISOString();
const FIXTURE = {
  mlb:    'Chicago Cubs vs. Milwaukee Brewers [Chicago Cubs vs Milwaukee Brewers]',
  nfl:    'Bears vs. Panthers [Bears vs Panthers]',
  cfb:    'Eastern Washington vs. Washington [Eastern Washington vs Washington]',
  soccer: 'Toronto FC vs. Nashville SC: Will Toronto FC win on 2026-09-09?',
};
for (const [cat, q] of Object.entries(FIXTURE)) {
  check(`[inplay/${cat}] game in progress is kept`,
    isSportMoneyline({ question: q, resolutionTime: at(Date.now() - 3 * HOUR2) }, cat) === true);
  check(`[inplay/${cat}] late game running past midnight is kept`,
    isSportMoneyline({ question: q, resolutionTime: at(Date.now() - 8 * HOUR2) }, cat) === true);
  check(`[inplay/${cat}] venue-settled market is dropped`,
    isSportMoneyline({ question: q, resolutionTime: at(Date.now() - 3 * HOUR2), tradeable: false }, cat) === false);
  check(`[inplay/${cat}] two-day-old game is dropped`,
    isSportMoneyline({ question: q, resolutionTime: at(Date.now() - 48 * HOUR2) }, cat) === false);
  check(`[inplay/${cat}] upcoming game is kept`,
    isSportMoneyline({ question: q, resolutionTime: at(Date.now() + 24 * HOUR2) }, cat) === true);
}
console.log(`in-play liveness: ${Object.keys(FIXTURE).length} sports x 5 rules`);

// ── the fixture DATE both venues must agree on ──
// Kalshi encodes the US Eastern date in its ticker. Polymarket is inconsistent: NFL slugs
// carry the UTC date, MLB slugs carry Eastern. So every NFL prime-time game looked like a
// different day on each venue and could not be paired at all — 7 of the 32 games in a
// week, every Thursday/Sunday/Monday night game. Deriving the day from the real kick-off
// timestamp in Eastern makes both venues agree without relaxing the same-day rule (which
// must stay strict: baseball plays the same opponent on back-to-back days).
const { easternDateOf } = await import('../lib/gameDate.ts');
const DATE_CASES = [
  ['2026-09-10 00:20:00+00', '2026-09-09', 'NFL Thursday night (NE-SEA)'],
  ['2026-09-14 00:20:00+00', '2026-09-13', 'NFL Sunday night (DAL-NYG)'],
  ['2026-09-21 00:20:00+00', '2026-09-20', 'NFL Monday night (IND-KC)'],
  ['2026-09-13 17:00:00+00', '2026-09-13', 'NFL Sunday afternoon is unchanged'],
  ['2026-09-09 02:10:00+00', '2026-09-08', 'MLB late game (CIN-LAD)'],
  ['2026-09-08 23:40:00+00', '2026-09-08', 'MLB evening game (CHC-MIL)'],
  ['2026-09-13 01:00:00+00', '2026-09-12', 'MLS late kick-off'],
  ['2026-03-08 07:30:00+00', '2026-03-08', 'EST side of the DST switch'],
  ['2026-07-04 03:15:00+00', '2026-07-03', 'EDT side of the DST switch'],
];
for (const [gst, want, label] of DATE_CASES) {
  check(`[date] ${label}`, easternDateOf(gst) === want);
}
// Unusable input must fall back to the slug rather than inventing a date.
for (const bad of [null, undefined, '', 'not-a-date', 123, {}]) {
  check(`[date] rejects ${JSON.stringify(bad)}`, easternDateOf(bad) === null);
}
console.log(`game-date conversion: ${DATE_CASES.length} timestamps + 6 bad inputs`);

// ── in-play games must survive the liveness filter ──
// `resolutionTime` is synthesised as "<gameDate>T23:59:00Z" purely so both venues agree
// on a fixture date; it is NOT when the game ends. Treating it as an expiry discarded
// every game in progress — a Sept 8 game starting 01:40 UTC on the 9th was dropped 29
// minutes after first pitch while Kalshi kept quoting it. In-play is where the two
// venues diverge most, so this removed exactly the window with the best edges.
const HOUR = 3600e3;
const iso = (ms) => new Date(ms).toISOString();
check('[inplay] a game still being played is kept (2h past the synthetic date)',
  isSportMoneyline({ question: 'Chicago Cubs vs. Milwaukee Brewers', resolutionTime: iso(Date.now() - 2 * HOUR) }, 'mlb') === true);
check('[inplay] a late west-coast game is kept (8h past)',
  isSportMoneyline({ question: 'Texas Rangers vs. Seattle Mariners', resolutionTime: iso(Date.now() - 8 * HOUR) }, 'mlb') === true);
check('[inplay] a genuinely stale game is dropped (2 days past)',
  isSportMoneyline({ question: 'Chicago Cubs vs. Milwaukee Brewers', resolutionTime: iso(Date.now() - 48 * HOUR) }, 'mlb') === false);
check('[inplay] the venue saying the market has settled always wins',
  isSportMoneyline({ question: 'Chicago Cubs vs. Milwaukee Brewers', resolutionTime: iso(Date.now() + HOUR), tradeable: false }, 'mlb') === false);
check('[inplay] an upcoming game is still kept',
  isSportMoneyline({ question: 'Chicago Cubs vs. Milwaukee Brewers', resolutionTime: iso(Date.now() + 24 * HOUR) }, 'mlb') === true);

// ── YES/NO alignment must not treat qualifier-different teams as the same club ──
// PM YES was "Eastern Washington", Kalshi YES was "WASH Washington". They overlap on
// "washington", the yes/no identity scores tied, and the tie fell through to PRICE
// proximity — inverted exactly when the venues disagree. The app then bought PM YES
// (Eastern Washington) alongside Kalshi NO (= Eastern Washington): both legs paying on
// the SAME outcome, reported as a 14.35% arb, in the default auto-execute scope.
const { teamsAreDifferent } = await import('../lib/matchMarkets.ts');
check('[align] Eastern Washington is not Washington',
  teamsAreDifferent('Eastern Washington', 'WASH Washington') === true);
check('[align] Washington State is not Washington',
  teamsAreDifferent('Washington State', 'WASH Washington') === true);
check('[align] Washington is Washington',
  teamsAreDifferent('Washington', 'WASH Washington') === false);
check('[align] Eastern Washington is Eastern Washington',
  teamsAreDifferent('Eastern Washington', 'EWU Eastern Washington') === false);
check('[align] Dodgers and Angels are not the same club',
  teamsAreDifferent('Los Angeles Dodgers', 'LAA Los Angeles Angels') === true);


console.log(`matching regression: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFAILURES');
  failures.forEach(f => console.log('  ' + f));
  process.exit(1);
}
