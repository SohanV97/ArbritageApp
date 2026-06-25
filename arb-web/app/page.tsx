'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArbitrageOpportunity, Category } from '@/lib/market-types';
import type { OpportunitiesResponse } from './api/opportunities/route';
import type { ExecuteResponse } from './api/execute/route';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '@/lib/categories';
import { kellyBet } from '@/lib/kelly';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtUsd(dollars: number) {
  return `$${Math.abs(dollars).toFixed(2)}`;
}

function pct(cents: number) {
  return `${Math.round(cents)}%`;
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

function OpportunityCard({ opp, amount, bankroll, onUseKelly }: {
  opp: ArbitrageOpportunity;
  amount: number;
  bankroll: number;
  onUseKelly: (n: number) => void;
}) {
  const [showDebug, setShowDebug] = useState(false);
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const isArb = edgePercent >= 0.5;
  const category = pair.polymarket.category;

  const totalCostDollars = (totalCostCents / 100) * amount;
  const payoutDollars = amount;
  const profitDollars = payoutDollars - totalCostDollars;
  const kellySuggestion = kellyBet(bankroll, edgePercent);

  const pmDate = fmtDate(pair.polymarket.resolutionTime);
  const kalDate = fmtDate(pair.kalshi.resolutionTime);
  const datesMatch = pair.polymarket.resolutionTime?.slice(0, 10) === pair.kalshi.resolutionTime?.slice(0, 10);

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
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <CategoryBadge category={category} />
          <p className="text-sm font-medium leading-snug text-[--text-muted] line-clamp-1 mt-1">
            {pair.polymarket.question}
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
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', textDecoration: 'none' }}
            className="rounded-lg p-4 flex flex-col gap-3 hover:border-[#8b949e] transition-colors cursor-pointer"
          >
            {/* Platform + Side */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <VenueBadge venue={leg.venue} />
              <SideBadge side={displaySide} />
            </div>

            {/* Question */}
            <p className="text-xs text-[--text-muted] line-clamp-2 leading-snug">{displayQuestion}</p>

            {/* Big dollar bet amount */}
            <div>
              <p className="text-xs text-[--text-muted] font-medium mb-0.5">Bet</p>
              <p className="text-3xl font-bold font-mono" style={{ color: 'var(--foreground)' }}>
                {fmtUsd(betDollars)}
              </p>
            </div>

            {/* Price + fee */}
            <div className="flex items-center justify-between text-xs text-[--text-muted] font-mono">
              <span>@ {pct(leg.priceCents)}</span>
              <span>fee {fmtUsd(feeDollars)}</span>
            </div>
          </a>
        ))}
      </div>

      {/* Summary */}
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-lg px-4 py-3 flex items-center justify-between gap-4"
      >
        <div className="flex gap-6 flex-wrap">
          <div>
            <p className="text-xs text-[--text-muted]">Total invested</p>
            <p className="text-sm font-bold font-mono">{fmtUsd(totalCostDollars)}</p>
          </div>
          <div>
            <p className="text-xs text-[--text-muted]">Payout</p>
            <p className="text-sm font-bold font-mono">{fmtUsd(payoutDollars)}</p>
          </div>
          <div>
            <p className="text-xs text-[--text-muted]">Profit</p>
            <p
              className="text-sm font-bold font-mono"
              style={{ color: edgePercent >= 0 ? '#4ade80' : '#f87171' }}
            >
              {profitDollars >= 0 ? '+' : '-'}{fmtUsd(profitDollars)}
            </p>
          </div>
        </div>
        <div className="text-xs text-[--text-muted] text-right flex flex-col gap-0.5">
          <span style={{ color: datesMatch ? 'var(--text-muted)' : '#f87171' }}>PM: {pmDate ?? '—'}</span>
          <span style={{ color: datesMatch ? 'var(--text-muted)' : '#f87171' }}>KAL: {kalDate ?? '—'}</span>
        </div>
      </div>

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

// ─── exec log ────────────────────────────────────────────────────────────────

interface ExecLogEntry {
  ts: string;
  question: string;
  edgePercent: number;
  amount: number;
  result: ExecuteResponse;
}

// ─── main page ───────────────────────────────────────────────────────────────

const ALL_CATEGORIES: Category[] = ['mlb', 'soccer', 'politics'];

export default function Home() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [edgeFilter, setEdgeFilter] = useState<'all' | 'arb' | 'near'>('all');
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all');
  const [amount, setAmount] = useState(100);

  // Auto-exec state
  const [autoExec, setAutoExec] = useState(false);
  const [execThreshold, setExecThreshold] = useState(1.5);
  const [bankroll, setBankroll] = useState(10000);
  const [execLog, setExecLog] = useState<ExecLogEntry[]>([]);
  const executedPairs = useRef(new Set<string>());
  const isFetching = useRef(false);

  const load = useCallback(async (force = false) => {
    if (isFetching.current && !force) return; // skip if a fetch is already in flight
    isFetching.current = true;
    setLoading(true);
    try {
      const res = await fetch('/api/opportunities');
      const json = await res.json() as OpportunitiesResponse;
      setData(json);
      setLastFetch(new Date().toISOString());
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      isFetching.current = false;
    }
  }, []);

  // Poll every 60s — server caches for 60s so polls after the first return instantly
  useEffect(() => {
    load();
    const id = setInterval(() => load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Auto-execute when opportunities appear and auto-exec is enabled
  useEffect(() => {
    if (!autoExec || !data) return;
    for (const opp of data.opportunities) {
      if (opp.edgePercent < execThreshold) break; // list is sorted descending
      const pairKey = `${opp.pair.polymarket.id}|${opp.pair.kalshi.id}`;
      if (executedPairs.current.has(pairKey)) continue;
      executedPairs.current.add(pairKey);

      const betAmount = kellyBet(bankroll, opp.edgePercent);
      fetch('/api/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunity: opp, amount: betAmount }),
      })
        .then(r => r.json())
        .then((result: ExecuteResponse) => {
          setExecLog(prev => [{
            ts: new Date().toISOString(),
            question: opp.pair.polymarket.question,
            edgePercent: opp.edgePercent,
            amount: betAmount,
            result,
          }, ...prev].slice(0, 50));
        })
        .catch(err => console.error('[auto-exec]', err));

      // 5-minute cooldown per pair to prevent re-executing the same opportunity
      setTimeout(() => executedPairs.current.delete(pairKey), 5 * 60_000);
    }
  }, [data, autoExec, execThreshold, bankroll]);

  const opportunities = data?.opportunities ?? [];

  const catFiltered = catFilter === 'all'
    ? opportunities
    : opportunities.filter(o => o.pair.polymarket.category === catFilter);

  const filtered =
    edgeFilter === 'arb' ? catFiltered.filter(o => o.edgePercent >= 2) :
    edgeFilter === 'near' ? catFiltered.filter(o => o.edgePercent >= 0.5 && o.edgePercent < 2) :
    catFiltered;

  const arbCount = catFiltered.filter(o => o.edgePercent >= 2).length;
  const nearCount = catFiltered.filter(o => o.edgePercent >= 0.5 && o.edgePercent < 2).length;

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
              Auto-trading active · Kelly sizing · {execLog.length} executed
            </span>
          </div>
        )}
      </div>

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

      {/* Category filter */}
      <div className="flex gap-2 mb-3 flex-wrap">
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
              {cat === 'all' ? 'All sports' : CATEGORY_LABELS[cat]}
            </button>
          );
        })}
      </div>

      {/* Edge filter */}
      <div className="flex gap-2 mb-5">
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
      </div>

      {/* Content */}
      {loading && !data && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-8 h-8 border-2 border-[--border] border-t-[--pm-light] rounded-full animate-spin" />
          <p className="text-sm text-[--text-muted]">Fetching markets across all categories…</p>
          <p className="text-xs text-[--text-muted]">This takes 15–40s on first load</p>
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
        {filtered.map((opp, i) => (
          <OpportunityCard
            key={`${opp.pair.polymarket.id}-${i}`}
            opp={opp}
            amount={amount}
            bankroll={bankroll}
            onUseKelly={setAmount}
          />
        ))}
      </div>

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
        <span>Prices refresh every 15s</span>
        <span>Fees included in edge calculation</span>
        <span>Amount = payout when winning leg resolves</span>
        <span>Kelly = fractional Kelly sizing based on bankroll</span>
        <span>Always verify prices before enabling auto-execute</span>
      </div>
    </div>
  );
}
