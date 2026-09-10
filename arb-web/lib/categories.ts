import type { Category } from './market-types';

export const CATEGORY_LABELS: Record<Category, string> = {
  mlb: 'MLB',
  soccer: 'Soccer',
  nfl: 'NFL',
  cfb: 'CFB',
  politics: 'Politics',
};

export const CATEGORY_COLORS: Record<Category, { bg: string; color: string; border: string }> = {
  mlb: { bg: '#dc262622', color: '#f87171', border: '#dc262644' },
  soccer: { bg: '#16a34a22', color: '#4ade80', border: '#16a34a44' },
  nfl: { bg: '#2563eb22', color: '#60a5fa', border: '#2563eb44' },
  cfb: { bg: '#ea580c22', color: '#fb923c', border: '#ea580c44' },
  politics: { bg: '#7c3aed22', color: '#a78bfa', border: '#7c3aed44' },
};

// Head-to-head game categories. These share one pipeline: two named teams, a single
// game date, team-split matching and identity-based YES/NO alignment. Politics is the
// only category that isn't. Defined once so adding a sport can't miss a check.
export const SPORT_CATEGORY_LIST: Category[] = ['mlb', 'soccer', 'nfl', 'cfb'];

export function isSportCategory(cat?: Category): boolean {
  return cat !== undefined && SPORT_CATEGORY_LIST.includes(cat);
}

// Sports where a draw is a real third outcome with its own Kalshi contract. Verified
// against live data: an MLS/EPL event has THREE contracts (team, team, Tie) and the two
// team YES prices sum well under 100, whereas MLB/NFL/CFB events have exactly two
// complementary contracts (sums ~100–104).
//
// This matters because pairing a Polymarket market with the OPPOSING team's Kalshi
// contract only hedges when the two outcomes are complementary. In a three-way market
// "Team A wins" + "Team B wins" leaves the draw uncovered — it looks like a huge edge
// (the draw probability) but is an unhedged bet that loses outright on a draw.
const THREE_WAY_CATEGORIES: Category[] = ['soccer'];

export function isThreeWayCategory(cat?: Category): boolean {
  return cat !== undefined && THREE_WAY_CATEGORIES.includes(cat);
}

export function kalshiTickerToCategory(ticker: string): Category | null {
  const t = ticker.toUpperCase();
  if (t.startsWith('KXMLB')) return 'mlb';
  // College football must be tested before the NFL prefix: both are "football", but
  // KXNCAAF* is college and KXNFL* is pro.
  if (t.startsWith('KXNCAAF')) return 'cfb';
  if (t.startsWith('KXNFL')) return 'nfl';
  if (
    t.startsWith('KXSOC') || t.startsWith('KXWC') || t.startsWith('KXFIFA') ||
    t.startsWith('KXMLS') || t.startsWith('KXEPL') || t.startsWith('KXUEFA') ||
    t.startsWith('KXSOCCER')
  ) return 'soccer';
  if (
    t.startsWith('SENATE') || t.startsWith('CONTROLS') || t.startsWith('KXBALANCE') ||
    t.startsWith('KXPRES') || t.startsWith('KXELEC') || t.startsWith('KXPOL') ||
    t.startsWith('KXPRIMARY') || t.startsWith('KXCONGRESS') || t.startsWith('KXGUV') ||
    t.startsWith('GOV') || t.startsWith('HOUSE')
  ) return 'politics';
  return null;
}

export const POLYMARKET_SPORT_KEYWORDS: Partial<Record<Category, string[]>> = {
  mlb: ['mlb', 'baseball'],
  // Matched against Polymarket's /sports `sport` names and tag slugs. Their sport codes
  // are exactly "nfl" and "cfb"; deliberately NOT the word "football", which would drag
  // in soccer leagues and every football-adjacent novelty tag.
  nfl: ['nfl'],
  cfb: ['cfb', 'ncaaf'],
  // 'football' excluded — matches American football on Polymarket.
  soccer: [
    'soccer', 'world-cup', 'fifa', 'fifwc', 'fif',
    'mls', 'epl', 'uef', 'lal', 'bun', 'fl1',
    'premier-league', 'champions-league', 'euro-2024', 'euro-2025', 'euro-2026',
  ],
};

export const POLYMARKET_POLITICS_TAG_SLUGS = [
  'politics', 'elections', 'election', 'us-politics',
  'us-elections', 'political', 'government',
];

export const KALSHI_MONEYLINE_PATTERN: Partial<Record<Category, RegExp>> = {
  // Allow 0-or-more additional hyphenated groups after the first so that tickers
  // without a -Y/-N suffix (e.g. KXMLBGAME-26JUL061410PHIKC) still pass.
  mlb: /^KXMLBGAME-[A-Z0-9]+(-[A-Z0-9]+)*$/i,
  // Soccer game tickers: e.g. KXWCGAME-26JUN22FRAIRQ (one group) or KXMLSGAME-TM1-TM2 (two groups)
  soccer: /^KX(SOC|WC|FIFA|MLS|EPL|UEFA|SOCCER)[A-Z0-9]*-[A-Z0-9]+(-[A-Z0-9]+)*$/i,
  // Game moneylines only. KXNFLGAME-26SEP21NYGLAR-NYG matches; the spread series
  // (KXNFLSPREAD-…), first-half (KXNCAAF1H-…) and season-long championship (KXNCAAF-27-…)
  // series are excluded both here and by not being fetched at all.
  nfl: /^KXNFLGAME-[A-Z0-9]+(-[A-Z0-9]+)*$/i,
  cfb: /^KXNCAAFGAME-[A-Z0-9]+(-[A-Z0-9]+)*$/i,
};

export const SPORT_ALIASES: Record<Category, Record<string, string[]>> = {
  mlb: {
    // 3-letter codes → team names
    nyy: ['yankees'], bos: ['red sox', 'redsox'], tor: ['blue jays', 'bluejays'],
    bal: ['orioles'], tb: ['rays'], tbr: ['rays'],
    cle: ['guardians'], det: ['tigers'], kc: ['royals', 'kansas city'],
    kcr: ['royals', 'kansas city'], min: ['twins'], cws: ['white sox', 'whitesox'],
    hou: ['astros'], tex: ['rangers'], sea: ['mariners'], laa: ['angels'],
    oak: ['athletics', 'as'], as: ['athletics', 'oakland athletics', 'sacramento athletics'],
    // Athletics is the one club whose Polymarket name ("Athletics") shares NO token with
    // Kalshi's ("ATH A's") — apostrophes are stripped and 1-char tokens dropped, so
    // identity alignment scored 0/0 and silently fell back to price proximity. These two
    // keys restore a real token overlap in both directions.
    ath: ['athletics', 'as', 'oakland athletics', 'sacramento athletics'],
    athletics: ['ath', 'as', 'oak'],
    atl: ['braves'], phi: ['phillies'], nym: ['mets'], mia: ['marlins'],
    wsh: ['nationals'], was: ['nationals'],
    chc: ['cubs'], mil: ['brewers'], pit: ['pirates'], stl: ['cardinals'], cin: ['reds'],
    lad: ['dodgers'], sf: ['giants'], sfg: ['giants'],
    ari: ['diamondbacks', 'd-backs'], col: ['rockies'], sd: ['padres'], sdp: ['padres'],
    // City-name → team-name aliases (Kalshi uses city names, PM may use nicknames only)
    // Single-token city words that uniquely (or mostly) identify an MLB team
    diego: ['padres'],
    angeles: ['dodgers', 'angels'],
    francisco: ['giants'],
    detroit: ['tigers'],
    texas: ['rangers'],
    kansas: ['royals'],
    tampa: ['rays'],
    louis: ['cardinals'],
    seattle: ['mariners'],
    atlanta: ['braves'],
    houston: ['astros'],
    minnesota: ['twins'],
    washington: ['nationals'],
    colorado: ['rockies'],
    cleveland: ['guardians'],
    boston: ['red sox'],
    oakland: ['athletics'],
    miami: ['marlins'],
    milwaukee: ['brewers'],
    pittsburgh: ['pirates'],
    philadelphia: ['phillies'],
    cincinnati: ['reds'],
    toronto: ['blue jays'],
    baltimore: ['orioles'],
    // Ambiguous city tokens — second-team check prevents false positives
    york: ['yankees', 'mets'],
    chicago: ['cubs', 'white sox'],
    san: ['padres', 'giants'],
    // Reverse (nickname -> Kalshi code) for the clubs that SHARE a city. Without these,
    // "Los Angeles Dodgers" scores identically against the LAA and LAD contracts (both
    // match only on "los"/"angeles") and the tie falls through to price. The code is the
    // one token that separates them.
    dodgers: ['lad'], angels: ['laa'],
    yankees: ['nyy'], mets: ['nym'],
    cubs: ['chc'], whitesox: ['cws'],
    padres: ['sd', 'sdp'], giants: ['sf', 'sfg'],
  },
  soccer: {
    // World Cup national teams — covers both 3-letter FIFA codes and full names
    arg: ['argentina'], bra: ['brazil'], fra: ['france'], eng: ['england'],
    ger: ['germany'], esp: ['spain'], por: ['portugal'], ned: ['netherlands', 'holland'],
    bel: ['belgium'], ita: ['italy'], usa: ['united states', 'usmnt'], mex: ['mexico'],
    mor: ['morocco'], sen: ['senegal'], nga: ['nigeria'], gha: ['ghana'],
    jpn: ['japan'], kor: ['south korea', 'korea'], aus: ['australia'],
    cro: ['croatia'], srb: ['serbia'], sui: ['switzerland'], den: ['denmark'],
    pol: ['poland'], uru: ['uruguay'], col: ['colombia'], ecu: ['ecuador'],
    chl: ['chile'], per: ['peru'], ven: ['venezuela'],
    // Additional FIFA 3-letter codes not covered above
    tur: ['turkey'], mar: ['morocco'], irn: ['iran'], ksa: ['saudi arabia'],
    qat: ['qatar'], cmr: ['cameroon'], civ: ["ivory coast", "cote d'ivoire", 'civ'],
    mli: ['mali'], egy: ['egypt'], zaf: ['south africa'], tun: ['tunisia'],
    alg: ['algeria'], cod: ['dr congo', 'congo dr', 'democratic republic of congo'],
    nzl: ['new zealand'], idn: ['indonesia'], phl: ['philippines'],
    tha: ['thailand'], vnm: ['vietnam'], sgp: ['singapore'],
    chn: ['china'], ind: ['india'], pak: ['pakistan'],
    can: ['canada'], crc: ['costa rica'], pan: ['panama'], hnd: ['honduras'],
    gtm: ['guatemala'], slv: ['el salvador'], jam: ['jamaica'], tto: ['trinidad'],
    bol: ['bolivia'], par: ['paraguay'], arg2: ['argentina'],
    svn: ['slovenia'], svk: ['slovakia'], aut: ['austria'], hun: ['hungary'],
    rou: ['romania'], ukr: ['ukraine'], swe: ['sweden'], nor: ['norway'],
    fin: ['finland'], gre: ['greece'], tur2: ['turkey'],
    scg: ['serbia'], bih: ['bosnia'], alb: ['albania'], mkd: ['north macedonia'],
    geo: ['georgia'], aze: ['azerbaijan'], arm: ['armenia'],
    // MLS clubs
    lafc: ['los angeles fc'], lag: ['la galaxy', 'galaxy'],
    nycfc: ['new york city fc', 'nyc fc'], nyrb: ['new york red bulls', 'red bulls'],
    atl: ['atlanta united'], mia: ['inter miami', 'miami'],
    sea: ['sounders', 'seattle sounders'], ptim: ['timbers', 'portland timbers'],
    // Common European clubs
    rma: ['real madrid'], bar: ['barcelona'], mci: ['manchester city', 'man city'],
    mun: ['manchester united', 'man utd'], lfc: ['liverpool'], che: ['chelsea'],
    ars: ['arsenal'], tot: ['tottenham', 'spurs'],
    bay: ['bayern', 'bayern munich'], bvb: ['dortmund', 'borussia dortmund'],
    psg: ['paris saint-germain', 'paris sg'], juve: ['juventus'],
  },
  nfl: {
    // Kalshi abbreviates shared-city clubs to "New York G" / "New York J", and the
    // distinguishing letter is a single character that tokenising drops. The ticker code
    // (carried in yesTeam, e.g. "NYG New York G") is what survives, so map each code to
    // its nickname — that is what keeps Giants/Jets and Rams/Chargers apart when the
    // YES side is aligned.
    nyg: ['giants'], nyj: ['jets'],
    // Include the city words so a bare code (Polymarket occasionally lists "LAR")
    // still reaches Kalshi's "Los Angeles R".
    lar: ['rams', 'los angeles'], lac: ['chargers', 'los angeles'],
    lv: ['raiders'], lvr: ['raiders'],
    sf: ['49ers', 'niners'], sfo: ['49ers', 'niners'],
    ne: ['patriots'], nwe: ['patriots'], tb: ['buccaneers', 'bucs'], tbb: ['buccaneers', 'bucs'],
    gb: ['packers'], gnb: ['packers'], no: ['saints'], nor: ['saints'],
    kc: ['chiefs'], kan: ['chiefs'], buf: ['bills'], mia: ['dolphins'],
    bal: ['ravens'], cin: ['bengals'], cle: ['browns'], pit: ['steelers'],
    // Kalshi's Jacksonville code is JAC (verified against live tickers); JAX is the more
    // common abbreviation elsewhere, so both are mapped.
    hou: ['texans'], ind: ['colts'], jax: ['jaguars'], jac: ['jaguars'], ten: ['titans'],
    den: ['broncos'], dal: ['cowboys'], phi: ['eagles'], was: ['commanders'], wsh: ['commanders'],
    chi: ['bears'], det: ['lions'], min: ['vikings'], atl: ['falcons'],
    car: ['panthers'], ari: ['cardinals'], arz: ['cardinals'], sea: ['seahawks'],
    // City words that identify a club on their own
    kansas: ['chiefs'], buffalo: ['bills'], miami: ['dolphins'], baltimore: ['ravens'],
    cincinnati: ['bengals'], cleveland: ['browns'], pittsburgh: ['steelers'],
    houston: ['texans'], indianapolis: ['colts'], jacksonville: ['jaguars'],
    tennessee: ['titans'], denver: ['broncos'], dallas: ['cowboys'],
    philadelphia: ['eagles'], washington: ['commanders'], chicago: ['bears'],
    detroit: ['lions'], minnesota: ['vikings'], atlanta: ['falcons'],
    carolina: ['panthers'], arizona: ['cardinals'], seattle: ['seahawks'],
    tampa: ['buccaneers', 'bucs'], orleans: ['saints'], england: ['patriots'],
    vegas: ['raiders'], francisco: ['49ers', 'niners'],
    // Multi-word city where Polymarket shows ONLY the nickname; unambiguous, so it can
    // alias directly.
    green: ['packers'],
    // NOTE: no `york` or `angeles` alias. Both cities host two clubs, so aliasing them
    // would make a Giants market match the Jets' game (and Rams match Chargers). The
    // shared-city clubs are matched through their ticker code instead — Kalshi's restated
    // matchup carries "(NYG)" / "(NYJ)" / "(LAR)" / "(LAC)", and the nickname→code
    // aliases above resolve them exactly.
    // Reverse (nickname -> code) for the two shared-city pairings, so a Giants market
    // outscores the Jets contract instead of tying on "new"/"york".
    giants: ['nyg'], jets: ['nyj'], rams: ['lar'], chargers: ['lac'],
  },
  cfb: {
    // NOTE: deliberately NO st<->state alias. Kalshi writes "Illinois St." and
    // Polymarket "Illinois State", but so many schools carry State/St. that aliasing
    // them made the word match everything — "Portland State" paired with
    // "Sacramento St.". Both words are treated as boilerplate in matchMarkets instead,
    // so the school name itself carries the match.
    cent: ['central'], intl: ['international'],
    tech: ['technological', 'technology'],
    miss: ['mississippi'], la: ['louisiana'], ky: ['kentucky'], fla: ['florida'],
    conn: ['connecticut'], mass: ['massachusetts'], mich: ['michigan'],
    okla: ['oklahoma'], ore: ['oregon'], wash: ['washington'], wisc: ['wisconsin'],
    // Short forms the two venues mix
    uconn: ['connecticut'], umass: ['massachusetts'], usc: ['southern california'],
    ucf: ['central florida'], utep: ['texas el paso'], utsa: ['texas san antonio'],
    smu: ['southern methodist'], tcu: ['christian'], byu: ['brigham young'],
    lsu: ['louisiana state'], ole: ['mississippi'], pitt: ['pittsburgh'],
  },
  politics: {
    // Party names — all forms alias to each other
    republican: ['republicans', 'gop', 'rnc', 'rep'],
    republicans: ['republican', 'gop', 'rnc', 'rep'],
    gop: ['republican', 'republicans', 'rep'],
    rep: ['republican', 'republicans', 'gop'],
    democrat: ['democrats', 'democratic', 'dems', 'dnc', 'dem'],
    democrats: ['democrat', 'democratic', 'dems', 'dnc', 'dem'],
    democratic: ['democrat', 'democrats', 'dems', 'dem'],
    dem: ['democrat', 'democrats', 'democratic', 'dems'],
    // Chamber/role
    senate: ['senator', 'senators'],
    senator: ['senate', 'senators'],
    senators: ['senate', 'senator'],
    house: ['representative', 'representatives', 'congressman', 'congresswoman'],
    control: ['controls', 'controlled', 'majority', 'win'],
    controls: ['control', 'controlled', 'majority'],
    majority: ['control', 'controls', 'win', 'winner'],
    // PM uses "election" / "seat"; Kalshi uses "race" — bridge them
    election: ['race', 'seat', 'contest', 'elections'],
    elections: ['election', 'race', 'seat', 'contest'],
    race: ['election', 'elections', 'seat', 'contest'],
    seat: ['election', 'elections', 'race'],
    contest: ['election', 'elections', 'race', 'seat'],
    // PM uses "midterm" / "midterms"; Kalshi may omit it
    midterm: ['election', 'elections', 'midterms'],
    midterms: ['midterm', 'election', 'elections'],
    // State abbreviations → full names (in case they appear as tokens in Kalshi tickers)
    tx: ['texas'], ga: ['georgia'], ia: ['iowa'], ak: ['alaska'],
    mi: ['michigan'], wi: ['wisconsin'], mt: ['montana'], me: ['maine'],
    nj: ['new jersey'], nh: ['new hampshire'], co: ['colorado'],
    nm: ['new mexico'], nc: ['north carolina'], or: ['oregon'], il: ['illinois'],
    md: ['maryland'], va: ['virginia'], nv: ['nevada'], de: ['delaware'],
    la: ['louisiana'], al: ['alabama'], ar: ['arkansas'], id: ['idaho'],
    ks: ['kansas'], mn: ['minnesota'], sc: ['south carolina'],
  },
};
