import type { UnifiedMarket, Category } from '@/lib/market-types';
import { KALSHI_MONEYLINE_PATTERN } from '@/lib/categories';

const KALSHI_API_BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const KALSHI_PAGE_LIMIT = 200;    // request 200/page (API may cap at 100)
const KALSHI_PAGE_DELAY_MS = 50;  // between pages of the same series
const KALSHI_MAX_PAGES = 3;       // up to 600 markets; MLB alone can have 200+ open games
const KALSHI_SERIES_BATCH = 4;    // 4 concurrent — keeps politics (34 series) under the rate limit
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
    const res = await fetch(`${KALSHI_API_BASE}/markets?${params.toString()}`, { headers });
    if (res.status === 429) {
      lastError = new Error('Kalshi API: 429 too many requests');
      await delay(600 * 2 ** attempt); // 600 → 1200 → 2400 → 4800 ms
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
const SERIES_SUBTITLE: Record<string, string> = {
  KXMLBGAME:  'professional-baseball-game',
  KXWCGAME:   'fifa-world-cup-game',
  KXMLSGAME:  'mls-soccer-game',
  KXEPLGAME:  'premier-league-game',
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
    ? rawSubtitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : SERIES_SUBTITLE[seriesKey] ?? null;
  return subtitle
    ? `https://kalshi.com/markets/${series}/${subtitle}/${event}`
    : `https://kalshi.com/markets/${series}/${event}`;
}

export function normalizeKalshiMarkets(markets: KalshiMarket[], category?: Category): UnifiedMarket[] {
  const result: UnifiedMarket[] = [];
  for (const m of markets) {
    // A market with no ticker is unusable (it's the order key and the URL/date source)
    // and previously crashed the whole build below, 500-ing the opportunities endpoint.
    if (typeof m.ticker !== 'string' || m.ticker.length === 0) continue;
    if (m.ticker.includes('KXMV') || m.market_type === 'scalar') continue;

    // Executable BUY price is the ASK on each side. Never fall back to the bid or
    // synthesize the complement (100 − other side): buying at the bid is not fillable
    // and fabricates phantom arbs. A market missing either ask isn't tradeable → skip.
    const yesCents = readPriceCents(m, 'yes_ask_dollars', 'yes_ask');
    const noCents = readPriceCents(m, 'no_ask_dollars', 'no_ask');
    // A real two-sided book's asks sum to ≥100 (the overround). A sum well below 100
    // means a stale/crossed quote — reject it rather than surface an impossible price.
    if (!yesCents || !noCents || yesCents + noCents > 105 || yesCents + noCents < 95) continue;

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
    if (category === 'mlb' || category === 'soccer') {
      const code = eventTicker && m.ticker.toUpperCase().startsWith(`${eventTicker.toUpperCase()}-`)
        ? m.ticker.slice(eventTicker.length + 1)
        : '';
      const sub = typeof m.yes_sub_title === 'string' ? m.yes_sub_title : '';
      yesTeam = `${code} ${sub}`.trim() || undefined;
    }

    // Contracts fillable at the quoted prices. Kalshi's book is unified: a NO buy
    // fills against the YES bid, so NO-side depth is the YES bid size.
    // Fractional sizes below one contract floor to 0, which is not a tradeable depth —
    // it surfaced as "Max fill ~$0.00" and a $0 Kelly suggestion. Report undefined
    // (unknown/none) rather than a zero that reads like a real number.
    const parseFp = (v: number | string | undefined): number | undefined => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
      if (!Number.isFinite(n) || n < 1) return undefined;
      const floored = Math.floor(n);
      return floored >= 1 ? floored : undefined;
    };

    result.push({
      id: `kalshi-${m.ticker}`,
      venue: 'kalshi',
      question: category === 'politics'
        ? buildKalshiPoliticsQuestion(m)
        : (m.title ?? m.subtitle ?? m.ticker ?? ''),
      symbol: m.ticker,
      yesPriceCents: yesCents,
      noPriceCents: noCents,
      resolutionTime: gameDate ? `${gameDate}T23:59:00Z` : (m.close_time ?? m.expiration_time),
      url: kalshiMarketUrl(m),
      category,
      yesTeam,
      yesDepth: parseFp(m.yes_ask_size_fp),
      noDepth: parseFp(m.yes_bid_size_fp),
    });
  }
  return result;
}

// Explicit series tickers to try per category. The API requires series_ticker to return
// sports markets — an unfiltered request returns only election markets.
// Multiple series are tried in parallel; empty/missing series return [] gracefully.
const CATEGORY_SERIES: Record<Category, string[]> = {
  mlb: ['KXMLBGAME'],
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
      if (deduped.length === 0) return;

      const normalized = normalizeKalshiMarkets(deduped, cat);
      const pattern = KALSHI_MONEYLINE_PATTERN[cat];

      let filtered: UnifiedMarket[];
      if (cat === 'politics') {
        filtered = normalized.filter(
          m => !m.resolutionTime || Date.parse(m.resolutionTime) > Date.now()
        );
      } else if (pattern) {
        filtered = normalized.filter(m => pattern.test(m.symbol?.toUpperCase() ?? ''));
        if (cat === 'soccer') {
          // Drop tie/draw contracts (ticker suffix -TIE) — the PM side only keeps
          // team moneylines, and a tie market must never pair against one.
          filtered = filtered.filter(m =>
            !/-TIE$/i.test(m.symbol ?? '') && !/\b(tie|draw)\b/i.test(m.question)
          );
        }
      } else {
        filtered = normalized;
      }

      console.log(`[Kalshi] ${cat}: ${filtered.length} markets after filter`);
      if (filtered.length > 0) result.set(cat, filtered);
    })
  );

  return result;
}
