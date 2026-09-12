import { NextResponse } from 'next/server';
import { getLiveKalshiBook, getLivePolymarketBook, liveBookStats } from '@/lib/liveBooks';
import { getKalshiOrderbook } from '@/api/kalshi';
import { getPolymarketBooks } from '@/api/polymarket';
import { kalshiAskLadder, polymarketAskLadder } from '@/lib/depth';

/**
 * Does the websocket-maintained book agree with a fresh REST read?
 *
 * The order path prices legs off these books, so a wrongly applied delta is worse than a slow
 * fetch — it is a bad price on a real order. That has to be provable rather than assumed, and
 * the two sources drifting apart is the first thing to check if fills start looking wrong.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ticker = url.searchParams.get('ticker') ?? '';
  const token = url.searchParams.get('token') ?? '';
  const out: Record<string, unknown> = { stats: liveBookStats() };

  if (ticker) {
    const live = getLiveKalshiBook(ticker);
    const rest = await getKalshiOrderbook(ticker);
    out.kalshi = {
      haveLive: !!live,
      liveYes: live ? kalshiAskLadder(live, 'yes')[0] ?? null : null,
      restYes: kalshiAskLadder(rest, 'yes')[0] ?? null,
      liveNo: live ? kalshiAskLadder(live, 'no')[0] ?? null : null,
      restNo: kalshiAskLadder(rest, 'no')[0] ?? null,
    };
  }
  if (token) {
    const live = getLivePolymarketBook(token);
    const rest = (await getPolymarketBooks([token])).get(token);
    out.polymarket = {
      haveLive: !!live,
      liveYes: live ? polymarketAskLadder(live, 'yes')[0] ?? null : null,
      restYes: polymarketAskLadder(rest, 'yes')[0] ?? null,
      liveNo: live ? polymarketAskLadder(live, 'no')[0] ?? null : null,
      restNo: polymarketAskLadder(rest, 'no')[0] ?? null,
    };
  }
  return NextResponse.json(out);
}
