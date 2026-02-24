import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  StyleSheet,
  TextInput,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';
import { useArbitrageOpportunities } from '@/hooks/useArbitrageOpportunities';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import { estimatePolymarketFeeCents, estimateKalshiFeeCents } from '@/lib/fees';
import type { PolymarketMarketKind } from '@/lib/fees';

function allocationForRisk(
  opp: ArbitrageOpportunity,
  riskDollars: number
): { spendPolymarket: number; spendKalshi: number; contracts: number } | null {
  if (riskDollars <= 0 || !Number.isFinite(riskDollars)) return null;
  const { pair, legA, legB } = opp;
  if (legA.priceCents < 1 || legB.priceCents < 1) return null;
  const priceSumDollars = (legA.priceCents + legB.priceCents) / 100;
  if (priceSumDollars <= 0) return null;
  const n = riskDollars / priceSumDollars;
  const kind: PolymarketMarketKind =
    (pair.polymarket as unknown as { polymarketFeeKind?: PolymarketMarketKind })
      .polymarketFeeKind ?? 'fee_free';

  const feeA =
    legA.venue === 'polymarket'
      ? estimatePolymarketFeeCents(kind, legA.priceCents, n)
      : estimateKalshiFeeCents(legA.priceCents, n);
  const feeB =
    legB.venue === 'polymarket'
      ? estimatePolymarketFeeCents(kind, legB.priceCents, n)
      : estimateKalshiFeeCents(legB.priceCents, n);

  const spendA = n * (legA.priceCents / 100) + feeA / 100;
  const spendB = n * (legB.priceCents / 100) + feeB / 100;

  const spendPolymarket = legA.venue === 'polymarket' ? spendA : spendB;
  const spendKalshi = legA.venue === 'kalshi' ? spendA : spendB;

  return {
    spendPolymarket,
    spendKalshi,
    contracts: Math.floor(n * 100) / 100,
  };
}

function OpportunityCard({
  opp,
  riskDollars,
  onOpenPolymarket,
  onOpenKalshi,
}: {
  opp: ArbitrageOpportunity;
  riskDollars: number;
  onOpenPolymarket: (url: string) => void;
  onOpenKalshi: (url: string) => void;
}) {
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const legLabel = (v: string, s: string) =>
    `${v === 'polymarket' ? 'Polymarket' : 'Kalshi'} ${s.toUpperCase()}`;
  const allocation = allocationForRisk(opp, riskDollars);

  const pm = pair.polymarket;
  const k = pair.kalshi;

  return (
    <ThemedView style={styles.card}>
      <ThemedText type="defaultSemiBold" numberOfLines={2} style={styles.question}>
        {pair.polymarket.question}
      </ThemedText>
      <ThemedText style={styles.oddsLine}>
        Polymarket: Yes {pm.yesPriceCents}¢ / No {pm.noPriceCents}¢ · Kalshi: Yes {k.yesPriceCents}¢ / No {k.noPriceCents}¢
      </ThemedText>
      <ThemedText style={styles.legs}>
        Bet: {legLabel(legA.venue, legA.side)} @ {legA.priceCents}¢ (+{legA.feeCents}¢) ·{' '}
        {legLabel(legB.venue, legB.side)} @ {legB.priceCents}¢ (+{legB.feeCents}¢)
      </ThemedText>
      <ThemedText style={styles.edge}>
        Cost: ${(totalCostCents / 100).toFixed(2)} · Edge: {edgePercent.toFixed(2)}%
      </ThemedText>
      {allocation && (
        <ThemedView style={styles.allocation}>
          <ThemedText style={styles.allocationText}>
            For your risk: put <ThemedText type="defaultSemiBold">${allocation.spendPolymarket.toFixed(2)}</ThemedText> on Polymarket and{' '}
            <ThemedText type="defaultSemiBold">${allocation.spendKalshi.toFixed(2)}</ThemedText> on Kalshi
            {' '}({allocation.contracts.toFixed(2)} contracts each)
          </ThemedText>
        </ThemedView>
      )}
      <ThemedView style={styles.actions}>
        <Pressable
          style={styles.linkButton}
          onPress={() => onOpenPolymarket(pair.polymarket.url)}
        >
          <ThemedText type="link">Open Polymarket</ThemedText>
        </Pressable>
        <Pressable style={styles.linkButton} onPress={() => onOpenKalshi(pair.kalshi.url)}>
          <ThemedText type="link">Open Kalshi</ThemedText>
        </Pressable>
      </ThemedView>
    </ThemedView>
  );
}

export default function HomeScreen() {
  const { opportunities, pmMarkets, kalshiMarkets, loading, error, refresh, stats } = useArbitrageOpportunities({
    minEdgePercent: 0,
  });
  const [riskInput, setRiskInput] = useState('100');
  const [showFetched, setShowFetched] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openUrl = useCallback((url: string) => {
    Linking.openURL(url).catch(() => {});
  }, []);

  const riskDollars = (() => {
    const n = parseFloat(riskInput.replace(/,/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  })();

  const inputBg = useThemeColor({}, 'background');
  const inputColor = useThemeColor({}, 'text');
  const riskInputStyle = {
    ...styles.riskInput,
    backgroundColor: inputBg === '#fff' || inputBg === '#ffffff' ? '#f0f0f0' : '#2a2a2a',
    color: inputColor,
  };

  if (loading && opportunities.length === 0) {
    return (
      <ThemedView style={styles.centered}>
        <ActivityIndicator size="large" />
        <ThemedText style={styles.loadingText}>Loading markets…</ThemedText>
      </ThemedView>
    );
  }

  const listHeader = (
    <>
      <ThemedView style={styles.header}>
        <ThemedText type="title">Arb opportunities</ThemedText>
        <ThemedText type="subtitle" style={styles.subtitle}>
          Kalshi vs Polymarket — place trades manually
        </ThemedText>
        <ThemedView style={styles.riskRow}>
          <ThemedText style={styles.riskLabel}>Amount to risk ($)</ThemedText>
          <TextInput
            style={riskInputStyle}
            value={riskInput}
            onChangeText={setRiskInput}
            placeholder="100"
            placeholderTextColor="#888"
            keyboardType="decimal-pad"
          />
        </ThemedView>
        {stats ? (
          <ThemedText style={styles.stats}>
            PM sports: {stats.pmSports}/{stats.pmTotal} · Kalshi sports: {stats.kalshiSports}/
            {stats.kalshiTotal} · Matched: {stats.matchedPairs}
          </ThemedText>
        ) : null}
        <Pressable style={styles.refreshButton} onPress={refresh} disabled={loading}>
          <ThemedText type="defaultSemiBold">{loading ? 'Refreshing…' : 'Refresh'}</ThemedText>
        </Pressable>
        <Pressable style={styles.refreshButton} onPress={() => setShowFetched((v) => !v)}>
          <ThemedText type="defaultSemiBold">
            {showFetched ? 'Hide fetched markets' : 'Show fetched markets'}
          </ThemedText>
        </Pressable>
      </ThemedView>
      {error ? (
        <ThemedView style={styles.error}>
          <ThemedText style={styles.errorText}>{error}</ThemedText>
        </ThemedView>
      ) : null}
      {showFetched ? (
        <ThemedView style={styles.debugBox}>
          <ThemedText type="defaultSemiBold" style={styles.debugTitle}>
            Fetched basketball markets
          </ThemedText>
          <ThemedText style={styles.debugSubtitle}>
            Polymarket: {pmMarkets.length} · Kalshi: {kalshiMarkets.length}
          </ThemedText>
          <ThemedText type="defaultSemiBold" style={styles.debugSection}>
            Polymarket (first 20)
          </ThemedText>
          {pmMarkets.slice(0, 100).map((m) => (
            <Pressable key={m.id} onPress={() => openUrl(m.url)} style={styles.debugRow}>
              <ThemedText numberOfLines={1} style={styles.debugRowText}>
                {m.question}
              </ThemedText>
            </Pressable>
          ))}
          <ThemedText type="defaultSemiBold" style={styles.debugSection}>
            Kalshi (first 20)
          </ThemedText>
          {kalshiMarkets.slice(0, 200).map((m) => (
            <Pressable key={m.id} onPress={() => openUrl(m.url)} style={styles.debugRow}>
              <ThemedText numberOfLines={1} style={styles.debugRowText}>
                {m.question}
              </ThemedText>
            </Pressable>
          ))}
        </ThemedView>
      ) : null}
    </>
  );

  return (
    <ThemedView style={styles.container}>
      <FlatList
        data={opportunities}
        keyExtractor={(item) =>
          `${item.pair.polymarket.id}-${item.pair.kalshi.id}-${item.legA.side}-${item.legB.side}`
        }
        renderItem={({ item }) => (
          <OpportunityCard
            opp={item}
            riskDollars={riskDollars}
            onOpenPolymarket={openUrl}
            onOpenKalshi={openUrl}
          />
        )}
        ListHeaderComponent={listHeader}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          !loading && !error ? (
            <ThemedView style={styles.empty}>
              <ThemedText>No sports arbitrage opportunities right now.</ThemedText>
              <ThemedText>Tap “Refresh” to check again.</ThemedText>
            </ThemedView>
          ) : null
        }
      />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    marginTop: 8,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 32,
    paddingBottom: 8,
    gap: 4,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '400',
    marginBottom: 8,
  },
  stats: {
    fontSize: 12,
    opacity: 0.85,
    marginBottom: 4,
  },
  riskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  riskLabel: {
    fontSize: 15,
  },
  riskInput: {
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.2)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 100,
    fontSize: 16,
  },
  refreshButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  debugBox: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.15)',
    gap: 6,
  },
  debugTitle: {
    fontSize: 14,
  },
  debugSubtitle: {
    fontSize: 12,
    opacity: 0.85,
  },
  debugSection: {
    marginTop: 6,
    fontSize: 13,
  },
  debugRow: {
    paddingVertical: 4,
  },
  debugRowText: {
    fontSize: 12,
    opacity: 0.9,
  },
  error: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 80, 80, 0.15)',
  },
  errorText: {
    color: '#c00',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  card: {
    padding: 14,
    marginBottom: 14,
    borderRadius: 14,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.08)',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  question: {
    fontSize: 16,
    lineHeight: 22,
  },
  oddsLine: {
    fontSize: 13,
    opacity: 0.9,
    lineHeight: 18,
  },
  legs: {
    fontSize: 13,
    opacity: 0.9,
    lineHeight: 18,
  },
  edge: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 4,
  },
  allocation: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.1)',
  },
  allocationText: {
    fontSize: 13,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 8,
  },
  linkButton: {
    paddingVertical: 4,
  },
  empty: {
    paddingVertical: 32,
    alignItems: 'center',
  },
});
