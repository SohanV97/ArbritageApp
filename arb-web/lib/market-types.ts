export type Category = 'mlb' | 'soccer' | 'nfl' | 'cfb' | 'politics';

// Polymarket's CLOB rejects orders under 5 shares (INVALID_ORDER_MIN_SIZE); verified
// against live /markets data — every market reports minimum_order_size = 5. Kalshi's
// minimum is 1, so a 1–4 contract arb would fill the Kalshi leg and have the Polymarket
// leg rejected, leaving a naked directional position. Both legs are sized equally, so
// no arb below this size may be placed.
export const MIN_ORDER_CONTRACTS = 5;

export type Venue = 'polymarket' | 'kalshi';

export type BinarySide = 'yes' | 'no';

export interface UnifiedMarket {
  id: string;
  venue: Venue;
  question: string;
  symbol?: string;
  yesPriceCents: number;
  noPriceCents: number;
  resolutionTime?: string;
  url: string;
  rulesDescription?: string;
  category?: Category;
  // Sports: which team a YES contract pays out on. Polymarket = outcomes[0]/[1];
  // Kalshi = ticker suffix + yes_sub_title. Used to align YES↔YES across venues by
  // identity — aligning by price proximity inverts exactly when venues disagree,
  // which is the arb case.
  yesTeam?: string;
  noTeam?: string;
  // Order-book context. Depths are contracts available at the quoted ask (Kalshi).
  // spread/liquidity describe the Polymarket book so thin quotes are visible.
  yesDepth?: number;
  noDepth?: number;
  spreadCents?: number;
  liquidityUsd?: number;
  /** Whether the venue itself still accepts orders on this market. This is the only
   *  reliable "is it still live" signal for a game IN PROGRESS: a synthetic date cutoff
   *  cannot tell a game that is mid-innings from one that finished, and both venues keep
   *  trading a game until a winner is declared. Undefined means the venue said nothing,
   *  which is treated as tradeable. */
  tradeable?: boolean;
}

export interface MatchedPair {
  polymarket: UnifiedMarket;
  kalshi: UnifiedMarket;
}

export interface ArbitrageOpportunity {
  pair: MatchedPair;
  legA: { venue: Venue; side: BinarySide; priceCents: number; feeCents: number };
  legB: { venue: Venue; side: BinarySide; priceCents: number; feeCents: number };
  totalCostCents: number;
  maxPayoutCents: number;
  edgePercent: number;
  // Contracts fillable at the quoted Kalshi ask (1 contract = $1 payout).
  // Undefined when the API didn't report depth.
  maxContracts?: number;
}
