/**
 * The wire contract between the engine and the browser.
 *
 * These lived in `app/api/opportunities/route.ts`, so `app/page.tsx` imported its types out
 * of a 1015-line server module whose type graph reached through both trading modules and
 * into the Polymarket SDK. Type imports erase, so it worked — but one refactor turning any
 * of it into a value import would have pulled `node:crypto` into the browser bundle.
 *
 * This file is the only sanctioned boundary between the two, and it must stay TYPE-ONLY:
 * `npm run check` asserts it declares no runtime values.
 */
import type { ArbitrageOpportunity, Category } from './market-types';

export interface PairInfo {
  category: Category;
  pmId: string;   // unique market id — URLs are shared across a multi-outcome event
  kalId: string;
  pmQuestion: string;
  pmPrice: number;
  pmDate?: string;
  pmUrl: string;
  kalQuestion: string;
  kalPrice: number;
  kalDate?: string;
  kalUrl: string;
  priceDiff: number;
  datesMatch: boolean;
  filteredOut: boolean; // true if excluded by date/sanity checks (shown greyed in UI)
}

export interface OpportunitiesResponse {
  opportunities: ArbitrageOpportunity[];
  pairsDetail: PairInfo[];
  stats: {
    pmMarkets: number;
    kalshiMarkets: number;
    matchedPairs: number;
    byCategory: Partial<Record<Category, { pm: number; kalshi: number; pairs: number }>>;
    fetchedAt: string;
    /** When these quotes were actually built (not when the response was sent). */
    builtAt?: string;
    /** Age of the quotes in ms at send time — what the UI should show as freshness. */
    ageMs?: number;
  };
  error?: string;
  /** Cold start: discovery is still running, so this is an empty placeholder.
   *  The client keeps polling and fills in as soon as the first build lands. */
  warming?: boolean;
}
