import { NextResponse } from 'next/server';
import { getLiveKalshiBook, liveBookStats, liveKalshiTickers } from '@/lib/liveBooks';
import { getKalshiOrderbook } from '@/api/kalshi';
import { kalshiBidLadder, kalshiAskLadder } from '@/lib/depth';

/**
 * Health check for the pushed books, built around an invariant a real book cannot break:
 * the best YES bid and the best NO bid cannot sum above 100. If they do, the two sides are
 * crossed — someone would be paid to take both — which means the book is corrupted, not
 * merely stale.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ticker = url.searchParams.get('ticker');

  if (!ticker) {
    const bad: { ticker: string; yesBid: number; noBid: number; sum: number }[] = [];
    let checked = 0;
    for (const t of liveKalshiTickers()) {
      const b = getLiveKalshiBook(t);
      if (!b) continue;
      const yesBid = kalshiBidLadder(b, 'yes')[0]?.priceCents;
      const noBid = kalshiBidLadder(b, 'no')[0]?.priceCents;
      if (yesBid === undefined || noBid === undefined) continue;
      checked++;
      if (yesBid + noBid > 100) bad.push({ ticker: t, yesBid, noBid, sum: yesBid + noBid });
    }
    return NextResponse.json({ stats: liveBookStats(), checked, crossed: bad.length, worst: bad.slice(0, 10) });
  }

  const live = getLiveKalshiBook(ticker);
  const rest = await getKalshiOrderbook(ticker);
  const norm = (l?: [string, string][]) =>
    Object.fromEntries((l ?? []).map(([p, s]) => [Number(p).toFixed(4), Number(s)]));
  return NextResponse.json({
    ticker,
    liveYesBid: kalshiBidLadder(live, 'yes')[0] ?? null,
    liveNoBid: kalshiBidLadder(live, 'no')[0] ?? null,
    liveYesAsk: kalshiAskLadder(live, 'yes')[0] ?? null,
    restYesBid: kalshiBidLadder(rest, 'yes')[0] ?? null,
    restNoBid: kalshiBidLadder(rest, 'no')[0] ?? null,
    liveYes: norm(live?.yes_dollars), restYes: norm(rest?.yes_dollars),
    liveNo: norm(live?.no_dollars), restNo: norm(rest?.no_dollars),
  });
}
