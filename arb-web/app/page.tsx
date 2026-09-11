'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArbitrageOpportunity, Category } from '@/lib/market-types';
import { MIN_ORDER_CONTRACTS } from '@/lib/market-types';
import type { OpportunitiesResponse, PairInfo } from './api/opportunities/route';
import type { ExecuteResponse, ConnectionTestResponse } from './api/execute/route';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '@/lib/categories';
import { sizeByRisk } from '@/lib/sizing';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtUsd(dollars: number) {
  return `$${Math.abs(dollars).toFixed(2)}`;
}

// Contract price in cents (= implied probability). Shown as ¢ to match how both
// platforms quote prices.
function pct(cents: number) {
  return `${Math.round(cents)}¢`;
}

function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function fmtDate(iso: string | undefined) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Extract a short, readable matchup from a full question string.
// PM sports questions look like "Title [Team A vs Team B]" — we use the bracket.
// Kalshi questions end in "Winner?" — we strip it.
function cleanQuestion(q: string): string {
  const s = q.replace(' [FLIPPED]', '').trim();
  const bracket = s.match(/\[([^\]]+)\]$/);
  if (bracket) return bracket[1].trim();
  return s.replace(/\s+Winner\??\s*$/i, '').trim() || s;
}

// ─── sub-components ─────────────────────────────────────────────────────────

function CategoryBadge({ category }: { category?: Category }) {
  if (!category) return null;
  const c = CATEGORY_COLORS[category];
  return (
    <span
      style={{ background: c.bg, color: c.color, border: `1px solid ${c.border}` }}
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
    >
      {CATEGORY_LABELS[category]}
    </span>
  );
}

function VenueBadge({ venue }: { venue: 'polymarket' | 'kalshi' }) {
  const ispm = venue === 'polymarket';
  return (
    <span
      style={{
        background: ispm ? '#7c3aed22' : '#2563eb22',
        color: ispm ? '#a78bfa' : '#60a5fa',
        border: `1px solid ${ispm ? '#7c3aed44' : '#2563eb44'}`,
      }}
      className="text-xs font-semibold px-2 py-0.5 rounded-full"
    >
      {ispm ? 'Polymarket' : 'Kalshi'}
    </span>
  );
}

function SideBadge({ side }: { side: 'yes' | 'no' }) {
  const isYes = side === 'yes';
  return (
    <span
      style={{
        background: isYes ? '#16a34a22' : '#9333ea22',
        color: isYes ? '#4ade80' : '#c084fc',
        border: `1px solid ${isYes ? '#16a34a55' : '#9333ea55'}`,
      }}
      className="text-sm font-bold px-2.5 py-0.5 rounded-full font-mono tracking-wide"
    >
      {side.toUpperCase()}
    </span>
  );
}

function EdgeBadge({ ep }: { ep: number }) {
  const color = ep >= 2 ? '#4ade80' : ep >= 0.5 ? '#fbbf24' : '#8b949e';
  const bg = ep >= 2 ? '#16a34a22' : ep >= 0.5 ? '#d9770622' : '#8b949e11';
  const border = ep >= 2 ? '#16a34a44' : ep >= 0.5 ? '#d9770644' : '#8b949e33';
  return (
    <span
      style={{ background: bg, color, border: `1px solid ${border}` }}
      className="text-sm font-bold px-3 py-1 rounded-full font-mono"
    >
      {ep >= 0 ? '+' : ''}{ep.toFixed(2)}%
    </span>
  );
}

// ─── PairRow ────────────────────────────────────────────────────────────────

// Memoised: polling replaces the whole list about once a second, and re-rendering
// every row when only a couple of prices moved is what makes the UI feel heavy.
// Comparing the fields actually rendered lets untouched rows skip the work entirely.
const PairRow = memo(function PairRow({ pair }: { pair: PairInfo }) {
  const c = CATEGORY_COLORS[pair.category];
  const diffColor = pair.priceDiff > 25 ? '#f87171' : pair.priceDiff > 10 ? '#fbbf24' : '#4ade80';
  const rowOpacity = pair.filteredOut ? 0.4 : 1;

  return (
    <div
      style={{
        background: 'var(--card)',
        border: `1px solid ${pair.filteredOut ? 'var(--border)' : 'var(--border)'}`,
        opacity: rowOpacity,
      }}
      className="rounded-xl p-4 flex flex-col gap-3"
    >
      {/* Top row: category + price diff + filtered badge */}
      <div className="flex items-center gap-2 flex-wrap">
        <CategoryBadge category={pair.category} />
        <span
          style={{ background: `${diffColor}22`, color: diffColor, border: `1px solid ${diffColor}44` }}
          className="text-xs font-mono px-2 py-0.5 rounded-full"
        >
          Δ{pair.priceDiff}¢
        </span>
        {!pair.datesMatch && (
          <span
            style={{ background: '#f8717122', color: '#f87171', border: '1px solid #f8717144' }}
            className="text-xs px-2 py-0.5 rounded-full"
          >
            Date mismatch
          </span>
        )}
        {pair.filteredOut && (
          <span
            style={{ background: '#8b949e22', color: '#8b949e', border: '1px solid #8b949e44' }}
            className="text-xs px-2 py-0.5 rounded-full"
          >
            Filtered out
          </span>
        )}
      </div>

      {/* Two questions side by side */}
      <div className="grid grid-cols-2 gap-3">
        <a
          href={pair.pmUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', textDecoration: 'none' }}
          className="rounded-lg p-3 flex flex-col gap-2 hover:border-[#8b949e] transition-colors"
        >
          <div className="flex items-center justify-between gap-2">
            <VenueBadge venue="polymarket" />
            <span className="text-xs font-mono font-bold" style={{ color: '#a78bfa' }}>{pair.pmPrice}¢</span>
          </div>
          <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>{pair.pmQuestion}</p>
          {pair.pmDate && (
            <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{pair.pmDate}</p>
          )}
        </a>

        <a
          href={pair.kalUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', textDecoration: 'none' }}
          className="rounded-lg p-3 flex flex-col gap-2 hover:border-[#8b949e] transition-colors"
        >
          <div className="flex items-center justify-between gap-2">
            <VenueBadge venue="kalshi" />
            <span className="text-xs font-mono font-bold" style={{ color: '#60a5fa' }}>{pair.kalPrice}¢</span>
          </div>
          <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>{pair.kalQuestion}</p>
          {pair.kalDate && (
            <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{pair.kalDate}</p>
          )}
        </a>
      </div>
    </div>
  );
}, (a, b) => {
  const x = a.pair, y = b.pair;
  return x.pmId === y.pmId && x.kalId === y.kalId
    && x.pmPrice === y.pmPrice && x.kalPrice === y.kalPrice
    && x.priceDiff === y.priceDiff && x.datesMatch === y.datesMatch
    && x.filteredOut === y.filteredOut;
});

// ─── OpportunityCard ────────────────────────────────────────────────────────

interface CardExecState {
  state: 'idle' | 'pending' | 'ok' | 'err';
  result?: ExecuteResponse;
}

// Memoised for the same reason as PairRow: ~100 of these re-render on every poll
// otherwise. Every value the card renders from is compared below, so a card only
// re-renders when something it actually shows has changed.
const OpportunityCard = memo(function OpportunityCard({ opp, amount, riskDollars, firstSeenAt, onUseSuggestedSize, onExecuted, onExecuteStart }: {
  opp: ArbitrageOpportunity;
  amount: number;
  /** Dollars to deploy across both legs combined, from the Risk box. */
  riskDollars: number;
  /** Timestamp this opportunity was first seen, for the "how long has this lasted" badge. */
  firstSeenAt: number;
  onUseSuggestedSize: (n: number) => void;
  onExecuted: (opp: ArbitrageOpportunity, amount: number, result: ExecuteResponse) => void;
  onExecuteStart: (opp: ArbitrageOpportunity) => void;
}) {
  const [showDebug, setShowDebug] = useState(false);
  const [cardExec, setCardExec] = useState<CardExecState>({ state: 'idle' });
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  // Whole seconds only: this re-renders on every poll, and a value that changed on each
  // one would keep re-measuring the badge and nudging its neighbours.
  const heldForSec = Math.floor((Date.now() - firstSeenAt) / 1000);
  const isArb = edgePercent >= 0.5;
  // Strictly positive edge after fees = the only case worth (and safe) to execute.
  const isProfitable = edgePercent > 0;
  const category = pair.polymarket.category;

  const totalCostDollars = (totalCostCents / 100) * amount;
  const payoutDollars = amount;
  const profitDollars = payoutDollars - totalCostDollars;
  // Turn the dollar budget into a contract count for THIS pair of prices, capped by what
  // the thinner book can actually fill — a $300 budget against a 19-contract book is fiction.
  const sized = sizeByRisk({
    riskDollars,
    legAPriceCents: legA.priceCents,
    legBPriceCents: legB.priceCents,
    maxContracts: opp.maxContracts,
    minContracts: MIN_ORDER_CONTRACTS,
  });
  const exceedsDepth = opp.maxContracts != null && amount > opp.maxContracts;
  // Polymarket rejects orders under 5 shares; Kalshi accepts 1. Placing a smaller pair
  // would fill only the Kalshi leg, so the trade must be blocked entirely.
  const belowMinimum = Math.round(amount) < MIN_ORDER_CONTRACTS;

  const pmDate = fmtDate(pair.polymarket.resolutionTime);
  const kalDate = fmtDate(pair.kalshi.resolutionTime);
  // Politics pairs are matched on (state, chamber, year), not date — PM settles on
  // election day while Kalshi settles at swearing-in, so differing raw dates are normal.
  const datesMatch = category === 'politics'
    || pair.polymarket.resolutionTime?.slice(0, 10) === pair.kalshi.resolutionTime?.slice(0, 10);

  // How long capital is tied up until settlement, and the edge expressed as an annual
  // rate — so a 3% arb that settles in 120 days doesn't look like an overnight 3%.
  const settleMs = pair.polymarket.resolutionTime ? Date.parse(pair.polymarket.resolutionTime) : NaN;
  const lockupDays = Number.isFinite(settleMs)
    ? Math.max(0, Math.ceil((settleMs - Date.now()) / 86_400_000))
    : null;
  const annualizedPct = (lockupDays != null && lockupDays >= 1 && edgePercent > 0)
    ? Math.round(edgePercent * (365 / lockupDays))
    : null;

  const legs = [
    { leg: legA, market: legA.venue === 'polymarket' ? pair.polymarket : pair.kalshi },
    { leg: legB, market: legB.venue === 'polymarket' ? pair.polymarket : pair.kalshi },
  ].map(({ leg, market }) => {
    const isFlipped = market.question.includes('[FLIPPED]');
    return {
      leg,
      market,
      displayQuestion: market.question.replace(' [FLIPPED]', ''),
      displaySide: (isFlipped ? (leg.side === 'yes' ? 'no' : 'yes') : leg.side) as 'yes' | 'no',
      betDollars: (leg.priceCents / 100) * amount,
      feeDollars: (leg.feeCents / 100) * amount,
    };
  });

  async function handleCardExecute() {
    // Register the pair immediately so auto-exec can't fire the same one in parallel.
    onExecuteStart(opp);
    setCardExec({ state: 'pending' });
    try {
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity: opp, amount }),
      });
      const result = await res.json() as ExecuteResponse;
      // A clean hedge is the only true success; a naked/partial leg shows as an error.
      setCardExec({ state: result.hedged ? 'ok' : 'err', result });
      onExecuted(opp, amount, result);
    } catch (err) {
      const result: ExecuteResponse = {
        kalshi: { ok: false, error: String(err) },
        polymarket: { ok: false, error: String(err) },
        executedAt: new Date().toISOString(),
        bothOk: false,
        hedged: false,
        hedgeNote: `Request failed: ${String(err)}`,
      };
      setCardExec({ state: 'err', result });
      onExecuted(opp, amount, result);
    }
  }

  return (
    <div
      style={{
        background: 'var(--card)',
        border: `1px solid ${isArb ? (edgePercent >= 2 ? '#16a34a44' : '#d9770644') : 'var(--border)'}`,
        boxShadow: isArb ? `0 0 0 1px ${edgePercent >= 2 ? '#16a34a22' : '#d9770622'}` : 'none',
      }}
      className="rounded-xl p-5 flex flex-col gap-4"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <CategoryBadge category={category} />
            {heldForSec >= 2 && (
              <span
                style={{ background: '#0284c711', color: '#7dd3fc', border: '1px solid #0284c733' }}
                className="text-xs px-2 py-0.5 rounded-full font-mono tabular-nums"
              >
                Held {heldForSec}s
              </span>
            )}
            {lockupDays != null && lockupDays > 2 && (
              <span
                style={{ background: '#d9770622', color: '#fbbf24', border: '1px solid #d9770644' }}
                className="text-xs px-2 py-0.5 rounded-full font-mono"
                title="Capital stays locked until this market settles"
              >
                locks ~{lockupDays}d{annualizedPct != null ? ` · ${annualizedPct}%/yr` : ''}
              </span>
            )}
          </div>
          <p className="text-base font-semibold leading-snug" style={{ color: 'var(--foreground)' }}>
            {cleanQuestion(pair.polymarket.question)}
          </p>
          <p className="text-xs font-mono" style={{ color: datesMatch ? 'var(--text-muted)' : '#f87171' }}>
            {pmDate ?? '—'}{!datesMatch && ` · KAL: ${kalDate ?? '—'} ⚠`}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <EdgeBadge ep={edgePercent} />
          {sized.contracts > 0 ? (
            <button
              onClick={() => onUseSuggestedSize(sized.contracts)}
              className="text-xs font-mono hover:underline text-right"
              style={{ color: '#fbbf24' }}
              title={`${sized.contracts} contracts · ${sized.limitedBy === 'depth' ? 'capped by book depth' : 'sized to your risk budget'}`}
            >
              Risk {fmtUsd(sized.costDollars)} → {sized.contracts}
              {sized.limitedBy === 'depth' && <span style={{ color: 'var(--text-muted)' }}> (depth)</span>}
            </button>
          ) : (
            <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
              under {MIN_ORDER_CONTRACTS}-share min
            </span>
          )}
        </div>
      </div>

      {/* Two legs */}
      <div className="grid grid-cols-2 gap-3">
        {legs.map(({ leg, market, displayQuestion, displaySide, betDollars, feeDollars }, i) => (
          <a
            key={i}
            href={market.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ background: 'var(--surface)', border: `1px solid ${displaySide === 'yes' ? '#16a34a33' : '#9333ea33'}`, textDecoration: 'none' }}
            className="rounded-lg p-4 flex flex-col gap-2 hover:opacity-90 transition-opacity cursor-pointer"
          >
            {/* Platform */}
            <VenueBadge venue={leg.venue} />

            {/* Primary action — amount then side label */}
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-3xl font-bold font-mono" style={{ color: 'var(--foreground)' }}>
                {fmtUsd(betDollars)}
              </span>
              <span className="text-lg font-bold" style={{ color: displaySide === 'yes' ? '#4ade80' : '#c084fc' }}>
                {displaySide.toUpperCase()}
              </span>
            </div>

            {/* Shortened matchup for context */}
            <p className="text-xs leading-snug line-clamp-2" style={{ color: 'var(--text-muted)' }}>
              {cleanQuestion(displayQuestion)}
            </p>

            {/* Price + fee */}
            <div className="flex items-center justify-between text-xs font-mono mt-auto" style={{ color: 'var(--text-muted)' }}>
              <span>@ {pct(leg.priceCents)}</span>
              <span>fee {fmtUsd(feeDollars)}</span>
            </div>

            {/* Book context: PM spread/liquidity, Kalshi fillable depth */}
            {leg.venue === 'polymarket' && market.spreadCents != null && (
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                spread {market.spreadCents}¢{market.liquidityUsd ? ` · $${(market.liquidityUsd / 1000).toFixed(0)}k book` : ''}
              </p>
            )}
            {leg.venue === 'kalshi' && opp.maxContracts != null && (
              <p className="text-xs font-mono" style={{ color: exceedsDepth ? '#f87171' : 'var(--text-muted)' }}>
                {/* Both venues, not just this leg: the fillable size of a hedged pair is set
                    by whichever book runs out first. */}
                ~{fmtUsd(opp.maxContracts)} fillable on both books
              </p>
            )}
          </a>
        ))}
      </div>

      {/* Summary */}
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-lg px-4 py-3 flex items-center gap-3 flex-wrap"
      >
        <div>
          <p className="text-xs text-[--text-muted]">Invest</p>
          <p className="text-sm font-bold font-mono">{fmtUsd(totalCostDollars)}</p>
        </div>
        <span className="text-[--text-muted]">→</span>
        <div>
          <p className="text-xs text-[--text-muted]">Payout</p>
          <p className="text-sm font-bold font-mono">{fmtUsd(payoutDollars)}</p>
        </div>
        <span className="text-[--text-muted]">→</span>
        <div>
          <p className="text-xs text-[--text-muted]">{isProfitable ? 'Profit' : 'Loss'}</p>
          <p className="text-sm font-bold font-mono" style={{ color: isProfitable ? '#4ade80' : '#f87171' }}>
            {profitDollars >= 0 ? '+' : '−'}{fmtUsd(profitDollars)}
          </p>
        </div>
        {opp.maxContracts != null && (
          <div className="ml-auto">
            <p className="text-xs text-[--text-muted]">Max fill</p>
            <p className="text-sm font-bold font-mono" style={{ color: exceedsDepth ? '#f87171' : 'var(--foreground)' }}>
              ~{fmtUsd(opp.maxContracts)}
            </p>
          </div>
        )}
      </div>
      {exceedsDepth && (
        <p className="text-xs -mt-2" style={{ color: '#f87171' }}>
          Only ~{fmtUsd(opp.maxContracts ?? 0)} can be filled across both books while this stays
          profitable. Ordering more would fill one leg further than the other and leave the
          difference unhedged — use Max fill or less.
        </p>
      )}

      {/* Per-card execute button / inline result.
          A non-positive edge is a guaranteed loss at these prices — never offer to
          place it, and never label a loss as "profit". */}
      {cardExec.state === 'idle' && (
        isProfitable && belowMinimum ? (
          <div
            style={{ background: 'var(--surface)', border: '1px solid #d9770655' }}
            className="w-full py-2.5 rounded-lg text-center"
          >
            <p className="text-sm font-semibold" style={{ color: '#fbbf24' }}>
              Amount below Polymarket&apos;s {MIN_ORDER_CONTRACTS}-share minimum
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Raise Amount to at least ${MIN_ORDER_CONTRACTS} — a smaller order fills only the Kalshi leg and leaves it unhedged
            </p>
          </div>
        ) : isProfitable ? (
          <button
            onClick={handleCardExecute}
            style={{ background: '#16a34a', color: 'white' }}
            className="w-full py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Execute — invest {fmtUsd(totalCostDollars)}, profit +{fmtUsd(profitDollars)}
          </button>
        ) : (
          <div
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            className="w-full py-2.5 rounded-lg text-center"
          >
            <p className="text-sm font-semibold" style={{ color: 'var(--text-muted)' }}>
              No profit at these prices — costs {fmtUsd(totalCostDollars)} to win {fmtUsd(payoutDollars)}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Needs {fmtUsd(Math.abs(profitDollars))} more edge ({edgePercent.toFixed(2)}%) · watching for the spread to widen
            </p>
          </div>
        )
      )}

      {cardExec.state === 'pending' && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          className="w-full py-2.5 rounded-lg flex items-center justify-center gap-2"
        >
          <div className="w-4 h-4 border-2 border-[--border] border-t-[#fbbf24] rounded-full animate-spin" />
          <span className="text-sm text-[--text-muted]">Placing orders…</span>
        </div>
      )}

      {(cardExec.state === 'ok' || cardExec.state === 'err') && cardExec.result && (
        <div
          style={{
            background: cardExec.state === 'ok' ? '#16a34a11' : '#dc262611',
            border: `1px solid ${cardExec.state === 'ok' ? '#16a34a33' : '#dc262633'}`,
          }}
          className="w-full py-2.5 rounded-lg px-4 flex flex-col gap-1.5"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-4 text-xs font-mono">
              <span style={{ color: (cardExec.result.kalshi.filledCount ?? (cardExec.result.kalshi.ok ? 1 : 0)) > 0 ? '#4ade80' : '#f87171' }}>
                KAL {cardExec.result.kalshi.ok
                  ? (cardExec.result.kalshi.filledCount != null ? `✓ filled ${cardExec.result.kalshi.filledCount}` : '✓ placed')
                  : `✗ ${cardExec.result.kalshi.error?.slice(0, 24) ?? 'error'}`}
              </span>
              <span style={{ color: (cardExec.result.polymarket.filledCount ?? (cardExec.result.polymarket.ok ? 1 : 0)) > 0 ? '#4ade80' : '#f87171' }}>
                PM {cardExec.result.polymarket.ok
                  ? (cardExec.result.polymarket.filledCount != null ? `✓ filled ${cardExec.result.polymarket.filledCount}` : '✓ placed')
                  : `✗ ${cardExec.result.polymarket.error?.slice(0, 24) ?? 'error'}`}
              </span>
            </div>
            <button
              onClick={() => setCardExec({ state: 'idle' })}
              className="text-xs hover:text-[--foreground] transition-colors flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}
            >
              ✕
            </button>
          </div>
          {cardExec.result.hedgeNote && (
            <p className="text-xs font-semibold" style={{ color: cardExec.result.hedged ? '#fbbf24' : '#f87171' }}>
              {cardExec.result.hedgeNote}
            </p>
          )}
        </div>
      )}

      {/* Debug toggle */}
      <button
        onClick={() => setShowDebug(v => !v)}
        className="text-xs underline text-left w-fit"
        style={{ color: 'var(--text-muted)' }}
      >
        {showDebug ? 'Hide' : 'Show'} matched questions
      </button>

      {showDebug && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          className="rounded-lg px-4 py-3 flex flex-col gap-2"
        >
          <div>
            <span className="text-xs font-semibold" style={{ color: '#a78bfa' }}>Polymarket</span>
            <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{pair.polymarket.question}</p>
          </div>
          <div>
            <span className="text-xs font-semibold" style={{ color: '#60a5fa' }}>Kalshi</span>
            <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>{pair.kalshi.question}</p>
          </div>
          {!datesMatch && (
            <p className="text-xs" style={{ color: '#f87171' }}>
              Date mismatch — may not be the same event.
            </p>
          )}
        </div>
      )}
    </div>
  );
}, (a, b) => {
  // Identity + every rendered number. Prices/edge/depth drive the whole card, and
  // amount/riskDollars/firstSeenAt drive the sizing and badges.
  if (a.amount !== b.amount || a.riskDollars !== b.riskDollars || a.firstSeenAt !== b.firstSeenAt) return false;
  if (a.onUseSuggestedSize !== b.onUseSuggestedSize || a.onExecuted !== b.onExecuted || a.onExecuteStart !== b.onExecuteStart) return false;
  const x = a.opp, y = b.opp;
  return x.edgePercent === y.edgePercent
    && x.totalCostCents === y.totalCostCents
    && x.maxContracts === y.maxContracts
    && x.legA.priceCents === y.legA.priceCents && x.legA.feeCents === y.legA.feeCents
    && x.legA.side === y.legA.side && x.legA.venue === y.legA.venue
    && x.legB.priceCents === y.legB.priceCents && x.legB.feeCents === y.legB.feeCents
    && x.legB.side === y.legB.side && x.legB.venue === y.legB.venue
    && x.pair.polymarket.id === y.pair.polymarket.id
    && x.pair.kalshi.id === y.pair.kalshi.id
    && x.pair.polymarket.question === y.pair.polymarket.question
    && x.pair.kalshi.question === y.pair.kalshi.question
    && x.pair.polymarket.url === y.pair.polymarket.url
    && x.pair.kalshi.url === y.pair.kalshi.url
    && x.pair.polymarket.spreadCents === y.pair.polymarket.spreadCents
    && x.pair.polymarket.liquidityUsd === y.pair.polymarket.liquidityUsd
    && x.pair.polymarket.resolutionTime === y.pair.polymarket.resolutionTime
    && x.pair.kalshi.resolutionTime === y.pair.kalshi.resolutionTime;
});

// ─── ExecutionPendingScreen ──────────────────────────────────────────────────

type ExecutingPhase = { phase: 'executing'; opp: ArbitrageOpportunity; amount: number; key: string };

function ExecutionPendingScreen({ execPhase }: { execPhase: ExecutingPhase }) {
  const { opp, amount } = execPhase;
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;

  const legs = [
    { leg: legA, market: legA.venue === 'polymarket' ? pair.polymarket : pair.kalshi },
    { leg: legB, market: legB.venue === 'polymarket' ? pair.polymarket : pair.kalshi },
  ].map(({ leg, market }) => {
    const isFlipped = market.question.includes('[FLIPPED]');
    return {
      leg,
      market,
      displaySide: (isFlipped ? (leg.side === 'yes' ? 'no' : 'yes') : leg.side) as 'yes' | 'no',
      betDollars: (leg.priceCents / 100) * amount,
    };
  });

  const totalCostDollars = (totalCostCents / 100) * amount;
  const profitDollars = amount - totalCostDollars;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div
          style={{
            background: 'var(--card)',
            border: '1px solid #fbbf2455',
            boxShadow: '0 0 60px #fbbf2412',
          }}
          className="rounded-2xl p-8"
        >
          {/* Header */}
          <div className="flex items-center gap-3 mb-7">
            <div className="w-3 h-3 rounded-full bg-[#fbbf24] animate-pulse flex-shrink-0" />
            <h2 className="text-xl font-bold">Arb Opportunity Detected</h2>
          </div>

          {/* Category + edge */}
          <div className="flex items-center gap-3 mb-3">
            <CategoryBadge category={pair.polymarket.category} />
            <EdgeBadge ep={edgePercent} />
          </div>

          {/* Question */}
          <p className="text-sm leading-relaxed mb-6" style={{ color: 'var(--text-muted)' }}>
            {pair.polymarket.question.replace(' [FLIPPED]', '')}
          </p>

          {/* Legs */}
          <div className="grid grid-cols-2 gap-3 mb-5">
            {legs.map(({ leg, market, displaySide, betDollars }, i) => (
              <div
                key={i}
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                className="rounded-xl p-4 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <VenueBadge venue={leg.venue} />
                  <SideBadge side={displaySide} />
                </div>
                <p className="text-xs line-clamp-2 leading-snug" style={{ color: 'var(--text-muted)' }}>
                  {market.question.replace(' [FLIPPED]', '')}
                </p>
                <div>
                  <p className="text-2xl font-bold font-mono">{fmtUsd(betDollars)}</p>
                  <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>@ {pct(leg.priceCents)}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Profit summary */}
          <div
            style={{ background: '#16a34a0a', border: '1px solid #16a34a33' }}
            className="rounded-xl px-4 py-3 mb-6 flex items-center justify-between"
          >
            <div className="text-center">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Cost</p>
              <p className="text-sm font-bold font-mono">{fmtUsd(totalCostDollars)}</p>
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>→</div>
            <div className="text-center">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Payout</p>
              <p className="text-sm font-bold font-mono">{fmtUsd(amount)}</p>
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>→</div>
            <div className="text-center">
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Profit</p>
              <p className="text-sm font-bold font-mono" style={{ color: '#4ade80' }}>+{fmtUsd(profitDollars)}</p>
            </div>
          </div>

          {/* Orders are already in flight by the time this renders — there is nothing to
              confirm or cancel, so this reports rather than asks. */}
          <div className="flex items-center justify-center gap-3 py-5">
            <div className="w-5 h-5 border-2 border-[--border] border-t-[#fbbf24] rounded-full animate-spin" />
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Placing orders on both platforms…</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ExecutionResultScreen ───────────────────────────────────────────────────

/**
 * Whether a result needs a human before trading continues.
 *
 * Only an actual position that is not a clean hedge does: a naked or partial fill is money
 * at risk that someone has to close by hand. Everything else — a clean hedge, or any of the
 * pre-order aborts, which send no orders at all — is informational, and holding the screen
 * open for it stops an unattended session dead.
 */
function resultNeedsAttention(r: ExecuteResponse): boolean {
  if (r.noOrdersSent) return false;   // nothing was sent, so nothing is exposed
  return !r.hedged;
}


function ExecutionResultScreen({
  opp,
  amount,
  result,
  onDismiss,
  autoDismissSec,
}: {
  opp: ArbitrageOpportunity;
  amount: number;
  result: ExecuteResponse;
  onDismiss: () => void;
  /** Seconds until this closes itself and scanning resumes; absent means it waits. */
  autoDismissSec?: number;
}) {
  const { pair, totalCostCents, edgePercent } = opp;
  const hedged = result.hedged;
  // hedgeNote present without hedged = a naked/partial position needing attention.
  // Backing out on a price move is a SAFE outcome — no orders were sent — so it must not
  // be presented with the same alarm as a half-filled position.
  const abortedSafely = result.abortedOnPriceMove === true;
  const naked = !hedged && !abortedSafely && !!result.hedgeNote;
  const profitDollars = amount - (totalCostCents / 100) * amount;
  // amber (a deliberate, harmless no-trade) rather than red (money at risk)
  const accent = hedged ? '#16a34a' : abortedSafely ? '#d97706' : '#dc2626';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div
          style={{
            background: 'var(--card)',
            border: `1px solid ${accent}55`,
            boxShadow: `0 0 60px ${accent}12`,
          }}
          className="rounded-2xl p-8"
        >
          {/* Header */}
          <div className="flex items-center gap-4 mb-7">
            <div
              style={{
                background: `${accent}22`,
                border: `1px solid ${accent}55`,
                color: hedged ? '#4ade80' : abortedSafely ? '#fbbf24' : '#f87171',
              }}
              className="w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold flex-shrink-0"
            >
              {hedged ? '✓' : abortedSafely ? '⤺' : '⚠'}
            </div>
            <div>
              <h2 className="text-xl font-bold">
                {hedged ? 'Hedge Complete'
                  : abortedSafely ? 'Backed Out — No Orders Sent'
                  : naked ? 'Position Needs Attention' : 'Execution Failed'}
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {new Date(result.executedAt).toLocaleString()}
                {result.revalidateMs !== undefined && ` · price re-checked in ${result.revalidateMs}ms`}
              </p>
            </div>
          </div>

          {/* Hedge warning — the single most important thing to see when not clean */}
          {result.hedgeNote && (
            <div
              style={{ background: naked ? '#dc262618' : '#d9770618', border: `1px solid ${naked ? '#dc262655' : '#d9770655'}` }}
              className="rounded-xl px-4 py-3 mb-5"
            >
              <p className="text-sm font-semibold" style={{ color: naked ? '#f87171' : '#fbbf24' }}>
                {result.hedgeNote}
              </p>
              {abortedSafely && (
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  Your balance is untouched — the edge disappeared between loading the card and
                  confirming the price, so the trade was skipped rather than filled at a loss.
                </p>
              )}
            </div>
          )}

          {/* Category + edge */}
          <div className="flex items-center gap-3 mb-3">
            <CategoryBadge category={pair.polymarket.category} />
            <EdgeBadge ep={edgePercent} />
          </div>

          {/* Question */}
          <p className="text-sm leading-relaxed mb-6" style={{ color: 'var(--text-muted)' }}>
            {pair.polymarket.question.replace(' [FLIPPED]', '')}
          </p>

          {/* Leg results — show ACTUAL filled counts, not just acceptance */}
          <div className="flex flex-col gap-3 mb-6">
            {([
              { label: 'Kalshi', res: result.kalshi },
              { label: 'Polymarket', res: result.polymarket },
            ] as const).map(({ label, res }) => {
              const filled = res.filledCount;
              const legOk = res.ok && (filled == null || filled > 0);
              return (
                <div
                  key={label}
                  style={{
                    background: 'var(--surface)',
                    border: `1px solid ${legOk ? '#16a34a33' : '#dc262633'}`,
                  }}
                  className="rounded-xl px-4 py-3 flex items-center justify-between gap-4"
                >
                  <span className="text-sm font-semibold">{label}</span>
                  <div className="text-right">
                    {res.ok ? (
                      <div>
                        <p className="text-sm font-mono" style={{ color: filled === 0 ? '#f87171' : '#4ade80' }}>
                          {filled != null ? (filled > 0 ? `✓ filled ${filled}` : '✗ filled 0') : '✓ accepted'}
                        </p>
                        {res.orderId && (
                          <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {res.orderId.slice(0, 18)}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm font-mono" style={{ color: '#f87171' }}>
                        ✗ {res.error?.slice(0, 60) ?? 'Failed'}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {hedged && (
            <div
              style={{ background: '#16a34a0d', border: '1px solid #16a34a33' }}
              className="rounded-xl px-4 py-3 mb-6 flex items-center justify-between"
            >
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Expected profit</span>
              <span className="text-lg font-bold font-mono" style={{ color: '#4ade80' }}>
                +{fmtUsd(profitDollars)}
              </span>
            </div>
          )}

          <button
            onClick={onDismiss}
            style={{
              background: hedged ? '#16a34a' : 'var(--surface)',
              color: hedged ? 'white' : 'var(--foreground)',
              border: hedged ? 'none' : '1px solid var(--border)',
            }}
            className="w-full py-3 rounded-xl text-sm font-bold hover:opacity-90 transition-opacity"
          >
            Back to Markets
          </button>

          {autoDismissSec !== undefined && (
            <p className="text-xs text-center mt-3" style={{ color: 'var(--text-muted)' }}>
              Auto-execute is on — resuming the scan in {autoDismissSec}s.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── exec log ────────────────────────────────────────────────────────────────

interface ExecLogEntry {
  /** Stable identity for dismissal. Auto-execute PREPENDS entries, so a list index
   *  captured at render time shifts underneath a click and would remove the wrong row.
   *  Optional because entries saved before this existed are read back from localStorage;
   *  those are given an id on load so everything in state always has one. */
  id?: string;
  ts: string;
  question: string;
  edgePercent: number;
  amount: number;
  result: ExecuteResponse;
}

const makeExecId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

// ─── exec phase type ────────────────────────────────────────────────────────

type ExecPhase =
  | ExecutingPhase
  | { phase: 'result'; opp: ArbitrageOpportunity; amount: number; result: ExecuteResponse };

// ─── main page ───────────────────────────────────────────────────────────────

const ALL_CATEGORIES: Category[] = ['mlb', 'nfl', 'cfb', 'soccer', 'politics'];
// Responses come from a warm in-memory cache (~13 ms, ~36 KB gzipped), so polling is
// bounded by how fast the server re-quotes rather than by request cost.
//
// The server now re-quotes games in progress every 250ms, which made this poll the
// dominant source of staleness: the price on screen could be a full poll behind even
// though the server had fresher data sitting in memory. During a live game that gap is
// exactly what makes a click arrive after the edge has gone, and the execution abort
// (correctly) refuses to trade it. Polling faster costs a memory read per request.
// Responses are a memory read (~10ms), so the poll interval is pure added staleness on
// top of the server's own refresh. At 350ms a price could be a third of a second old before
// it even reached the screen, which is most of the window an in-play edge lives in.
const POLL_MS = 150;
// How long a harmless result stays on screen while auto-execute is running. Long enough to
// read in passing, short enough that an unattended session does not sit idle on it.
const RESULT_AUTODISMISS_MS = 6_000;

// How many consecutive polls an edge must survive before auto-execute will fire on it.
//
// Measured against live books: on slow markets the displayed edge and the order-book edge
// agree to the decimal (a college game read 0.62% on both). On IN-PLAY baseball they
// diverged every time, and always the same way — cards showing +0.56/+3.59/+2.55/+0.54%
// re-checked at -4.37/-3.31/-2.40/-8.49% roughly 160ms later. A real move would scatter in
// both directions; a one-sided gap is selection bias. The scan surfaces a pair at the
// instant one venue's feed has moved and the other has not, so the "edge" is the lag
// between two feeds rather than a price anyone can trade.
//
// Those artifacts die within about 160ms. An edge still present two polls later is one both
// venues agree on. Two observations costs ~150ms and turns eight straight wasted attempts
// into none — and it forfeits nothing, because an edge that cannot survive 150ms is exactly
// the one the pre-order re-check was already refusing.
// Set to 1 — OFF by default. Two confirmations reliably filtered the artifacts, but it buys
// that by never attempting a fleeting edge at all, and a fleeting edge is the only kind a
// lagging feed ever offers. A wasted attempt costs nothing: no orders are sent, and the
// pre-order re-check is what refuses them. Trading away capture to reduce log noise is the
// wrong side of that trade while catching these is the goal. Raise to 2 to suppress the
// failed attempts once the latency work below makes real captures the common case.
const EDGE_CONFIRMATIONS = 1;

export default function Home() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  // 'sports' is the default view: politics settles months out, so those markets dominate
  // the list by count while being the least actionable day to day.
  const [view, setView] = useState<'sports' | 'opportunities' | 'pairs'>('sports');
  // Every listed opportunity is already profitable, so the bands narrow by size only.
  const [edgeFilter, setEdgeFilter] = useState<'all' | 'strong' | 'arb'>('all');
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all');
  const [pairsCatFilter, setPairsCatFilter] = useState<Category | 'all'>('all');
  const [amount, setAmount] = useState(100);

  // Persistence tracking: how many consecutive polls each opportunity has appeared in
  // Maps an opportunity to the timestamp it was FIRST seen. Previously this counted polls,
// so the badge text grew with the poll rate ("Seen 9x" -> "Seen 10x") several times a
// second, widening the badge and shifting everything beside it. A first-seen timestamp is
// constant while the opportunity lives, so the value stops churning and the derived age is
// correct regardless of how fast we poll.
const [persistMap, setPersistMap] = useState<Map<string, number>>(new Map());

  // Auto-exec state
  const [autoExec, setAutoExec] = useState(false);
  // 'sports' (default) skips politics: those markets settle months out (Nov 2026),
  // locking capital the whole time. 'all' opts in explicitly.
  const [autoExecScope, setAutoExecScope] = useState<'sports' | 'all'>('sports');
  const [execThreshold, setExecThreshold] = useState(1.5);
  // Dollars to put at risk per trade, across both legs combined. Contracts are derived
  // from this per-market, because a contract's cost depends on the pair of prices.
  const [riskDollars, setRiskDollars] = useState(100);
  const [execLog, setExecLog] = useState<ExecLogEntry[]>([]);
  const [execPhase, setExecPhase] = useState<ExecPhase | null>(null);
  const [resultCountdown, setResultCountdown] = useState<number | null>(null);
  // How many consecutive polls each pair has shown a qualifying edge for.
  const edgeStreak = useRef<Map<string, number>>(new Map());
  const [connTest, setConnTest] = useState<{ state: 'idle' | 'pending' | 'done'; result?: ConnectionTestResponse }>({ state: 'idle' });

  async function handleTestConnection() {
    setConnTest({ state: 'pending' });
    try {
      const res = await fetch('/api/execute');
      const result = await res.json() as ConnectionTestResponse;
      setConnTest({ state: 'done', result });
    } catch {
      setConnTest({ state: 'done' });
    }
  }
  const executedPairs = useRef(new Set<string>());
  const isFetching = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // `load` is a stable callback (empty dep list) so the poll interval is never torn down
  // and rebuilt. It still needs to know which tab is open, to decide whether to ask for
  // pairsDetail — a ref gives it the current value without making it a dependency.
  const viewRef = useRef(view);
  viewRef.current = view;
  const execLogLoaded = useRef(false);

  // Persist the execution log across refreshes/crashes — order history is a record
  // you may need to reconcile against the venues. Loaded on mount (client-only to
  // avoid a hydration mismatch), saved on every change after the initial load.
  const EXEC_LOG_KEY = 'arb-exec-log';
  useEffect(() => {
    try {
      const saved = localStorage.getItem(EXEC_LOG_KEY);
      // Backfill ids on history written before dismissal existed, so every entry in state
      // can be addressed individually.
      if (saved) setExecLog((JSON.parse(saved) as ExecLogEntry[]).map(e => ({ ...e, id: e.id ?? makeExecId() })));
    } catch { /* ignore corrupt/absent storage */ }
  }, []);
  useEffect(() => {
    // Skip the first run so the initial empty log doesn't clobber saved history
    // before the load effect's state update has applied.
    if (!execLogLoaded.current) { execLogLoaded.current = true; return; }
    try { localStorage.setItem(EXEC_LOG_KEY, JSON.stringify(execLog)); } catch { /* quota/absent */ }
  }, [execLog]);

  const executeOpportunity = useCallback(async (opp: ArbitrageOpportunity, betAmount: number, key: string) => {
    let result: ExecuteResponse;
    try {
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity: opp, amount: betAmount }),
      });
      result = await res.json() as ExecuteResponse;
    } catch (err) {
      result = {
        kalshi: { ok: false, error: String(err) },
        polymarket: { ok: false, error: String(err) },
        executedAt: new Date().toISOString(),
        bothOk: false,
        hedged: false,
        hedgeNote: `Request failed: ${String(err)}`,
      };
    }
    setExecPhase({ phase: 'result', opp, amount: betAmount, result });
    // Always log — successes AND failures — so a naked/failed leg is never silently dropped.
    setExecLog(prev => [{
      id: makeExecId(),
      ts: new Date().toISOString(),
      question: opp.pair.polymarket.question,
      edgePercent: opp.edgePercent,
      amount: betAmount,
      result,
    }, ...prev].slice(0, 50));
    // Re-arm when no position is at risk: a clean hedge, or a price-move abort where
    // nothing was sent. A naked/partial/failed leg stays blocked so we never auto-fire a
    // second order onto it. Backing out must not blacklist a pair for five minutes —
    // the edge often returns within seconds.
    if (result.hedged) {
      setTimeout(() => executedPairs.current.delete(key), 5 * 60_000);
    } else if (result.noOrdersSent) {
      setTimeout(() => executedPairs.current.delete(key), 10_000);
    }
  }, []);

  const load = useCallback(async (force = false) => {
    if (isFetching.current && !force) return;
    // Cancel any in-flight request so a manual Refresh always wins
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    isFetching.current = true;
    // Only a user-initiated Refresh shows the loading state. Background polls run every
    // 350ms, and toggling it there swapped the button between "Refresh prices" and
    // "Fetching live prices…" — two different widths — so the whole header reflowed about
    // three times a second. The poll is meant to be invisible.
    if (force) setLoading(true);
    try {
      // force -> ?fresh=1 makes the server rebuild from the venues and wait for it, so
      // Refresh shows the prices that are live right now and drops opportunities that
      // have already evaporated. cache:'no-store' stops the browser answering from its
      // own cache, which previously made Refresh look like it did nothing.
      // pairsDetail is 93% of the payload and only the Matched Pairs tab renders it, so ask
      // for it only when that tab is open. The tab LABEL uses stats.matchedPairs, which is
      // always present, so the count stays correct without shipping the array.
      const params = new URLSearchParams();
      if (force) params.set('fresh', '1');
      if (viewRef.current === 'pairs') params.set('pairs', '1');
      const qs = params.toString();
      const res = await fetch(`/api/opportunities${qs ? `?${qs}` : ''}`, {
        signal: abortRef.current.signal,
        cache: 'no-store',
      });
      // A dev recompile (and any server error page) answers with HTML, not JSON. Parsing
      // that threw `SyntaxError: Unexpected token '<'` and surfaced as a red overlay over
      // an otherwise working app. Check before parsing and treat it as a transient miss —
      // the next poll a few hundred ms later succeeds.
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.ok || !contentType.includes('application/json')) {
        return; // keep the last good data on screen
      }
      const json = await res.json() as OpportunitiesResponse;
      setData(json);
      setLastFetch(new Date().toISOString());
      setPersistMap(prev => {
        const next = new Map<string, number>();
        for (const opp of (json.opportunities ?? [])) {
          const k = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
          next.set(k, prev.get(k) ?? Date.now());
        }
        return next;
      });
    } catch (e) {
      const err = e as Error;
      // A dev-server recompile (or the cold-start window) drops the connection mid-flight
      // and surfaces as `TypeError: Failed to fetch`. It is transient and the next poll
      // 800ms later succeeds, so keep the last good data on screen and don't raise it to
      // console.error — that painted a red overlay over a working app.
      const transient = err.name === 'AbortError' ||
        err instanceof SyntaxError ||
        (err instanceof TypeError && /failed to fetch|load failed|networkerror/i.test(err.message));
      if (!transient) console.error(err);
    } finally {
      if (force) setLoading(false);
      isFetching.current = false;
    }
  }, []);

  // The server keeps quotes hot in memory and answers in ~15 ms, so polling can run
  // near real time — an edge that appears is on screen within about a second instead
  // of after a multi-second fetch, by which point it has usually already gone.
  useEffect(() => {
    load();
    const id = setInterval(() => load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Switching to Matched Pairs changes what the request must ask for, so fetch straight
  // away instead of waiting up to a poll for the tab to fill in.
  useEffect(() => {
    if (view === 'pairs') load();
  }, [view, load]);

  // Auto-exec: fire on a new qualifying opportunity the moment one appears
  useEffect(() => {
    // A trade in flight blocks another, and so does a result that needs a human — a naked or
    // partial fill must not be scrolled past by the next trade. A HARMLESS result does not
    // block: it closes itself after a few seconds, and refusing to trade for that whole
    // countdown is a blind window an unattended run cannot afford. The next execution simply
    // replaces the screen.
    const busy = execPhase !== null
      && (execPhase.phase !== 'result' || resultNeedsAttention(execPhase.result));
    if (!autoExec || !data || busy) return;

    // Streaks must count CONSECUTIVE sightings. An edge that flickers in and out is the
    // artifact this guards against, and without clearing it between polls each flicker would
    // add to the count until it fired on exactly the wrong kind of edge.
    const qualifyingNow = new Set<string>();
    for (const opp of data.opportunities) {
      if (opp.edgePercent > 0 && opp.edgePercent >= execThreshold) {
        qualifyingNow.add(`${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`);
      }
    }
    for (const k of edgeStreak.current.keys()) {
      if (!qualifyingNow.has(k)) edgeStreak.current.delete(k);
    }

    for (const opp of data.opportunities) {
      if (opp.edgePercent < execThreshold) break;
      // Hard floor: never auto-trade a non-profitable edge, whatever the threshold says.
      // The list now includes near-misses (negative edge) for visibility.
      if (opp.edgePercent <= 0) break;
      // Default scope trades sports only — politics settle months out and lock capital
      if (autoExecScope === 'sports' && opp.pair.polymarket.category === 'politics') continue;
      const key = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
      if (executedPairs.current.has(key)) continue;
      // Size from the dollar budget, never beyond what the thinner book can fill — an
      // oversized leg partially fills and cancels, leaving the other one naked. sizeByRisk
      // returns 0 when the budget cannot reach the venue minimum, which is a skip, not a
      // small trade: below it the Polymarket leg is rejected while Kalshi fills.
      const betAmount = sizeByRisk({
        riskDollars,
        legAPriceCents: opp.legA.priceCents,
        legBPriceCents: opp.legB.priceCents,
        maxContracts: opp.maxContracts,
        minContracts: MIN_ORDER_CONTRACTS,
      }).contracts;
      if (betAmount <= 0) continue;

      // Require the edge to survive consecutive polls before committing real money to it.
      const streak = (edgeStreak.current.get(key) ?? 0) + 1;
      edgeStreak.current.set(key, streak);
      if (streak < EDGE_CONFIRMATIONS) continue;

      executedPairs.current.add(key);
      edgeStreak.current.delete(key);
      // Fire immediately. This used to open a 10-second confirmation countdown, which
      // defeated the point: an arb edge is usually gone within a second or two, so by the
      // time the prompt was answered the trade no longer existed. Auto-execute means
      // auto-execute — the toggle itself is the consent, and the safety checks that matter
      // (depth, funding, and a price re-check) all run server-side inside /api/execute,
      // which backs out and sends nothing if the edge has moved.
      setExecPhase({ phase: 'executing', opp, amount: betAmount, key });
      executeOpportunity(opp, betAmount, key);
      break; // one at a time
    }
  }, [data, autoExec, autoExecScope, execThreshold, riskDollars, execPhase, executeOpportunity]);

  // Close a harmless result by itself while auto-execute is on.
  //
  // The result screen takes over the whole view and the auto-exec effect refuses to fire
  // while execPhase is set, so an unattended run stopped at the first trade and waited for
  // a click that might not come for hours. Every result is already recorded in the execution
  // log, so closing it loses nothing. A naked or partial fill is the exception and stays up:
  // that is money at risk, and it should not scroll past while nobody is watching.
  useEffect(() => {
    if (!autoExec || execPhase?.phase !== 'result') { setResultCountdown(null); return; }
    if (resultNeedsAttention(execPhase.result)) { setResultCountdown(null); return; }

    setResultCountdown(Math.ceil(RESULT_AUTODISMISS_MS / 1000));
    const tick = setInterval(() => {
      setResultCountdown(prev => (prev === null ? null : Math.max(0, prev - 1)));
    }, 1000);
    const close = setTimeout(() => setExecPhase(null), RESULT_AUTODISMISS_MS);
    return () => { clearInterval(tick); clearTimeout(close); };
  }, [autoExec, execPhase]);

  function handleDismiss() {
    setExecPhase(null);
  }

  // useCallback so the memoised cards see stable props — a fresh function identity on
  // every poll would make React.memo bail out and re-render all ~100 cards anyway.
  const handleExecuteStart = useCallback((opp: ArbitrageOpportunity) => {
    // Block auto-exec from firing this pair while a manual execute is in flight.
    executedPairs.current.add(`${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`);
  }, []);

  // Remove one row from the log. Dismissing is display-only — it does not cancel or undo
  // an order that was actually placed; the position (if any) still stands at the venue.
  const dismissExecEntry = useCallback((id: string | undefined) => {
    if (!id) return;
    setExecLog(prev => prev.filter(e => e.id !== id));
  }, []);

  const handleCardExecuted = useCallback((opp: ArbitrageOpportunity, betAmount: number, result: ExecuteResponse) => {
    setExecLog(prev => [{
      id: makeExecId(),
      ts: new Date().toISOString(),
      question: opp.pair.polymarket.question,
      edgePercent: opp.edgePercent,
      amount: betAmount,
      result,
    }, ...prev].slice(0, 50));
    // Re-arm only when nothing is at risk; a naked/partial/failed leg stays blocked.
    // A price-move abort sent no orders, so it clears quickly.
    const key = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
    if (result.hedged) setTimeout(() => executedPairs.current.delete(key), 5 * 60_000);
    else if (result.noOrdersSent) setTimeout(() => executedPairs.current.delete(key), 10_000);
  }, []);

  // Derived values — MUST be computed before any early return below, or the hook
  // count changes between renders (Rules of Hooks) and React crashes the moment
  // an execution screen shows.
  const opportunities = useMemo(() => data?.opportunities ?? [], [data]);


  // Both opportunity tabs share the same controls and card list; only their scope differs.
  const isOppView = view === 'sports' || view === 'opportunities';

  // Politics can be selected on the All tab; carrying that choice into Sports would show
  // an empty list with no matching chip to clear it, so drop back to "All".
  useEffect(() => {
    if (view === 'sports' && catFilter === 'politics') setCatFilter('all');
  }, [view, catFilter]);

  // The Sports view hides politics entirely; every count and filter below derives from
  // this, so the tab is genuinely a separate list rather than a styling change.
  const viewScoped = useMemo(
    () => view === 'sports' ? opportunities.filter(o => o.pair.polymarket.category !== 'politics') : opportunities,
    [opportunities, view]
  );

  const catFiltered = useMemo(
    () => catFilter === 'all' ? viewScoped : viewScoped.filter(o => o.pair.polymarket.category === catFilter),
    [viewScoped, catFilter]
  );

  const filtered = useMemo(
    () => {
      const list =
        edgeFilter === 'arb' ? catFiltered.filter(o => o.edgePercent >= 2) :
        edgeFilter === 'strong' ? catFiltered.filter(o => o.edgePercent >= 1) :
        catFiltered;
      // The server sorts by exact edge, which changes on every reprice — two rows at 1.86%
      // and 1.85% swapped places several times a second and the whole list visibly danced.
      // Rank on a coarse bucket instead and break ties on a stable identity, so a card only
      // moves when its edge changes by an amount actually worth noticing.
      const key = (o: ArbitrageOpportunity) => `${o.pair.polymarket.id}|${o.pair.kalshi.id}`;
      const bucket = (e: number) => Math.round(e * 4) / 4;   // 0.25% steps
      return [...list].sort((a, b) => {
        const d = bucket(b.edgePercent) - bucket(a.edgePercent);
        return d !== 0 ? d : key(a).localeCompare(key(b));
      });
    },
    [catFiltered, edgeFilter]
  );

  // Profitable edges that exist but are not on screen, because of the tab or the
  // category/edge filters. Drives the empty-state hint below.
  const hiddenElsewhere = useMemo(
    () => opportunities.length - filtered.length,
    [opportunities, filtered],
  );


  const arbCount = useMemo(() => catFiltered.filter(o => o.edgePercent >= 2).length, [catFiltered]);
  const strongCount = useMemo(() => catFiltered.filter(o => o.edgePercent >= 1).length, [catFiltered]);
  // Scoped to the active tab so the Sports view never reports politics in its totals.
  const profitableCount = useMemo(() => viewScoped.filter(o => o.edgePercent > 0).length, [viewScoped]);
  // Quotes older than ~20s are worth flagging: at prediction-market speed an edge can be
  // gone by then, which is exactly the "site says arb, venue disagrees" complaint.
  // Quote age is derived from the server's builtAt stamp rather than a per-request
  // field, so the payload stays byte-identical between refreshes and can be served
  // pre-compressed. Past ~8s the refresh loop has stalled and prices aren't actionable.
  const quoteAgeMs = data?.stats.builtAt ? Date.now() - Date.parse(data.stats.builtAt) : 0;
  const quotesStale = quoteAgeMs > 8_000;

  // ── two-screen auto-exec views ─────────────────────────────────────────────
  if (execPhase?.phase === 'executing') {
    return (
      <ExecutionPendingScreen
        execPhase={execPhase}
      />
    );
  }

  if (execPhase?.phase === 'result') {
    return (
      <ExecutionResultScreen
        opp={execPhase.opp}
        amount={execPhase.amount}
        result={execPhase.result}
        onDismiss={handleDismiss}
        autoDismissSec={resultCountdown ?? undefined}
      />
    );
  }

  // ── normal market view ─────────────────────────────────────────────────────

  return (
    <div className="min-h-screen px-4 py-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Arb Finder</h1>
          <p className="text-sm text-[--text-muted] mt-1">
            Kalshi × Polymarket · MLB · NFL · CFB · Soccer · Politics
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 flex-wrap">
          <button
            onClick={() => load(true)}
            disabled={loading}
            title="Re-fetch live prices from both venues now"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:border-[#8b949e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Fetching live prices…' : 'Refresh prices'}
          </button>
        </div>
      </div>

      {/* View tabs */}
      <div className="flex gap-1 mb-5 p-1 rounded-xl w-fit" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        {(['sports', 'opportunities', 'pairs'] as const).map(v => {
          const sportsCount = data ? data.opportunities.filter(o => o.pair.polymarket.category !== 'politics').length : 0;
          const label =
            v === 'sports' ? `Sports${data ? ` (${sportsCount})` : ''}` :
            v === 'opportunities' ? `All${data ? ` (${data.opportunities.length})` : ''}` :
            // stats.matchedPairs is always sent; pairsDetail only when this tab is open.
            `Matched Pairs${data ? ` (${data.stats?.matchedPairs ?? 0})` : ''}`;
          return (
            <button
              key={v}
              onClick={() => setView(v)}
              title={v === 'sports' ? 'MLB, NFL, CFB and soccer — politics excluded' : undefined}
              style={{
                background: view === v ? 'var(--card)' : 'transparent',
                color: view === v ? 'var(--foreground)' : 'var(--text-muted)',
                border: view === v ? '1px solid var(--border)' : '1px solid transparent',
              }}
              className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Controls bar */}
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-xl px-5 py-4 mb-4 flex flex-wrap gap-5 items-end"
      >
        {/* Manual amount */}
        <div className="flex flex-col gap-1">
          <label htmlFor="arb-amount" className="text-xs text-[--text-muted]">Amount ($)</label>
          <input
            id="arb-amount"
            type="number"
            min={MIN_ORDER_CONTRACTS}
            max={100000}
            value={amount}
            onChange={e => setAmount(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            className="w-24 px-2 py-1.5 rounded-lg text-sm font-mono text-right"
          />
        </div>

        <div style={{ width: 1, height: 36, background: 'var(--border)' }} />

        {/* Risk budget — the number a trader actually thinks in. Contracts are derived. */}
        <div className="flex flex-col gap-1">
          <label htmlFor="arb-risk" className="text-xs text-[--text-muted]">Risk / trade ($)</label>
          <input
            id="arb-risk"
            type="number"
            min={1}
            step={10}
            value={riskDollars}
            onChange={e => {
              const v = parseFloat(e.target.value);
              setRiskDollars(Number.isFinite(v) && v > 0 ? v : 1);
            }}
            style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            className="w-28 px-2 py-1.5 rounded-lg text-sm font-mono text-right"
          />
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>total, both legs</span>
        </div>

        {/* Auto-exec toggle */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[--text-muted]">Auto-execute</label>
          <div className="flex items-center gap-2 h-[34px]">
            <button
              onClick={() => setAutoExec(v => !v)}
              style={{
                background: autoExec ? '#16a34a' : '#374151',
                transition: 'background 0.2s',
              }}
              className="relative w-10 h-5 rounded-full flex-shrink-0"
              aria-label="Toggle auto-execute"
            >
              <div
                style={{
                  transform: autoExec ? 'translateX(20px)' : 'translateX(2px)',
                  transition: 'transform 0.2s',
                }}
                className="absolute top-0.5 w-4 h-4 bg-white rounded-full"
              />
            </button>
            <span className="text-xs font-medium" style={{ color: autoExec ? '#4ade80' : 'var(--text-muted)' }}>
              {autoExec ? 'ON' : 'OFF'}
            </span>
          </div>
        </div>

        {/* Scope — only shown when auto-exec is on. Sports-only is the default:
            politics settle in Nov 2026 and lock capital until then. */}
        {autoExec && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[--text-muted]">Trades</label>
            <div className="flex gap-1 p-0.5 rounded-lg" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
              {([
                { value: 'sports', label: 'Sports only' },
                { value: 'all', label: 'All + politics' },
              ] as const).map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setAutoExecScope(value)}
                  style={{
                    background: autoExecScope === value ? (value === 'all' ? '#7c3aed33' : '#16a34a33') : 'transparent',
                    color: autoExecScope === value ? (value === 'all' ? '#a78bfa' : '#4ade80') : 'var(--text-muted)',
                    border: `1px solid ${autoExecScope === value ? (value === 'all' ? '#7c3aed55' : '#16a34a55') : 'transparent'}`,
                  }}
                  className="px-2.5 py-1 rounded-md text-xs font-medium transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Threshold — only shown when auto-exec is on */}
        {autoExec && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[--text-muted]">Min edge</label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0.1}
                max={20}
                step={0.1}
                value={execThreshold}
                // Clamp above zero — a negative/zero threshold would arm auto-exec on
                // the near-miss (loss-making) opportunities now shown in the list.
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  setExecThreshold(Number.isFinite(v) && v > 0 ? v : 0.1);
                }}
                style={{ background: 'var(--card)', border: `1px solid #16a34a66`, color: '#4ade80' }}
                className="w-16 px-2 py-1.5 rounded-lg text-sm font-mono text-right"
              />
              <span className="text-xs text-[--text-muted]">%</span>
            </div>
          </div>
        )}

        {autoExec && (
          <div
            style={{ background: '#16a34a11', border: '1px solid #16a34a33' }}
            className="rounded-lg px-3 py-1.5 flex items-center gap-2 self-end"
          >
            <div className="w-2 h-2 rounded-full bg-[#4ade80] animate-pulse" />
            <span className="text-xs text-[#4ade80] font-medium">
              Auto-trading {autoExecScope === 'sports' ? 'sports only' : 'all categories'} · {fmtUsd(riskDollars)}/trade · {execLog.length} executed
            </span>
          </div>
        )}

        <div style={{ width: 1, height: 36, background: 'var(--border)' }} />

        {/* Trading connection test — verifies auth + balances, places nothing */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[--text-muted]">Trading setup</label>
          <button
            onClick={handleTestConnection}
            disabled={connTest.state === 'pending'}
            style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium hover:border-[#8b949e] transition-colors disabled:opacity-50"
          >
            {connTest.state === 'pending' ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </div>

      {/* Connection test results */}
      {connTest.state === 'done' && connTest.result && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          className="rounded-xl px-5 py-3 mb-4 flex flex-col gap-2"
        >
          {([
            { label: 'Kalshi', r: connTest.result.kalshi, detail: connTest.result.kalshi.ok ? `balance $${connTest.result.kalshi.balanceDollars?.toFixed(2) ?? '?'}` : connTest.result.kalshi.error },
            // Name the wallet the balance was read FROM. A bare "$0.00" gave no way to tell
            // an unfunded account apart from one pointed at the wrong address — which is
            // exactly what happened when a real deposit landed in a different wallet.
            // Keep the balance and wallet on screen even when the check fails: a key that
            // cannot sign orders still reports a real balance, and hiding it makes a signing
            // problem look like a funding problem.
            { label: 'Polymarket', r: connTest.result.polymarket, detail: connTest.result.polymarket.usdcBalance !== undefined
              ? `PUSD $${connTest.result.polymarket.usdcBalance.toFixed(2)} · wallet ${connTest.result.polymarket.funderAddress ?? connTest.result.polymarket.address ?? '?'}${connTest.result.polymarket.canSignOrders === false ? ' · CANNOT SIGN ORDERS' : ''}`
              : connTest.result.polymarket.error },
          ] as const).map(({ label, r, detail }) => (
            <div key={label} className="flex items-start gap-2 text-xs font-mono">
              <span style={{ color: r.ok ? '#4ade80' : '#f87171' }} className="flex-shrink-0 font-bold">
                {r.ok ? '✓' : '✗'} {label}
              </span>
              <span style={{ color: 'var(--text-muted)' }} className="break-all">{detail}</span>
            </div>
          ))}
          {connTest.result.polymarket.diagnosis && (
            <p className="text-xs leading-relaxed" style={{ color: '#fbbf24' }}>
              {connTest.result.polymarket.diagnosis}
            </p>
          )}
        </div>
      )}

      {/* Stats bar */}
      {data && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          className="rounded-xl px-5 py-4 mb-4 flex flex-wrap gap-6 items-center"
        >
          {[
            { label: 'PM markets', val: data.stats.pmMarkets },
            { label: 'Kalshi markets', val: data.stats.kalshiMarkets },
            { label: 'Tracked (incl. near-miss)', val: viewScoped.length },
            { label: 'Profitable (>0%)', val: profitableCount, highlight: profitableCount > 0 },
            { label: 'True arb (≥2%)', val: viewScoped.filter(o => o.edgePercent >= 2).length, highlight: viewScoped.filter(o => o.edgePercent >= 2).length > 0 },
          ].map(({ label, val, highlight }) => (
            <div key={label}>
              <p className="text-xs text-[--text-muted]">{label}</p>
              <p className="text-lg font-bold font-mono" style={{ color: highlight ? '#4ade80' : 'var(--foreground)' }}>
                {val}
              </p>
            </div>
          ))}
          {/* Show how old the QUOTES are (server build time), not when the response
              arrived — the latter always read "just now" even on 55s-old prices. */}
          <div className="ml-auto text-xs" style={{ color: quotesStale ? '#fbbf24' : 'var(--text-muted)' }}>
            {data.stats.builtAt
              ? `Prices ${timeAgo(data.stats.builtAt)}${quotesStale ? ' — hit Refresh' : ''}`
              : lastFetch ? `Updated ${timeAgo(lastFetch)}` : ''}
          </div>
        </div>
      )}

      {/* Per-category breakdown */}
      {data?.stats.byCategory && Object.keys(data.stats.byCategory).length > 0 && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          className="rounded-xl px-5 py-3 mb-6 flex flex-wrap gap-4"
        >
          {ALL_CATEGORIES.map(cat => {
            const s = data.stats.byCategory[cat];
            if (!s) return null;
            const c = CATEGORY_COLORS[cat];
            return (
              <div key={cat} className="flex items-center gap-2">
                <span style={{ color: c.color }} className="text-xs font-semibold">{CATEGORY_LABELS[cat]}</span>
                <span className="text-xs text-[--text-muted] font-mono">
                  {s.pm}pm / {s.kalshi}kal / {s.pairs} events matched
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Category filter — opportunity views only. The Sports tab drops the Politics chip
          so the choices match what the tab can actually show. */}
      {isOppView && <div className="flex gap-2 mb-3 flex-wrap">
        {(['all', ...(view === 'sports' ? ALL_CATEGORIES.filter(c => c !== 'politics') : ALL_CATEGORIES)] as const).map(cat => {
          const isActive = catFilter === cat;
          const c = cat !== 'all' ? CATEGORY_COLORS[cat] : null;
          return (
            <button
              key={cat}
              onClick={() => setCatFilter(cat)}
              style={{
                background: isActive ? (c ? c.bg : 'var(--surface)') : 'transparent',
                border: `1px solid ${isActive ? (c ? c.border : '#8b949e') : 'var(--border)'}`,
                color: isActive ? (c ? c.color : 'var(--foreground)') : 'var(--text-muted)',
              }}
              className="px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
            >
              {cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
            </button>
          );
        })}
      </div>}

      {/* Edge filter — opportunities view only */}
      {isOppView && <div className="flex gap-2 mb-5 flex-wrap">
        {(['all', 'strong', 'arb'] as const).map(f => (
          <button
            key={f}
            onClick={() => setEdgeFilter(f)}
            style={{
              background: edgeFilter === f ? 'var(--surface)' : 'transparent',
              border: `1px solid ${edgeFilter === f ? '#8b949e' : 'var(--border)'}`,
              color: edgeFilter === f ? 'var(--foreground)' : 'var(--text-muted)',
            }}
            className="px-4 py-1.5 rounded-full text-sm font-medium transition-colors"
          >
            {f === 'all' ? `All profitable (${catFiltered.length})` :
             f === 'strong' ? `≥1% (${strongCount})` :
             `≥2% (${arbCount})`}
          </button>
        ))}
      </div>}

      {/* Content */}
      {/* `warming` means the server answered instantly with a placeholder while its cold
          discovery runs, so keep showing the spinner rather than "no edge found" — the
          poll picks up real data the moment the build lands. */}
      {(!data || data.warming) && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-8 h-8 border-2 border-[--border] border-t-[--pm-light] rounded-full animate-spin" />
          <p className="text-sm text-[--text-muted]">Fetching markets across all categories…</p>
          <p className="text-xs text-[--text-muted]">First load pages every open market on both venues — up to ~20s</p>
        </div>
      )}

      {data?.error && (
        <div
          style={{ background: '#dc262622', border: '1px solid #dc262644' }}
          className="rounded-xl p-5 mb-6"
        >
          <p className="text-sm font-semibold text-red-400">Error fetching data</p>
          <p className="text-xs text-[--text-muted] mt-1 font-mono">{data.error}</p>
        </div>
      )}

      {isOppView && (
        <>
          {data && !data.warming && filtered.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-[--text-muted]">
                {edgeFilter === 'all'
                  ? 'No profitable edge right now.'
                  : `Nothing at ${edgeFilter === 'arb' ? '≥2%' : '≥1%'} right now — ${catFiltered.length} profitable market${catFiltered.length === 1 ? '' : 's'} listed.`}
              </p>
              {/* An empty list is ambiguous: it looks identical whether nothing exists or
                  the current tab simply hides what does. Sports is the default tab and
                  excludes politics, so a session can show nothing for half an hour while
                  live edges sit one tab away. Say where they are. */}
              {hiddenElsewhere > 0 && (
                <p className="text-xs mt-2 font-medium" style={{ color: '#fbbf24' }}>
                  {hiddenElsewhere} profitable edge{hiddenElsewhere === 1 ? '' : 's'} {hiddenElsewhere === 1 ? 'is' : 'are'} hidden by the current tab or filter
                  {view === 'sports' && ' — politics is excluded from Sports; check the All tab'}.
                </p>
              )}
              {edgeFilter === 'all' && (
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
                  {data.stats.matchedPairs} markets are being tracked and re-priced about once a second.
                  Only trades that profit after fees are listed here — see Matched Pairs for everything being watched.
                </p>
              )}
            </div>
          )}
          <div className="flex flex-col gap-4">
            {filtered.map((opp, i) => {
              const k = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
              return (
                <OpportunityCard
                  key={`${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`}
                  opp={opp}
                  amount={amount}
                  riskDollars={riskDollars}
                  firstSeenAt={persistMap.get(k) ?? Date.now()}
                  onUseSuggestedSize={setAmount}
                  onExecuted={handleCardExecuted}
                  onExecuteStart={handleExecuteStart}
                />
              );
            })}
          </div>
        </>
      )}

      {view === 'pairs' && (
        <>
          {/* Category filter for pairs */}
          <div className="flex gap-2 mb-4 flex-wrap">
            {(['all', ...ALL_CATEGORIES] as const).map(cat => {
              const isActive = pairsCatFilter === cat;
              const c = cat !== 'all' ? CATEGORY_COLORS[cat] : null;
              return (
                <button
                  key={cat}
                  onClick={() => setPairsCatFilter(cat)}
                  style={{
                    background: isActive ? (c ? c.bg : 'var(--surface)') : 'transparent',
                    border: `1px solid ${isActive ? (c ? c.border : '#8b949e') : 'var(--border)'}`,
                    color: isActive ? (c ? c.color : 'var(--foreground)') : 'var(--text-muted)',
                  }}
                  className="px-3 py-1.5 rounded-full text-sm font-medium transition-colors"
                >
                  {cat === 'all' ? 'All' : CATEGORY_LABELS[cat]}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-[--text-muted] mb-4">
            Greyed-out pairs were filtered out (date too far apart or price gap &gt;25¢). Δ = aligned YES price difference between platforms.
          </p>
          <div className="flex flex-col gap-3">
            {(data?.pairsDetail ?? [])
              .filter(p => pairsCatFilter === 'all' || p.category === pairsCatFilter)
              .map(pair => <PairRow key={`${pair.pmId}|${pair.kalId}`} pair={pair} />)
            }
          </div>
        </>
      )}

      {/* Execution log */}
      {execLog.length > 0 && (
        <div className="mt-10">
          <h2 className="text-sm font-semibold mb-3">Execution Log</h2>
          <div className="flex flex-col gap-2">
            {execLog.map((entry, i) => (
              <div
                key={entry.id ?? `${entry.ts}-${i}`}
                style={{
                  background: 'var(--surface)',
                  border: `1px solid ${entry.result.hedged ? '#16a34a44' : '#f8717144'}`,
                }}
                // `group` drives the dismiss button's hover reveal; `pr-9` reserves room for
                // it so it never sits on top of the KAL/PM status text.
                className="group relative rounded-lg pl-4 pr-9 py-3 flex items-center justify-between gap-4 flex-wrap"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <p className="text-xs font-medium truncate">{entry.question}</p>
                  <p className="text-xs text-[--text-muted] font-mono">
                    {new Date(entry.ts).toLocaleTimeString()} · +{entry.edgePercent.toFixed(2)}% · {fmtUsd(entry.amount)}
                  </p>
                </div>
                <div className="flex gap-3 text-xs font-mono flex-shrink-0">
                  <span style={{ color: entry.result.kalshi.ok ? '#4ade80' : '#f87171' }}>
                    KAL {entry.result.kalshi.ok ? `✓ ${entry.result.kalshi.orderId?.slice(0, 8)}` : `✗ ${entry.result.kalshi.error?.slice(0, 30)}`}
                  </span>
                  <span style={{ color: entry.result.polymarket.ok ? '#4ade80' : '#f87171' }}>
                    PM {entry.result.polymarket.ok ? `✓ ${entry.result.polymarket.orderId?.slice(0, 8)}` : `✗ ${entry.result.polymarket.error?.slice(0, 30)}`}
                  </span>
                </div>
                {/* Hidden until the row is hovered, per the request — but also revealed on
                    keyboard focus, otherwise the control is unreachable without a mouse. */}
                <button
                  type="button"
                  onClick={() => dismissExecEntry(entry.id)}
                  aria-label="Remove this entry from the log"
                  title="Remove from log (does not cancel the order)"
                  className="absolute top-2 right-2 w-5 h-5 flex items-center justify-center rounded
                             text-sm leading-none text-[--text-muted]
                             opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                             hover:text-white hover:bg-white/10 transition-opacity cursor-pointer"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-12 pt-6 border-t border-[--border] text-xs text-[--text-muted] flex flex-wrap gap-x-6 gap-y-2">
        <span>Prices refresh every ~1.5s</span>
        <span>Fees included in edge calculation</span>
        <span>Amount = payout when winning leg resolves</span>
        <span>Risk = dollars deployed across both legs; contracts are derived per market</span>
        <span>Always verify prices before enabling auto-execute</span>
      </div>
    </div>
  );
}
