import { NextResponse } from 'next/server';
import { startEngine, getServablePayload } from '@/server/engine';
import type { OpportunitiesResponse } from '@/lib/contracts';

// The engine itself now lives in server/engine.ts so it can be hosted by a standalone
// process. This route is one of two possible hosts for it; nothing here decides anything
// about discovery, pricing or trading.
//
// Starting on module load preserves today's behaviour exactly. It is temporary: once the
// standalone service owns the engine, ONLY ONE process may run it — two would mean two
// refresh loops, two auto-exec mutexes and two cooldown maps, and the same pair bought twice.
void startEngine();

// Re-exported so existing importers keep working while the wire types move to lib/contracts.
export type { PairInfo, OpportunitiesResponse } from '@/lib/contracts';

// Never let a browser or proxy serve a cached copy: quotes go stale in seconds, and an
// HTTP-cached response made pressing Refresh look like nothing had changed because the
// request never reached the server.
const cacheHeaders = { 'Cache-Control': 'no-store, max-age=0' };

// No `revalidate` export: that would opt this GET handler into static/ISR caching and bake
// responses at build time. Left dynamic (the Next 16 default).
export async function GET(request: Request): Promise<Response> {
  let forceFresh = false;
  let withPairs = false;
  try {
    const params = new URL(request.url).searchParams;
    forceFresh = params.get('fresh') === '1';
    // pairsDetail is opt-in: it is 93% of the bytes and only the Matched Pairs tab renders it.
    withPairs = params.get('pairs') === '1';
  } catch { /* malformed URL: defaults stand */ }
  const acceptsGzip = /\bgzip\b/i.test(request.headers.get('accept-encoding') ?? '');

  const result = await getServablePayload({ forceFresh, acceptsGzip, withPairs });

  if (result.kind === 'warming') {
    // Cold start: answer immediately rather than holding the connection open for a full
    // discovery. 200, not 503, so the client's normal render path handles it.
    return NextResponse.json({
      opportunities: [],
      pairsDetail: [],
      stats: {
        pmMarkets: 0, kalshiMarkets: 0, matchedPairs: 0, byCategory: {},
        fetchedAt: new Date().toISOString(),
      },
      warming: true,
    } satisfies OpportunitiesResponse, { headers: cacheHeaders });
  }

  if (result.kind === 'error') {
    console.error('[/api/opportunities]', result.message);
    return NextResponse.json({
      opportunities: [],
      pairsDetail: [],
      stats: {
        pmMarkets: 0, kalshiMarkets: 0, matchedPairs: 0, byCategory: {},
        fetchedAt: new Date().toISOString(),
      },
      error: result.message,
    } satisfies OpportunitiesResponse, { status: 500, headers: cacheHeaders });
  }

  if (acceptsGzip && result.gzip) {
    return new Response(new Uint8Array(result.gzip), {
      headers: {
        ...cacheHeaders,
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
      },
    });
  }
  return new Response(result.json, {
    headers: { ...cacheHeaders, 'Content-Type': 'application/json', 'Vary': 'Accept-Encoding' },
  });
}
