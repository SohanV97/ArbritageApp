import { NextResponse } from 'next/server';
import {
  getAutoExecConfig,
  setAutoExecConfig,
  getAutoExecRecords,
  type AutoExecConfig,
} from '@/lib/autoExec';

// The browser owns the settings and pushes them here; the refresh loop reads them and does
// the trading, because it already holds the freshest books. GET is how the browser learns
// what the loop has done while it was not the one deciding.
export async function GET(): Promise<Response> {
  return NextResponse.json({ config: getAutoExecConfig(), records: getAutoExecRecords() });
}

export async function POST(request: Request): Promise<Response> {
  let patch: Partial<AutoExecConfig>;
  try {
    patch = await request.json() as Partial<AutoExecConfig>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 });
  }
  const config = setAutoExecConfig(patch);
  console.log('[autoexec] config', JSON.stringify(config));
  return NextResponse.json({ config, records: getAutoExecRecords() });
}
