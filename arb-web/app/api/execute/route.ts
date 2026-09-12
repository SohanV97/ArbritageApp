import { NextResponse } from 'next/server';
import type { KalshiAuthTest } from '@/api/kalshi-trading';
import { testKalshiAuth } from '@/api/kalshi-trading';
import type { PolymarketAuthTest } from '@/api/polymarket-trading';
import { testPolymarketAuth } from '@/api/polymarket-trading';
import { executeArb } from '@/api/tradeExecutor';
import type { ExecuteRequest } from '@/api/tradeExecutor';

// The order path itself lives in @/api/tradeExecutor so the refresh loop can run it without
// an HTTP round trip. This route is the manual entry point onto the same code.
export type { LegResult, ExecuteResponse } from '@/api/tradeExecutor';

export interface ConnectionTestResponse {
  kalshi: KalshiAuthTest;
  polymarket: PolymarketAuthTest;
  testedAt: string;
}

// GET = connection test. Verifies both venues' full auth path (key, signing, L2
// credential derivation, balance/allowance read) without placing any order.
export async function GET(): Promise<Response> {
  const [kalshi, polymarket] = await Promise.all([testKalshiAuth(), testPolymarketAuth()]);
  const body: ConnectionTestResponse = { kalshi, polymarket, testedAt: new Date().toISOString() };
  return NextResponse.json(body);
}

export async function POST(request: Request): Promise<Response> {
  let body: ExecuteRequest;
  try {
    body = await request.json() as ExecuteRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  // `JSON.parse` accepts "null", "[]" and bare scalars — destructuring those threw a
  // TypeError that escaped as an unshaped 500 the client could not render.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const { body: result, status } = await executeArb(body);
  return NextResponse.json(result, { status });
}
