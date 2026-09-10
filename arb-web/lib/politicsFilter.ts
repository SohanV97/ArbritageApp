// Which Polymarket politics markets are eligible to be matched against Kalshi.
// Kept in lib/ with no path-alias imports so the regression suite can load it under bare
// Node: the filter is the last line of defence against fake politics arbs, and a fake arb
// here is exactly what the auto-execute button reaches for first.

// States with 2026 Senate races that Kalshi lists (mirrors CATEGORY_SERIES in kalshi.ts).
const KALSHI_SENATE_STATES = [
  'texas', 'iowa', 'alaska', 'georgia', 'michigan', 'wisconsin',
  'montana', 'maine', 'new jersey', 'new hampshire', 'colorado',
  'new mexico', 'north carolina', 'oregon', 'illinois', 'maryland',
  'virginia', 'nevada', 'delaware', 'louisiana', 'alabama',
  'arkansas', 'idaho', 'kansas', 'minnesota', 'south carolina',
  'massachusetts', 'rhode island', 'west virginia', 'oklahoma',
  'tennessee', 'mississippi', 'nebraska',
];

// Kalshi politics coverage is narrow: individual 2026 Senate races + Senate/House control.
// Filtering PM down to the same slice prevents false matches with approval ratings,
// Supreme Court picks, policy bills, foreign elections, and other things Kalshi ignores.
export function isPoliticsMarket(market: { question: string; resolutionTime?: string | null }): boolean {
  if (market.resolutionTime && Date.parse(market.resolutionTime) < Date.now()) return false;
  const q = market.question.toLowerCase();

  // Kalshi has no primaries, runoffs, caucuses, or governor races
  if (/\bprimary\b|\bprimaries\b|\brunoff\b|\bcaucus\b|\bgovernor\b|\bgov\b/.test(q)) return false;

  // Drop Polymarket's placeholder candidate/party slots ("Person A", "Party B",
  // "a candidate not listed above", "another party") — they have no real prices.
  if (/\b(person|party|candidate)\s+[a-l]\b/.test(q)) return false;
  if (/not listed|another party|other party/.test(q)) return false;

  // Compound / derivative markets that LOOK like control markets but resolve on a
  // different event: trifecta, supermajority, "all core four races", seat counts,
  // "lose a seat", "before the midterms" timing markets, House+Senate combos.
  if (/\btrifecta\b|\bsupermajority\b|\bcore four\b|\bhow many\b|\bincumbent|\bsweep\b|\bswept\b|\blose\b|\bflip\b|\bbefore the midterm/.test(q)) return false;
  if (/\bhouse\b/.test(q) && /\bsenate\b/.test(q)) return false;

  // Markets that resolve on a QUANTITY rather than on who wins. These read almost
  // identically to a winner market — "Will the Republican Party candidate win the 2026
  // Alabama Senate election by 15%-20%?" — so they sail past a naive party+senate+state
  // check and then pair with Kalshi's plain "Will Republicans win the Senate race in
  // Alabama?". They are not the same event: a 20%+ "edge" there is fictional, because the
  // two legs can both lose. Polymarket lists ~10 margin buckets per state plus a full
  // seat-count ladder, so this is the single largest source of false politics pairs.
  if (/\bmargin\b|margin of victory|\bfirst round\b/.test(q)) return false;
  if (/\bseats\b|\bseat count\b/.test(q)) return false;              // "hold exactly 51 Senate seats"
  if (/\bby\s*\d+(\.\d+)?\s*%/.test(q)) return false;                // "win ... by 35% or more"
  if (/\bby\s*\d+(\.\d+)?\s*%?\s*[-–]\s*\d+/.test(q)) return false;  // "win ... by 5%-10%"
  if (/\b(exactly|or fewer|or more|at least|at most)\b/.test(q)) return false;

  // Must name a real party so the structured matcher can align it.
  const hasParty = /\b(republican|republicans|democrat|democrats|democratic)\b/.test(q);
  if (!hasParty) return false;

  const hasSenate = /\bsenate\b|\bsenator\b/.test(q);
  const hasControl = /\bcontrol\b|\bmajority\b/.test(q);

  // Senate race in a state Kalshi covers
  if (hasSenate && KALSHI_SENATE_STATES.some(s => q.includes(s))) return true;

  // "Which party controls / wins the Senate / House / Congress?"
  if ((hasControl || hasSenate) && /\b(senate|house|congress)\b/.test(q)) return true;

  return false;
}
