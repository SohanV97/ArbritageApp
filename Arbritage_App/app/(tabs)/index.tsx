import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  Text,
} from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';

import { useArbitrageOpportunities } from '@/hooks/useArbitrageOpportunities';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import { estimatePolymarketFeeCents, estimateKalshiFeeCents } from '@/lib/fees';
import type { PolymarketMarketKind } from '@/lib/fees';

// ─────────────── DESIGN TOKENS ───────────────
const C = {
  pm: '#7C3AED',          // Polymarket purple
  kal: '#2563EB',         // Kalshi blue
  arb: '#16A34A',         // positive edge green
  thin: '#D97706',        // marginal edge amber
  danger: '#DC2626',
  cardLight: '#FFFFFF',
  cardDark: '#1C2128',
  bgLight: '#F3F6FA',
  bgDark: '#0D1117',
  surface1Light: '#EFF4FB',
  surface1Dark: '#161B22',
  border: '#E2E8F0',
  borderDark: '#30363D',
};

// ─────────────── ALLOCATION HELPER ───────────────
function allocationForRisk(
  opp: ArbitrageOpportunity,
  riskDollars: number
): { spendPM: number; spendKal: number; contracts: number } | null {
  if (riskDollars <= 0 || !Number.isFinite(riskDollars)) return null;
  const { pair, legA, legB } = opp;
  if (legA.priceCents < 1 || legB.priceCents < 1) return null;
  const priceSumDollars = (legA.priceCents + legB.priceCents) / 100;
  if (priceSumDollars <= 0) return null;
  const n = riskDollars / priceSumDollars;
  const kind: PolymarketMarketKind =
    (pair.polymarket as unknown as { polymarketFeeKind?: PolymarketMarketKind })
      .polymarketFeeKind ?? 'fee_free';

  const feeA = legA.venue === 'polymarket'
    ? estimatePolymarketFeeCents(kind, legA.priceCents, n)
    : estimateKalshiFeeCents(legA.priceCents, n);
  const feeB = legB.venue === 'polymarket'
    ? estimatePolymarketFeeCents(kind, legB.priceCents, n)
    : estimateKalshiFeeCents(legB.priceCents, n);

  const spendA = n * (legA.priceCents / 100) + feeA / 100;
  const spendB = n * (legB.priceCents / 100) + feeB / 100;
  return {
    spendPM: legA.venue === 'polymarket' ? spendA : spendB,
    spendKal: legA.venue === 'kalshi' ? spendA : spendB,
    contracts: Math.floor(n * 10) / 10,
  };
}

// ─────────────── SUB-COMPONENTS ───────────────
function VenuePill({ venue }: { venue: string }) {
  const isPM = venue === 'polymarket';
  return (
    <View style={[s.venuePill, { backgroundColor: isPM ? C.pm : C.kal }]}>
      <Text style={s.venuePillText}>{isPM ? 'PM' : 'KAL'}</Text>
    </View>
  );
}

function StatChip({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  const isDark = useColorScheme() === 'dark';
  return (
    <View style={[s.statChip, { backgroundColor: isDark ? C.surface1Dark : C.surface1Light }]}>
      <Text style={[s.statChipValue, { color: accent ?? (isDark ? '#E5E7EB' : '#1F2937') }]}>
        {value}
      </Text>
      <Text style={s.statChipLabel}>{label}</Text>
    </View>
  );
}

function OpportunityCard({
  opp,
  riskDollars,
  onOpen,
}: {
  opp: ArbitrageOpportunity;
  riskDollars: number;
  onOpen: (url: string) => void;
}) {
  const isDark = useColorScheme() === 'dark';
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const pm = pair.polymarket;
  const k = pair.kalshi;
  const allocation = allocationForRisk(opp, riskDollars);
  const hasArb = edgePercent > 0;
  const edgeColor = edgePercent >= 1.5 ? C.arb : C.thin;

  const gameTitle = pm.question.replace(/\s*\[.*?\]\s*$/, '').trim();
  const titleColor = isDark ? '#F3F4F6' : '#111827';
  const subColor   = isDark ? '#9CA3AF' : '#6B7280';
  const oddsBg     = isDark ? C.surface1Dark : '#F8FAFC';
  const divColor   = isDark ? C.borderDark : C.border;
  const footerBorder = isDark ? '#21262D' : '#F1F5F9';

  return (
    <View style={[s.card, { backgroundColor: isDark ? C.cardDark : C.cardLight }]}>

      {/* ── Title row ── */}
      <View style={s.cardTitleRow}>
        <Text style={[s.gameTitle, { color: titleColor }]} numberOfLines={2}>
          {gameTitle}
        </Text>
        {hasArb ? (
          <View style={[s.edgeBadge, { backgroundColor: edgeColor }]}>
            <Text style={s.edgeBadgeText}>{edgePercent.toFixed(1)}%</Text>
          </View>
        ) : (
          <View style={[s.edgeBadge, { backgroundColor: isDark ? '#21262D' : '#F1F5F9' }]}>
            <Text style={[s.edgeBadgeText, { color: subColor }]}>0%</Text>
          </View>
        )}
      </View>

      {/* ── Current odds ── */}
      <View style={[s.oddsRow, { backgroundColor: oddsBg }]}>
        <View style={s.oddsSide}>
          <Text style={[s.oddsVenue, { color: C.pm }]}>Polymarket</Text>
          <View style={s.oddsPrices}>
            <Text style={[s.oddsLabel, { color: subColor }]}>YES</Text>
            <Text style={[s.oddsNum, { color: titleColor }]}>{pm.yesPriceCents}¢</Text>
            <Text style={[s.oddsLabel, { color: subColor, marginLeft: 10 }]}>NO</Text>
            <Text style={[s.oddsNum, { color: titleColor }]}>{pm.noPriceCents}¢</Text>
          </View>
        </View>
        <View style={[s.dividerV, { backgroundColor: divColor }]} />
        <View style={s.oddsSide}>
          <Text style={[s.oddsVenue, { color: C.kal }]}>Kalshi</Text>
          <View style={s.oddsPrices}>
            <Text style={[s.oddsLabel, { color: subColor }]}>YES</Text>
            <Text style={[s.oddsNum, { color: titleColor }]}>{k.yesPriceCents}¢</Text>
            <Text style={[s.oddsLabel, { color: subColor, marginLeft: 10 }]}>NO</Text>
            <Text style={[s.oddsNum, { color: titleColor }]}>{k.noPriceCents}¢</Text>
          </View>
        </View>
      </View>

      {/* ── Bet legs ── */}
      <View style={s.legsSection}>
        {[legA, legB].map((leg, i) => (
          <View key={i} style={s.legRow}>
            <VenuePill venue={leg.venue} />
            <Text style={[s.legText, { color: titleColor }]}>
              {leg.side.toUpperCase()}
              <Text style={{ color: subColor, fontWeight: '400' }}>
                {' @ '}{leg.priceCents}¢{leg.feeCents > 0 ? ` +${leg.feeCents}¢ fee` : ''}
              </Text>
            </Text>
          </View>
        ))}
      </View>

      {/* ── Cost / profit ── */}
      <View style={[s.costRow, { borderTopColor: footerBorder }]}>
        <Text style={[s.costText, { color: subColor }]}>
          Cost{' '}
          <Text style={[s.costValue, { color: titleColor }]}>
            ${(totalCostCents / 100).toFixed(2)}
          </Text>
        </Text>
        {hasArb && (
          <Text style={[s.profitText, { color: edgeColor }]}>
            +${((100 - totalCostCents) / 100).toFixed(2)} profit
          </Text>
        )}
      </View>

      {/* ── Allocation ── */}
      {allocation !== null && riskDollars > 0 && (
        <View style={[s.allocationBox, {
          backgroundColor: hasArb
            ? 'rgba(22,163,74,0.08)'
            : (isDark ? '#21262D' : '#F8FAFC'),
        }]}>
          <Text style={[s.allocationText, { color: subColor }]}>
            ${riskDollars} risk →{' '}
            <Text style={[s.allocationBold, { color: titleColor }]}>
              ${allocation.spendPM.toFixed(2)} PM
            </Text>
            {' + '}
            <Text style={[s.allocationBold, { color: titleColor }]}>
              ${allocation.spendKal.toFixed(2)} Kalshi
            </Text>
            {'  '}({allocation.contracts}x)
          </Text>
        </View>
      )}

      {/* ── Action buttons ── */}
      <View style={s.cardActions}>
        <Pressable
          style={[s.actionBtn, { backgroundColor: C.pm }]}
          onPress={() => onOpen(pm.url)}
        >
          <Text style={s.actionBtnText}>Polymarket</Text>
        </Pressable>
        <Pressable
          style={[s.actionBtn, { backgroundColor: C.kal }]}
          onPress={() => onOpen(k.url)}
        >
          <Text style={s.actionBtnText}>Kalshi</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─────────────── MAIN SCREEN ───────────────
export default function HomeScreen() {
  const isDark = useColorScheme() === 'dark';
  const { opportunities, pmMarkets, kalshiMarkets, loading, error, refresh, stats } =
    useArbitrageOpportunities({ minEdgePercent: 0 });
  const [riskInput, setRiskInput] = useState('100');
  const [showDebug, setShowDebug] = useState(false);

  useEffect(() => { refresh(); }, [refresh]);

  const openUrl = useCallback((url: string) => {
    Linking.openURL(url).catch(() => {});
  }, []);

  const riskDollars = (() => {
    const n = parseFloat(riskInput.replace(/,/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();

  const arbCount = opportunities.filter(o => o.edgePercent > 0).length;

  const titleColor = isDark ? '#F9FAFB' : '#111827';
  const subColor   = isDark ? '#9CA3AF' : '#6B7280';
  const bgColor    = isDark ? C.bgDark : C.bgLight;
  const surfaceColor = isDark ? C.surface1Dark : C.surface1Light;
  const borderColor  = isDark ? C.borderDark : C.border;

  if (loading && opportunities.length === 0) {
    return (
      <View style={[s.centered, { backgroundColor: bgColor }]}>
        <ActivityIndicator size="large" color={C.arb} />
        <Text style={[s.loadingText, { color: subColor }]}>Scanning MLB markets…</Text>
      </View>
    );
  }

  const header = (
    <View style={[s.headerWrap, { backgroundColor: bgColor }]}>
      {/* Title + Refresh */}
      <View style={s.titleRow}>
        <View>
          <Text style={[s.screenTitle, { color: titleColor }]}>MLB Arb Scanner</Text>
          <Text style={[s.screenSub, { color: subColor }]}>Kalshi vs Polymarket</Text>
        </View>
        <Pressable
          style={[s.refreshBtn, loading && { opacity: 0.5 }]}
          onPress={refresh}
          disabled={loading}
        >
          <Text style={s.refreshBtnText}>{loading ? 'Loading…' : 'Refresh'}</Text>
        </Pressable>
      </View>

      {/* Stat chips */}
      {stats && (
        <View style={s.statsRow}>
          <StatChip label="PM markets" value={stats.pmSports} />
          <StatChip label="Kalshi" value={stats.kalshiSports} />
          <StatChip label="Matched" value={stats.matchedPairs} />
          <StatChip label="Arb opps" value={arbCount} accent={arbCount > 0 ? C.arb : undefined} />
        </View>
      )}

      {/* Risk input card */}
      <View style={[s.riskCard, { backgroundColor: surfaceColor, borderColor }]}>
        <Text style={[s.riskCardLabel, { color: subColor }]}>RISK PER TRADE</Text>
        <View style={s.riskInputRow}>
          <Text style={[s.dollarPrefix, { color: subColor }]}>$</Text>
          <TextInput
            style={[s.riskInput, { color: titleColor }]}
            value={riskInput}
            onChangeText={setRiskInput}
            placeholder="100"
            placeholderTextColor={isDark ? '#4B5563' : '#CBD5E1'}
            keyboardType="decimal-pad"
          />
        </View>
      </View>

      {/* Error */}
      {error ? (
        <View style={s.errorBox}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Section header */}
      <View style={s.sectionHeaderRow}>
        <Text style={[s.sectionTitle, { color: titleColor }]}>
          {opportunities.length > 0
            ? `${opportunities.length} matched game${opportunities.length === 1 ? '' : 's'}`
            : loading ? 'Fetching…' : 'No markets found — tap Refresh'}
        </Text>
        <Pressable onPress={() => setShowDebug(v => !v)}>
          <Text style={[s.debugToggle, { color: subColor }]}>{showDebug ? 'Hide' : 'Debug'}</Text>
        </Pressable>
      </View>

      {/* Debug panel */}
      {showDebug && (
        <View style={[s.debugBox, { backgroundColor: surfaceColor, borderColor }]}>
          <Text style={[s.debugSectionLabel, { color: subColor }]}>
            Polymarket ({pmMarkets.length})
          </Text>
          {pmMarkets.slice(0, 30).map(m => (
            <Pressable key={m.id} onPress={() => openUrl(m.url)} style={s.debugItem}>
              <Text style={[s.debugItemText, { color: subColor }]} numberOfLines={1}>
                {m.question}
              </Text>
            </Pressable>
          ))}
          <View style={[s.debugDivider, { backgroundColor: borderColor }]} />
          <Text style={[s.debugSectionLabel, { color: subColor }]}>
            Kalshi ({kalshiMarkets.length})
          </Text>
          {kalshiMarkets.slice(0, 30).map(m => (
            <Pressable key={m.id} onPress={() => openUrl(m.url)} style={s.debugItem}>
              <Text style={[s.debugItemText, { color: subColor }]} numberOfLines={1}>
                {m.question}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {opportunities.length > 0 && (
        <Text style={[s.listHint, { color: subColor }]}>
          {arbCount > 0 ? `${arbCount} with positive edge ↓` : 'Prices matched — no edge yet'}
        </Text>
      )}
    </View>
  );

  return (
    <View style={[s.container, { backgroundColor: bgColor }]}>
      <FlatList
        data={opportunities}
        keyExtractor={item =>
          `${item.pair.polymarket.id}-${item.pair.kalshi.id}-${item.legA.side}`
        }
        renderItem={({ item }) => (
          <OpportunityCard
            opp={item}
            riskDollars={riskDollars}
            onOpen={openUrl}
          />
        )}
        ListHeaderComponent={header}
        contentContainerStyle={s.listContent}
        ListEmptyComponent={
          !loading && !error ? (
            <View style={s.emptyWrap}>
              <Text style={[s.emptyTitle, { color: subColor }]}>No MLB games found</Text>
              <Text style={[s.emptySub, { color: isDark ? '#4B5563' : '#CBD5E1' }]}>
                Tap Refresh to scan again
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

// ─────────────── STYLES ───────────────
const s = StyleSheet.create({
  container: { flex: 1 },
  listContent: { paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  loadingText: { fontSize: 16, fontWeight: '500' },

  // Header
  headerWrap: { paddingTop: 56, paddingHorizontal: 16, paddingBottom: 8, gap: 16 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  screenTitle: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  screenSub: { fontSize: 13, marginTop: 2 },

  refreshBtn: {
    backgroundColor: C.arb,
    paddingVertical: 9,
    paddingHorizontal: 20,
    borderRadius: 22,
    marginTop: 4,
  },
  refreshBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Stats
  statsRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  statChip: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    minWidth: 64,
  },
  statChipValue: { fontSize: 20, fontWeight: '800' },
  statChipLabel: {
    fontSize: 10,
    color: '#9CA3AF',
    marginTop: 1,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  // Risk card
  riskCard: {
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    gap: 6,
  },
  riskCardLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  riskInputRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dollarPrefix: { fontSize: 22, fontWeight: '700' },
  riskInput: { flex: 1, fontSize: 28, fontWeight: '800' },

  // Error
  errorBox: {
    backgroundColor: 'rgba(220,38,38,0.1)',
    borderRadius: 10,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: C.danger,
  },
  errorText: { color: C.danger, fontSize: 13, fontWeight: '500' },

  // Section header
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 4,
  },
  sectionTitle: { fontSize: 15, fontWeight: '700' },
  debugToggle: { fontSize: 13 },
  listHint: { fontSize: 12, textAlign: 'center', paddingBottom: 4 },

  // Debug
  debugBox: { borderRadius: 12, padding: 12, borderWidth: 1, gap: 2 },
  debugSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  debugItem: { paddingVertical: 3 },
  debugItemText: { fontSize: 12 },
  debugDivider: { height: 1, marginVertical: 8 },

  // Opportunity card
  card: {
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 20,
    padding: 16,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  gameTitle: { flex: 1, fontSize: 17, fontWeight: '700', lineHeight: 23 },
  edgeBadge: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minWidth: 50,
    alignItems: 'center',
  },
  edgeBadgeText: { color: '#fff', fontSize: 13, fontWeight: '800' },

  // Odds
  oddsRow: {
    flexDirection: 'row',
    borderRadius: 12,
    padding: 12,
    gap: 0,
  },
  oddsSide: { flex: 1, gap: 4 },
  oddsVenue: { fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  oddsPrices: { flexDirection: 'row', alignItems: 'center' },
  oddsLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.3 },
  oddsNum: { fontSize: 15, fontWeight: '800', marginLeft: 4 },
  dividerV: { width: 1, marginHorizontal: 12 },

  // Legs
  legsSection: { gap: 7 },
  legRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  venuePill: { borderRadius: 7, paddingHorizontal: 8, paddingVertical: 3 },
  venuePillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  legText: { fontSize: 14, fontWeight: '700' },

  // Cost
  costRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 10,
    borderTopWidth: 1,
  },
  costText: { fontSize: 14 },
  costValue: { fontWeight: '700' },
  profitText: { fontSize: 14, fontWeight: '800' },

  // Allocation
  allocationBox: { borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  allocationText: { fontSize: 13 },
  allocationBold: { fontWeight: '700' },

  // Action buttons
  cardActions: { flexDirection: 'row', gap: 10 },
  actionBtn: { flex: 1, borderRadius: 12, paddingVertical: 11, alignItems: 'center' },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },

  // Empty
  emptyWrap: { paddingTop: 60, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptySub: { fontSize: 14 },
});
