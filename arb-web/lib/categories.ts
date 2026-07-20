import type { Category } from './market-types';

export const CATEGORY_LABELS: Record<Category, string> = {
  mlb: 'MLB',
  soccer: 'Soccer',
  politics: 'Politics',
};

export const CATEGORY_COLORS: Record<Category, { bg: string; color: string; border: string }> = {
  mlb: { bg: '#dc262622', color: '#f87171', border: '#dc262644' },
  soccer: { bg: '#16a34a22', color: '#4ade80', border: '#16a34a44' },
  politics: { bg: '#7c3aed22', color: '#a78bfa', border: '#7c3aed44' },
};

export function kalshiTickerToCategory(ticker: string): Category | null {
  const t = ticker.toUpperCase();
  if (t.startsWith('KXMLB')) return 'mlb';
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
