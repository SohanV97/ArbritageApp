/**
 * The standalone engine process.
 *
 * Runs discovery, pricing, the websocket feeds and — once Stage 6 flips it on — the order
 * path, in a process that does nothing else. That is the whole point: the trading loop
 * previously shared a heap with page rendering, HMR and request serving, and a blocked event
 * loop there meant a trade decided seconds after the prices that justified it.
 *
 * Deliberately `node:http` rather than a framework. Six endpoints do not justify one, and
 * every dependency inside the process that signs orders is a liability.
 *
 * Bound to 127.0.0.1 explicitly. POST /execute has no authentication and spends real money;
 * it must not be reachable from anything but this machine.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadEnv } from './loadEnv';

// Before ANY module that reads process.env at import time.
const env = loadEnv();
console.log(`[engine] loaded ${env.loaded.length} vars from ${env.path}` +
  (env.skipped.length ? ` (${env.skipped.length} already set in the environment)` : ''));

const { startEngine, stopEngine, getServablePayload, getSnapshotBody, engineHealth } =
  await import('./engine');

const PORT = Number(process.env.ARB_ENGINE_PORT ?? 4311);
const HOST = '127.0.0.1';
// The UI runs under Next on another port, so it is cross-origin. Exact allowlist, not '*':
// this origin can POST orders.
const ALLOWED_ORIGIN = process.env.ARB_UI_ORIGIN ?? 'http://localhost:3000';

const json = (res: ServerResponse, status: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  });
  res.end(s);
};

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let data = '';
  // A trading endpoint should not accept an unbounded body.
  req.on('data', chunk => {
    data += chunk;
    if (data.length > 2_000_000) { reject(new Error('request body too large')); req.destroy(); }
  });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return void res.end();
  }

  if (path === '/health' || path === '/api/health') {
    return json(res, 200, {
      ok: true,
      tradingEnabled: process.env.ARB_TRADING_ENABLED !== 'false',
      allowedOrigin: ALLOWED_ORIGIN,
      ...engineHealth(),
    });
  }

  if ((path === '/snapshot' || path === '/api/opportunities') && req.method === 'GET') {
    const acceptsGzip = /\bgzip\b/i.test(req.headers['accept-encoding'] as string ?? '');
    const result = await getServablePayload({
      forceFresh: url.searchParams.get('fresh') === '1',
      acceptsGzip,
      withPairs: url.searchParams.get('pairs') === '1',
    });
    if (result.kind === 'warming') {
      return json(res, 200, {
        opportunities: [], pairsDetail: [],
        stats: { pmMarkets: 0, kalshiMarkets: 0, matchedPairs: 0, byCategory: {}, fetchedAt: new Date().toISOString() },
        warming: true,
      });
    }
    if (result.kind === 'error') return json(res, 500, { error: result.message });
    if (acceptsGzip && result.gzip) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Cache-Control': 'no-store, max-age=0',
        'Vary': 'Accept-Encoding',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      });
      return void res.end(result.gzip);
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, max-age=0',
      'Vary': 'Accept-Encoding',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    });
    return void res.end(result.json);
  }

  // A reliable way to stop, because on Windows signals are not one.
  //
  // Verified: process.kill(pid, 'SIGINT') from another process terminates this one WITHOUT
  // delivering the signal, so the drain never runs — and the drain is what prevents a
  // half-executed trade being abandoned between the Polymarket fill and the Kalshi leg.
  // Ctrl+C in the owning terminal does deliver, but nothing else does: not a script, not a
  // supervisor, not closing the window. This endpoint is the dependable path, and it is
  // safe to expose because the socket is bound to 127.0.0.1 and stopping is not destructive.
  if (path === '/shutdown' && req.method === 'POST') {
    json(res, 200, { stopping: true });
    setTimeout(() => void shutdown('POST /shutdown'), 10);
    return;
  }

  // Book health. These are how a corrupted feed is caught before it prices an order, so
  // they belong with the engine rather than with the UI that used to host them.
  if (path === '/diag/books' && req.method === 'GET') {
    const { getLiveKalshiBook, liveBookStats, liveKalshiTickers } = await import('@/lib/liveBooks');
    const { kalshiBidLadder } = await import('@/lib/depth');
    const ticker = url.searchParams.get('ticker');
    if (ticker) {
      const live = getLiveKalshiBook(ticker);
      const norm = (l?: [string, string][]) =>
        Object.fromEntries((l ?? []).map(([p, q]) => [Number(p).toFixed(4), Number(q)]));
      return json(res, 200, { ticker, haveLive: !!live, yes: norm(live?.yes_dollars), no: norm(live?.no_dollars) });
    }
    // A book whose two best bids sum above 100 is not a market, it is corrupted state.
    const crossed: { ticker: string; yesBid: number; noBid: number }[] = [];
    let checked = 0;
    for (const t of liveKalshiTickers()) {
      const b = getLiveKalshiBook(t);
      if (!b) continue;
      const yesBid = kalshiBidLadder(b, 'yes')[0]?.priceCents;
      const noBid = kalshiBidLadder(b, 'no')[0]?.priceCents;
      if (yesBid === undefined || noBid === undefined) continue;
      checked++;
      if (yesBid + noBid > 100) crossed.push({ ticker: t, yesBid, noBid });
    }
    return json(res, 200, { stats: liveBookStats(), checked, crossed: crossed.length, worst: crossed.slice(0, 10) });
  }

  if (path === '/debug/snapshot' && req.method === 'GET') {
    return json(res, 200, getSnapshotBody() ?? { warming: true });
  }

  json(res, 404, { error: `no route for ${req.method} ${path}` });
}

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[engine] request failed:', err);
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
});

// Start listening BEFORE the first build so the UI can connect and render its warming state
// immediately rather than waiting on a cold discovery.
server.listen(PORT, HOST, () => {
  console.log(`[engine] listening on http://${HOST}:${PORT}`);
  console.log(`[engine] trading ${process.env.ARB_TRADING_ENABLED === 'false' ? 'DISABLED' : 'ENABLED'}`);
  void startEngine().then(() => console.log('[engine] first build complete'));
});

// ─── shutdown ────────────────────────────────────────────────────────────────
// Ordered, because the window between the Polymarket fill and the Kalshi leg is exactly
// where a naked position is born. Closing a Windows terminal delivers no signal at all,
// hence SIGBREAK and the beforeExit belt-and-braces.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[engine] ${signal} — draining`);
  const hard = setTimeout(() => {
    console.error('[engine] drain exceeded 30s — exiting anyway');
    process.exit(1);
  }, 30_000);
  hard.unref?.();
  try {
    server.close();
    await stopEngine();
    console.log('[engine] stopped cleanly');
    clearTimeout(hard);
    process.exit(0);
  } catch (err) {
    console.error('[engine] shutdown error:', err);
    process.exit(1);
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) {
  process.on(sig, () => void shutdown(sig));
}

// Never die mid-order because of an unrelated rejection. Next swallowed these per-request;
// a bare process does not.
process.on('unhandledRejection', err => console.error('[engine] unhandled rejection:', err));
process.on('uncaughtException', err => console.error('[engine] uncaught exception:', err));
