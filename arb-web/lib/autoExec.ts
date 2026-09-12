/**
 * Server-side auto-execution state.
 *
 * Auto-execute used to live entirely in the browser: the server found an edge, cached it, the
 * client polled for it, then sent it back for the server to re-read the same books. Measured
 * end to end, the order landed 450-600ms after the prices that justified it, and most of that
 * was the round trip — the client poll alone is ~150ms, and the re-read another ~160ms.
 *
 * In-play edges do not last that long. Moving the decision to where the data already is cuts
 * both, so the loop can act on its own fetch instead of waiting to be told about it.
 *
 * The browser still owns the settings; it pushes them here. Critically, only ONE side may
 * execute — if both the loop and the browser fired, the same pair could be bought twice — so
 * whenever this is enabled the client stops firing and only renders what came back.
 */
import type { ExecuteResponse } from '@/api/tradeExecutor';

export interface AutoExecConfig {
  enabled: boolean;
  /** Minimum edge to act on, in percent. */
  thresholdPercent: number;
  /** Dollars to deploy across both legs combined. */
  riskDollars: number;
  /** 'sports' skips politics, which settle months out and lock capital. */
  scope: 'sports' | 'all';
  /**
   * Run the complete pre-order path and record what WOULD have been sent, without sending
   * it. The only way to learn why a run of executions never becomes a trade is to watch the
   * checks on live markets at the rate they actually fire, and the alternative is paying for
   * the answer one rejected order at a time.
   */
  dryRun?: boolean;
}

export interface AutoExecRecord {
  id: string;
  ts: string;
  question: string;
  edgePercent: number;
  amount: number;
  result: ExecuteResponse;
}

const DEFAULT_CONFIG: AutoExecConfig = {
  enabled: false,
  thresholdPercent: 1.5,
  riskDollars: 100,
  scope: 'sports',
  dryRun: false,
};

// Dev HMR re-evaluates modules, and a fresh module instance would silently forget that
// auto-execute is armed — or worse, forget which pairs it has already traded and buy one a
// second time. Pin the state to the process, exactly as the refresh loop pins its timer.
const STATE = Symbol.for('arb.autoExec.state');
interface State {
  config: AutoExecConfig;
  records: AutoExecRecord[];
  /** Pair key -> time it may be considered again. Prevents repeat-firing on one edge. */
  cooldown: Map<string, number>;
  busy: boolean;
}
type Host = { [STATE]?: State };

function state(): State {
  const host = globalThis as unknown as Host;
  if (!host[STATE]) {
    host[STATE] = { config: { ...DEFAULT_CONFIG }, records: [], cooldown: new Map(), busy: false };
  }
  return host[STATE];
}

export function getAutoExecConfig(): AutoExecConfig {
  return { ...state().config };
}

export function setAutoExecConfig(patch: Partial<AutoExecConfig>): AutoExecConfig {
  const s = state();
  const next: AutoExecConfig = { ...s.config };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (Number.isFinite(patch.thresholdPercent) && (patch.thresholdPercent as number) > 0) {
    next.thresholdPercent = patch.thresholdPercent as number;
  }
  if (Number.isFinite(patch.riskDollars) && (patch.riskDollars as number) > 0) {
    next.riskDollars = patch.riskDollars as number;
  }
  if (patch.scope === 'sports' || patch.scope === 'all') next.scope = patch.scope;
  if (typeof patch.dryRun === 'boolean') next.dryRun = patch.dryRun;
  s.config = next;
  return { ...next };
}

/** Newest first. The browser merges these into its execution log. */
export function getAutoExecRecords(): AutoExecRecord[] {
  return state().records;
}

export function addAutoExecRecord(r: AutoExecRecord): void {
  const s = state();
  s.records = [r, ...s.records].slice(0, 50);
}

/**
 * One execution at a time. Both legs of a trade are in flight for a few hundred ms, and a
 * second trade starting inside that window would size itself against a balance the first has
 * already committed.
 */
export function tryClaimExecution(): boolean {
  const s = state();
  if (s.busy) return false;
  s.busy = true;
  return true;
}

export function releaseExecution(): void {
  state().busy = false;
}

/**
 * Whether a pair may be traded now, and marking it as taken.
 *
 * Re-arm timing mirrors the browser's: a clean hedge rests for five minutes, while anything
 * that sent no orders comes back in ten seconds, because the edge often returns immediately
 * and nothing is at risk. A naked or partial fill is never re-armed automatically — it is an
 * open position, and firing a second order onto it is the last thing anyone wants.
 */
export function pairIsAvailable(key: string): boolean {
  const until = state().cooldown.get(key);
  return until === undefined || Date.now() >= until;
}

export function holdPair(key: string, ms: number): void {
  state().cooldown.set(key, Date.now() + ms);
}

export function releasePairAfter(key: string, result: ExecuteResponse): void {
  if (result.hedged) holdPair(key, 5 * 60_000);
  else if (result.noOrdersSent) holdPair(key, 10_000);
  else holdPair(key, Number.MAX_SAFE_INTEGER - Date.now());   // position at risk: never re-arm
}
