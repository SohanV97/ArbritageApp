import { useCallback, useState } from 'react';
import type { ArbitrageOpportunity, UnifiedMarket } from '@/lib/market-types';
import { getPolymarketBaseballMarkets, type PolymarketMarketWithKind } from '@/api/polymarket';
import { getKalshiBaseballMarkets } from '@/api/kalshi';
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
  const [pmMarkets, setPmMarkets] = useState<PolymarketMarketWithKind[]>([]);
  const [kalshiMarkets, setKalshiMarkets] = useState<UnifiedMarket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ArbStats | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [fetchedPm, fetchedKalshi] = await Promise.all([
        getPolymarketBaseballMarkets(),
        getKalshiBaseballMarkets(),
      ]);

      const pairs = matchMarkets(fetchedPm, fetchedKalshi, {
        minTitleSimilarity: 0.35,
        minOverlapTokens: 2,
        requireSameDay: false,
      });

      const typedPairs: PairWithKind[] = pairs.map(p => {
        const pmYes = p.polymarket.yesPriceCents;
        const kalYes = p.kalshi.yesPriceCents;
        const kalNo = p.kalshi.noPriceCents;

        const isAligned = Math.abs(pmYes - kalYes) < Math.abs(pmYes - kalNo);
        let alignedKalshi = { ...p.kalshi };

        if (!isAligned) {
          alignedKalshi.yesPriceCents = kalNo;
          alignedKalshi.noPriceCents = kalYes;
          alignedKalshi.question = `${alignedKalshi.question} [FLIPPED FOR ALIGNMENT]`;
        }

        return {
          ...p,
          polymarket: p.polymarket as PolymarketMarketWithKind,
          kalshi: alignedKalshi,
        };
      });

      const opps = findArbitrageOpportunities(typedPairs, options?.minEdgePercent ?? 0);

      setOpportunities(opps);
      setPmMarkets(fetchedPm);
      setKalshiMarkets(fetchedKalshi);
      setStats({
        pmTotal: fetchedPm.length,
        pmSports: fetchedPm.length,
        kalshiTotal: fetchedKalshi.length,
        kalshiSports: fetchedKalshi.length,
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
