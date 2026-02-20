import { useCallback, useState } from 'react';
import type { ArbitrageOpportunity } from '@/lib/market-types';
import type { PolymarketMarketWithKind } from '@/api/polymarket';
import { getPolymarketMarkets } from '@/api/polymarket';
import { getKalshiMarkets } from '@/api/kalshi';
import { matchMarkets } from '@/lib/matchMarkets';
import { findArbitrageOpportunities } from '@/lib/arbitrage';
import { isSportsMarket } from '@/lib/sports';

type PairWithKind = {
  polymarket: PolymarketMarketWithKind;
  kalshi: {
    id: string;
    venue: 'kalshi';
    question: string;
    yesPriceCents: number;
    noPriceCents: number;
    url: string;
    [k: string]: unknown;
  };
};

export interface ArbStats {
  pmTotal: number;
  pmSports: number;
  kalshiTotal: number;
  kalshiSports: number;
  matchedPairs: number;
}

export function useArbitrageOpportunities(options?: { minEdgePercent?: number }) {
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ArbStats | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pmMarkets, kalshiMarkets] = await Promise.all([
        getPolymarketMarkets(80),
        getKalshiMarkets(200),
      ]);
      const sportsPm = pmMarkets.filter((m) => isSportsMarket(m.question));
      const sportsKalshi = kalshiMarkets.filter((m) =>
        isSportsMarket(m.question, 'symbol' in m ? m.symbol : undefined)
      );

      const pairs = matchMarkets(sportsPm, sportsKalshi, {
        minTitleSimilarity: 0.2,
        requireSameDay: false,
      });
      const opps = findArbitrageOpportunities(pairs as PairWithKind[], options?.minEdgePercent ?? 0);
      setOpportunities(opps);
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
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [options?.minEdgePercent]);

  return { opportunities, loading, error, refresh, stats };
}
