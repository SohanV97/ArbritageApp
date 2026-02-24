import { useCallback, useState } from 'react';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import type { UnifiedMarket } from '@/lib/market-types';
import { getPolymarketBasketballMarkets } from '@/api/polymarket';
import { getKalshiBasketballMarkets } from '@/api/kalshi';
import { matchMarkets } from '@/lib/matchMarkets';
import { findArbitrageOpportunities, type PairWithKind } from '@/lib/arbitrage';

export interface ArbStats {
  pmTotal: number;
  pmSports: number;
  kalshiTotal: number;
  kalshiSports: number;
  matchedPairs: number;
}

export function useArbitrageOpportunities(options?: { minEdgePercent?: number }) {
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [pmMarkets, setPmMarkets] = useState<UnifiedMarket[]>([]);
  const [kalshiMarkets, setKalshiMarkets] = useState<UnifiedMarket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ArbStats | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pmMarkets, kalshiMarkets] = await Promise.all([
        getPolymarketBasketballMarkets(120),
        getKalshiBasketballMarkets(),
      ]);
      const sportsPm = pmMarkets;
      const sportsKalshi = kalshiMarkets;

      const pairs = matchMarkets(sportsPm, sportsKalshi, {
        minTitleSimilarity: 0.12,
        minOverlapTokens: 2,
        requireSameDay: false,
      });
      const typedPairs = pairs as PairWithKind[];
      const opps = findArbitrageOpportunities(typedPairs, options?.minEdgePercent ?? 0);
      // #region agent log
      if (opps.length > 0) {
        const o = opps[0];
        const pm = o.pair.polymarket;
        const k = o.pair.kalshi;
        const pairData = { pmQuestion: (pm.question || '').slice(0, 70), pmYes: pm.yesPriceCents, pmNo: pm.noPriceCents, kalshiQuestion: (k.question || '').slice(0, 70), kalshiYes: k.yesPriceCents, kalshiNo: k.noPriceCents };
        fetch('http://127.0.0.1:7864/ingest/1db4401f-b144-4aed-9aa6-5a1876b1005e', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6ebff7' }, body: JSON.stringify({ sessionId: '6ebff7', location: 'useArbitrageOpportunities', message: 'First pair PM vs Kalshi', data: pairData, timestamp: Date.now(), hypothesisId: 'H3' }) }).catch(() => {});
        console.log('[DEBUG] first pair PM vs Kalshi:', JSON.stringify(pairData));
      }
      // #endregion
      setOpportunities(opps);
      setPmMarkets(sportsPm);
      setKalshiMarkets(sportsKalshi);
      setStats({
        pmTotal: pmMarkets.length,
        pmSports: sportsPm.length,
        kalshiTotal: kalshiMarkets.length,
        kalshiSports: sportsKalshi.length,
        matchedPairs: pairs.length,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setOpportunities([]);
      setPmMarkets([]);
      setKalshiMarkets([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [options?.minEdgePercent]);

  return { opportunities, pmMarkets, kalshiMarkets, loading, error, refresh, stats };
}
