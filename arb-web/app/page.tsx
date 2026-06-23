'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ArbitrageOpportunity, Category } from '@/lib/market-types';
import type { OpportunitiesResponse } from './api/opportunities/route';
import { CATEGORY_LABELS, CATEGORY_COLORS } from '@/lib/categories';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtUsd(dollars: number) {
  return `$${dollars.toFixed(2)}`;
}

function pct(cents: number) {
  return `${(cents / 100).toFixed(0)}%`;
}

function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function fmtDate(iso: string | undefined) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
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

function EdgeBadge({ ep }: { ep: number }) {
  const color = ep >= 2 ? '#4ade80' : ep >= 0.5 ? '#fbbf24' : '#8b949e';
  const bg = ep >= 2 ? '#16a34a22' : ep >= 0.5 ? '#d9770622' : '#8b949e11';
  const border = ep >= 2 ? '#16a34a44' : ep >= 0.5 ? '#d9770644' : '#8b949e33';
  return (
    <span
      style={{ background: bg, color, border: `1px solid ${border}` }}
      className="text-sm font-bold px-3 py-1 rounded-full font-mono"
    >
      +{ep.toFixed(2)}%
    </span>
  );
}

function OpportunityCard({ opp, contracts }: { opp: ArbitrageOpportunity; contracts: number }) {
  const [showDebug, setShowDebug] = useState(false);
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const isArb = edgePercent >= 0.5;
  const category = pair.polymarket.category;

  const totalCostDollars = (totalCostCents / 100) * contracts;
  const payoutDollars = contracts;
  const profitDollars = (edgePercent / 100) * contracts;

  const pmDate = fmtDate(pair.polymarket.resolutionTime);
  const kalDate = fmtDate(pair.kalshi.resolutionTime);
  const datesMatch = pair.polymarket.resolutionTime?.slice(0, 10) === pair.kalshi.resolutionTime?.slice(0, 10);

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
          <div className="flex items-center gap-2">
            <CategoryBadge category={category} />
          </div>
          <p className="text-sm font-medium leading-snug text-[--text-muted] line-clamp-1">
            {pair.polymarket.question}
          </p>
        </div>
        <EdgeBadge ep={edgePercent} />
      </div>

      {/* Two legs */}
      <div className="grid grid-cols-2 gap-3">
        {[
          { leg: legA, market: legA.venue === 'polymarket' ? pair.polymarket : pair.kalshi, label: 'Leg A' },
          { leg: legB, market: legB.venue === 'polymarket' ? pair.polymarket : pair.kalshi, label: 'Leg B' },
        ].map(({ leg, market, label }) => (
          <a
            key={label}
            href={market.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            className="rounded-lg p-3 flex flex-col gap-2 hover:border-[#8b949e] transition-colors cursor-pointer"
          >
            <div className="flex items-center justify-between">
              <VenueBadge venue={leg.venue} />
              <span className="text-xs text-[--text-muted] font-mono">{leg.side.toUpperCase()}</span>
            </div>
            <p className="text-xs text-[--text-muted] line-clamp-2 leading-snug">{market.question}</p>
            <div className="flex items-center justify-between mt-1">
              <span className="text-base font-bold font-mono">{pct(leg.priceCents)}</span>
              <span className="text-xs text-[--text-muted] font-mono">
                fee {fmtUsd((leg.feeCents / 100) * contracts)}
              </span>
            </div>
          </a>
        ))}
      </div>

      {/* Summary */}
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-lg px-4 py-3 flex items-center justify-between gap-4"
      >
        <div className="flex gap-6">
          <div>
            <p className="text-xs text-[--text-muted]">Total cost</p>
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
              style={{ color: edgePercent >= 0.5 ? '#4ade80' : '#8b949e' }}
            >
              {fmtUsd(profitDollars)}
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

// ─── main page ───────────────────────────────────────────────────────────────

const ALL_CATEGORIES: Category[] = ['mlb', 'soccer', 'politics'];

export default function Home() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [edgeFilter, setEdgeFilter] = useState<'all' | 'arb' | 'near'>('all');
  const [catFilter, setCatFilter] = useState<Category | 'all'>('all');
  const [contracts, setContracts] = useState(100);

  const load = useCallback(async () => {
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
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 90_000);
    return () => clearInterval(id);
  }, [load]);

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
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Arb Finder</h1>
          <p className="text-sm text-[--text-muted] mt-1">
            Kalshi × Polymarket · MLB · Soccer · Politics
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <label className="text-xs text-[--text-muted] whitespace-nowrap">Contracts</label>
            <input
              type="number"
              min={1}
              max={10000}
              value={contracts}
              onChange={e => setContracts(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              className="w-20 px-2 py-1.5 rounded-lg text-sm font-mono text-right"
            />
          </div>
          <button
            onClick={load}
            disabled={loading}
            style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            className="px-4 py-2 rounded-lg text-sm font-medium hover:border-[#8b949e] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
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
            { label: 'Matched pairs', val: data.stats.matchedPairs },
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
                  {s.pm}pm / {s.kalshi}kal / {s.pairs} pairs
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
            contracts={contracts}
          />
        ))}
      </div>

      <div className="mt-12 pt-6 border-t border-[--border] text-xs text-[--text-muted] flex flex-wrap gap-x-6 gap-y-2">
        <span>Prices refresh every 90s</span>
        <span>Fees included in edge calculation</span>
        <span>Contracts = max payout in dollars per pair</span>
        <span>Always verify prices before placing trades</span>
      </div>
    </div>
  );
}
