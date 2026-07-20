export type Category = 'mlb' | 'soccer' | 'politics';

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
