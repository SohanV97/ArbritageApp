import type { UnifiedMarket, Category } from '@/lib/market-types';
import { KALSHI_MONEYLINE_PATTERN, isSportCategory } from '@/lib/categories';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_PAGE_LIMIT = 200;    // request 200/page (API may cap at 100)
const KALSHI_PAGE_DELAY_MS = 50;  // between pages of the same series
const KALSHI_MAX_PAGES = 3;       // up to 600 markets; MLB alone can have 200+ open games
// Kept deliberately low. Raising this to 10 (with a 12-wide gate) looked safe in an
// isolated benchmark — Kalshi served 24 concurrent requests of this shape with no rate
// limiting — but under the REAL fan-out, with Polymarket loading at the same time, it
// produced 429s that survived all four retries and wiped MLB to 0 markets and 0 pairs.
// Discovery speed is no longer worth that risk: restarts are served from the discovery
// cache, so this scan runs in the background rather than blocking the user.
const KALSHI_SERIES_BATCH = 4;
const KALSHI_BATCH_DELAY_MS = 80; // between batches

function getKalshiApiKey(): string | null {
  const key = process.env.KALSHI_API_KEY;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

interface KalshiMarket {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  market_type?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  status?: string;
  yes_bid?: number;
  yes_bid_dollars?: number | string;
  yes_bid_size_fp?: number | string;
  yes_ask?: number;
  yes_ask_dollars?: number | string;
  yes_ask_size_fp?: number | string;
  no_bid?: number;
  no_bid_dollars?: number | string;
  no_ask?: number;
  no_ask_dollars?: number | string;
  close_time?: string;
  expiration_time?: string;
  market?: KalshiMarket;
  [key: string]: unknown;
}

interface KalshiMarketsResponse {
  markets?: KalshiMarket[];
  cursor?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── global request gate ─────────────────────────────────────────────────────
// Per-category batching is not enough on its own: all five categories fan out at the
// same time, and sports additionally resolve every series subtitle in an unbounded
// Promise.all. At startup that stacked up well past Kalshi's burst limit, and the 429
// survived all four retries — soccer came back with 41 markets instead of 81, so half
// the fixtures silently vanished from matching. Cap concurrency across EVERY Kalshi
// request so the ceiling holds no matter how the callers fan out.
// Last successful market list per category. A category that comes back empty is almost
// always a transient upstream failure (a burst of 429s wiping every series in the
// fan-out), not a venue that genuinely delisted a whole sport. Overwriting good data
// with nothing made an entire sport vanish from the app until the next rediscovery
// happened to succeed — serve the previous list instead and say so in the log.
const _lastGoodByCategory = new Map<Category, UnifiedMarket[]>();

const KALSHI_MAX_INFLIGHT = 6;
let _inflight = 0;
const _waiters: Array<() => void> = [];

async function kalshiFetch(url: string, init?: RequestInit): Promise<Response> {
  // Queue if the gate is full OR anyone is already waiting. Without the second condition a
  // request arriving while slots are free jumps the queue, so a category that fans out late
  // can be starved indefinitely by categories still issuing new requests. That is what kept
  // politics 34 single-page series (~54ms each, ~0.2s of real work) taking 10.6s of the
  // cold start. FIFO makes the wait bounded.
  if (_inflight >= KALSHI_MAX_INFLIGHT || _waiters.length > 0) {
    await new Promise<void>(resolve => _waiters.push(resolve));
  }
  _inflight++;
  try {
    return await fetch(url, init);
  } finally {
    _inflight--;
    _waiters.shift()?.();
  }
}

function getPrice(m: KalshiMarket, ...keys: string[]): number | string | undefined {
  const src = (m.market as Record<string, unknown> | undefined) ?? m;
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && v !== '') return v as number | string;
  }
  return undefined;
}

// Reads a price in CENTS from the two shapes Kalshi returns.
// `unit` removes a genuine ambiguity: the raw value 1 means $1.00 (=100¢) coming from a
// *_dollars field but 1¢ coming from an integer-cent field. Guessing from magnitude
// alone silently turns a 1¢ quote into a 100¢ one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractCents(val: any, unit: 'dollars' | 'cents'): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = typeof val === 'string' ? parseFloat(val) : Number(val);
  if (!Number.isFinite(n)) return null;
  const cents = unit === 'dollars' ? Math.round(n * 100) : Math.round(n);
  return cents >= 1 && cents <= 100 ? cents : null;
}

// Prefer the authoritative *_dollars field; fall back to the integer-cent field.
function readPriceCents(m: KalshiMarket, dollarsKey: string, centsKey: string): number | null {
  return extractCents(getPrice(m, dollarsKey), 'dollars')
      ?? extractCents(getPrice(m, centsKey), 'cents');
}

// Contracts fillable at the quoted price. Fractional sizes below one contract floor to
// 0, which is not a tradeable depth — report undefined rather than a zero that reads
// like a real number ("Max fill ~$0.00", $0 Kelly suggestion).
function parseFp(v: number | string | undefined): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return undefined;
  const floored = Math.floor(n);
  return floored >= 1 ? floored : undefined;
}

// A quoted two-sided book. Both asks must be present, and their sum must be plausible.
//
// The upper bound used to be 105, which silently discarded every market with a WIDE book —
// and books widen the further out a game is. Measured across all open game markets: the ask
// sum has p50 103 but p90 162 for college football and 156 for MLS, with a maximum of 180.
// Those are real two-sided quotes, not broken data: not one market anywhere was missing an
// ask, and not one summed below 95. The 105 cap was throwing away 189 college-football, 45
// soccer and 13 baseball markets, which is why 88 of the 115 college games ten days out
// could not be paired at all.
//
// A wide book does not make an arbitrage fake. Both numbers are genuine asks, so if the two
// legs sum below 100 the profit is real; the risk is depth, which maxContracts and the
// pre-order revalidation handle. The lower bound stays: a sum under 95 would be an arb
// inside a single venue, which cannot persist and therefore means bad data.
function readAsks(m: KalshiMarket): { yes: number; no: number } | null {
  const yes = readPriceCents(m, 'yes_ask_dollars', 'yes_ask');
  const no = readPriceCents(m, 'no_ask_dollars', 'no_ask');
  if (!yes || !no || yes + no > 200 || yes + no < 95) return null;
  return { yes, no };
}

// ─── fast price refresh ──────────────────────────────────────────────────────
// Re-quoting the markets we already matched is far cheaper than rediscovering them:
// `?tickers=A,B,C` returns exactly the requested markets (~45 ms per batch), versus
// ~1 s to re-walk every series. Mutates the passed markets in place and returns how
// many were re-quoted. A market that fails to refresh keeps its previous price rather
// than being zeroed or dropped.
const KALSHI_TICKER_BATCH = 90;

// Single-market live quote, used to re-check a price immediately before an order goes
// out. One targeted request (~45 ms) rather than any re-walk of a series.
export async function getKalshiQuote(ticker: string): Promise<{ yes: number; no: number } | null> {
  const headers: Record<string, string> = {};
  const key = getKalshiApiKey();
  if (key) headers['KALSHI-ACCESS-KEY'] = key;
  try {
    const res = await kalshiFetch(`${KALSHI_API_BASE}/markets?limit=1&tickers=${encodeURIComponent(ticker)}`, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as KalshiMarketsResponse;
    const m = (data.markets ?? []).find(x => x.ticker === ticker);
    return m ? readAsks(m) : null;
  } catch {
    return null;
  }
}

// The full resting book for one market, for sizing. The market list only reports the size
// at the BEST price, which is a fraction of what is fillable — a market showing 10,961 at
// the top had 26,709 available within a cent. Returns Kalshi's raw ladders; convert with
// kalshiAskLadder(), which mirrors them into buy-side prices.
export async function getKalshiOrderbook(
  ticker: string,
): Promise<{ yes_dollars?: [string, string][]; no_dollars?: [string, string][] } | null> {
  const headers: Record<string, string> = {};
  const key = getKalshiApiKey();
  if (key) headers['KALSHI-ACCESS-KEY'] = key;
  try {
    const res = await kalshiFetch(
      `${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}/orderbook`,
      { headers },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
    };
    return data.orderbook_fp ?? null;
  } catch {
    return null;
  }
}

export async function refreshKalshiPrices(markets: UnifiedMarket[]): Promise<number> {
  const bySymbol = new Map<string, UnifiedMarket[]>();
  for (const m of markets) {
    if (!m.symbol) continue;
    const list = bySymbol.get(m.symbol) ?? [];
    list.push(m);
    bySymbol.set(m.symbol, list);
  }
  const tickers = [...bySymbol.keys()];
  if (tickers.length === 0) return 0;

  const headers: Record<string, string> = {};
  const key = getKalshiApiKey();
  if (key) headers['KALSHI-ACCESS-KEY'] = key;

  let updated = 0;
  const batches: string[][] = [];
  for (let i = 0; i < tickers.length; i += KALSHI_TICKER_BATCH) {
    batches.push(tickers.slice(i, i + KALSHI_TICKER_BATCH));
  }
  await Promise.all(batches.map(async (chunk) => {
    try {
      const url = `${KALSHI_API_BASE}/markets?limit=${chunk.length}&tickers=${encodeURIComponent(chunk.join(','))}`;
      const res = await kalshiFetch(url, { headers });
      if (!res.ok) return;
      const data = (await res.json()) as KalshiMarketsResponse;
      for (const raw of data.markets ?? []) {
        if (typeof raw.ticker !== 'string') continue;
        const targets = bySymbol.get(raw.ticker);
        if (!targets) continue;
        const asks = readAsks(raw);
        if (!asks) continue; // unquotable right now — keep the last good price
        for (const t of targets) {
          t.yesPriceCents = asks.yes;
          t.noPriceCents = asks.no;
          t.yesDepth = parseFp(raw.yes_ask_size_fp);
          t.noDepth = parseFp(raw.yes_bid_size_fp);
        }
        updated++;
      }
    } catch { /* keep last good prices */ }
  }));
  return updated;
}

async function fetchKalshiMarketsPage(opts: {
  cursor?: string | null;
  seriesTicker?: string;
}): Promise<{ markets: KalshiMarket[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  params.set('status', 'open');
  params.set('limit', String(KALSHI_PAGE_LIMIT));
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.seriesTicker) params.set('series_ticker', opts.seriesTicker);

  const headers: Record<string, string> = {};
  const key = getKalshiApiKey();
  if (key) headers['KALSHI-ACCESS-KEY'] = key;

  let lastError: Error | null = null;
  // Up to 4 attempts with exponential backoff — politics fans out to ~34 series and
  // Kalshi rate-limits bursts. Dropping a series here means an entire state's races
  // silently vanish from matching, so retry generously.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await kalshiFetch(`${KALSHI_API_BASE}/markets?${params.toString()}`, { headers });
    if (res.status === 429) {
      lastError = new Error('Kalshi API: 429 too many requests');
      // Jitter: without it every rate-limited series retries on the same schedule and
      // re-collides, which is how a burst survived all four attempts.
      await delay(600 * 2 ** attempt + Math.random() * 400);
      continue;
    }
    if (!res.ok) throw new Error(`Kalshi API: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as KalshiMarketsResponse;
    const binary = (data.markets ?? []).filter(m => {
      const mt = m.market_type;
      return !mt || (mt !== 'scalar' && mt !== 'multivariate');
    });
    const nextCursor = data.cursor != null && String(data.cursor).length > 0 ? String(data.cursor) : null;
    return { markets: binary, nextCursor };
  }
  throw lastError ?? new Error('Kalshi API: failed after retry');
}

// ─── series → URL subtitle ───────────────────────────────────────────────────
// A Kalshi market page is /markets/{series}/{subtitle}/{event_ticker}, where the
// subtitle is the series TITLE slugified ("Professional Baseball Game" ->
// professional-baseball-game). Fetch it from /series/{ticker} rather than hardcoding:
// a hand-written guess is exactly how the soccer links ended up wrong
// ("mls-soccer-game" when the real title is "Major League Soccer Game"). Titles are
// static, so one fetch per series per process is enough.
const _seriesSubtitle = new Map<string, string>();

function slugifyTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function loadSeriesSubtitle(seriesTicker: string): Promise<void> {
  const key = seriesTicker.toUpperCase();
  if (_seriesSubtitle.has(key)) return;
  try {
    const headers: Record<string, string> = {};
    const apiKey = getKalshiApiKey();
    if (apiKey) headers['KALSHI-ACCESS-KEY'] = apiKey;
    const res = await kalshiFetch(`${KALSHI_API_BASE}/series/${encodeURIComponent(key)}`, { headers });
    if (!res.ok) return;
    const data = (await res.json()) as { series?: { title?: string } };
    const title = data.series?.title;
    if (typeof title === 'string' && title.trim()) _seriesSubtitle.set(key, slugifyTitle(title));
  } catch { /* fall back to the static map */ }
}

const MONTH_ABBR: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

// Extracts the actual game date from tickers like KXWCGAME-26JUN25TURUSA-USA.
// Kalshi uses tournament end date as close_time for soccer (e.g. July 11 for WC final),
// so we must read the date embedded in the ticker instead.
function parseKalshiGameDate(ticker: string): string | null {
  const m = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return null;
  const mm = MONTH_ABBR[m[2].toUpperCase()];
  return mm ? `20${m[1]}-${mm}-${m[3]}` : null;
}

async function paginateKalshi(seriesTicker?: string): Promise<KalshiMarket[]> {
  const all: KalshiMarket[] = [];
  let cursor: string | null = null;
  let isFirstPage = true;
  let pageCount = 0;
  do {
    if (!isFirstPage) await delay(KALSHI_PAGE_DELAY_MS);
    isFirstPage = false;
    if (pageCount >= KALSHI_MAX_PAGES) break;
    const { markets, nextCursor } = await fetchKalshiMarketsPage({ cursor, seriesTicker });
    all.push(...markets);
    cursor = nextCursor;
    pageCount++;
  } while (cursor != null);
  return all;
}

// Kalshi politics titles are already rich, e.g. "Will Republicans win the Senate
// race in Texas?" — they carry party + chamber + state. We only append the election
// year (encoded in the ticker, e.g. SENATETX-26 → 2026 or CONTROLS-2026) so the
// structured matcher can keep the 2026 race distinct from the 2028 one.
function politicsYearFromTicker(ticker: string): string | null {
  const m = ticker.match(/-(\d{4}|\d{2})(?:\D|$)/);
  if (!m) return null;
  return m[1].length === 4 ? m[1] : `20${m[1]}`;
}

function buildKalshiPoliticsQuestion(m: KalshiMarket): string {
  const base = (m.title && m.title.trim().length > 1)
    ? m.title.trim()
    : (typeof m.subtitle === 'string' && m.subtitle.trim() ? m.subtitle.trim() : m.ticker);
  const year = politicsYearFromTicker(m.event_ticker ?? m.ticker);
  return year ? `${base} ${year}` : base;
}

// Kalshi URL format: /markets/{series}/{subtitle}/{event_ticker}
// The Kalshi markets API does not return the subtitle field, so we hardcode it per series.
// Fallback only — the live series title (fetched above) wins when available. Values
// here are the slugified real titles, verified against /series.
const SERIES_SUBTITLE: Record<string, string> = {
  KXMLBGAME:   'professional-baseball-game',
  KXNFLGAME:   'professional-football-game',
  KXNCAAFGAME: 'college-football-game',
  KXMLSGAME:   'major-league-soccer-game',
  KXEPLGAME:   'english-premier-league-game',
  KXWCGAME:    'fifa-world-cup-game',
};

function kalshiMarketUrl(m: KalshiMarket): string {
  // Both fields are untrusted API data — fall back rather than assume a string.
  const eventTicker = (typeof m.event_ticker === 'string' && m.event_ticker)
    || (typeof m.ticker === 'string' && m.ticker)
    || '';
  if (!eventTicker) return 'https://kalshi.com/markets';
  const seriesKey = eventTicker.split('-')[0].toUpperCase();
  const series = seriesKey.toLowerCase();
  const event = eventTicker.toLowerCase();
  // Politics subtitles arrive as "Democratic party:: Democratic party" — keep the
  // part before '::' so the URL slug isn't doubled.
  const rawSubtitle = typeof m.subtitle === 'string' ? m.subtitle.split('::')[0].trim() : '';
  const subtitle = rawSubtitle
    ? slugifyTitle(rawSubtitle)
    : _seriesSubtitle.get(seriesKey) ?? SERIES_SUBTITLE[seriesKey] ?? null;
  return subtitle
    ? `https://kalshi.com/markets/${series}/${subtitle}/${event}`
    : `https://kalshi.com/markets/${series}/${event}`;
}

export function normalizeKalshiMarkets(markets: KalshiMarket[], category?: Category): UnifiedMarket[] {
  const isSportCat = isSportCategory(category);

  // Kalshi titles game markets one team at a time ("Vancouver wins", "San Diego FC wins"),
  // which names only ONE side of the matchup. Matching a half-named game against a
  // Polymarket "A vs B" market can only compare a single team, and a generic club word
  // ("FC") is then enough to pair completely unrelated fixtures — that is how
  // "San Diego FC wins" matched "FC Schalke 04 vs FC Bayern München".
  // Both teams are recoverable: every market in an event carries its own team in
  // yes_sub_title, so collect them per event and restate the full matchup below.
  //
  // Each team is written as "Name (CODE)". The code matters: Kalshi shortens shared-city
  // clubs to "New York G" / "New York J" and the distinguishing letter is a single
  // character that tokenising drops, leaving the two indistinguishable. The ticker
  // suffix (NYG / NYJ, LAR / LAC) is the only token that separates them.
  const teamsByEvent = new Map<string, string[]>();
  if (isSportCat) {
    for (const m of markets) {
      const et = typeof m.event_ticker === 'string' ? m.event_ticker : '';
      const sub = typeof m.yes_sub_title === 'string' ? m.yes_sub_title.trim() : '';
      if (!et || !sub || typeof m.ticker !== 'string') continue;
      if (/^(tie|draw)$/i.test(sub)) continue; // draw contract is not a team
      const code = m.ticker.toUpperCase().startsWith(`${et.toUpperCase()}-`)
        ? m.ticker.slice(et.length + 1)
        : '';
      const label = code ? `${sub} (${code})` : sub;
      const teams = teamsByEvent.get(et) ?? [];
      if (!teams.includes(label)) teams.push(label);
      teamsByEvent.set(et, teams);
    }
  }

  const result: UnifiedMarket[] = [];
  for (const m of markets) {
    // A market with no ticker is unusable (it's the order key and the URL/date source)
    // and previously crashed the whole build below, 500-ing the opportunities endpoint.
    if (typeof m.ticker !== 'string' || m.ticker.length === 0) continue;
    if (m.ticker.includes('KXMV') || m.market_type === 'scalar') continue;

    // Executable BUY price is the ASK on each side. Never fall back to the bid or
    // synthesize the complement (100 − other side): buying at the bid is not fillable
    // and fabricates phantom arbs. A market missing either ask isn't tradeable → skip.
    // Executable BUY price is the ASK on each side; a real two-sided book's asks sum
    // near 100. Shared with the fast reprice path so both accept the same quotes.
    const asks = readAsks(m);
    if (!asks) continue;
    const yesCents = asks.yes;
    const noCents = asks.no;

    // Use event_ticker for date extraction — it encodes the actual game date in the URL
    // (e.g. KXMLBGAME-26JUL061410PHIKC). The market ticker (m.ticker) may carry a
    // -Y/-N suffix or a stale date from when the contract was originally created.
    // Treat event_ticker as untrusted: the API could return a non-string.
    const eventTicker = typeof m.event_ticker === 'string' ? m.event_ticker : '';
    const gameDate = parseKalshiGameDate(eventTicker || m.ticker);

    // Sports game markets share one title per game ("Toronto vs San Diego Winner?");
    // which team YES pays on lives only in the ticker suffix (-TOR) and yes_sub_title
    // ("Toronto"). Capture both so alignment can be done by identity, not price.
    let yesTeam: string | undefined;
    if (isSportCat) {
      const code = eventTicker && m.ticker.toUpperCase().startsWith(`${eventTicker.toUpperCase()}-`)
        ? m.ticker.slice(eventTicker.length + 1)
        : '';
      const sub = typeof m.yes_sub_title === 'string' ? m.yes_sub_title : '';
      yesTeam = `${code} ${sub}`.trim() || undefined;
    }

    // Restate a one-sided game title as the full matchup so matching compares BOTH
    // teams (the same "A vs B Winner?" shape MLB already uses). Falls back to the raw
    // title when an event didn't yield exactly two teams.
    let question: string;
    if (category === 'politics') {
      question = buildKalshiPoliticsQuestion(m);
    } else {
      const rawTitle = m.title ?? m.subtitle ?? m.ticker ?? '';
      const teams = isSportCat ? teamsByEvent.get(eventTicker) : undefined;
      question = (teams && teams.length === 2)
        ? `${teams[0]} vs ${teams[1]} Winner?`
        : rawTitle;
    }

    result.push({
      id: `kalshi-${m.ticker}`,
      venue: 'kalshi',
      question,
      symbol: m.ticker,
      yesPriceCents: yesCents,
      noPriceCents: noCents,
      resolutionTime: gameDate ? `${gameDate}T23:59:00Z` : (m.close_time ?? m.expiration_time),
      url: kalshiMarketUrl(m),
      category,
      yesTeam,
      yesDepth: parseFp(m.yes_ask_size_fp),
      noDepth: parseFp(m.yes_bid_size_fp),
      // Kalshi keeps a game market `active` while it is being played and settles it only
      // once a winner is declared, so this is the liveness signal — not the game date.
      tradeable: m.status === undefined || m.status === 'active' || m.status === 'open',
    });
  }
  return result;
}

// Explicit series tickers to try per category. The API requires series_ticker to return
// sports markets — an unfiltered request returns only election markets.
// Multiple series are tried in parallel; empty/missing series return [] gracefully.
const CATEGORY_SERIES: Record<Category, string[]> = {
  mlb: ['KXMLBGAME'],
  // Game moneylines only. Deliberately NOT KXNFLSPREAD (point spreads), KXNCAAF1H
  // (first-half winner) or KXNCAAF (season-long national championship) — none of those
  // resolve on the same event as a Polymarket game moneyline.
  nfl: ['KXNFLGAME'],
  cfb: ['KXNCAAFGAME'],
  soccer: [
    'KXWCGAME',   // World Cup games (2026)
    'KXWC',       // World Cup generic
    'KXWC2026',   // World Cup 2026 explicit
    'KXFIFAWC',   // FIFA World Cup
    'KXSOCCER',   // General soccer
    'KXMLSGAME',  // MLS games
    'KXMLS',      // MLS generic
    'KXEPL',      // English Premier League
    'KXUEFACL',   // UEFA Champions League
  ],
  politics: [
    // Senate control. (KXBALANCEPOWERCOMBO omitted — it's a House-AND-Senate combo
    // market with no clean 1:1 counterpart on Polymarket.)
    'CONTROLS',             // Which party wins the US Senate
    // 2026 Senate races — pattern: SENATE{2-letter-state}. All verified to return markets.
    'SENATETX', 'SENATEIA', 'SENATEAK', 'SENATEGA', 'SENATEMI', 'SENATEWI',
    'SENATEMT', 'SENATEME', 'SENATENJ', 'SENATENH', 'SENATECO', 'SENATENM',
    'SENATENC', 'SENATEOR', 'SENATEIL', 'SENATEMD', 'SENATEVA', 'SENATENV',
    'SENATEDE', 'SENATELA', 'SENATEAL', 'SENATEAR', 'SENATEID', 'SENATEKS',
    'SENATEMN', 'SENATESC', 'SENATEMA', 'SENATERI', 'SENATEWV', 'SENATEOK',
    'SENATETN', 'SENATEMS', 'SENATENE',
  ],
};

export async function getKalshiMarketsForAllCategories(): Promise<Map<Category, UnifiedMarket[]>> {
  const result = new Map<Category, UnifiedMarket[]>();

  await Promise.all(
    (Object.entries(CATEGORY_SERIES) as [Category, string[]][]).map(async ([cat, seriesList]) => {
      // Fetch in batches of KALSHI_SERIES_BATCH concurrently rather than one-by-one.
      // Politics has 26 series; batching 4 at a time drops it from ~12 s to ~2 s.
      // Sports links need the series title for their URL slug; load it alongside the
      // markets (cached, so this is a no-op after the first pass).
      if (isSportCategory(cat)) {
        await Promise.all(seriesList.map(s => loadSeriesSubtitle(s)));
      }

      const raw: KalshiMarket[] = [];
      for (let i = 0; i < seriesList.length; i += KALSHI_SERIES_BATCH) {
        const batch = seriesList.slice(i, i + KALSHI_SERIES_BATCH);
        const batchResults = await Promise.all(
          batch.map(s => paginateKalshi(s).catch((err: Error) => {
            console.error(`[Kalshi] ${cat}/${s}: ${err.message}`);
            return [] as KalshiMarket[];
          }))
        );
        raw.push(...batchResults.flat());
        if (i + KALSHI_SERIES_BATCH < seriesList.length) await delay(KALSHI_BATCH_DELAY_MS);
      }

      // Deduplicate by ticker across series
      const seen = new Set<string>();
      const deduped = raw.filter(m => {
        if (seen.has(m.ticker)) return false;
        seen.add(m.ticker);
        return true;
      });

      console.log(`[Kalshi] ${cat}: ${deduped.length} raw markets`);
      if (deduped.length === 0) return;   // handled by the last-good fallback below

      const normalized = normalizeKalshiMarkets(deduped, cat);
      const pattern = KALSHI_MONEYLINE_PATTERN[cat];

      let filtered: UnifiedMarket[];
      if (cat === 'politics') {
        filtered = normalized.filter(
          m => !m.resolutionTime || Date.parse(m.resolutionTime) > Date.now()
        );
      } else if (pattern) {
        filtered = normalized.filter(m => pattern.test(m.symbol?.toUpperCase() ?? ''));
        // Drop tie/draw contracts (ticker suffix -TIE) in every sport, not just soccer:
        // the Polymarket side only keeps two-outcome team moneylines, so a draw contract
        // is a third outcome that must never be paired against one. NFL games can tie
        // too, so this can't be soccer-only.
        filtered = filtered.filter(m =>
          !/-TIE$/i.test(m.symbol ?? '') && !/\b(tie|draw)\b/i.test(m.question)
        );
      } else {
        filtered = normalized;
      }

      console.log(`[Kalshi] ${cat}: ${filtered.length} markets after filter`);
      if (filtered.length > 0) {
        result.set(cat, filtered);
        _lastGoodByCategory.set(cat, filtered);
      }
    })
  );

  // Restore any category this pass failed to fetch, so a transient outage degrades to
  // slightly stale prices rather than silently removing the sport entirely.
  for (const [cat, markets] of _lastGoodByCategory) {
    if (!result.has(cat)) {
      console.warn(`[Kalshi] ${cat}: fetch returned nothing — reusing ${markets.length} markets from the last good pass`);
      result.set(cat, markets);
    }
  }

  return result;
}
