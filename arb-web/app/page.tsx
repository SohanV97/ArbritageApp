'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import type { OpportunitiesResponse } from './api/opportunities/route';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(cents: number) {
  return `${cents}¢`;
}

function pct(cents: number) {
  return `${(cents / 100).toFixed(0)}%`;
}

function edge(ep: number) {
  return ep.toFixed(2);
}

function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

// ─── sub-components ─────────────────────────────────────────────────────────

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
      +{edge(ep)}%
    </span>
  );
}

function OpportunityCard({ opp }: { opp: ArbitrageOpportunity }) {
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const isArb = edgePercent >= 0.5;

  return (
    <div
      style={{
        background: 'var(--card)',
        border: `1px solid ${isArb ? (edgePercent >= 2 ? '#16a34a44' : '#d9770644') : 'var(--border)'}`,
        boxShadow: isArb ? `0 0 0 1px ${edgePercent >= 2 ? '#16a34a22' : '#d9770622'}` : 'none',
      }}
      className="rounded-xl p-5 flex flex-col gap-4"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
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
              <span className="text-xs text-[--text-muted] font-mono">
                {leg.side.toUpperCase()}
              </span>
            </div>
            <p className="text-xs text-[--text-muted] line-clamp-2 leading-snug">
              {market.question}
            </p>
            <div className="flex items-center justify-between mt-1">
              <span className="text-base font-bold font-mono">
                {pct(leg.priceCents)}
              </span>
              <span className="text-xs text-[--text-muted] font-mono">
                fee {fmt(leg.feeCents)}
              </span>
            </div>
          </a>
        ))}
      </div>

      {/* Summary row */}
      <div
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        className="rounded-lg px-4 py-3 flex items-center justify-between gap-4"
      >
        <div className="flex gap-6">
          <div>
            <p className="text-xs text-[--text-muted]">Total cost</p>
            <p className="text-sm font-bold font-mono">{fmt(totalCostCents)}</p>
          </div>
          <div>
            <p className="text-xs text-[--text-muted]">Payout</p>
            <p className="text-sm font-bold font-mono">100¢</p>
          </div>
          <div>
            <p className="text-xs text-[--text-muted]">Profit / $100 bet</p>
            <p
              className="text-sm font-bold font-mono"
              style={{ color: edgePercent >= 0.5 ? '#4ade80' : '#8b949e' }}
            >
              ${((edgePercent / 100) * 100).toFixed(2)}
            </p>
          </div>
        </div>
        <div className="text-xs text-[--text-muted] text-right">
          {pair.kalshi.resolutionTime
            ? new Date(pair.kalshi.resolutionTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
            : ''}
        </div>
      </div>
    </div>
  );
}

// ─── main page ───────────────────────────────────────────────────────────────

export default function Home() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastFetch, setLastFetch] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'arb' | 'near'>('all');

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

  // Load on mount, then every 90s
  useEffect(() => {
    load();
    const id = setInterval(load, 90_000);
    return () => clearInterval(id);
  }, [load]);

  const opportunities = data?.opportunities ?? [];
  const filtered =
    filter === 'arb' ? opportunities.filter(o => o.edgePercent >= 2) :
    filter === 'near' ? opportunities.filter(o => o.edgePercent >= 0.5 && o.edgePercent < 2) :
    opportunities;

  const arbCount = opportunities.filter(o => o.edgePercent >= 2).length;

  return (
    <div className="min-h-screen px-4 py-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">MLB Arb Finder</h1>
          <p className="text-sm text-[--text-muted] mt-1">
            Kalshi × Polymarket · live moneyline arbitrage
          </p>
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

      {/* Stats bar */}
      {data && (
        <div
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
          className="rounded-xl px-5 py-4 mb-6 flex flex-wrap gap-6 items-center"
        >
          {[
            { label: 'Polymarket games', val: data.stats.pmMarkets },
            { label: 'Kalshi games', val: data.stats.kalshiMarkets },
            { label: 'Matched pairs', val: data.stats.matchedPairs },
            { label: 'Opportunities', val: opportunities.length },
            { label: 'True arb (≥2%)', val: arbCount, highlight: arbCount > 0 },
          ].map(({ label, val, highlight }) => (
            <div key={label}>
              <p className="text-xs text-[--text-muted]">{label}</p>
              <p
                className="text-lg font-bold font-mono"
                style={{ color: highlight ? '#4ade80' : 'var(--foreground)' }}
              >
                {val}
              </p>
            </div>
          ))}
          <div className="ml-auto text-xs text-[--text-muted]">
            {lastFetch ? `Updated ${timeAgo(lastFetch)}` : ''}
          </div>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 mb-5">
        {(['all', 'arb', 'near'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              background: filter === f ? 'var(--surface)' : 'transparent',
              border: `1px solid ${filter === f ? '#8b949e' : 'var(--border)'}`,
              color: filter === f ? 'var(--foreground)' : 'var(--text-muted)',
            }}
            className="px-4 py-1.5 rounded-full text-sm font-medium transition-colors"
          >
            {f === 'all' ? `All (${opportunities.length})` :
             f === 'arb' ? `True arb ≥2% (${arbCount})` :
             `Near miss 0.5–2% (${opportunities.filter(o => o.edgePercent >= 0.5 && o.edgePercent < 2).length})`}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading && !data && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <div className="w-8 h-8 border-2 border-[--border] border-t-[--pm-light] rounded-full animate-spin" />
          <p className="text-sm text-[--text-muted]">Fetching markets from Kalshi and Polymarket…</p>
          <p className="text-xs text-[--text-muted]">This takes 10–30s on first load (paginating both APIs)</p>
        </div>
      )}

      {data?.error && (
        <div
          style={{ background: '#dc262622', border: '1px solid #dc262644' }}
          className="rounded-xl p-5 mb-6"
        >
          <p className="text-sm font-semibold text-red-400">Error fetching data</p>
          <p className="text-xs text-[--text-muted] mt-1 font-mono">{data.error}</p>
          <p className="text-xs text-[--text-muted] mt-2">
            Note: Kalshi&apos;s API may block browser requests (CORS). This app calls APIs server-side, so it should work — but Kalshi may require an API key.
          </p>
        </div>
      )}

      {data && !loading && filtered.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-[--text-muted]">
            {filter === 'all'
              ? 'No matched pairs found right now. Markets may be closed or prices are too far apart.'
              : `No ${filter === 'arb' ? 'true arb' : 'near-miss'} opportunities right now.`}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {filtered.map((opp, i) => (
          <OpportunityCard key={`${opp.pair.polymarket.id}-${i}`} opp={opp} />
        ))}
      </div>

      {/* Footer */}
      <div className="mt-12 pt-6 border-t border-[--border] text-xs text-[--text-muted] flex flex-wrap gap-x-6 gap-y-2">
        <span>Prices refresh every 90s</span>
        <span>Fees included in edge calculation</span>
        <span>Always verify prices before placing trades</span>
      </div>
    </div>
  );
}
