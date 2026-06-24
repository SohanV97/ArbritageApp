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
    // Kalshi politics tickers — many don't use KX prefix
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
  // Includes Polymarket sport-code shortnames (fifwc, fif, epl, uef, mls, etc.)
  // alongside slug-style keywords so both the sport-metadata and tag matchers fire.
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
  mlb: /^KXMLBGAME-[A-Z0-9]+-[A-Z0-9]+$/i,
  // Soccer game tickers: e.g. KXWCGAME-26JUN22FRAIRQ (one group) or KXMLSGAME-TM1-TM2 (two groups)
  soccer: /^KX(SOC|WC|FIFA|MLS|EPL|UEFA|SOCCER)[A-Z0-9]*-[A-Z0-9]+(-[A-Z0-9]+)*$/i,
};

export const SPORT_ALIASES: Record<Category, Record<string, string[]>> = {
  mlb: {
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
  },
  soccer: {
    // World Cup national teams
    arg: ['argentina'], bra: ['brazil'], fra: ['france'], eng: ['england'],
    ger: ['germany'], esp: ['spain'], por: ['portugal'], ned: ['netherlands', 'holland'],
    bel: ['belgium'], ita: ['italy'], usa: ['united states', 'usmnt'], mex: ['mexico'],
    mor: ['morocco'], sen: ['senegal'], nga: ['nigeria'], gha: ['ghana'],
    jpn: ['japan'], kor: ['south korea', 'korea'], aus: ['australia'],
    cro: ['croatia'], srb: ['serbia'], sui: ['switzerland'], den: ['denmark'],
    pol: ['poland'], uru: ['uruguay'], col: ['colombia'], ecu: ['ecuador'],
    chl: ['chile'], per: ['peru'], ven: ['venezuela'],
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
  politics: {},
};
