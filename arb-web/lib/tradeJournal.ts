/**
 * An append-only record of every execution attempt, successful or not.
 *
 * Every failure this app has had was diagnosed by hand-correlating five sources: the
 * in-memory execution records, the dev server log, Kalshi's fills endpoint, Kalshi's orders
 * endpoint, and Polymarket's positions API. That worked, but only because someone was
 * watching at the time and the process had not restarted. Most failures are not observed
 * live, and the evidence is gone by the time anyone asks.
 *
 * Several of those bugs were invisible in the app's own view of events and only appeared in
 * the venue's: Polymarket reported a fill of zero on an order that had filled, and Kalshi's
 * book showed depth of 2000 contracts where 501 existed. So this records BOTH what we
 * believed and, later, what the venue says actually happened, and treats a disagreement
 * between them as the finding rather than an error.
 *
 * Written as JSONL because it is appended from a hot path and read by scripts: one line per
 * attempt, no rewriting, no parse of the whole file to add to it, and a truncated final line
 * costs one record rather than the file.
 *
 * No path-alias imports: the analysis scripts load this directly under bare Node.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const JOURNAL_PATH = join(process.cwd(), 'data', 'trade-journal.jsonl');

/** What happened to the pair, as the app understood it at the time. */
export type AttemptOutcome =
  | 'hedged'        // both legs filled, sizes matched
  | 'partial'       // both filled, sizes differ
  | 'naked'         // one leg filled, the other did not
  | 'unwound'       // one leg filled and was closed back out
  | 'no-orders'     // refused before anything was sent
  | 'error';        // threw

export interface LegRecord {
  venue: 'kalshi' | 'polymarket';
  side: 'yes' | 'no';
  /** Limit we sent, in cents. */
  limitCents: number;
  requested: number;
  /** What the venue said at placement. */
  reportedFill: number;
  avgPriceCents?: number;
  status?: string;
  orderId?: string;
  ok: boolean;
  error?: string;
  /** Milliseconds from sending to the response landing. */
  ms: number;
}

export interface UnwindRecord {
  venue: 'kalshi' | 'polymarket';
  attempt: number;
  limitCents: number;
  offered: number;
  filled: number;
  ok: boolean;
  error?: string;
}

/** What the venue says happened, asked long enough afterwards to be settled. */
export interface Reconciliation {
  checkedAt: string;
  kalshiActualFill?: number;
  polymarketActualFill?: number;
  /** True when the venue disagrees with what we recorded at placement. */
  mismatch: boolean;
  note?: string;
}

export interface TradeAttempt {
  id: string;
  ts: string;
  /** Set when the attempt never sent an order. */
  refusedReason?: string;
  outcome: AttemptOutcome;

  market: {
    kalshiTicker: string;
    question: string;
    category?: string;
    kalshiSide: 'yes' | 'no';
    polymarketSide: 'yes' | 'no';
  };

  /** The edge as advertised, and as re-checked against live books immediately before ordering. */
  edge: {
    quotedPercent?: number;
    freshPercent?: number;
    /** Milliseconds spent re-quoting both venues. */
    revalidateMs?: number;
    /** "live/live", "live/fetch", ... — which side came from the websocket. */
    bookSource?: string;
    /**
     * The per-leg prices behind quotedPercent and freshPercent.
     *
     * Recorded even when the attempt is refused for a vanished edge, which is the case that
     * needs them most: an aborted attempt used to record the two totals and nothing else, so
     * "the edge went from +1.04% to -4.88%" could not be attributed to a leg without going
     * back to the venues by hand. The same pair aborting twice five minutes apart with
     * identical numbers is a disagreement between how the list prices and how the order path
     * prices, not a market that moved, and only the per-leg figures show which.
     */
    quotedKalCents?: number;
    quotedPmCents?: number;
    freshKalCents?: number;
    freshPmCents?: number;
    /** Size behind the quoted depth, and what the ladder said was there. */
    kalTopDepth?: number;
    pmTopDepth?: number;
  };

  /** The prices the decision was made from, so a bad fill can be traced to a bad book. */
  plan?: {
    plannedContracts: number;
    kalAtBookCents: number;
    pmAtBookCents: number;
    kalBufferCents: number;
    pmBufferCents: number;
    kalLimitCents: number;
    pmLimitCents: number;
    netEdgeCents: number;
    /** Depth the ladders claimed at those prices — the number an under-fill contradicts. */
    kalDepth?: number;
    pmDepth?: number;
  };

  legs: LegRecord[];
  unwind?: UnwindRecord[];
  reconciliation?: Reconciliation;

  /** Where the milliseconds went. Placement speed is the whole game, so it is measured. */
  timings?: {
    /** Time still spent waiting on the funding check after the books were read. */
    fundingWaitMs?: number;
  };

  /** Wall time from the start of executeArb to the response. */
  totalMs: number;
  dryRun?: boolean;
}

let _warnedOnce = false;
// Appends are chained so two attempts cannot interleave a line, and awaited by nobody.
let _writeQueue: Promise<void> = Promise.resolve();

/**
 * Append one attempt. Never throws, and never makes the caller wait.
 *
 * Deliberately asynchronous. The whole point of this app is to get an order out before the
 * price moves, and appendFileSync would put a disk write on the event loop at exactly the
 * moment that matters — paying real latency to record how much latency there was. A journal
 * that can slow a trade is worse than no journal.
 */
export function recordAttempt(attempt: TradeAttempt): void {
  const line = (() => {
    try { return JSON.stringify(attempt) + '\n'; } catch { return null; }
  })();
  if (line === null) return;
  _writeQueue = _writeQueue
    .then(async () => {
      const dir = dirname(JOURNAL_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await appendFile(JOURNAL_PATH, line, 'utf8');
    })
    .catch(err => {
      if (!_warnedOnce) {
        _warnedOnce = true;
        console.warn('[journal] could not write:', err instanceof Error ? err.message : String(err));
      }
    });
}

/** Wait for queued writes to land. For scripts and tests; the order path never calls it. */
export function flushJournal(): Promise<void> {
  return _writeQueue;
}
/** Every attempt on file, oldest first. A malformed line is skipped, not fatal. */
export function readAttempts(path = JOURNAL_PATH): TradeAttempt[] {
  if (!existsSync(path)) return [];
  const out: TradeAttempt[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as TradeAttempt); } catch { /* truncated tail */ }
  }
  return out;
}

/**
 * Replace the file with these attempts. Used only by reconciliation, which has to amend
 * records written earlier; the hot path never calls it.
 */
export function rewriteAttempts(attempts: TradeAttempt[], path = JOURNAL_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, attempts.map(a => JSON.stringify(a)).join('\n') + '\n', 'utf8');
}

export function journalSizeBytes(path = JOURNAL_PATH): number {
  try { return statSync(path).size; } catch { return 0; }
}
