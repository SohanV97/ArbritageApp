import { NextResponse } from 'next/server';
import { getLiveKalshiBook } from '@/lib/liveBooks';
import { getKalshiOrderbook } from '@/api/kalshi';

export async function GET(request: Request): Promise<Response> {
  const ticker = new URL(request.url).searchParams.get('ticker') ?? '';
  const live = getLiveKalshiBook(ticker);
  const rest = await getKalshiOrderbook(ticker);
  const norm = (l?: [string, string][]) =>
    Object.fromEntries((l ?? []).map(([p, s]) => [Number(p).toFixed(4), Number(s)]));
  return NextResponse.json({
    ticker,
    liveYes: norm(live?.yes_dollars), restYes: norm(rest?.yes_dollars),
    liveNo: norm(live?.no_dollars), restNo: norm(rest?.no_dollars),
  });
}
