import { useCallback, useState } from 'react';
import type { ArbitrageOpportunity, UnifiedMarket } from '@/lib/market-types';
import { getPolymarketBasketballMarkets, type PolymarketMarketWithKind } from '@/api/polymarket';
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
        getPolymarketBasketballMarkets(),
        getKalshiBasketballMarkets(),
      ]);

      const pairs = matchMarkets(fetchedPm, fetchedKalshi, {
        minTitleSimilarity: 0.35, // <-- Increased to prevent Michigan State / Eastern Michigan errors
        minOverlapTokens: 3,      // <-- Requires a stricter word match for CBB
        requireSameDay: false,
      });
      
      // ==========================================
      // SMART ALIGNMENT INTERCEPTOR
      // ==========================================
      const typedPairs: PairWithKind[] = pairs.map(p => {
        const pmYes = p.polymarket.yesPriceCents;
        const kalYes = p.kalshi.yesPriceCents;
        const kalNo = p.kalshi.noPriceCents;

        // Determine if Kalshi reversed the Home/Away order compared to Polymarket
        const isAligned = Math.abs(pmYes - kalYes) < Math.abs(pmYes - kalNo);

        let alignedKalshi = { ...p.kalshi };

        if (!isAligned) {
          // If flipped, swap Kalshi's prices in memory so they perfectly match PM's orientation
          alignedKalshi.yesPriceCents = kalNo;
          alignedKalshi.noPriceCents = kalYes;
          alignedKalshi.question = `${alignedKalshi.question} [FLIPPED FOR ALIGNMENT]`;
        }

        return {
          ...p,
          polymarket: p.polymarket as PolymarketMarketWithKind,
          kalshi: alignedKalshi
        };
      });

      // Now your arbitrage calculator receives perfectly aligned Yes/No pairs!
      const opps = findArbitrageOpportunities(typedPairs, options?.minEdgePercent ?? 0);
      
      // #region agent log
      if (opps.length > 0) {
        const o = opps[0];
        const pm = o.pair.polymarket;
        const k = o.pair.kalshi;
        const pairData = { 
          pmQuestion: (pm.question || '').slice(0, 70), 
          pmYes: pm.yesPriceCents, 
          pmNo: pm.noPriceCents, 
          kalshiQuestion: (k.question || '').slice(0, 70), 
          kalshiYes: k.yesPriceCents, 
          kalshiNo: k.noPriceCents 
        };
        fetch('http://127.0.0.1:7864/ingest/1db4401f-b144-4aed-9aa6-5a1876b1005e', { 
          method: 'POST', 
          headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '6ebff7' }, 
          body: JSON.stringify({ sessionId: '6ebff7', location: 'useArbitrageOpportunities', message: 'First pair PM vs Kalshi', data: pairData, timestamp: Date.now(), hypothesisId: 'H3' }) 
        }).catch(() => {});
        console.log('[DEBUG] first pair PM vs Kalshi:', JSON.stringify(pairData));
      }
      // #endregion
      
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