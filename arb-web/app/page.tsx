'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ArbitrageOpportunity, Category } from '@/lib/market-types';
import type { OpportunitiesResponse, PairInfo } from './api/opportunities/route';
import type { ExecuteResponse, ConnectionTestResponse } from './api/execute/route';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '@/lib/categories';
import { kellyBet } from '@/lib/kelly';

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

function PairRow({ pair }: { pair: PairInfo }) {
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
}

// ─── OpportunityCard ────────────────────────────────────────────────────────

interface CardExecState {
  state: 'idle' | 'pending' | 'ok' | 'err';
  result?: ExecuteResponse;
}

function OpportunityCard({ opp, amount, bankroll, persistence, onUseKelly, onExecuted }: {
  opp: ArbitrageOpportunity;
  amount: number;
  bankroll: number;
  persistence: number;
  onUseKelly: (n: number) => void;
  onExecuted: (opp: ArbitrageOpportunity, amount: number, result: ExecuteResponse) => void;
}) {
  const [showDebug, setShowDebug] = useState(false);
  const [cardExec, setCardExec] = useState<CardExecState>({ state: 'idle' });
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const isArb = edgePercent >= 0.5;
  const category = pair.polymarket.category;

  const totalCostDollars = (totalCostCents / 100) * amount;
  const payoutDollars = amount;
  const profitDollars = payoutDollars - totalCostDollars;
  // Cap the Kelly suggestion at what the Kalshi book can actually fill —
  // a $690 suggestion against a 19-contract book is fiction.
  const kellyRaw = kellyBet(bankroll, edgePercent);
  const kellySuggestion = opp.maxContracts != null ? Math.min(kellyRaw, opp.maxContracts) : kellyRaw;
  const exceedsDepth = opp.maxContracts != null && amount > opp.maxContracts;

  const pmDate = fmtDate(pair.polymarket.resolutionTime);
  const kalDate = fmtDate(pair.kalshi.resolutionTime);
  // Politics pairs are matched on (state, chamber, year), not date — PM settles on
  // election day while Kalshi settles at swearing-in, so differing raw dates are normal.
  const datesMatch = category === 'politics'
    || pair.polymarket.resolutionTime?.slice(0, 10) === pair.kalshi.resolutionTime?.slice(0, 10);

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
    setCardExec({ state: 'pending' });
    try {
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity: opp, amount }),
      });
      const result = await res.json() as ExecuteResponse;
      setCardExec({ state: result.bothOk ? 'ok' : 'err', result });
      onExecuted(opp, amount, result);
    } catch (err) {
      const result: ExecuteResponse = {
        kalshi: { ok: false, error: String(err) },
        polymarket: { ok: false, error: String(err) },
        executedAt: new Date().toISOString(),
        bothOk: false,
      };
      setCardExec({ state: 'err', result });
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
            {persistence >= 2 && (
              <span
                style={{ background: '#0284c711', color: '#7dd3fc', border: '1px solid #0284c733' }}
                className="text-xs px-2 py-0.5 rounded-full font-mono"
              >
                Seen {persistence}× · {persistence * 7}s
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
          <button
            onClick={() => onUseKelly(kellySuggestion)}
            className="text-xs font-mono hover:underline"
            style={{ color: '#fbbf24' }}
          >
            Kelly: {fmtUsd(kellySuggestion)}
          </button>
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
                depth ≈ {fmtUsd(opp.maxContracts)} at this price
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
          <p className="text-xs text-[--text-muted]">Profit</p>
          <p className="text-sm font-bold font-mono" style={{ color: edgePercent >= 0 ? '#4ade80' : '#f87171' }}>
            {profitDollars >= 0 ? '+' : '-'}{fmtUsd(profitDollars)}
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
          Amount exceeds visible Kalshi book depth — the order may only partially fill at this price.
        </p>
      )}

      {/* Per-card execute button / inline result */}
      {cardExec.state === 'idle' && (
        <button
          onClick={handleCardExecute}
          style={{ background: '#16a34a', color: 'white' }}
          className="w-full py-2.5 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          Execute — invest {fmtUsd(totalCostDollars)}, profit +{fmtUsd(profitDollars)}
        </button>
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
          className="w-full py-2.5 rounded-lg px-4 flex items-center justify-between gap-3"
        >
          <div className="flex gap-4 text-xs font-mono">
            <span style={{ color: cardExec.result.kalshi.ok ? '#4ade80' : '#f87171' }}>
              KAL {cardExec.result.kalshi.ok
                ? `✓ ${cardExec.result.kalshi.orderId?.slice(0, 10) ?? 'placed'}`
                : `✗ ${cardExec.result.kalshi.error?.slice(0, 24) ?? 'error'}`}
            </span>
            <span style={{ color: cardExec.result.polymarket.ok ? '#4ade80' : '#f87171' }}>
              PM {cardExec.result.polymarket.ok
                ? `✓ ${cardExec.result.polymarket.orderId?.slice(0, 10) ?? 'placed'}`
                : `✗ ${cardExec.result.polymarket.error?.slice(0, 24) ?? 'error'}`}
            </span>
          </div>
          <button
            onClick={() => setCardExec({ state: 'idle' })}
            className="text-xs hover:text-[--foreground] transition-colors"
            style={{ color: 'var(--text-muted)' }}
          >
            ✕
          </button>
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
}

// ─── ExecutionPendingScreen ──────────────────────────────────────────────────

type PendingPhase = { phase: 'pending'; opp: ArbitrageOpportunity; amount: number; countdown: number; key: string };
type ExecutingPhase = { phase: 'executing'; opp: ArbitrageOpportunity; amount: number; key: string };

function ExecutionPendingScreen({
  execPhase,
  onCancel,
  onExecuteNow,
}: {
  execPhase: PendingPhase | ExecutingPhase;
  onCancel: () => void;
  onExecuteNow: () => void;
}) {
  const { opp, amount } = execPhase;
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const isPending = execPhase.phase === 'pending';
  const countdown = isPending ? execPhase.countdown : 0;

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

          {/* Countdown or spinner */}
          {isPending ? (
            <>
              <div className="mb-5">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Auto-executing in</span>
                  <span className="text-lg font-bold font-mono" style={{ color: '#fbbf24' }}>{countdown}s</span>
                </div>
                <div style={{ background: '#fbbf2420', height: 8, borderRadius: 4 }}>
                  <div
                    style={{
                      background: '#fbbf24',
                      width: `${(countdown / 10) * 100}%`,
                      height: '100%',
                      borderRadius: 4,
                      transition: 'width 1s linear',
                    }}
                  />
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={onCancel}
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                  className="flex-1 py-3 rounded-xl text-sm font-medium hover:border-[#8b949e] transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={onExecuteNow}
                  style={{ background: '#16a34a', color: 'white' }}
                  className="flex-1 py-3 rounded-xl text-sm font-bold hover:opacity-90 transition-opacity"
                >
                  Execute Now
                </button>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center gap-3 py-5">
              <div className="w-5 h-5 border-2 border-[--border] border-t-[#fbbf24] rounded-full animate-spin" />
              <span className="text-sm" style={{ color: 'var(--text-muted)' }}>Placing orders on both platforms…</span>
            </div>
          )}
        </div>

        {isPending && (
          <p className="text-xs text-center mt-4" style={{ color: 'var(--text-muted)' }}>
            Market scanning continues in background · prices refresh every 7s
          </p>
        )}
      </div>
    </div>
  );
}

// ─── ExecutionResultScreen ───────────────────────────────────────────────────

function ExecutionResultScreen({
  opp,
  amount,
  result,
  onDismiss,
}: {
  opp: ArbitrageOpportunity;
  amount: number;
  result: ExecuteResponse;
  onDismiss: () => void;
}) {
  const { pair, totalCostCents, edgePercent } = opp;
  const bothOk = result.bothOk;
  const profitDollars = amount - (totalCostCents / 100) * amount;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <div
          style={{
            background: 'var(--card)',
            border: `1px solid ${bothOk ? '#16a34a55' : '#dc262655'}`,
            boxShadow: `0 0 60px ${bothOk ? '#16a34a12' : '#dc262612'}`,
          }}
          className="rounded-2xl p-8"
        >
          {/* Header */}
          <div className="flex items-center gap-4 mb-7">
            <div
              style={{
                background: bothOk ? '#16a34a22' : '#dc262622',
                border: `1px solid ${bothOk ? '#16a34a55' : '#dc262655'}`,
                color: bothOk ? '#4ade80' : '#f87171',
              }}
              className="w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold flex-shrink-0"
            >
              {bothOk ? '✓' : '✗'}
            </div>
            <div>
              <h2 className="text-xl font-bold">{bothOk ? 'Execution Complete' : 'Execution Failed'}</h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {new Date(result.executedAt).toLocaleString()}
              </p>
            </div>
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

          {/* Leg results */}
          <div className="flex flex-col gap-3 mb-6">
            {([
              { label: 'Kalshi', res: result.kalshi },
              { label: 'Polymarket', res: result.polymarket },
            ] as const).map(({ label, res }) => (
              <div
                key={label}
                style={{
                  background: 'var(--surface)',
                  border: `1px solid ${res.ok ? '#16a34a33' : '#dc262633'}`,
                }}
                className="rounded-xl px-4 py-3 flex items-center justify-between gap-4"
              >
                <span className="text-sm font-semibold">{label}</span>
                <div className="text-right">
                  {res.ok ? (
                    <div>
                      <p className="text-sm font-mono" style={{ color: '#4ade80' }}>✓ Order placed</p>
                      {res.orderId && (
                        <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {res.orderId}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm font-mono" style={{ color: '#f87171' }}>
                      ✗ {res.error?.slice(0, 50) ?? 'Failed'}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {bothOk && (
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
              background: bothOk ? '#16a34a' : 'var(--surface)',
              color: bothOk ? 'white' : 'var(--foreground)',
              border: bothOk ? 'none' : '1px solid var(--border)',
            }}
            className="w-full py-3 rounded-xl text-sm font-bold hover:opacity-90 transition-opacity"
          >
            Back to Markets
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── exec log ────────────────────────────────────────────────────────────────

interface ExecLogEntry {
  ts: string;
  question: string;
  edgePercent: number;
  amount: number;
  result: ExecuteResponse;
}

// ─── exec phase type ────────────────────────────────────────────────────────

type ExecPhase =
  | PendingPhase
  | ExecutingPhase
  | { phase: 'result'; opp: ArbitrageOpportunity; amount: number; result: ExecuteResponse };

// ─── main page ───────────────────────────────────────────────────────────────

const ALL_CATEGORIES: Category[] = ['mlb', 'soccer', 'politics'];
const COUNTDOWN_START = 10;

export default function Home() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [view, setView] = useState<'opportunities' | 'pairs'>('opportunities');
  const [edgeFilter, setEdgeFilter] = useState<'all' | 'arb' | 'near'>('all');
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all');
  const [pairsCatFilter, setPairsCatFilter] = useState<Category | 'all'>('all');
  const [amount, setAmount] = useState(100);

  // Persistence tracking: how many consecutive polls each opportunity has appeared in
  const [persistMap, setPersistMap] = useState<Map<string, number>>(new Map());

  // Auto-exec state
  const [autoExec, setAutoExec] = useState(false);
  // 'sports' (default) skips politics: those markets settle months out (Nov 2026),
  // locking capital the whole time. 'all' opts in explicitly.
  const [autoExecScope, setAutoExecScope] = useState<'sports' | 'all'>('sports');
  const [execThreshold, setExecThreshold] = useState(1.5);
  const [bankroll, setBankroll] = useState(10000);
  const [execLog, setExecLog] = useState<ExecLogEntry[]>([]);
  const [execPhase, setExecPhase] = useState<ExecPhase | null>(null);
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

  const executeOpportunity = useCallback(async (opp: ArbitrageOpportunity, betAmount: number, key: string) => {
    try {
      const res = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity: opp, amount: betAmount }),
      });
      const result = await res.json() as ExecuteResponse;
      setExecPhase({ phase: 'result', opp, amount: betAmount, result });
      setExecLog(prev => [{
        ts: new Date().toISOString(),
        question: opp.pair.polymarket.question,
        edgePercent: opp.edgePercent,
        amount: betAmount,
        result,
      }, ...prev].slice(0, 50));
      // 5-minute cooldown per pair
      setTimeout(() => executedPairs.current.delete(key), 5 * 60_000);
    } catch (err) {
      const result: ExecuteResponse = {
        kalshi: { ok: false, error: String(err) },
        polymarket: { ok: false, error: String(err) },
        executedAt: new Date().toISOString(),
        bothOk: false,
      };
      setExecPhase({ phase: 'result', opp, amount: betAmount, result });
    }
  }, []);

  const load = useCallback(async (force = false) => {
    if (isFetching.current && !force) return;
    // Cancel any in-flight request so a manual Refresh always wins
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    isFetching.current = true;
    setLoading(true);
    try {
      const res = await fetch('/api/opportunities', { signal: abortRef.current.signal });
      const json = await res.json() as OpportunitiesResponse;
      setData(json);
      setLastFetch(new Date().toISOString());
      setPersistMap(prev => {
        const next = new Map<string, number>();
        for (const opp of (json.opportunities ?? [])) {
          const k = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
          next.set(k, (prev.get(k) ?? 0) + 1);
        }
        return next;
      });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e);
    } finally {
      setLoading(false);
      isFetching.current = false;
    }
  }, []);

  // Poll every 7s
  useEffect(() => {
    load();
    const id = setInterval(() => load(), 7_000);
    return () => clearInterval(id);
  }, [load]);

  // Auto-exec: queue a pending execution when a new qualifying opportunity appears
  useEffect(() => {
    if (!autoExec || !data || execPhase !== null) return;
    for (const opp of data.opportunities) {
      if (opp.edgePercent < execThreshold) break;
      // Default scope trades sports only — politics settle months out and lock capital
      if (autoExecScope === 'sports' && opp.pair.polymarket.category === 'politics') continue;
      const key = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
      if (executedPairs.current.has(key)) continue;
      executedPairs.current.add(key);
      const betAmount = kellyBet(bankroll, opp.edgePercent);
      setExecPhase({ phase: 'pending', opp, amount: betAmount, countdown: COUNTDOWN_START, key });
      break; // one at a time
    }
  }, [data, autoExec, autoExecScope, execThreshold, bankroll, execPhase]);

  // Countdown: decrement every second, fire when it hits 0
  useEffect(() => {
    if (!execPhase || execPhase.phase !== 'pending') return;
    if (execPhase.countdown <= 0) {
      const { opp, amount: betAmount, key } = execPhase;
      setExecPhase({ phase: 'executing', opp, amount: betAmount, key });
      executeOpportunity(opp, betAmount, key);
      return;
    }
    const id = setTimeout(() => {
      setExecPhase(prev =>
        prev?.phase === 'pending' ? { ...prev, countdown: prev.countdown - 1 } : prev
      );
    }, 1000);
    return () => clearTimeout(id);
  }, [execPhase, executeOpportunity]);

  function handleCancel() {
    if (execPhase?.phase === 'pending') {
      executedPairs.current.delete(execPhase.key);
    }
    setExecPhase(null);
  }

  function handleExecuteNow() {
    if (execPhase?.phase !== 'pending') return;
    const { opp, amount: betAmount, key } = execPhase;
    setExecPhase({ phase: 'executing', opp, amount: betAmount, key });
    executeOpportunity(opp, betAmount, key);
  }

  function handleDismiss() {
    setExecPhase(null);
  }

  function handleCardExecuted(opp: ArbitrageOpportunity, betAmount: number, result: ExecuteResponse) {
    setExecLog(prev => [{
      ts: new Date().toISOString(),
      question: opp.pair.polymarket.question,
      edgePercent: opp.edgePercent,
      amount: betAmount,
      result,
    }, ...prev].slice(0, 50));
  }

  // ── two-screen auto-exec views ─────────────────────────────────────────────
  if (execPhase?.phase === 'pending' || execPhase?.phase === 'executing') {
    return (
      <ExecutionPendingScreen
        execPhase={execPhase as PendingPhase | ExecutingPhase}
        onCancel={handleCancel}
        onExecuteNow={handleExecuteNow}
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
      />
    );
  }

  // ── normal market view ─────────────────────────────────────────────────────

  const opportunities = useMemo(() => data?.opportunities ?? [], [data]);

  const catFiltered = useMemo(
    () => catFilter === 'all' ? opportunities : opportunities.filter(o => o.pair.polymarket.category === catFilter),
    [opportunities, catFilter]
  );

  const filtered = useMemo(
    () =>
      edgeFilter === 'arb' ? catFiltered.filter(o => o.edgePercent >= 2) :
      edgeFilter === 'near' ? catFiltered.filter(o => o.edgePercent >= 0.5 && o.edgePercent < 2) :
      catFiltered,
    [catFiltered, edgeFilter]
  );

  const arbCount = useMemo(() => catFiltered.filter(o => o.edgePercent >= 2).length, [catFiltered]);
  const nearCount = useMemo(() => catFiltered.filter(o => o.edgePercent >= 0.5 && o.edgePercent < 2).length, [catFiltered]);

  return (
    <div className="min-h-screen px-4 py-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Arb Finder</h1>
          <p className="text-sm text-[--text-muted] mt-1">
            Kalshi × Polymarket · MLB · Soccer · Politics
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0 flex-wrap">
          <button
            onClick={() => load(true)}
            disabled={loading}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:border-[#8b949e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* View tabs */}
      <div className="flex gap-1 mb-5 p-1 rounded-xl w-fit" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        {(['opportunities', 'pairs'] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            style={{
              background: view === v ? 'var(--card)' : 'transparent',
              color: view === v ? 'var(--foreground)' : 'var(--text-muted)',
              border: view === v ? '1px solid var(--border)' : '1px solid transparent',
            }}
            className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
          >
            {v === 'opportunities' ? `Opportunities${data ? ` (${data.opportunities.length})` : ''}` : `Matched Pairs${data ? ` (${data.pairsDetail?.length ?? 0})` : ''}`}
          </button>
        ))}
      </div>

      {/* Controls bar */}
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-xl px-5 py-4 mb-4 flex flex-wrap gap-5 items-end"
      >
        {/* Manual amount */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[--text-muted]">Amount ($)</label>
          <input
            type="number"
            min={1}
            max={100000}
            value={amount}
            onChange={e => setAmount(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            className="w-24 px-2 py-1.5 rounded-lg text-sm font-mono text-right"
          />
        </div>

        <div style={{ width: 1, height: 36, background: 'var(--border)' }} />

        {/* Bankroll */}
        <div className="flex flex-col gap-1">
          <label className="text-xs text-[--text-muted]">Bankroll ($)</label>
          <input
            type="number"
            min={1}
            value={bankroll}
            onChange={e => setBankroll(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
            className="w-28 px-2 py-1.5 rounded-lg text-sm font-mono text-right"
          />
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
                onChange={e => setExecThreshold(parseFloat(e.target.value) || 1.5)}
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
              Auto-trading {autoExecScope === 'sports' ? 'sports only' : 'all categories'} · Kelly sizing · {execLog.length} executed
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
            { label: 'Polymarket', r: connTest.result.polymarket, detail: connTest.result.polymarket.ok ? `USDC $${connTest.result.polymarket.usdcBalance?.toFixed(2) ?? '?'} · allowance $${connTest.result.polymarket.usdcAllowance?.toFixed(2) ?? '?'}` : connTest.result.polymarket.error },
          ] as const).map(({ label, r, detail }) => (
            <div key={label} className="flex items-start gap-2 text-xs font-mono">
              <span style={{ color: r.ok ? '#4ade80' : '#f87171' }} className="flex-shrink-0 font-bold">
                {r.ok ? '✓' : '✗'} {label}
              </span>
              <span style={{ color: 'var(--text-muted)' }} className="break-all">{detail}</span>
            </div>
          ))}
          {connTest.result.polymarket.ok && (connTest.result.polymarket.usdcAllowance ?? 0) === 0 && (connTest.result.polymarket.usdcBalance ?? 0) > 0 && (
            <p className="text-xs" style={{ color: '#fbbf24' }}>
              USDC present but exchange allowance is 0 — approve once via a small trade on the Polymarket website, then re-test.
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
            { label: 'Opportunities', val: opportunities.length },
            { label: 'True arb (≥2%)', val: opportunities.filter(o => o.edgePercent >= 2).length, highlight: opportunities.filter(o => o.edgePercent >= 2).length > 0 },
          ].map(({ label, val, highlight }) => (
            <div key={label}>
              <p className="text-xs text-[--text-muted]">{label}</p>
              <p className="text-lg font-bold font-mono" style={{ color: highlight ? '#4ade80' : 'var(--foreground)' }}>
                {val}
              </p>
            </div>
          ))}
          <div className="ml-auto text-xs text-[--text-muted]">
            {lastFetch ? `Updated ${timeAgo(lastFetch)}` : ''}
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

      {/* Category filter — opportunities view only */}
      {view === 'opportunities' && <div className="flex gap-2 mb-3 flex-wrap">
        {(['all', ...ALL_CATEGORIES] as const).map(cat => {
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
      {view === 'opportunities' && <div className="flex gap-2 mb-5">
        {(['all', 'arb', 'near'] as const).map(f => (
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
            {f === 'all' ? `All (${catFiltered.length})` :
             f === 'arb' ? `True arb ≥2% (${arbCount})` :
             `Near miss 0.5–2% (${nearCount})`}
          </button>
        ))}
      </div>}

      {/* Content */}
      {loading && !data && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-8 h-8 border-2 border-[--border] border-t-[--pm-light] rounded-full animate-spin" />
          <p className="text-sm text-[--text-muted]">Fetching markets across all categories…</p>
          <p className="text-xs text-[--text-muted]">This takes 3–6s on first load</p>
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

      {view === 'opportunities' && (
        <>
          {data && !loading && filtered.length === 0 && (
            <div className="py-16 text-center">
              <p className="text-[--text-muted]">
                {edgeFilter === 'all'
                  ? 'No matched pairs found right now.'
                  : `No ${edgeFilter === 'arb' ? 'true arb' : 'near-miss'} opportunities right now.`}
              </p>
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
                  bankroll={bankroll}
                  persistence={persistMap.get(k) ?? 1}
                  onUseKelly={setAmount}
                  onExecuted={handleCardExecuted}
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
                key={i}
                style={{
                  background: 'var(--surface)',
                  border: `1px solid ${entry.result.bothOk ? '#16a34a44' : '#f8717144'}`,
                }}
                className="rounded-lg px-4 py-3 flex items-center justify-between gap-4 flex-wrap"
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
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-12 pt-6 border-t border-[--border] text-xs text-[--text-muted] flex flex-wrap gap-x-6 gap-y-2">
        <span>Prices refresh every 7s</span>
        <span>Fees included in edge calculation</span>
        <span>Amount = payout when winning leg resolves</span>
        <span>Kelly = fractional Kelly sizing based on bankroll</span>
        <span>Always verify prices before enabling auto-execute</span>
      </div>
    </div>
  );
}
