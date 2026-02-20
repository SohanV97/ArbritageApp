import { useCallback, useEffect } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useArbitrageOpportunities } from '@/hooks/useArbitrageOpportunities';
import type { ArbitrageOpportunity } from '@/lib/market-types';

function OpportunityCard({
  opp,
  onOpenPolymarket,
  onOpenKalshi,
}: {
  opp: ArbitrageOpportunity;
  onOpenPolymarket: (url: string) => void;
  onOpenKalshi: (url: string) => void;
}) {
  const { pair, legA, legB, totalCostCents, edgePercent } = opp;
  const legLabel = (v: string, s: string) =>
    `${v === 'polymarket' ? 'Polymarket' : 'Kalshi'} ${s.toUpperCase()}`;

  return (
    <ThemedView style={styles.card}>
      <ThemedText type="defaultSemiBold" numberOfLines={2} style={styles.question}>
        {pair.polymarket.question}
      </ThemedText>
      <ThemedText style={styles.legs}>
        {legLabel(legA.venue, legA.side)} @ {legA.priceCents}¢ (+{legA.feeCents}¢) ·{' '}
        {legLabel(legB.venue, legB.side)} @ {legB.priceCents}¢ (+{legB.feeCents}¢)
      </ThemedText>
      <ThemedText style={styles.edge}>
        Cost: ${(totalCostCents / 100).toFixed(2)} · Edge: {edgePercent.toFixed(2)}%
      </ThemedText>
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
  const { opportunities, loading, error, refresh, stats } = useArbitrageOpportunities({
    minEdgePercent: 0,
  });

  useEffect(() => {
    refresh();
  }, [refresh]);

  const openUrl = useCallback((url: string) => {
    Linking.openURL(url).catch(() => {});
  }, []);

  if (loading && opportunities.length === 0) {
    return (
      <ThemedView style={styles.centered}>
        <ActivityIndicator size="large" />
        <ThemedText style={styles.loadingText}>Loading markets…</ThemedText>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ThemedView style={styles.header}>
        <ThemedText type="title">Arb opportunities</ThemedText>
        <ThemedText type="subtitle" style={styles.subtitle}>
          Kalshi vs Polymarket — place trades manually
        </ThemedText>
        {stats ? (
          <ThemedText style={styles.stats}>
            PM sports: {stats.pmSports}/{stats.pmTotal} · Kalshi sports: {stats.kalshiSports}/
            {stats.kalshiTotal} · Matched: {stats.matchedPairs}
          </ThemedText>
        ) : null}
        <Pressable style={styles.refreshButton} onPress={refresh} disabled={loading}>
          <ThemedText type="defaultSemiBold">{loading ? 'Refreshing…' : 'Refresh'}</ThemedText>
        </Pressable>
      </ThemedView>
      {error ? (
        <ThemedView style={styles.error}>
          <ThemedText style={styles.errorText}>{error}</ThemedText>
        </ThemedView>
      ) : null}
      <FlatList
        data={opportunities}
        keyExtractor={(item) =>
          `${item.pair.polymarket.id}-${item.pair.kalshi.id}-${item.legA.side}-${item.legB.side}`
        }
        renderItem={({ item }) => (
          <OpportunityCard
            opp={item}
            onOpenPolymarket={openUrl}
            onOpenKalshi={openUrl}
          />
        )}
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
  refreshButton: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
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
    paddingVertical: 12,
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
